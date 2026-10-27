package com.birdscounter.app

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.graphics.Rect
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.content.Intent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : TauriActivity() {
    companion object {
        // Home screen quick actions (see setQuickActions)
        const val ACTION_TAKE_PHOTO = "com.birdscounter.app.TAKE_PHOTO"
        const val ACTION_CHOOSE_PHOTO = "com.birdscounter.app.CHOOSE_PHOTO"
        // Photos the app takes start with this; the Rust history deletes only those files.
        private const val PHOTO_PREFIX = "BirdsCounter_"
        private const val STATE_PHOTO_FILE = "photoFile"
    }

    private var webView: WebView? = null
    private var currentPhotoFile: File? = null
    private val gestureExclusionRects = mutableListOf<Rect>()

    // Result for the page, as JSON: {"image": {...}} or {"error": "<code>"}. It waits here
    // until the page takes it, so a photo taken while the page is still loading (or was
    // reloaded) is not lost.
    private val pendingLock = Any()
    private var pendingResult: String? = null

    private lateinit var cameraLauncher: ActivityResultLauncher<Intent>
    private lateinit var permissionLauncher: ActivityResultLauncher<String>
    private lateinit var pickerLauncher: ActivityResultLauncher<PickVisualMediaRequest>

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        currentPhotoFile = savedInstanceState?.getString(STATE_PHOTO_FILE)?.let { File(it) }

        // Register launchers before super.onCreate()
        cameraLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val file = currentPhotoFile
            currentPhotoFile = null
            if (file == null) return@registerForActivityResult
            if (result.resultCode == RESULT_OK && file.length() > 0) {
                deliverImage(Uri.fromFile(file), "file:${file.absolutePath}", file.name, owned = true)
            } else {
                file.delete()
            }
        }

        pickerLauncher = registerForActivityResult(
            ActivityResultContracts.PickVisualMedia()
        ) { uri ->
            if (uri == null) return@registerForActivityResult
            // Lets the history open the photo again after a restart, instead of keeping a copy.
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (e: SecurityException) {
                // The photo still opens now; the history may just not reopen it later.
            }
            deliverImage(uri, uri.toString(), displayName(uri), owned = false)
        }

        permissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { isGranted ->
            if (isGranted) {
                launchCamera()
            } else {
                deliverResult(JSONObject().put("error", "camera-denied"))
            }
        }

        super.onCreate(savedInstanceState)
        configureBackGestureExclusion()
        if (savedInstanceState == null) {
            handleQuickAction(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleQuickAction(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // The system may destroy the activity while the camera app is open.
        currentPhotoFile?.let { outState.putString(STATE_PHOTO_FILE, it.absolutePath) }
    }

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
        webView.addJavascriptInterface(CameraInterface(), "Android")
        applySystemAccentToWebView()
    }

    private fun handleQuickAction(intent: Intent?) {
        when (intent?.action) {
            ACTION_TAKE_PHOTO -> openCamera()
            ACTION_CHOOSE_PHOTO -> openPicker()
            Intent.ACTION_SEND -> handleSharedPhoto(intent)
        }
    }

    // A photo shared from another app. The grant on its Uri ends with this task, so the photo
    // is copied into the app's pictures folder, where the history can open it again.
    private fun handleSharedPhoto(intent: Intent) {
        val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        }
        if (uri == null) {
            deliverResult(JSONObject().put("error", "photo-unreadable"))
            return
        }
        // Handle each Intent once, not again when the activity is recreated.
        intent.action = null
        Thread {
            try {
                val file = createImageFile()
                val copied = contentResolver.openInputStream(uri)?.use { input ->
                    file.outputStream().use { input.copyTo(it) }
                    true
                } ?: false
                if (!copied || file.length() == 0L) {
                    file.delete()
                    deliverResult(JSONObject().put("error", "photo-unreadable"))
                    return@Thread
                }
                runOnUiThread {
                    deliverImage(Uri.fromFile(file), "file:${file.absolutePath}", file.name, owned = true)
                }
            } catch (e: Exception) {
                deliverResult(JSONObject().put("error", "photo-unreadable"))
            }
        }.start()
    }

    private fun hasCameraPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun openCamera() {
        if (hasCameraPermission()) {
            launchCamera()
        } else {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun openPicker() {
        pickerLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    private fun launchCamera() {
        val photoFile = try {
            createImageFile()
        } catch (e: Exception) {
            deliverResult(JSONObject().put("error", "camera-unavailable"))
            return
        }

        val photoUri = FileProvider.getUriForFile(
            this,
            "${packageName}.fileprovider",
            photoFile
        )
        val takePictureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri)

        currentPhotoFile = photoFile
        try {
            cameraLauncher.launch(takePictureIntent)
        } catch (e: android.content.ActivityNotFoundException) {
            currentPhotoFile = null
            photoFile.delete()
            deliverResult(JSONObject().put("error", "camera-unavailable"))
        }
    }

    // App-specific pictures folder: the photo stays there for the history, without
    // storage permissions, and is removed with the app.
    private fun createImageFile(): File {
        val storageDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES)
            ?: throw IllegalStateException("No pictures folder")
        storageDir.mkdirs()
        val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        var file = File(storageDir, "${PHOTO_PREFIX}${timeStamp}.jpg")
        var n = 1
        while (file.exists()) {
            file = File(storageDir, "${PHOTO_PREFIX}${timeStamp}_${n++}.jpg")
        }
        file.createNewFile()
        return file
    }

    private fun displayName(uri: Uri): String? {
        return try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun readBase64(uri: Uri): String? {
        return try {
            contentResolver.openInputStream(uri)?.use { input ->
                Base64.encodeToString(input.readBytes(), Base64.NO_WRAP)
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun deliverImage(uri: Uri, source: String, name: String?, owned: Boolean) {
        Thread {
            val data = readBase64(uri)
            if (data == null) {
                deliverResult(JSONObject().put("error", "photo-unreadable"))
                return@Thread
            }
            val image = JSONObject()
                .put("data", data)
                .put("mime", contentResolver.getType(uri) ?: "image/jpeg")
                .put("source", source)
                .put("name", name ?: JSONObject.NULL)
                .put("owned", owned)
            deliverResult(JSONObject().put("image", image))
        }.start()
    }

    private fun deliverResult(result: JSONObject) {
        synchronized(pendingLock) {
            pendingResult = result.toString()
        }
        webView?.post {
            webView?.evaluateJavascript(
                "if (window.onNativeImageReady) window.onNativeImageReady();",
                null
            )
        }
    }

    private fun applySystemAccentToWebView() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return

        val accent400 = colorToHex(ContextCompat.getColor(this, android.R.color.system_accent1_400))
        val accent500 = colorToHex(ContextCompat.getColor(this, android.R.color.system_accent1_500))
        val accent600 = colorToHex(ContextCompat.getColor(this, android.R.color.system_accent1_600))

        val js = """
            (function () {
                var root = document.documentElement;
                if (!root) return;
                root.style.setProperty('--system-accent', '$accent500');
                root.style.setProperty('--system-accent-hover', '$accent400');
                root.style.setProperty('--system-accent-active', '$accent600');
            })();
        """.trimIndent()

        webView?.post {
            webView?.evaluateJavascript(js, null)
        }
    }

    private fun colorToHex(color: Int): String {
        val r = (color shr 16) and 0xFF
        val g = (color shr 8) and 0xFF
        val b = color and 0xFF
        return String.format("#%02X%02X%02X", r, g, b)
    }

    private fun configureBackGestureExclusion() {
        val rootView = window.decorView.findViewById<android.view.View>(android.R.id.content)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return

        ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
            updateGestureExclusionRects(view, insets)
            insets
        }

        rootView.post {
            updateGestureExclusionRects(rootView, ViewCompat.getRootWindowInsets(rootView))
        }
    }

    private fun updateGestureExclusionRects(view: android.view.View, insets: WindowInsetsCompat?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val systemInsets = insets?.getInsets(WindowInsetsCompat.Type.systemGestures())
        val edgeWidth = maxOf(dpToPx(48), systemInsets?.left ?: 0, systemInsets?.right ?: 0)
        if (view.width == 0 || view.height == 0 || edgeWidth == 0) return

        gestureExclusionRects.clear()
        gestureExclusionRects.add(Rect(0, 0, edgeWidth, view.height))
        gestureExclusionRects.add(Rect(view.width - edgeWidth, 0, view.width, view.height))
        view.systemGestureExclusionRects = gestureExclusionRects
    }

    private fun dpToPx(dp: Int): Int {
        return (dp * resources.displayMetrics.density).toInt()
    }

    inner class CameraInterface {
        @JavascriptInterface
        fun openCamera() {
            runOnUiThread { this@MainActivity.openCamera() }
        }

        @JavascriptInterface
        fun pickImage() {
            runOnUiThread { openPicker() }
        }

        // The last camera or picker result, once (see pendingResult).
        @JavascriptInterface
        fun takePendingResult(): String? {
            synchronized(pendingLock) {
                val result = pendingResult
                pendingResult = null
                return result
            }
        }

        // Photo of a history entry as base64, or null when it is gone or no longer readable.
        @JavascriptInterface
        fun readImage(source: String): String? {
            val uri = when {
                source.startsWith("content://") -> Uri.parse(source)
                source.startsWith("file:") -> Uri.fromFile(File(source.removePrefix("file:")))
                else -> return null
            }
            return readBase64(uri)
        }

        // JSON array of {"type", "title"}, titled in the app's language by the page.
        @JavascriptInterface
        fun setQuickActions(json: String) {
            val items = try {
                JSONArray(json)
            } catch (e: Exception) {
                return
            }
            val shortcuts = (0 until items.length()).mapNotNull { i ->
                val item = items.optJSONObject(i) ?: return@mapNotNull null
                val type = item.optString("type")
                val (action, icon) = when (type) {
                    "take-photo" -> ACTION_TAKE_PHOTO to R.drawable.ic_shortcut_camera
                    "choose-photo" -> ACTION_CHOOSE_PHOTO to R.drawable.ic_shortcut_photo
                    else -> return@mapNotNull null
                }
                ShortcutInfoCompat.Builder(this@MainActivity, type)
                    .setShortLabel(item.optString("title", type))
                    .setIcon(IconCompat.createWithResource(this@MainActivity, icon))
                    .setIntent(Intent(action).setClass(this@MainActivity, MainActivity::class.java))
                    .build()
            }
            try {
                ShortcutManagerCompat.setDynamicShortcuts(this@MainActivity, shortcuts)
            } catch (e: Exception) {
                // Rate limited or not supported by the launcher
            }
        }

        @JavascriptInterface
        fun getSystemAccentPalette(): String? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null

            val accent400 = colorToHex(ContextCompat.getColor(this@MainActivity, android.R.color.system_accent1_400))
            val accent500 = colorToHex(ContextCompat.getColor(this@MainActivity, android.R.color.system_accent1_500))
            val accent600 = colorToHex(ContextCompat.getColor(this@MainActivity, android.R.color.system_accent1_600))

            return "{\"accent\":\"$accent500\",\"hover\":\"$accent400\",\"active\":\"$accent600\"}"
        }
    }
}
