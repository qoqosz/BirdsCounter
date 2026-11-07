//! Counting history: one entry per photo with its count, settings, crop and mask.
//!
//! Entries link to the photo instead of copying it. Each `source` is one of:
//! - `file:<absolute path>`: a file on disk (Android camera photos);
//!   relative paths are refused
//! - `appdoc:<relative path>`: an existing file in the app's Documents folder (iOS camera photos);
//!   it must stay inside that folder once `..` and symlinks are resolved
//! - `content://…`: an Android document the app holds a persistable permission for
//! - `photos:<local identifier>`: an asset in the iOS photo library
//!
//! Only a small thumbnail of the result, and the painted mask if there is one, are stored
//! next to `history.json`.

use crate::blob_filter::Crop;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State, ipc::Response};

/// Prefix of the photos the app takes itself; only those are deleted with their entry.
pub const OWNED_PHOTO_PREFIX: &str = "BirdsCounter_";

#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
    pub updated_at: u64,
    /// Where the photo lives (see the module docs); `None` when it came without a
    /// lasting location, e.g. dropped from a web browser.
    pub source: Option<String>,
    /// The app took the photo, so it is deleted together with the entry.
    #[serde(default)]
    pub owned: bool,
    pub name: Option<String>,
    pub count: u32,
    /// Detection settings, as built by `readParamsFromUI()` in `main.js`.
    pub params: serde_json::Value,
    pub crop: Option<Crop>,
    #[serde(default)]
    pub has_mask: bool,
}

/// What the frontend sends to create (`id: None`) or update an entry.
#[derive(Deserialize)]
pub struct EntryInput {
    id: Option<String>,
    source: Option<String>,
    #[serde(default)]
    owned: bool,
    name: Option<String>,
    count: u32,
    params: serde_json::Value,
    crop: Option<Crop>,
}

/// The JSON part of a `history_save` body.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveMeta {
    entry: EntryInput,
    thumb_length: usize,
    update_mask: bool,
}

struct SaveBody<'a> {
    entry: EntryInput,
    update_mask: bool,
    thumb: &'a [u8],
    mask: Option<&'a [u8]>,
}

/// Splits a `history_save` body (see `split_framed`): after the JSON come the thumbnail and
/// the mask, which may be empty.
fn parse_save_body(body: &[u8]) -> Result<SaveBody<'_>, String> {
    let (meta, rest) = crate::split_framed(body)?;
    let meta: SaveMeta = serde_json::from_slice(meta).map_err(|e| e.to_string())?;
    let (thumb, mask) = rest
        .split_at_checked(meta.thumb_length)
        .ok_or_else(|| "Invalid history save".to_string())?;
    Ok(SaveBody {
        entry: meta.entry,
        update_mask: meta.update_mask,
        thumb,
        mask: (!mask.is_empty()).then_some(mask),
    })
}

pub struct History {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl History {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
        }
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join("history.json")
    }

    fn thumb_path(&self, id: &str) -> PathBuf {
        self.dir.join("thumbs").join(format!("{id}.jpg"))
    }

    fn mask_path(&self, id: &str) -> PathBuf {
        self.dir.join("masks").join(format!("{id}.png"))
    }

    fn load(&self) -> Vec<Entry> {
        let path = self.index_path();
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Vec::new();
        };
        match serde_json::from_str(&text) {
            Ok(entries) => entries,
            Err(e) => {
                // Keep the unreadable file instead of overwriting it with the next save.
                eprintln!("Unreadable history ({e}), moving it aside");
                let _ = std::fs::rename(&path, path.with_extension("json.bak"));
                Vec::new()
            }
        }
    }

    fn store(&self, entries: &[Entry]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("History folder: {e}"))?;
        let json = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
        let tmp = self.index_path().with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("History write: {e}"))?;
        std::fs::rename(&tmp, self.index_path()).map_err(|e| format!("History write: {e}"))
    }

    fn remove_files(&self, app: &AppHandle, entry: &Entry) {
        let _ = std::fs::remove_file(self.thumb_path(&entry.id));
        let _ = std::fs::remove_file(self.mask_path(&entry.id));
        if entry.owned
            && let Some(path) = entry
                .source
                .as_deref()
                .and_then(|s| source_path(app, s).ok())
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(OWNED_PHOTO_PREFIX))
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Ids name files, so only accept the ones `history_save` generates.
fn check_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err(format!("Invalid history id: {id}"))
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("History folder: {e}"))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("History write: {e}"))
}

