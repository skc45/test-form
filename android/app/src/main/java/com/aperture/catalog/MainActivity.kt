package com.aperture.catalog

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import androidx.core.content.FileProvider
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
    private var pendingDownload: Pair<String, String>? = null
    private var pendingOpenDownloads = false

    private val requestDownloads = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val granted = store.downloadsPermissions().all { permission ->
            result[permission] == true || checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        }
        if (granted) onDownloadsGranted()
        else onDownloadsDenied()
    }

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
                        path == "/api/skin" && request.method == "GET" -> store.skinResponse()
                        path == "/api/interface" && request.method == "GET" -> store.interfaceResponse()
                        path == "/api/eth" && request.method == "GET" -> store.ethResponse()
                        path == "/api/posts" && request.method == "GET" -> store.postsResponse()
                        path.startsWith("/api/eth/nft/") -> {
                            val address = Uri.decode(path.removePrefix("/api/eth/nft/"))
                            store.nftResponse(address)
                        }
                        path == "/api/eth/shard" && request.method == "GET" -> {
                            val code = url.getQueryParameter("c") ?: url.getQueryParameter("code").orEmpty()
                            store.ethShardResponse(code)
                        }
                        path.startsWith("/media/eth/") -> {
                            val rel = Uri.decode(path.removePrefix("/media/eth/"))
                            store.ethMediaResponse(rel)
                        }
                        path.startsWith("/media/posts/") -> {
                            val rel = Uri.decode(path.removePrefix("/media/posts/"))
                            store.postMediaResponse(rel)
                        }
                        path == "/api/recent-cover" -> {
                            val index = url.getQueryParameter("i")?.toIntOrNull() ?: -1
                            val plate = url.getQueryParameter("p")?.toIntOrNull() ?: 0
                            store.recentCoverResponse(index, plate)
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

        @JavascriptInterface
        fun hasDownloadsAccess(): Boolean = store.hasDownloadsAccess()

        @JavascriptInterface
        fun requestDownloads() {
            runOnUiThread {
                startDownloadsPermission()
            }
        }

        @JavascriptInterface
        fun openDownloads() {
            runOnUiThread {
                startDownloadsPermission(openAfter = true)
            }
        }

        @JavascriptInterface
        fun download(url: String, filename: String) {
            runOnUiThread {
                if (!store.hasDownloadsAccess()) {
                    pendingDownload = url to filename
                    startDownloadsPermission()
                    return@runOnUiThread
                }
                startDownload(url, filename)
            }
        }

        @JavascriptInterface
        fun share(url: String, filename: String, caption: String) {
            runOnUiThread {
                startShare(url, filename, caption)
            }
        }

        @JavascriptInterface
        fun savePost(url: String, filename: String, title: String, caption: String): String {
            return store.savePost(url, filename, title, caption).toString()
        }

        @JavascriptInterface
        fun posts(): String {
            return store.postsListing().toString()
        }

        @JavascriptInterface
        fun attachPostNft(file: String, json: String): String {
            return store.attachPostNft(file, json).toString()
        }

        @JavascriptInterface
        fun loadSkin(): String {
            return store.loadSkin()
        }

        @JavascriptInterface
        fun saveSkin(json: String): String {
            return store.saveSkin(json).toString()
        }

        @JavascriptInterface
        fun loadInterface(): String {
            return store.loadInterface()
        }

        @JavascriptInterface
        fun saveInterface(json: String): String {
            return store.saveInterface(json).toString()
        }

        @JavascriptInterface
        fun ethShard(): String {
            return store.ethShard().toString()
        }

        @JavascriptInterface
        fun ethOpen(code: String): String {
            return store.ethOpen(code).toString()
        }

        @JavascriptInterface
        fun ethEncode(url: String, filename: String, title: String): String {
            return store.ethEncode(url, filename, title).toString()
        }

        @JavascriptInterface
        fun ethEncodeFolder(): String {
            return store.ethEncodeFolder().toString()
        }

        @JavascriptInterface
        fun shareEth() {
            runOnUiThread {
                startShareEth()
            }
        }

        @JavascriptInterface
        fun setChrome(color: String) {
            runOnUiThread {
                applyChrome(color)
            }
        }
    }

    private fun startDownloadsPermission(openAfter: Boolean = false) {
        if (openAfter) pendingOpenDownloads = true
        if (store.hasDownloadsAccess()) {
            onDownloadsGranted()
            return
        }
        val needed = store.downloadsPermissions().filter { permission ->
            checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isEmpty()) {
            onDownloadsGranted()
            return
        }
        requestDownloads.launch(needed.toTypedArray())
    }

    private fun onDownloadsGranted() {
        notifyDownloads(true)
        val pending = pendingDownload
        pendingDownload = null
        if (pending != null) startDownload(pending.first, pending.second)
        if (pendingOpenDownloads) {
            pendingOpenDownloads = false
            if (store.openDownloads()) notifyCatalog()
        }
    }

    private fun onDownloadsDenied() {
        pendingOpenDownloads = false
        pendingDownload = null
        notifyDownloads(false)
        notifyDownload(-1)
    }

    private fun notifyDownloads(granted: Boolean) {
        webView.evaluateJavascript(
            "window.apertureDownloadsPermission && window.apertureDownloadsPermission(${if (granted) "true" else "false"})",
            null,
        )
    }

    private fun startDownload(url: String, filename: String) {
        notifyDownload(4)
        Thread {
            val ok = try {
                store.download(url, filename) { pct -> notifyDownload(pct) }
            } catch (_: Exception) {
                false
            }
            notifyDownload(if (ok) 100 else -1)
        }.start()
    }

    private fun notifyDownload(pct: Int) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.apertureDownloadProgress && window.apertureDownloadProgress($pct)",
                null,
            )
        }
    }

    private fun notifyPost(pct: Int) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.aperturePostProgress && window.aperturePostProgress($pct)",
                null,
            )
        }
    }

    private fun startShare(url: String, filename: String, caption: String) {
        notifyPost(6)
        Thread {
            val safe = filename.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._-]+"), "_").ifBlank { "plate.jpg" }
            val dest = java.io.File(cacheDir, "share/$safe")
            val ok = try {
                store.exportToFile(url, dest) { pct -> notifyPost(pct) }
            } catch (_: Exception) {
                false
            }
            if (!ok || !dest.exists()) {
                notifyPost(-1)
                return@Thread
            }
            runOnUiThread {
                val uri = FileProvider.getUriForFile(this, "$packageName.files", dest)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = CatalogStore.mimeFor(safe)
                    clipData = android.content.ClipData.newUri(contentResolver, "plate", uri)
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_TEXT, caption)
                    putExtra(Intent.EXTRA_SUBJECT, caption.ifBlank { safe })
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(Intent.createChooser(send, "Send plate"))
                notifyPost(100)
            }
        }.start()
    }

    private fun startShareEth() {
        Thread {
            val dest = try {
                store.writeEthShardFile()
            } catch (_: Exception) {
                null
            }
            if (dest == null || !dest.exists()) return@Thread
            runOnUiThread {
                val uri = FileProvider.getUriForFile(this, "$packageName.files", dest)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "application/json"
                    clipData = android.content.ClipData.newUri(contentResolver, "eth", uri)
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, "Aperture Ethereum shard")
                    putExtra(Intent.EXTRA_TEXT, "Ethereum shard index for Aperture plates.")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(Intent.createChooser(send, "Share Ethereum shard"))
            }
        }.start()
    }

    private fun applyChrome(color: String) {
        val parsed = try {
            Color.parseColor(color)
        } catch (_: Exception) {
            return
        }
        window.statusBarColor = parsed
        window.navigationBarColor = parsed
        webView.setBackgroundColor(parsed)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
    }
}
