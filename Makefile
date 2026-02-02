android:
	cargo tauri android build --apk true --target aarch64
	cp /Users/qoqosz/Documents/Coding/Rust/BirdsCounter/BirdsCounter/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk /Users/qoqosz/Library/CloudStorage/Dropbox/Public/app-universal-release.apk

mac:
	cargo tauri dev
