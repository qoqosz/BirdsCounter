android:
	./build_android.sh --target aarch64
	cp src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk .

mac:
	cargo tauri dev
