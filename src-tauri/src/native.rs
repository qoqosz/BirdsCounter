//! Camera, photo library, photos shared from other apps and home screen quick actions on iOS.
//!
//! The UIKit side is the Objective-C class `BCNativeBridge` in
//! `gen/apple/Sources/birdscounter/BCNativeBridge.m`, looked up at runtime so the library
//! has no link-time dependency on the app. It reports back through the two C callbacks
//! passed to `install`. Android does the same in `MainActivity.kt`, which the frontend
//! calls directly, so on other platforms these commands report that they are unsupported.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, ipc::Response};

/// A photo the user just took or picked. Its bytes wait in `take_staged_image`.
#[derive(Serialize)]
pub struct PickedImage {
    /// History source of the photo (see `history`), if it has a lasting location.
    source: Option<String>,
    name: Option<String>,
    /// Taken by the app, which stored it in Documents/Photos.
    owned: bool,
}

#[derive(Deserialize, Serialize)]
pub struct QuickAction {
    #[serde(rename = "type")]
    kind: String,
    title: String,
    /// SF Symbol name.
    icon: String,
}

#[cfg(target_os = "ios")]
pub use ios::install;

#[cfg(target_os = "ios")]
mod ios {
    use super::{PickedImage, QuickAction};
    use crate::history::OWNED_PHOTO_PREFIX;
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    use std::collections::HashMap;
    use std::ffi::{CStr, CString, c_char, c_void};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::async_runtime::{Receiver, Sender, channel};
    use tauri::{AppHandle, Emitter, Manager};

    struct NativeImage {
        bytes: Vec<u8>,
        asset_id: Option<String>,
        name: Option<String>,
    }

    /// `Ok(None)`: the user cancelled.
    type NativeResult = Result<Option<NativeImage>, String>;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
    static REQUESTS: Mutex<Option<HashMap<u64, Sender<NativeResult>>>> = Mutex::new(None);
    static QUICK_ACTION: Mutex<Option<String>> = Mutex::new(None);
    static SHARED: Mutex<Option<NativeImage>> = Mutex::new(None);
    pub(super) static STAGED: Mutex<Option<Vec<u8>>> = Mutex::new(None);

    fn bridge() -> Result<&'static AnyClass, String> {
        AnyClass::get(c"BCNativeBridge").ok_or_else(|| "BCNativeBridge is missing".to_string())
    }

    unsafe fn string(ptr: *const c_char) -> Option<String> {
        (!ptr.is_null()).then(|| {
            unsafe { CStr::from_ptr(ptr) }
                .to_string_lossy()
                .into_owned()
        })
    }

    extern "C" fn on_quick_action(kind: *const c_char) {
        let Some(kind) = (unsafe { string(kind) }) else {
            return;
        };
        *QUICK_ACTION.lock().unwrap() = Some(kind);
        // The frontend takes the action with `take_quick_action`, also when it loads after
        // a cold start and missed this event.
        if let Some(app) = APP.get() {
            let _ = app.emit("quick-action", ());
        }
    }

    extern "C" fn on_image(
        request: u64,
        bytes: *const u8,
        length: u64,
        asset_id: *const c_char,
        name: *const c_char,
        error: *const c_char,
    ) {
        let result = if let Some(error) = unsafe { string(error) } {
            Err(error)
        } else if bytes.is_null() {
            Ok(None)
        } else {
            Ok(Some(NativeImage {
                bytes: unsafe { std::slice::from_raw_parts(bytes, length as usize) }.to_vec(),
                asset_id: unsafe { string(asset_id) },
                name: unsafe { string(name) },
            }))
        };
        // Request 0 is a photo shared from another app (see BCHandleSharedURL).
        if request == 0 {
            if let (Ok(Some(image)), Some(app)) = (result, APP.get()) {
                *SHARED.lock().unwrap() = Some(image);
                let _ = app.emit("shared-photo", ());
            }
            return;
        }
        let sender = REQUESTS
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|requests| requests.remove(&request));
        if let Some(sender) = sender {
            let _ = sender.try_send(result);
        }
    }

    /// Registers the quick action handlers with UIKit. Must run after the Tauri app is built
    /// (which declares Tao's app and scene delegates) and before it runs, so a quick action
    /// that launches the app is not missed.
    pub fn install(app: &AppHandle) {
        let _ = APP.set(app.clone());
        match bridge() {
            Ok(bridge) => unsafe {
                let _: () = msg_send![
                    bridge,
                    installWithQuickActionHandler: on_quick_action as *const c_void,
                    imageHandler: on_image as *const c_void
                ];
            },
            Err(e) => eprintln!("{e}"),
        }
    }

    fn new_request() -> (u64, Receiver<NativeResult>) {
        let id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = channel(1);
        REQUESTS
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(id, sender);
        (id, receiver)
    }

    /// Calls `+[BCNativeBridge <selector>:request]` (or `<selector>:request source:`) on the
    /// main thread and waits for its `on_image` callback.
    async fn request(
        app: &AppHandle,
        selector: &'static str,
        source: Option<String>,
    ) -> NativeResult {
        let bridge = bridge()?;
        let (id, mut receiver) = new_request();
        let source = source
            .map(|s| CString::new(s).map_err(|e| e.to_string()))
            .transpose()?;
        app.run_on_main_thread(move || unsafe {
            match (selector, source) {
                ("takePhoto", _) => {
                    let _: () = msg_send![bridge, takePhoto: id];
                }
                ("pickPhoto", _) => {
                    let _: () = msg_send![bridge, pickPhoto: id];
                }
                ("loadAsset", Some(asset_id)) => {
                    let _: () =
                        msg_send![bridge, loadAsset: id, identifier: asset_id.as_ptr() as *mut c_char];
                }
                _ => unreachable!(),
            }
        })
        .map_err(|e| e.to_string())?;
        receiver
            .recv()
            .await
            .unwrap_or_else(|| Err("No answer from the photo picker".to_string()))
    }

    /// The only copy of the photo: keeps it in Documents, which the Files app shows.
    fn save_owned(app: &AppHandle, image: NativeImage) -> Result<PickedImage, String> {
        let name = image
            .name
            .filter(|n| n.starts_with(OWNED_PHOTO_PREFIX) && !n.contains('/'))
            .unwrap_or_else(|| {
                let millis = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis());
                format!("{OWNED_PHOTO_PREFIX}{millis}.jpg")
            });
        let relative = format!("Photos/{name}");
        let path = app
            .path()
            .document_dir()
            .map_err(|e| e.to_string())?
            .join(&relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, &image.bytes).map_err(|e| format!("Saving the photo: {e}"))?;
        *STAGED.lock().unwrap() = Some(image.bytes);
        Ok(PickedImage {
            source: Some(format!("appdoc:{relative}")),
            name: Some(name),
            owned: true,
        })
    }

    pub async fn take_photo(app: AppHandle) -> Result<Option<PickedImage>, String> {
        let Some(image) = request(&app, "takePhoto", None).await? else {
            return Ok(None);
        };
        save_owned(&app, image).map(Some)
    }

    /// The photo another app shared, once. It is copied like a camera photo, because the
    /// file it came from is only readable while the share lasts.
    pub fn take_shared_photo(app: AppHandle) -> Result<Option<PickedImage>, String> {
        match SHARED.lock().unwrap().take() {
            Some(image) => save_owned(&app, image).map(Some),
            None => Ok(None),
        }
    }

    pub async fn pick_photo(app: AppHandle) -> Result<Option<PickedImage>, String> {
        let Some(image) = request(&app, "pickPhoto", None).await? else {
            return Ok(None);
        };
        *STAGED.lock().unwrap() = Some(image.bytes);
        Ok(Some(PickedImage {
            source: image.asset_id.map(|id| format!("photos:{id}")),
            name: image.name,
            owned: false,
        }))
    }

    pub async fn load_asset(app: AppHandle, asset_id: String) -> Result<Vec<u8>, String> {
        request(&app, "loadAsset", Some(asset_id))
            .await?
            .map(|image| image.bytes)
            .ok_or_else(|| "The photo is not available".to_string())
    }

    pub fn take_quick_action() -> Option<String> {
        QUICK_ACTION.lock().unwrap().take()
    }

    pub fn set_quick_actions(app: AppHandle, items: Vec<QuickAction>) -> Result<(), String> {
        let bridge = bridge()?;
        let json = CString::new(serde_json::to_string(&items).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        app.run_on_main_thread(move || unsafe {
            let _: () = msg_send![bridge, setQuickActions: json.as_ptr() as *mut c_char];
        })
        .map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "ios"))]
