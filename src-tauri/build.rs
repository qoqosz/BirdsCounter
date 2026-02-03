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
        println!(
            "cargo:rustc-link-search=native={}/3rdparty/libs/{}",
            opencv_sdk, abi
        );

        // Link 3rd party dependencies (order matters for static linking)
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
            "kleidicv",
            "kleidicv_hal",
            "kleidicv_thread",
            "ittnotify",
        ];

        for lib in &third_party_libs {
            println!("cargo:rustc-link-lib=static={}", lib);
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
