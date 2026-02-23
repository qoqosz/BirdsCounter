package com.birdscounter.app

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.graphics.Rect
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.content.Intent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : TauriActivity() {
    private var webView: WebView? = null
    private var currentPhotoUri: Uri? = null
    private val gestureExclusionRects = mutableListOf<Rect>()
    
    private lateinit var cameraLauncher: ActivityResultLauncher<Intent>
    private lateinit var permissionLauncher: ActivityResultLauncher<String>
    
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        
        // Register camera launcher before super.onCreate()
        cameraLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            if (result.resultCode == RESULT_OK) {
                currentPhotoUri?.let { uri ->
                    sendImageToWebView(uri)
                }
            } else {
                // User cancelled - send null result
                webView?.post {
                    webView?.evaluateJavascript("if(window.onCameraResult) window.onCameraResult(null);", null)
                }
            }
        }
        
        // Register permission launcher
        permissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { isGranted ->
            if (isGranted) {
                launchCamera()
            } else {
                webView?.post {
                    webView?.evaluateJavascript(
                        "if(window.onCameraResult) window.onCameraResult(null); alert('Camera permission is required to take photos.');",
                        null
                    )
                }
            }
        }
        
        super.onCreate(savedInstanceState)
        configureBackGestureExclusion()
    }
    
    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
        webView.addJavascriptInterface(CameraInterface(), "Android")
        applySystemAccentToWebView()
    }
    
    private fun hasCameraPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
    }
    
    private fun launchCamera() {
        val takePictureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        
        val photoFile: File? = try {
            createImageFile()
        } catch (ex: IOException) {
            null
        }
        
        if (photoFile == null) {
            webView?.post {
                webView?.evaluateJavascript(
                    "if(window.onCameraResult) window.onCameraResult(null); alert('Could not create image file.');",
                    null
                )
            }
            return
        }
        
        currentPhotoUri = FileProvider.getUriForFile(
            this,
            "${packageName}.fileprovider",
            photoFile
        )
        takePictureIntent.putExtra(MediaStore.EXTRA_OUTPUT, currentPhotoUri)
        
        try {
            cameraLauncher.launch(takePictureIntent)
        } catch (e: android.content.ActivityNotFoundException) {
            webView?.post {
                webView?.evaluateJavascript(
                    "if(window.onCameraResult) window.onCameraResult(null); alert('No camera app available.');",
                    null
                )
            }
        }
    }
    
    @Throws(IOException::class)
    private fun createImageFile(): File {
        val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val imageFileName = "JPEG_${timeStamp}_"
        val storageDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES)
        return File.createTempFile(imageFileName, ".jpg", storageDir)
    }
    
    private fun sendImageToWebView(uri: Uri) {
        try {
            contentResolver.openInputStream(uri)?.use { inputStream ->
                val bytes = inputStream.readBytes()
                val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val dataUrl = "data:image/jpeg;base64,$base64"
                
                webView?.post {
                    webView?.evaluateJavascript(
                        "if(window.onCameraResult) window.onCameraResult('$dataUrl');",
                        null
                    )
                }
            }
        } catch (e: Exception) {
            webView?.post {
                webView?.evaluateJavascript(
                    "if(window.onCameraResult) window.onCameraResult(null); console.error('Failed to read captured image');",
                    null
                )
            }
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
            runOnUiThread {
                if (hasCameraPermission()) {
                    launchCamera()
                } else {
                    permissionLauncher.launch(Manifest.permission.CAMERA)
                }
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
