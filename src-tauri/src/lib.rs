// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod blob_filter;
mod history;
mod native;
use blob_filter::{Bird, BlobFilter, BlobParams, Crop};
use serde::Deserialize;
use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::ipc::InvokeBody;

#[derive(serde::Serialize)]
struct ProcessResult {
    birds: Vec<Bird>,
    count: u32,
}

/// The bytes sent as a command's raw request body. Android has no raw IPC bodies, so there
/// they arrive as a JSON array.
fn request_bytes<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<Cow<'a, [u8]>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        InvokeBody::Json(value) => Vec::<u8>::deserialize(value)
            .map(Cow::Owned)
            .map_err(|e| e.to_string()),
    }
}

/// Splits a body built by `framedBody` in `main.js` into its JSON and the bytes after it:
/// the length of the JSON (u32, little endian), the JSON, the bytes.
fn split_framed(body: &[u8]) -> Result<(&[u8], &[u8]), String> {
    let invalid = || "Invalid request body".to_string();
    let (length, rest) = body.split_first_chunk::<4>().ok_or_else(invalid)?;
    rest.split_at_checked(u32::from_le_bytes(*length) as usize)
        .ok_or_else(invalid)
}

/// The JSON part of a `process_image` body.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMeta {
    photo_id: u64,
    params: BlobParams,
    crop: Option<Crop>,
}

/// The photo being counted, decoded once by `load_photo` so that settings changes do not
/// send and decode it again. Holds one photo at a time.
#[derive(Default)]
struct LoadedPhoto(Mutex<Option<(u64, Arc<opencv::core::Mat>)>>);

/// Decodes a photo, sent as the raw request body, for `process_image`; returns its id.
#[tauri::command]
async fn load_photo(
    request: tauri::ipc::Request<'_>,
    photo: tauri::State<'_, LoadedPhoto>,
) -> Result<u64, String> {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let gray = blob_filter::decode_gray(&request_bytes(&request)?)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    *photo.0.lock().map_err(|e| e.to_string())? = Some((id, Arc::new(gray)));
    Ok(id)
}

/// Counts the birds in the photo `photo_id` from `load_photo`, or in its `crop`; the mask
/// covers the whole photo. Sent as a raw request body (see `split_framed`) with the mask, if
/// any, after the JSON. Fails with `photo-missing` once another photo was loaded. The
/// frontend draws the rings, so only the detections go back. Runs off the main thread
/// so the UI stays responsive.
#[tauri::command(async)]
fn process_image(
    request: tauri::ipc::Request<'_>,
    photo: tauri::State<'_, LoadedPhoto>,
) -> Result<ProcessResult, String> {
    let body = request_bytes(&request)?;
    let (meta, mask) = split_framed(&body)?;
    let meta: ProcessMeta = serde_json::from_slice(meta).map_err(|e| e.to_string())?;
    let gray = match &*photo.0.lock().map_err(|e| e.to_string())? {
        Some((id, gray)) if *id == meta.photo_id => Arc::clone(gray),
        _ => return Err("photo-missing".to_string()),
    };
    let filter = BlobFilter::new(meta.params);
    let birds = filter.detect(&gray, (!mask.is_empty()).then_some(mask), meta.crop)?;
    let count = birds.iter().map(|bird| bird.count).sum();
    Ok(ProcessResult { birds, count })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let history_dir = app.path().app_data_dir()?.join("history");
            app.manage(history::History::new(history_dir));
            app.manage(LoadedPhoto::default());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_photo,
            process_image,
            history::read_image,
            history::history_list,
            history::history_save,
            history::history_thumb,
            history::history_mask,
            history::history_delete,
            history::history_clear,
            native::native_take_photo,
            native::native_pick_photo,
            native::native_take_shared_photo,
            native::native_load_photo,
            native::take_staged_image,
            native::take_quick_action,
            native::set_quick_actions,
            native::native_share_image,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Between build (which declares the iOS app delegate) and run (which launches the app).
    #[cfg(target_os = "ios")]
    native::install(app.handle());

    app.run(|_, _| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(meta: &str, bytes: &[u8]) -> Vec<u8> {
        let mut body = (meta.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(meta.as_bytes());
        body.extend_from_slice(bytes);
        body
    }

    #[test]
    fn process_body_splits_meta_and_mask() {
        let body = framed(
            r#"{"photoId":5,"params":{"min_radius":2,"sky_only":false},"crop":null}"#,
            &[1, 2, 3],
        );
        let (meta, mask) = split_framed(&body).unwrap();
        let meta: ProcessMeta = serde_json::from_slice(meta).unwrap();
        assert_eq!(meta.photo_id, 5);
        assert_eq!(meta.params.min_radius, 2.0);
        assert!(!meta.params.sky_only);
        assert!(meta.crop.is_none());
        assert_eq!(mask, [1, 2, 3]);
    }

    #[test]
    fn framed_body_rejects_wrong_lengths() {
        assert!(split_framed(&[1, 0]).is_err());
        assert!(split_framed(&[200, 0, 0, 0, b'{']).is_err());
    }
}
