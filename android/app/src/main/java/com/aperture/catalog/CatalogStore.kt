package com.aperture.catalog

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.WebResourceResponse
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Calendar
import java.util.Locale
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class CatalogStore(private val context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("aperture_cache", Context.MODE_PRIVATE)
    private val photos = mutableListOf<JSONObject>()
    private val media = linkedMapOf<String, Pair<Uri, String>>()
    private val currentTrees = mutableListOf<Uri>()

    fun restore() {
        val raw = prefs.getString(KEY_URI, "").orEmpty()
        if (raw.isBlank()) return
        val uri = Uri.parse(raw)
        if (!hasPermission(uri)) return
        scan(uri)
    }

    fun forget() {
        rememberedUris().forEach { raw ->
            try {
                context.contentResolver.releasePersistableUriPermission(
                    Uri.parse(raw),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            } catch (_: SecurityException) {
            }
        }
        prefs.edit().clear().apply()
        photos.clear()
        media.clear()
        currentTrees.clear()
    }

    fun openTree(uri: Uri) {
        context.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        val name = DocumentFile.fromTreeUri(context, uri)?.name ?: "Folder"
        prefs.edit()
            .putString(KEY_URI, uri.toString())
            .putString(KEY_NAME, name)
            .putLong(KEY_OPENED, System.currentTimeMillis())
            .apply()
        scan(uri)
        upsertRecent(uri, name, photos.size)
    }

    fun openRecent(index: Int): Boolean {
        return openRecents(intArrayOf(index))
    }

    fun openRecents(indexes: IntArray): Boolean {
        val recents = recentsArray()
        val trees = linkedMapOf<String, Uri>()
        for (index in indexes) {
            if (index < 0 || index >= recents.length()) continue
            val item = recents.getJSONObject(index)
            val raw = item.optString("path").ifBlank { item.optString("id") }
            if (raw.isBlank()) continue
            val uri = Uri.parse(raw)
            if (!hasPermission(uri)) continue
            trees[raw] = uri
        }
        if (trees.isEmpty()) return false
        val uris = trees.values.toList()
        val names = uris.map { DocumentFile.fromTreeUri(context, it)?.name ?: "Folder" }
        prefs.edit()
            .putString(KEY_URI, uris.first().toString())
            .putString(KEY_NAME, names.joinToString(" + "))
            .putLong(KEY_OPENED, System.currentTimeMillis())
            .apply()
        scanTrees(uris)
        return true
    }

    fun catalogResponse(): WebResourceResponse {
        val name = prefs.getString(KEY_NAME, "").orEmpty()
        val path = prefs.getString(KEY_URI, "").orEmpty()
        val body = JSONObject()
            .put("folder", name)
            .put("path", currentTrees.firstOrNull()?.toString() ?: path)
            .put("paths", JSONArray(currentTrees.map { it.toString() }))
            .put("app", true)
            .put("cached", path.isNotBlank())
            .put("photos", JSONArray(photos))
            .put("recents", decoratedRecents())
        return json(body)
    }

    fun cacheResponse(): WebResourceResponse {
        val path = prefs.getString(KEY_URI, "").orEmpty()
        val body = JSONObject()
            .put("lastFolder", path)
            .put("lastFolderName", prefs.getString(KEY_NAME, "").orEmpty())
            .put("photoCount", photos.size)
            .put("source", if (path.isBlank()) "demo" else "folder")
            .put("updatedAt", prefs.getLong(KEY_OPENED, 0L).takeIf { it > 0 }?.let { java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(it) } ?: "")
            .put("exists", path.isNotBlank() && hasPermission(Uri.parse(path)))
            .put("recents", decoratedRecents())
        return json(body)
    }

    fun recentCoverResponse(index: Int, plate: Int = 0): WebResourceResponse {
        val recents = recentsArray()
        if (index < 0 || index >= recents.length()) return notFound()
        val raw = recents.getJSONObject(index).optString("path").ifBlank {
            recents.getJSONObject(index).optString("id")
        }
        if (raw.isBlank()) return notFound()
        val safePlate = plate.coerceAtLeast(0)
        val current = prefs.getString(KEY_URI, "").orEmpty()
        if (raw == current && photos.isNotEmpty() && currentTrees.size <= 1) {
            val photo = photos.getOrNull(safePlate.coerceAtMost(photos.lastIndex)) ?: return notFound()
            return mediaResponse(photo.optString("id"))
        }
        val uri = Uri.parse(raw)
        if (!hasPermission(uri)) return notFound()
        val root = DocumentFile.fromTreeUri(context, uri) ?: return notFound()
        val cover = nthImage(root, safePlate) ?: return notFound()
        val stream = context.contentResolver.openInputStream(cover.uri) ?: return notFound()
        return WebResourceResponse(
            mimeFor(cover.name ?: "cover.jpg"),
            null,
            200,
            "OK",
            mapOf("Cache-Control" to "public, max-age=60"),
            stream,
        )
    }

    fun mediaResponse(rel: String): WebResourceResponse {
        val key = listOf(rel, Uri.decode(rel)).firstOrNull { media.containsKey(it) }
        val entry = key?.let { media[it] } ?: return notFound()
        val stream = context.contentResolver.openInputStream(entry.first) ?: return notFound()
        val headers = mutableMapOf(
            "Cache-Control" to "public, max-age=60",
        )
        context.contentResolver.openAssetFileDescriptor(entry.first, "r")?.use { afd ->
            if (afd.length >= 0) headers["Content-Length"] = afd.length.toString()
        }
        return WebResourceResponse(
            entry.second,
            null,
            200,
            "OK",
            headers,
            stream,
        )
    }

    private fun scan(tree: Uri) {
        scanTrees(listOf(tree))
    }

    private fun scanTrees(trees: List<Uri>) {
        photos.clear()
        media.clear()
        currentTrees.clear()
        currentTrees.addAll(trees)
        val multi = trees.size > 1
        trees.forEachIndexed { index, tree ->
            val root = DocumentFile.fromTreeUri(context, tree) ?: return@forEachIndexed
            val folderName = root.name ?: "Folder"
            walk(root, folderName, "", if (multi) "$index/" else "")
        }
        photos.forEachIndexed { index, photo ->
            photo.put("index", index)
            photo.put("featured", index == 0)
        }
        prefs.edit().putInt(KEY_COUNT, photos.size).apply()
    }

    private fun walk(dir: DocumentFile, folderName: String, prefix: String, idPrefix: String = "") {
        val children = dir.listFiles().sortedBy { it.name?.lowercase(Locale.US) ?: "" }
        for (child in children) {
            val name = child.name ?: continue
            if (child.isDirectory) {
                if (name.equals("blockchain", ignoreCase = true)) continue
                val next = if (prefix.isEmpty()) name else "$prefix/$name"
                walk(child, folderName, next, idPrefix)
                continue
            }
            if (!isImage(name)) continue
            val rel = if (prefix.isEmpty()) name else "$prefix/$name"
            val key = idPrefix + rel
            val mime = mimeFor(name)
            media[key] = child.uri to mime
            val parent = if (prefix.contains("/")) prefix.substringAfterLast("/") else folderName
            val location = prefix.ifEmpty { folderName }
            val year = Calendar.getInstance().apply { timeInMillis = child.lastModified() }.get(Calendar.YEAR)
            val mediaPath = "/media/" + Uri.encode(key)
            photos += JSONObject()
                .put("id", key)
                .put("title", name.substringBeforeLast("."))
                .put("photographer", folderName)
                .put("location", location)
                .put("year", year)
                .put("category", slug(parent))
                .put("src", mediaPath)
                .put("thumb", mediaPath)
                .put("hero", mediaPath)
                .put("local", true)
                .put("featured", false)
        }
    }

    private fun recentsArray(): JSONArray {
        val raw = prefs.getString(KEY_RECENTS, "").orEmpty()
        if (raw.isBlank()) {
            val last = prefs.getString(KEY_URI, "").orEmpty()
            if (last.isBlank()) return JSONArray()
            return JSONArray().put(
                JSONObject()
                    .put("id", last)
                    .put("path", last)
                    .put("name", prefs.getString(KEY_NAME, "Folder"))
                    .put("photoCount", prefs.getInt(KEY_COUNT, photos.size))
                    .put("openedAt", prefs.getLong(KEY_OPENED, 0L))
                    .put("cover", ""),
            )
        }
        return try {
            JSONArray(raw)
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun decoratedRecents(): JSONArray {
        val recents = recentsArray()
        val out = JSONArray()
        val limit = minOf(recents.length(), MAX_RECENTS)
        for (index in 0 until limit) {
            val item = recents.getJSONObject(index)
            item.put("cover", "/api/recent-cover?i=$index&p=0")
            val rawCount = item.optInt("photoCount", 0)
            val count = (if (rawCount > 0) rawCount else MAX_RECENT_SLIDES).coerceIn(1, MAX_RECENT_SLIDES)
            val covers = JSONArray()
            for (plate in 0 until count) {
                covers.put("/api/recent-cover?i=$index&p=$plate")
            }
            item.put("covers", covers)
            out.put(item)
        }
        return out
    }

    private fun upsertRecent(uri: Uri, name: String, count: Int) {
        val id = uri.toString()
        val next = JSONObject()
            .put("id", id)
            .put("path", id)
            .put("name", name)
            .put("photoCount", count)
            .put("openedAt", System.currentTimeMillis())
            .put("cover", "")
        val existing = recentsArray()
        val out = JSONArray().put(next)
        for (index in 0 until existing.length()) {
            if (out.length() == MAX_RECENTS) break
            val item = existing.getJSONObject(index)
            val itemId = item.optString("id").ifBlank { item.optString("path") }
            if (itemId == id) continue
            out.put(item)
        }
        prefs.edit().putString(KEY_RECENTS, out.toString()).apply()
    }

    private fun rememberedUris(): List<String> {
        val uris = linkedSetOf<String>()
        prefs.getString(KEY_URI, "")?.takeIf { it.isNotBlank() }?.let { uris.add(it) }
        val recents = try {
            JSONArray(prefs.getString(KEY_RECENTS, "[]").orEmpty().ifBlank { "[]" })
        } catch (_: Exception) {
            JSONArray()
        }
        for (index in 0 until recents.length()) {
            recents.getJSONObject(index).optString("path").takeIf { it.isNotBlank() }?.let { uris.add(it) }
        }
        return uris.toList()
    }

    private fun collectImages(dir: DocumentFile, out: MutableList<DocumentFile>, limit: Int) {
        if (out.size >= limit) return
        val children = dir.listFiles().sortedBy { it.name?.lowercase(Locale.US) ?: "" }
        for (child in children) {
            if (out.size >= limit) return
            val name = child.name ?: continue
            if (child.isDirectory) {
                if (name.equals("blockchain", ignoreCase = true)) continue
                collectImages(child, out, limit)
                continue
            }
            if (isImage(name)) out += child
        }
    }

    private fun nthImage(dir: DocumentFile, plate: Int): DocumentFile? {
        val found = mutableListOf<DocumentFile>()
        collectImages(dir, found, plate + 1)
        return found.getOrNull(plate)
    }

    private fun firstImage(dir: DocumentFile): DocumentFile? {
        return nthImage(dir, 0)
    }

    fun skinResponse(): WebResourceResponse {
        return json(loadSkinObject().put("ok", true))
    }

    fun loadSkin(): String {
        val raw = prefs.getString(KEY_SKIN, "").orEmpty()
        return raw.ifBlank { "{}" }
    }

    fun saveSkin(raw: String): JSONObject {
        val data = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return JSONObject().put("ok", false)
        }
        if (data.optString("skyMid").isBlank() && data.optString("id").isBlank()) {
            return JSONObject().put("ok", false)
        }
        prefs.edit().putString(KEY_SKIN, data.toString()).apply()
        return data.put("ok", true)
    }

    private fun loadSkinObject(): JSONObject {
        return try {
            val raw = prefs.getString(KEY_SKIN, "").orEmpty()
            if (raw.isBlank()) JSONObject() else JSONObject(raw)
        } catch (_: Exception) {
            JSONObject()
        }
    }

    fun xrpResponse(): WebResourceResponse {
        return json(xrpLedger())
    }

    fun xrpLedger(): JSONObject {
        val plates = xrpPlates()
        return JSONObject()
            .put("ok", true)
            .put("catalogAddress", catalogXrpAddress())
            .put("count", plates.length())
            .put("plates", plates)
    }

    fun xrpEncode(url: String, filename: String, title: String): JSONObject {
        val dest = File(context.cacheDir, "xrp-in/${filename.substringAfterLast('/').ifBlank { "plate.jpg" }}")
        dest.parentFile?.mkdirs()
        if (!exportToFile(url, dest) { }) return JSONObject().put("ok", false)
        val bytes = dest.readBytes()
        return encodeXrpPlate(bytes, title.ifBlank { dest.nameWithoutExtension }, dest.name, mimeFor(dest.name))
    }

    fun xrpEncodeFolder(): JSONObject {
        var encoded = 0
        var skipped = 0
        media.values.forEach { entry ->
            val bytes = readUriBytes(entry.first) ?: run {
                skipped += 1
                return@forEach
            }
            if (bytes.isEmpty() || bytes.size > XRP_MAX_PLATE) {
                skipped += 1
                return@forEach
            }
            val name = DocumentFile.fromSingleUri(context, entry.first)?.name ?: "plate.jpg"
            val result = encodeXrpPlate(bytes, name.substringBeforeLast('.'), name, entry.second)
            if (result.optBoolean("ok")) encoded += 1 else skipped += 1
        }
        return xrpLedger().put("encoded", encoded).put("skipped", skipped)
    }

    fun writeXrpLedgerFile(): File {
        val dest = File(context.cacheDir, "share/Aperture-xrp.json")
        dest.parentFile?.mkdirs()
        dest.writeText(xrpLedger().toString())
        return dest
    }

    private fun encodeXrpPlate(plain: ByteArray, title: String, filename: String, mime: String): JSONObject {
        if (plain.isEmpty() || plain.size > XRP_MAX_PLATE) return JSONObject().put("ok", false)
        val secret = xrpSecret()
        val nonce = ByteArray(XRP_NONCE)
        SecureRandom().nextBytes(nonce)
        val imageHash = sha256(plain)
        val key = sha256(secret + nonce + imageHash)
        val cipher = xorSeal(plain, key)
        val tag = hmacSha256(sha256(XRP_LABEL + secret), nonce + imageHash + cipher)
        val envelope = XRP_MAGIC + byteArrayOf(XRP_VERSION) + nonce + imageHash + tag + cipher
        val address = plateXrpAddress(imageHash, secret)
        val catalog = catalogXrpAddress(secret)
        val cert = JSONObject()
            .put("v", 1)
            .put("kind", "aperture-xrp")
            .put("ledger", "xrpl")
            .put("title", title.ifBlank { "Plate" })
            .put("file", filename)
            .put("mime", mime.ifBlank { mimeFor(filename) })
            .put("imageHash", toHex(imageHash))
            .put("cipherHash", toHex(sha256(cipher)))
            .put("address", address)
            .put("tag", toHex(tag))
            .put("encodedAt", java.time.Instant.now().toString().take(19))
        val memoData = toHex(stableCertJson(cert).toByteArray(StandardCharsets.UTF_8))
        val memoType = toHex(XRP_MEMO_TYPE.toByteArray(StandardCharsets.UTF_8))
        val memoFormat = toHex("application/json".toByteArray(StandardCharsets.UTF_8))
        cert.put("memoType", memoType)
        cert.put("memoFormat", memoFormat)
        cert.put("memoData", memoData)
        cert.put(
            "tx",
            JSONObject()
                .put("TransactionType", "Payment")
                .put("Account", catalog)
                .put("Destination", address)
                .put("Amount", "1")
                .put(
                    "Memos",
                    JSONArray().put(
                        JSONObject().put(
                            "Memo",
                            JSONObject()
                                .put("MemoType", memoType)
                                .put("MemoFormat", memoFormat)
                                .put("MemoData", memoData),
                        ),
                    ),
                ),
        )
        cert.put("spot", encodeXrpSpot(imageHash, secret))
        val vault = File(xrpVaultDir(), "$address.apxr")
        vault.writeBytes(envelope)
        rememberXrpCertificate(cert)
        return JSONObject()
            .put("ok", true)
            .put("certificate", cert)
            .put("address", address)
            .put("catalogAddress", catalog)
            .put("vault", vault.name)
            .put("spot", cert.optString("spot"))
    }

    fun xrpDecode(code: String): JSONObject {
        return resolveSpot(code)
    }

    fun xrpSpotResponse(code: String): WebResourceResponse {
        return json(resolveSpot(code))
    }

    fun resolveSpot(code: String): JSONObject {
        val located = decodeXrpSpot(code) ?: return JSONObject().put("ok", false).put("error", "invalid spot")
        val cert = lookupXrpCertificate(located.optString("address"), located.optString("imageHash"))
        val decoded = decodeVault(located.optString("address"))
        located.put("certificate", cert ?: JSONObject())
        located.put("title", cert?.optString("title")?.ifBlank { "XRP plate" } ?: "XRP plate")
        located.put("file", cert?.optString("file") ?: "plate")
        located.put("mime", cert?.optString("mime") ?: "application/octet-stream")
        located.put("src", if (decoded != null) "/media/xrp/" + located.optString("address") else "")
        located.put("decoded", decoded != null)
        return located
    }

    fun xrpMediaResponse(address: String): WebResourceResponse {
        val decoded = decodeVault(address) ?: return notFound()
        val cert = lookupXrpCertificate(address, "")
        val mime = cert?.optString("mime").orEmpty().ifBlank { mimeFor(cert?.optString("file").orEmpty()) }
        return WebResourceResponse(
            mime,
            "UTF-8",
            200,
            "OK",
            mapOf("Cache-Control" to "no-store", "Content-Type" to mime),
            ByteArrayInputStream(decoded),
        )
    }

    private fun encodeXrpSpot(imageHash: ByteArray, secret: ByteArray): String {
        val dest = sha256(imageHash + XRP_PLATE + secret).copyOf(20)
        val catalog = sha256(XRP_CATALOG + secret).copyOf(20)
        val payload = dest + catalog + imageHash
        val nonce = ByteArray(XRP_NONCE)
        SecureRandom().nextBytes(nonce)
        val key = sha256(secret + nonce + SPOT_LABEL)
        val cipher = xorSeal(payload, key)
        val tag = hmacSha256(sha256(SPOT_LABEL + secret), nonce + cipher)
        val envelope = SPOT_MAGIC + byteArrayOf(XRP_VERSION) + nonce + tag + cipher
        return SPOT_PREFIX + b58encode(envelope)
    }

    private fun decodeXrpSpot(code: String): JSONObject? {
        var raw = code.trim()
        if (raw.lowercase().startsWith(SPOT_PREFIX)) raw = raw.substring(SPOT_PREFIX.length)
        val packed = b58decode(raw) ?: return null
        val header = 5 + XRP_NONCE + 32
        if (packed.size < header + SPOT_PAYLOAD) return null
        if (packed[0] != SPOT_MAGIC[0] || packed[1] != SPOT_MAGIC[1] || packed[2] != SPOT_MAGIC[2] || packed[3] != SPOT_MAGIC[3] || packed[4] != XRP_VERSION) {
            return null
        }
        val nonce = packed.copyOfRange(5, 5 + XRP_NONCE)
        val tag = packed.copyOfRange(5 + XRP_NONCE, header)
        val cipher = packed.copyOfRange(header, packed.size)
        val expected = hmacSha256(sha256(SPOT_LABEL + xrpSecret()), nonce + cipher)
        if (!expected.contentEquals(tag)) return null
        val payload = xorSeal(cipher, sha256(xrpSecret() + nonce + SPOT_LABEL))
        if (payload.size < SPOT_PAYLOAD) return null
        val address = classicXrpAddress(payload.copyOfRange(0, 20))
        val catalog = classicXrpAddress(payload.copyOfRange(20, 40))
        val imageHash = payload.copyOfRange(40, 72)
        return JSONObject()
            .put("ok", true)
            .put("kind", "aperture-xrp-spot")
            .put("ledger", "xrpl")
            .put("address", address)
            .put("catalogAddress", catalog)
            .put("destination", address)
            .put("account", catalog)
            .put("imageHash", toHex(imageHash))
            .put("spot", if (code.trim().lowercase().startsWith(SPOT_PREFIX)) code.trim() else SPOT_PREFIX + raw)
    }

    private fun lookupXrpCertificate(address: String, imageHash: String): JSONObject? {
        val digest = imageHash.uppercase()
        val plates = xrpPlates()
        for (i in 0 until plates.length()) {
            val item = plates.getJSONObject(i)
            if (address.isNotBlank() && item.optString("address") == address) return item
            if (digest.isNotBlank() && item.optString("imageHash").uppercase() == digest) return item
        }
        return null
    }

    private fun decodeVault(address: String): ByteArray? {
        val name = address.substringAfterLast('/').ifBlank { return null }
        val file = File(xrpVaultDir(), "$name.apxr")
        if (!file.isFile) return null
        return decodeXrpEnvelope(file.readBytes())
    }

    private fun decodeXrpEnvelope(data: ByteArray, secret: ByteArray = xrpSecret()): ByteArray? {
        val header = 5 + XRP_NONCE + 64
        if (data.size < header) return null
        if (data[0] != XRP_MAGIC[0] || data[1] != XRP_MAGIC[1] || data[2] != XRP_MAGIC[2] || data[3] != XRP_MAGIC[3] || data[4] != XRP_VERSION) {
            return null
        }
        val nonce = data.copyOfRange(5, 5 + XRP_NONCE)
        val imageHash = data.copyOfRange(5 + XRP_NONCE, 5 + XRP_NONCE + 32)
        val tag = data.copyOfRange(5 + XRP_NONCE + 32, header)
        val cipher = data.copyOfRange(header, data.size)
        val expected = hmacSha256(sha256(XRP_LABEL + secret), nonce + imageHash + cipher)
        if (!expected.contentEquals(tag)) return null
        val plain = xorSeal(cipher, sha256(secret + nonce + imageHash))
        if (!sha256(plain).contentEquals(imageHash)) return null
        return plain
    }

    private fun b58decode(text: String): ByteArray? {
        var zeros = 0
        for (ch in text) {
            if (ch == XRP_ALPHABET[0]) zeros += 1 else break
        }
        var number = BigInteger.ZERO
        val base = BigInteger.valueOf(58)
        for (ch in text) {
            val index = XRP_ALPHABET.indexOf(ch)
            if (index < 0) return null
            number = number.multiply(base).add(BigInteger.valueOf(index.toLong()))
        }
        val signed = if (number == BigInteger.ZERO) ByteArray(0) else number.toByteArray()
        val body = if (signed.isNotEmpty() && signed[0] == 0.toByte()) signed.copyOfRange(1, signed.size) else signed
        return ByteArray(zeros) { 0 } + body
    }

    private fun stableCertJson(cert: JSONObject): String {
        val keys = cert.keys().asSequence().sorted().toList()
        val ordered = JSONObject()
        for (key in keys) ordered.put(key, cert.get(key))
        return ordered.toString()
    }

    private fun rememberXrpCertificate(cert: JSONObject) {
        val plates = xrpPlates()
        val digest = cert.optString("imageHash")
        val next = JSONArray()
        next.put(cert)
        for (i in 0 until plates.length()) {
            val item = plates.getJSONObject(i)
            if (item.optString("imageHash") == digest) continue
            next.put(item)
            if (next.length() >= 80) break
        }
        prefs.edit().putString(KEY_XRP, next.toString()).apply()
    }

    private fun xrpPlates(): JSONArray {
        val raw = prefs.getString(KEY_XRP, "").orEmpty()
        if (raw.isBlank()) return JSONArray()
        return try {
            JSONArray(raw)
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun xrpSecret(): ByteArray {
        val raw = prefs.getString(KEY_XRP_SECRET, "").orEmpty()
        if (raw.length == 64) {
            return hexToBytes(raw)
        }
        val secret = ByteArray(32)
        SecureRandom().nextBytes(secret)
        prefs.edit().putString(KEY_XRP_SECRET, toHex(secret).lowercase()).apply()
        return secret
    }

    private fun catalogXrpAddress(secret: ByteArray = xrpSecret()): String {
        return classicXrpAddress(sha256(XRP_CATALOG + secret).copyOf(20))
    }

    private fun plateXrpAddress(imageHash: ByteArray, secret: ByteArray): String {
        return classicXrpAddress(sha256(imageHash + XRP_PLATE + secret).copyOf(20))
    }

    private fun classicXrpAddress(payload20: ByteArray): String {
        val versioned = byteArrayOf(0) + payload20.copyOf(20)
        val check = sha256(sha256(versioned)).copyOf(4)
        return b58encode(versioned + check)
    }

    private fun b58encode(data: ByteArray): String {
        var zeros = 0
        for (byte in data) {
            if (byte == 0.toByte()) zeros += 1 else break
        }
        var number = BigInteger(1, data)
        val chars = StringBuilder()
        val base = BigInteger.valueOf(58)
        if (number == BigInteger.ZERO) chars.append(XRP_ALPHABET[0])
        while (number > BigInteger.ZERO) {
            val div = number.divideAndRemainder(base)
            number = div[0]
            chars.append(XRP_ALPHABET[div[1].toInt()])
        }
        return XRP_ALPHABET[0].toString().repeat(zeros) + chars.reverse().toString()
    }

    private fun xorSeal(plain: ByteArray, key: ByteArray): ByteArray {
        if (key.isEmpty()) return plain
        return ByteArray(plain.size) { index -> (plain[index].toInt() xor key[index % key.size].toInt()).toByte() }
    }

    private fun sha256(data: ByteArray): ByteArray {
        return MessageDigest.getInstance("SHA-256").digest(data)
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    private fun toHex(data: ByteArray): String {
        return data.joinToString("") { byte -> "%02X".format(byte) }
    }

    private fun hexToBytes(value: String): ByteArray {
        val hex = value.replace(Regex("[^0-9A-Fa-f]"), "")
        return ByteArray(hex.length / 2) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    }

    private fun xrpVaultDir(): File {
        val dir = File(context.filesDir, "xrp")
        dir.mkdirs()
        return dir
    }

    private fun readUriBytes(uri: Uri): ByteArray? {
        return try {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (_: Exception) {
            null
        }
    }

    private fun hasPermission(uri: Uri): Boolean {
        return context.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
    }

    private fun json(body: JSONObject): WebResourceResponse {
        val bytes = body.toString().toByteArray(StandardCharsets.UTF_8)
        return WebResourceResponse(
            "application/json",
            "UTF-8",
            200,
            "OK",
            mapOf("Cache-Control" to "no-store", "Content-Type" to "application/json; charset=utf-8"),
            ByteArrayInputStream(bytes),
        )
    }

    private fun notFound(): WebResourceResponse {
        return WebResourceResponse(
            "text/plain",
            "UTF-8",
            404,
            "Not found",
            emptyMap(),
            ByteArrayInputStream(ByteArray(0)),
        )
    }

    fun download(url: String, filename: String, onProgress: (Int) -> Unit): Boolean {
        onProgress(4)
        val rel = mediaRelFrom(url)
        if (rel != null) {
            val key = listOf(rel, Uri.decode(rel)).firstOrNull { media.containsKey(it) }
            if (key != null) {
                val entry = media[key] ?: return false
                return saveUri(entry.first, filename, entry.second, onProgress)
            }
        }
        return saveHttp(url, filename, onProgress)
    }

    fun exportToFile(url: String, dest: File, onProgress: (Int) -> Unit): Boolean {
        onProgress(4)
        dest.parentFile?.mkdirs()
        val rel = mediaRelFrom(url)
        if (rel != null) {
            val key = listOf(rel, Uri.decode(rel)).firstOrNull { media.containsKey(it) }
            if (key != null) {
                val entry = media[key] ?: return false
                val total = context.contentResolver.openAssetFileDescriptor(entry.first, "r")?.use { it.length } ?: -1L
                val input = context.contentResolver.openInputStream(entry.first) ?: return false
                return input.use { stream ->
                    dest.outputStream().use { output ->
                        copyWithProgress(stream, output, total, onProgress)
                    }
                    onProgress(99)
                    true
                }
            }
        }
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 15000
        connection.readTimeout = 30000
        connection.connect()
        if (connection.responseCode !in 200..299) {
            connection.disconnect()
            return false
        }
        return try {
            val total = connection.contentLengthLong
            connection.inputStream.use { stream ->
                dest.outputStream().use { output ->
                    copyWithProgress(stream, output, total, onProgress)
                }
            }
            onProgress(99)
            true
        } finally {
            connection.disconnect()
        }
    }

    private fun mediaRelFrom(url: String): String? {
        val marker = "/media/"
        val index = url.indexOf(marker)
        if (index < 0) return null
        return Uri.decode(url.substring(index + marker.length).substringBefore("?"))
    }

    private fun saveUri(uri: Uri, filename: String, mime: String, onProgress: (Int) -> Unit): Boolean {
        val total = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
        val input = context.contentResolver.openInputStream(uri) ?: return false
        return input.use { saveStream(it, filename, mime, total, onProgress) }
    }

    private fun saveHttp(url: String, filename: String, onProgress: (Int) -> Unit): Boolean {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 15000
        connection.readTimeout = 30000
        connection.connect()
        val code = connection.responseCode
        if (code !in 200..299) {
            connection.disconnect()
            return false
        }
        val mime = connection.contentType?.substringBefore(";")?.trim().orEmpty().ifBlank { mimeFor(filename) }
        val total = connection.contentLengthLong
        return try {
            connection.inputStream.use { saveStream(it, filename, mime, total, onProgress) }
        } finally {
            connection.disconnect()
        }
    }

    private fun saveStream(
        input: InputStream,
        filename: String,
        mime: String,
        total: Long,
        onProgress: (Int) -> Unit,
    ): Boolean {
        val name = safeDownloadName(filename, mime)
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, mime.ifBlank { mimeFor(name) })
            if (Build.VERSION.SDK_INT >= 29) {
                put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Aperture")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        }
        val resolver = context.contentResolver
        val dest = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return false
        return try {
            resolver.openOutputStream(dest)?.use { output ->
                copyWithProgress(input, output, total, onProgress)
            } ?: return false
            if (Build.VERSION.SDK_INT >= 29) {
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(dest, values, null, null)
            }
            onProgress(100)
            true
        } catch (_: Exception) {
            resolver.delete(dest, null, null)
            false
        }
    }

    private fun copyWithProgress(input: InputStream, output: OutputStream, total: Long, onProgress: (Int) -> Unit) {
        val buffer = ByteArray(16 * 1024)
        var copied = 0L
        var last = -1
        while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            output.write(buffer, 0, read)
            copied += read
            val pct = if (total > 0) {
                ((copied * 99) / total).toInt().coerceIn(1, 99)
            } else {
                (8 + ((copied / 40_000L) % 80)).toInt()
            }
            if (pct != last) {
                last = pct
                onProgress(pct)
            }
        }
        output.flush()
    }

    private fun safeDownloadName(filename: String, mime: String): String {
        val base = filename.substringAfterLast('/').substringAfterLast('\\').ifBlank { "plate" }
        val cleaned = base.replace(Regex("[^A-Za-z0-9._-]+"), "_")
        if (cleaned.contains('.')) return cleaned
        val ext = when {
            mime.contains("png") -> ".png"
            mime.contains("webp") -> ".webp"
            mime.contains("gif") -> ".gif"
            else -> ".jpg"
        }
        return cleaned + ext
    }

    companion object {
        private const val KEY_URI = "lastFolder"
        private const val KEY_NAME = "lastFolderName"
        private const val KEY_OPENED = "openedAt"
        private const val KEY_COUNT = "photoCount"
        private const val KEY_RECENTS = "recents"
        private const val KEY_SKIN = "skin"
        private const val KEY_XRP = "xrpLedger"
        private const val KEY_XRP_SECRET = "xrpSecret"
        private const val MAX_RECENTS = 3
        private const val MAX_RECENT_SLIDES = 8
        private const val XRP_VERSION: Byte = 1
        private const val XRP_NONCE = 16
        private const val XRP_MAX_PLATE = 25 * 1024 * 1024
        private const val XRP_MEMO_TYPE = "aperture/xrp"
        private val XRP_MAGIC = byteArrayOf(0x41, 0x50, 0x58, 0x52)
        private val XRP_LABEL = "aperture-xrp-cipher-v1".toByteArray(StandardCharsets.UTF_8)
        private val XRP_PLATE = "xrpl-plate".toByteArray(StandardCharsets.UTF_8)
        private val XRP_CATALOG = "xrpl-catalog".toByteArray(StandardCharsets.UTF_8)
        private val SPOT_MAGIC = byteArrayOf(0x41, 0x50, 0x58, 0x53)
        private val SPOT_LABEL = "aperture-xrp-spot-v1".toByteArray(StandardCharsets.UTF_8)
        private const val SPOT_PREFIX = "apxs1:"
        private const val SPOT_PAYLOAD = 72
        private const val XRP_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"
        private val IMAGE_EXT = setOf(
            "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "avif", "svg", "heic", "heif",
        )

        fun isImage(name: String): Boolean {
            val ext = name.substringAfterLast('.', "").lowercase(Locale.US)
            return ext in IMAGE_EXT
        }

        fun slug(value: String): String {
            val cleaned = buildString {
                for (ch in value.ifBlank { "folder" }) {
                    append(if (ch.isLetterOrDigit()) ch.lowercaseChar() else '-')
                }
            }
            return cleaned.split('-').filter { it.isNotEmpty() }.joinToString("-").ifEmpty { "folder" }
        }

        fun mimeFor(name: String): String {
            return when (name.substringAfterLast('.', "").lowercase(Locale.US)) {
                "jpg", "jpeg" -> "image/jpeg"
                "png" -> "image/png"
                "gif" -> "image/gif"
                "webp" -> "image/webp"
                "bmp" -> "image/bmp"
                "svg" -> "image/svg+xml"
                "tif", "tiff" -> "image/tiff"
                "avif" -> "image/avif"
                "heic", "heif" -> "image/heic"
                else -> "application/octet-stream"
            }
        }
    }
}
