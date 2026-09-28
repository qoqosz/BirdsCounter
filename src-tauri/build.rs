fn main() {
    // For Android targets, add OpenCV library paths
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("android") {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let opencv_sdk = format!("{}/opencv-android-sdk/sdk/native", manifest_dir);

        // Determine the correct ABI directory
        let abi = if target.contains("aarch64") {
            "arm64-v8a"
        } else if target.contains("armv7") {
            "armeabi-v7a"
        } else if target.contains("x86_64") {
            "x86_64"
        } else if target.contains("i686") {
            "x86"
        } else {
            "arm64-v8a" // default
        };

        // Add library search paths
        println!(
            "cargo:rustc-link-search=native={}/staticlibs/{}",
            opencv_sdk, abi
        );
        let third_party_dir = format!("{}/3rdparty/libs/{}", opencv_sdk, abi);
        println!("cargo:rustc-link-search=native={}", third_party_dir);
        println!("cargo:rerun-if-changed={}", third_party_dir);

        // Link 3rd party dependencies (order matters for static linking).
        // The set differs between OpenCV versions and ABIs (e.g. KleidiCV only on arm64,
        // IPP only on x86, OpenEXR/ADE gone in OpenCV 5), so link only what the SDK ships.
        let third_party_libs = [
            "IlmImf",
            "libopenjp2",
            "libjpeg-turbo",
            "libpng",
            "libtiff",
            "libwebp",
            "libprotobuf",
            "tbb",
            "ade",
            "cpufeatures",
            "tegra_hal",
            "kleidicv_hal",
            "kleidicv_thread",
            "kleidicv",
            "ipphal",
            "ippiw",
            "ippicv",
            "ittnotify",
        ];

        for lib in &third_party_libs {
            let archive = format!("{}/lib{}.a", third_party_dir, lib);
            if std::path::Path::new(&archive).is_file() {
                println!("cargo:rustc-link-lib=static={}", lib);
            }
        }

        // Link Android system libraries
        println!("cargo:rustc-link-lib=z");
        println!("cargo:rustc-link-lib=log");
        println!("cargo:rustc-link-lib=android");
        println!("cargo:rustc-link-lib=jnigraphics");
        println!("cargo:rustc-link-lib=mediandk");
        println!("cargo:rustc-link-lib=c++_static");
        println!("cargo:rustc-link-lib=c++abi");
    }

    tauri_build::build()
}