/// `file:` sources are only the camera photos the app saves itself: `BirdsCounter_*` files
/// in a `Pictures` folder. Anything else is refused, so the command can't read arbitrary files.
fn checked_photo_path(path: &Path, source: &str) -> Result<PathBuf, String> {
    let invalid = || format!("Invalid source: {source}");
    // A relative path would be resolved against the process's current directory.
    if !path.is_absolute() {
        return Err(invalid());
    }
    // Resolve `..` and symlinks before checking where the file really is.
    let path = path.canonicalize().map_err(|_| invalid())?;
    let owned = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(OWNED_PHOTO_PREFIX));
    let in_pictures = path
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == "Pictures");
    if owned && in_pictures {
        Ok(path)
    } else {
        Err(invalid())
    }
}

/// `appdoc:` sources are relative to the Documents folder (its absolute path changes between
/// installs on iOS). The result must still be inside it once `..` and symlinks are resolved,
/// so a photo that is missing is refused too.
fn checked_appdoc_path(documents: &Path, relative: &str, source: &str) -> Result<PathBuf, String> {
    let invalid = || format!("Invalid source: {source}");
    let relative = Path::new(relative);
    if relative.is_absolute() {
        return Err(invalid());
    }
    let documents = documents.canonicalize().map_err(|_| invalid())?;
    let path = documents
        .join(relative)
        .canonicalize()
        .map_err(|_| invalid())?;
    if path.starts_with(&documents) {
        Ok(path)
    } else {
        Err(invalid())
    }
}

/// Resolves a `file:` or `appdoc:` source to a path on disk.
pub fn source_path(app: &AppHandle, source: &str) -> Result<PathBuf, String> {
    if let Some(path) = source
        .strip_prefix("file://")
        .or_else(|| source.strip_prefix("file:"))
    {
        return checked_photo_path(Path::new(path), source);
    }
    if let Some(relative) = source.strip_prefix("appdoc:") {
        let documents = app.path().document_dir().map_err(|e| e.to_string())?;
        return checked_appdoc_path(&documents, relative, source);
    }
    Err(format!("Not a file source: {source}"))
}

