//! Counting history: one entry per photo with its count, settings, crop and mask.
//!
//! Entries link to the photo instead of copying it. Each `source` is one of:
//! - `file:<absolute path>`: a file on disk (desktop; Android camera photos)
//! - `appdoc:<relative path>`: a file in the app's Documents folder (iOS camera photos)
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

/// Resolves a `file:` or `appdoc:` source to a path on disk.
pub fn source_path(app: &AppHandle, source: &str) -> Result<PathBuf, String> {
    if let Some(path) = source
        .strip_prefix("file://")
        .or_else(|| source.strip_prefix("file:"))
    {
        return Ok(PathBuf::from(path));
    }
    if let Some(relative) = source.strip_prefix("appdoc:") {
        let relative = Path::new(relative);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("Invalid source: {source}"));
        }
        let documents = app.path().document_dir().map_err(|e| e.to_string())?;
        return Ok(documents.join(relative));
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

/// Creates or updates an entry. The mask file is only touched when `update_mask` is set:
/// replaced by `mask`, or removed when `mask` is `None`.
#[tauri::command]
pub async fn history_save(
    history: State<'_, History>,
    entry: EntryInput,
    thumb: Vec<u8>,
    mask: Option<Vec<u8>>,
    update_mask: bool,
) -> Result<Entry, String> {
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

    write_file(&history.thumb_path(&stored.id), &thumb)?;
    if update_mask {
        match &mask {
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
