// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod blob_filter;
mod history;
mod native;
use blob_filter::{BlobFilter, BlobParams, Crop};
use tauri::Manager;

#[derive(serde::Serialize)]
struct ProcessResult {
    bytes: Vec<u8>,
    count: u32,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn open_camera() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        // On macOS, we'll use the native Photo Booth or Camera app
        let output = Command::new("open")
            .arg("-a")
            .arg("Photo Booth")
            .output()
            .map_err(|e| format!("Failed to open camera app: {}", e))?;

        if !output.status.success() {
            // Fallback to FaceTime if Photo Booth is not available
            Command::new("open")
                .arg("-a")
                .arg("FaceTime")
                .output()
                .map_err(|e| format!("Failed to open camera: {}", e))?;
        }

        return Ok("Camera opened".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        // On Windows, open the Camera app
        Command::new("cmd")
            .args(&["/C", "start", "microsoft.windows.camera:"])
            .output()
            .map_err(|e| format!("Failed to open camera: {}", e))?;

        return Ok("Camera opened".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        // Try common camera apps on Linux
        let apps = vec!["gnome-photos", "cheese", "ffplay"];

        for app in apps {
            if let Ok(output) = Command::new("which").arg(app).output() {
                if output.status.success() {
                    Command::new(app)
                        .output()
                        .map_err(|e| format!("Failed to open {}: {}", app, e))?;
                    return Ok("Camera opened".to_string());
                }
            }
        }

        return Err("No camera application found".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return Err("Unsupported platform".to_string());
    }
}

/// Counts the birds in the image, or in its `crop`; the mask covers the whole image.
/// Runs off the main thread so the UI stays responsive.
#[tauri::command(async)]
fn process_image(
    payload: Vec<u8>,
    params: BlobParams,
    mask_payload: Option<Vec<u8>>,
    crop: Option<Crop>,
) -> Result<ProcessResult, String> {
    let filter = BlobFilter::new(params);
    let (bytes, count) = filter.apply(payload, mask_payload, crop)?;
    Ok(ProcessResult {
        bytes,
        count: count as u32,
    })
}

/// Native macOS menu bar; "Open Image…" (⌘O) is forwarded to the frontend.
#[cfg(target_os = "macos")]
fn setup_macos_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Emitter;
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let open_image = MenuItemBuilder::with_id("open_image", "Open Image…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Birds Counter")
        .about(Some(AboutMetadata::default()))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_image)
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == "open_image" {
            let _ = app.emit("menu-open-image", ());
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            setup_macos_menu(app)?;
            let history_dir = app.path().app_data_dir()?.join("history");
            app.manage(history::History::new(history_dir));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            open_camera,
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
            native::native_load_photo,
            native::take_staged_image,
            native::take_quick_action,
            native::set_quick_actions,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Between build (which declares the iOS app delegate) and run (which launches the app).
    #[cfg(target_os = "ios")]
    native::install(app.handle());

    app.run(|_, _| {});
}