/// Reads a photo from a `file:` or `appdoc:` source.
#[tauri::command]
pub async fn read_image(app: AppHandle, source: String) -> Result<Response, String> {
    let path = source_path(&app, &source)?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Entries, most recently updated first.
#[tauri::command]
pub async fn history_list(history: State<'_, History>) -> Result<Vec<Entry>, String> {
    let _guard = history.lock.lock().map_err(|e| e.to_string())?;
    let mut entries = history.load();
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(entries)
}

/// Creates or updates an entry, sent as a raw request body (see `parse_save_body`). The mask
/// file is only touched when `update_mask` is set: replaced by `mask`, or removed when there
/// is none.
#[tauri::command]
pub async fn history_save(
    request: tauri::ipc::Request<'_>,
    history: State<'_, History>,
) -> Result<Entry, String> {
    let body = crate::request_bytes(&request)?;
    let SaveBody {
        entry,
        update_mask,
        thumb,
        mask,
    } = parse_save_body(&body)?;
    let _guard = history.lock.lock().map_err(|e| e.to_string())?;
    let mut entries = history.load();
    let now = now_ms();

    let index = match &entry.id {
        Some(id) => entries.iter().position(|e| &e.id == id),
        None => None,
    };
    let index = match index {
        Some(index) => index,
        None => {
            // Deleted while open in the editor, or new: start a new entry.
            let mut id = format!("{now:x}");
            let mut n = 1;
            while entries.iter().any(|e| e.id == id) {
                id = format!("{now:x}-{n}");
                n += 1;
            }
            entries.push(Entry {
                id,
                created_at: now,
                updated_at: now,
                source: None,
                owned: false,
                name: None,
                count: 0,
                params: serde_json::Value::Null,
                crop: None,
                has_mask: false,
            });
            entries.len() - 1
        }
    };

    let stored = &mut entries[index];
    stored.updated_at = now;
    stored.source = entry.source;
    stored.owned = entry.owned;
    stored.name = entry.name;
    stored.count = entry.count;
    stored.params = entry.params;
    stored.crop = entry.crop;

    write_file(&history.thumb_path(&stored.id), thumb)?;
    if update_mask {
        match mask {
            Some(png) => write_file(&history.mask_path(&stored.id), png)?,
            None => {
                let _ = std::fs::remove_file(history.mask_path(&stored.id));
            }
        }
        stored.has_mask = mask.is_some();
    }

    let saved = stored.clone();
    history.store(&entries)?;
    Ok(saved)
}

#[tauri::command]
pub async fn history_thumb(history: State<'_, History>, id: String) -> Result<Response, String> {
    check_id(&id)?;
    std::fs::read(history.thumb_path(&id))
        .map(Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn history_mask(history: State<'_, History>, id: String) -> Result<Response, String> {
    check_id(&id)?;
    std::fs::read(history.mask_path(&id))
        .map(Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn history_delete(
    app: AppHandle,
    history: State<'_, History>,
    id: String,
) -> Result<(), String> {
    let _guard = history.lock.lock().map_err(|e| e.to_string())?;
    let mut entries = history.load();
    if let Some(index) = entries.iter().position(|e| e.id == id) {
        let entry = entries.remove(index);
        history.store(&entries)?;
        history.remove_files(&app, &entry);
    }
    Ok(())
}

#[tauri::command]
pub async fn history_clear(app: AppHandle, history: State<'_, History>) -> Result<(), String> {
    let _guard = history.lock.lock().map_err(|e| e.to_string())?;
    let entries = history.load();
    history.store(&[])?;
    for entry in &entries {
        history.remove_files(&app, entry);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn file_sources_are_limited_to_own_photos() {
        let dir = std::env::temp_dir().join("bc_photo_check").join("Pictures");
        std::fs::create_dir_all(&dir).unwrap();
        let own = dir.join("BirdsCounter_1.jpg");
        let other = dir.join("other.jpg");
        std::fs::write(&own, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();
        assert!(checked_photo_path(&own, "file").is_ok());
        assert!(checked_photo_path(&other, "file").is_err());
        assert!(checked_photo_path(&dir.join("../Pictures/other.jpg"), "file").is_err());
        assert!(checked_photo_path(Path::new("/etc/passwd"), "file").is_err());
        assert!(checked_photo_path(Path::new("Pictures/BirdsCounter_1.jpg"), "file").is_err());
    }

    #[test]
    fn appdoc_sources_stay_in_the_documents_folder() {
        let root = std::env::temp_dir().join("bc_appdoc_check");
        let docs = root.join("Documents");
        std::fs::create_dir_all(docs.join("Photos")).unwrap();
        std::fs::write(docs.join("Photos/BirdsCounter_1.jpg"), b"x").unwrap();
        std::fs::write(root.join("secret.txt"), b"x").unwrap();
        let check = |rel: &str| checked_appdoc_path(&docs, rel, rel);
        assert!(check("Photos/BirdsCounter_1.jpg").is_ok());
        assert!(check("Photos/missing.jpg").is_err());
        assert!(check("../secret.txt").is_err());
        assert!(check("Photos/../../secret.txt").is_err());
        assert!(check("/etc/passwd").is_err());
    }

    use super::*;

    fn save_body(meta: &str, files: &[u8]) -> Vec<u8> {
        let mut body = (meta.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(meta.as_bytes());
        body.extend_from_slice(files);
        body
    }

    const ENTRY: &str = r#""entry":{"id":null,"source":null,"owned":false,"name":"Żuraw.jpg","count":3,"params":{},"crop":null}"#;

    #[test]
    fn save_body_splits_thumb_and_mask() {
        let meta = format!(r#"{{{ENTRY},"thumbLength":2,"updateMask":true}}"#);
        let body = save_body(&meta, &[1, 2, 3, 4, 5]);
        let saved = parse_save_body(&body).unwrap();
        assert_eq!(saved.entry.name.as_deref(), Some("Żuraw.jpg"));
        assert!(saved.update_mask);
        assert_eq!(saved.thumb, [1, 2]);
        assert_eq!(saved.mask, Some(&[3, 4, 5][..]));
    }

    #[test]
    fn save_body_without_mask() {
        let meta = format!(r#"{{{ENTRY},"thumbLength":2,"updateMask":true}}"#);
        let body = save_body(&meta, &[1, 2]);
        let saved = parse_save_body(&body).unwrap();
        assert_eq!(saved.thumb, [1, 2]);
        assert_eq!(saved.mask, None);
    }

    #[test]
    fn save_body_rejects_wrong_lengths() {
        assert!(parse_save_body(&[1, 0]).is_err());
        assert!(parse_save_body(&[200, 0, 0, 0, b'{']).is_err());
        let meta = format!(r#"{{{ENTRY},"thumbLength":3,"updateMask":false}}"#);
        assert!(parse_save_body(&save_body(&meta, &[1, 2])).is_err());
    }
}
