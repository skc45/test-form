package com.aperture.catalog

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
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
    private var pickingVault = false
    private var pageReady = false
    private var pendingIncoming: Uri? = null

    private val requestWrite = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val pending = pendingDownload
        pendingDownload = null
        if (granted && pending != null) startDownload(pending.first, pending.second)
        else notifyDownload(-1)
    }

    private val pickFolder = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        val vault = pickingVault
        pickingVault = false
        if (uri != null) {
            if (vault) {
                store.openVaultTree(uri)
                notifyVault()
            } else {
                store.openTree(uri)
                notifyCatalog()
            }
        }
    }

    private val pickFiles = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents(),
    ) { uris ->
        filePathCallback?.onReceiveValue(uris.toTypedArray())
        filePathCallback = null
    }

    private val pickSync = registerForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        Thread {
            val data = try {
                store.receiveSyncUri(uri)
            } catch (_: Exception) {
                org.json.JSONObject().put("ok", false)
            }
            runOnUiThread {
                if (data.optBoolean("ok")) notifyVault()
                else notifySyncError()
            }
        }.start()
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
                        path == "/api/chain" && request.method == "GET" -> store.chainResponse()
                        path == "/api/vault" && request.method == "GET" -> store.vaultResponse()
                        path == "/api/sync" && request.method == "GET" -> store.syncResponse()
                        path == "/api/skin" && request.method == "GET" -> store.skinResponse()
                        path.startsWith("/media/vault/") -> {
                            val rel = Uri.decode(path.removePrefix("/media/vault/"))
                            store.vaultMediaResponse(rel)
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

                override fun onPageFinished(view: WebView?, url: String?) {
                    pageReady = true
                    pendingIncoming?.let { uri ->
                        pendingIncoming = null
                        importIncoming(uri)
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
        handleIncoming(intent)

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

    private fun notifyVault() {
        webView.evaluateJavascript(
            "window.dispatchEvent(new Event('aperture-native-vault'))",
            null,
        )
    }

    private fun notifySyncError() {
        webView.evaluateJavascript(
            "window.dispatchEvent(new Event('aperture-native-sync-error'))",
            null,
        )
    }

    inner class ApertureBridge {
        @JavascriptInterface
        fun openFolder() {
            runOnUiThread {
                pickingVault = false
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
                    pickingVault = false
                    pickFolder.launch(null)
                } else {
                    notifyCatalog()
                }
            }
        }

        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun download(url: String, filename: String) {
            runOnUiThread {
                if (Build.VERSION.SDK_INT < 29 &&
                    checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
                ) {
                    pendingDownload = url to filename
                    requestWrite.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
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
        fun chainAppend(title: String, caption: String, file: String, imageHash: String): String {
            return store.chainAppend(title, caption, file, imageHash).toString()
        }

        @JavascriptInterface
        fun chainLock(url: String, filename: String, blockJson: String): String {
            return store.chainLock(url, filename, blockJson).toString()
        }

        @JavascriptInterface
        fun openBlockchainFolder() {
            runOnUiThread {
                pickingVault = true
                pickFolder.launch(null)
            }
        }

        @JavascriptInterface
        fun encodeFolder(): String {
            return store.encodeFolder().toString()
        }

        @JavascriptInterface
        fun shareSync() {
            runOnUiThread {
                startShareSync()
            }
        }

        @JavascriptInterface
        fun receiveSync() {
            runOnUiThread {
                pickSync.launch("*/*")
            }
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
        fun setChrome(color: String) {
            runOnUiThread {
                applyChrome(color)
            }
        }
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

    private fun startShareSync() {
        Thread {
            val dest = try {
                store.writeSyncPack()
            } catch (_: Exception) {
                null
            }
            if (dest == null || !dest.exists()) {
                notifySyncError()
                return@Thread
            }
            runOnUiThread {
                val uri = FileProvider.getUriForFile(this, "$packageName.files", dest)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "application/octet-stream"
                    clipData = android.content.ClipData.newUri(contentResolver, "sync", uri)
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, "Aperture chain sync")
                    putExtra(Intent.EXTRA_TEXT, "Receive this pack in Aperture with Receive sync.")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(Intent.createChooser(send, "Send chain"))
            }
        }.start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncoming(intent)
    }

    private fun incomingUri(intent: Intent?): Uri? {
        if (intent == null) return null
        return when (intent.action) {
            Intent.ACTION_SEND -> {
                if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
            }
            Intent.ACTION_VIEW -> intent.data
            else -> null
        }
    }

    private fun handleIncoming(intent: Intent?) {
        val uri = incomingUri(intent) ?: return
        if (pageReady) importIncoming(uri) else pendingIncoming = uri
    }

    private fun importIncoming(uri: Uri) {
        Thread {
            val data = try {
                store.receiveSyncUri(uri)
            } catch (_: Exception) {
                org.json.JSONObject().put("ok", false)
            }
            runOnUiThread {
                if (data.optBoolean("ok")) notifyVault()
                else notifySyncError()
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
