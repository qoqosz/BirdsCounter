// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

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

#[tauri::command]
fn process_image(payload: Vec<u8>) -> Result<Vec<u8>, String> {
    use opencv::prelude::*;
    use opencv::{core, core::AlgorithmHint, imgcodecs, imgproc};

    // Decode the image from the byte vector
    let vec: core::Vector<u8> = core::Vector::from_iter(payload);
    let src = imgcodecs::imdecode(&vec, imgcodecs::IMREAD_COLOR)
        .map_err(|e| format!("OpenCV decode error: {}", e))?;

    // Convert to grayscale
    let mut gray = Mat::default();
    imgproc::cvt_color(
        &src,
        &mut gray,
        imgproc::COLOR_BGR2GRAY,
        0,
        AlgorithmHint::ALGO_HINT_DEFAULT,
    )
    .map_err(|e| format!("OpenCV color conversion error: {}", e))?;

    // Encode the grayscale image back to a byte vector (using PNG format for example)
    let mut buf = core::Vector::new();
    let params = core::Vector::new(); // default params
    imgcodecs::imencode(".png", &gray, &mut buf, &params)
        .map_err(|e| format!("OpenCV encode error: {}", e))?;

    Ok(buf.to_vec())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![greet, open_camera, process_image])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
