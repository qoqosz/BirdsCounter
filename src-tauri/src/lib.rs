// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod blob_filter;
mod history;
mod native;
use blob_filter::{Bird, BlobFilter, BlobParams, Crop};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::ipc::InvokeBody;

#[derive(serde::Serialize)]
struct ProcessResult {
    birds: Vec<Bird>,
    count: u32,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
    let gray = match request.body() {
        InvokeBody::Raw(bytes) => blob_filter::decode_gray(bytes)?,
        // Platforms without raw IPC bodies send the bytes as a JSON array.
        InvokeBody::Json(value) => {
            let bytes: Vec<u8> =
                serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            blob_filter::decode_gray(&bytes)?
        }
    };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    *photo.0.lock().map_err(|e| e.to_string())? = Some((id, Arc::new(gray)));
    Ok(id)
}

/// Counts the birds in the photo `photo_id` from `load_photo`, or in its `crop`; the mask
/// covers the whole photo. Fails with `photo-missing` once another photo was loaded. The
/// frontend draws the rings, so only the detections go back. Runs off the main thread
/// so the UI stays responsive.
#[tauri::command(async)]
fn process_image(
    photo: tauri::State<'_, LoadedPhoto>,
    photo_id: u64,
    params: BlobParams,
    mask_payload: Option<Vec<u8>>,
    crop: Option<Crop>,
) -> Result<ProcessResult, String> {
    let gray = match &*photo.0.lock().map_err(|e| e.to_string())? {
        Some((id, gray)) if *id == photo_id => Arc::clone(gray),
        _ => return Err("photo-missing".to_string()),
    };
    let filter = BlobFilter::new(params);
    let birds = filter.detect(&gray, mask_payload.as_deref(), crop)?;
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
            greet,
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