mod ios {
    use super::{PickedImage, QuickAction};
    use std::sync::Mutex;
    use tauri::AppHandle;

    pub(super) static STAGED: Mutex<Option<Vec<u8>>> = Mutex::new(None);
    const UNSUPPORTED: &str = "Not supported on this platform";

    pub async fn take_photo(_app: AppHandle) -> Result<Option<PickedImage>, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub async fn pick_photo(_app: AppHandle) -> Result<Option<PickedImage>, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub async fn load_asset(_app: AppHandle, _asset_id: String) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn take_shared_photo(_app: AppHandle) -> Result<Option<PickedImage>, String> {
        Ok(None)
    }

    pub fn take_quick_action() -> Option<String> {
        None
    }

    pub fn set_quick_actions(_app: AppHandle, _items: Vec<QuickAction>) -> Result<(), String> {
        Ok(())
    }
}

/// Opens the camera. The photo is saved to the app's Documents/Photos folder.
#[tauri::command]
pub async fn native_take_photo(app: AppHandle) -> Result<Option<PickedImage>, String> {
    ios::take_photo(app).await
}

/// Opens the photo library picker.
#[tauri::command]
pub async fn native_pick_photo(app: AppHandle) -> Result<Option<PickedImage>, String> {
    ios::pick_photo(app).await
}

/// A photo another app shared with BirdsCounter, once. Its bytes wait in `take_staged_image`.
#[tauri::command]
pub fn native_take_shared_photo(app: AppHandle) -> Result<Option<PickedImage>, String> {
    ios::take_shared_photo(app)
}

/// Bytes of the photo from the last `native_take_photo` or `native_pick_photo`.
#[tauri::command]
pub fn take_staged_image() -> Result<Response, String> {
    ios::STAGED
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .map(Response::new)
        .ok_or_else(|| "No photo".to_string())
}

/// Loads a `photos:` history source from the photo library, asking for access first.
#[tauri::command]
pub async fn native_load_photo(app: AppHandle, source: String) -> Result<Response, String> {
    let asset_id = source
        .strip_prefix("photos:")
        .ok_or_else(|| format!("Not a photo library source: {source}"))?;
    ios::load_asset(app, asset_id.to_string())
        .await
        .map(Response::new)
}

/// The home screen quick action the app was opened with, once.
#[tauri::command]
pub fn take_quick_action() -> Option<String> {
    ios::take_quick_action()
}

/// Replaces the home screen quick actions (titles follow the app's language).
#[tauri::command]
pub fn set_quick_actions(app: AppHandle, items: Vec<QuickAction>) -> Result<(), String> {
    ios::set_quick_actions(app, items)
}
