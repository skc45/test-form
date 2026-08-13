package com.aperture.catalog

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var store: CatalogStore
    private lateinit var assetLoader: WebViewAssetLoader
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val pickFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        if (uri != null) {
            store.openTree(uri)
            notifyCatalog()
        }
    }

    private val pickFiles = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents(),
    ) { uris ->
        filePathCallback?.onReceiveValue(uris.toTypedArray())
        filePathCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.parseColor("#1C5FA8")
        window.navigationBarColor = Color.parseColor("#1C5FA8")
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        store = CatalogStore(this)
        store.restore()

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#1C5FA8"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = false
            settings.textZoom = 100
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            addJavascriptInterface(ApertureBridge(), "ApertureAndroid")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    val url = request.url
                    if (url.host != HOST) return super.shouldInterceptRequest(view, request)
                    val path = url.path ?: return assetLoader.shouldInterceptRequest(url)
                    return when {
                        path == "/api/catalog" -> store.catalogResponse()
                        path == "/api/cache" && request.method == "GET" -> store.cacheResponse()
                        path == "/api/cache" && request.method == "DELETE" -> {
                            store.forget()
                            store.cacheResponse()
                        }
                        path == "/api/recent-cover" -> {
                            val index = url.getQueryParameter("i")?.toIntOrNull() ?: -1
                            store.recentCoverResponse(index)
                        }
                        path.startsWith("/media/") -> {
                            val rel = Uri.decode(path.removePrefix("/media/"))
                            store.mediaResponse(rel)
                        }
                        else -> assetLoader.shouldInterceptRequest(url)
                    }
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView?,
                    callback: ValueCallback<Array<Uri>>?,
                    params: FileChooserParams?,
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = callback
                    pickFiles.launch("image/*")
                    return true
                }
            }
        }
        setContentView(webView)
        webView.loadUrl("https://$HOST/assets/www/index.html?mode=app")

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    webView.evaluateJavascript("window.apertureHandleBack && window.apertureHandleBack()") { result ->
                        if (result != "true" && result != "\"true\"") {
                            finish()
                        }
                    }
                }
            },
        )
    }

    private fun notifyCatalog() {
        webView.evaluateJavascript(
            "window.dispatchEvent(new Event('aperture-native-catalog'))",
            null,
        )
    }

    inner class ApertureBridge {
        @JavascriptInterface
        fun openFolder() {
            runOnUiThread {
                pickFolder.launch(null)
            }
        }

        @JavascriptInterface
        fun openRecent(index: Int) {
            openRecents(JSONArray().put(index).toString())
        }

        @JavascriptInterface
        fun openRecents(indexesJson: String) {
            runOnUiThread {
                val indexes = try {
                    val arr = org.json.JSONArray(indexesJson)
                    IntArray(arr.length()) { arr.getInt(it) }
                } catch (_: Exception) {
                    intArrayOf()
                }
                if (!store.openRecents(indexes)) {
                    pickFolder.launch(null)
                } else {
                    notifyCatalog()
                }
            }
        }

        @JavascriptInterface
        fun isNative(): Boolean = true
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
    }
}
