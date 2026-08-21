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
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Calendar
import java.util.Locale

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

    fun searchResponse(query: String, imageHash: String): WebResourceResponse {
        return json(searchCatalog(query, imageHash))
    }

    fun searchCatalog(query: String, imageHash: String): JSONObject {
        val needle = query.trim().lowercase(Locale.US)
        val digest = normalizeImageHash(imageHash)
        if (needle.isEmpty() && digest.isEmpty()) {
            return JSONObject()
                .put("ok", true)
                .put("query", query.trim())
                .put("imageHash", "")
                .put("count", 0)
                .put("photos", JSONArray())
                .put("exact", false)
        }
        val roots = searchRoots()
        val openKeys = currentTrees.mapIndexed { index, uri -> uri.toString() to index }.toMap()
        val multiOpen = currentTrees.size > 1
        val hits = mutableListOf<JSONObject>()
        val seen = mutableSetOf<String>()
        var exact: JSONObject? = null
        var hashed = 0

        roots.forEachIndexed { searchIndex, tree ->
            val root = DocumentFile.fromTreeUri(context, tree) ?: return@forEachIndexed
            val folderName = root.name ?: "Folder"
            val openIndex = openKeys[tree.toString()]
            val found = mutableListOf<SearchPlate>()
            collectSearch(root, "", found)
            for (plate in found) {
                val ident = when {
                    openIndex != null && multiOpen -> "$openIndex/${plate.rel}"
                    openIndex != null -> plate.rel
                    else -> "search/$searchIndex/${plate.rel}"
                }
                if (openIndex == null) {
                    media[ident] = plate.uri to plate.mime
                }
                val parent = if (plate.rel.contains("/")) plate.rel.substringBeforeLast("/").substringAfterLast("/") else folderName
                val location = if (plate.rel.contains("/")) plate.rel.substringBeforeLast("/") else folderName
                val title = plate.name.substringBeforeLast('.')
                val mediaPath = "/media/" + Uri.encode(ident)
                val photo = JSONObject()
                    .put("id", ident)
                    .put("title", title)
                    .put("photographer", folderName)
                    .put("location", location)
                    .put("year", plate.year)
                    .put("category", slug(parent))
                    .put("src", mediaPath)
                    .put("thumb", mediaPath)
                    .put("hero", mediaPath)
                    .put("local", true)
                    .put("featured", false)
                val blob = listOf(title, location, folderName, slug(parent), ident).joinToString(" ").lowercase(Locale.US)
                val textHit = needle.isNotEmpty() && blob.contains(needle)
                var hashHit = false
                if (digest.isNotEmpty() && hashed < SEARCH_HASH_FILE_LIMIT && exact == null) {
                    val bytes = readUriBytesLimited(plate.uri)
                    if (bytes != null) {
                        hashed += 1
                        if (toHex(sha256(bytes)) == digest) {
                            hashHit = true
                            photo.put("exact", true)
                            exact = photo
                        }
                    }
                }
                if (!textHit && !hashHit) continue
                if (!seen.add(ident)) continue
                hits += photo
                if (hits.size >= SEARCH_HIT_LIMIT && (exact != null || digest.isEmpty())) break
            }
            if (hits.size >= SEARCH_HIT_LIMIT && (exact != null || digest.isEmpty())) return@forEachIndexed
        }

        val ordered = mutableListOf<JSONObject>()
        exact?.let { match ->
            ordered += match
            hits.filterTo(ordered) { it.optString("id") != match.optString("id") }
        } ?: ordered.addAll(hits)
        val capped = ordered.take(SEARCH_HIT_LIMIT)
        capped.forEachIndexed { index, photo ->
            photo.put("index", index)
            photo.put("featured", index == 0)
        }
        return JSONObject()
            .put("ok", true)
            .put("query", query.trim())
            .put("imageHash", digest.lowercase(Locale.US))
            .put("count", capped.size)
            .put("photos", JSONArray(capped))
            .put("exact", exact != null)
    }

    private data class SearchPlate(
        val rel: String,
        val name: String,
        val year: Int,
        val uri: Uri,
        val mime: String,
    )

    private fun searchRoots(): List<Uri> {
        val out = linkedMapOf<String, Uri>()
        currentTrees.forEach { out[it.toString()] = it }
        val recents = recentsArray()
        for (index in 0 until recents.length()) {
            val item = recents.getJSONObject(index)
            val raw = item.optString("path").ifBlank { item.optString("id") }
            if (raw.isBlank()) continue
            val uri = Uri.parse(raw)
            if (!hasPermission(uri)) continue
            out.putIfAbsent(raw, uri)
        }
        val last = prefs.getString(KEY_URI, "").orEmpty()
        if (last.isNotBlank()) {
            val uri = Uri.parse(last)
            if (hasPermission(uri)) out.putIfAbsent(last, uri)
        }
        return out.values.toList()
    }

    private fun collectSearch(dir: DocumentFile, prefix: String, out: MutableList<SearchPlate>) {
        val children = dir.listFiles().sortedBy { it.name?.lowercase(Locale.US) ?: "" }
        for (child in children) {
            val name = child.name ?: continue
            if (child.isDirectory) {
                if (skipDir(name)) continue
                val next = if (prefix.isEmpty()) name else "$prefix/$name"
                collectSearch(child, next, out)
                continue
            }
            if (!isImage(name)) continue
            val rel = if (prefix.isEmpty()) name else "$prefix/$name"
            val year = Calendar.getInstance().apply { timeInMillis = child.lastModified() }.get(Calendar.YEAR)
            out += SearchPlate(rel, name, year, child.uri, mimeFor(name))
        }
    }

    private fun skipDir(name: String): Boolean {
        return name.equals("blockchain", ignoreCase = true) || name.equals("xrp", ignoreCase = true)
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
                if (skipDir(name)) continue
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
                if (skipDir(name)) continue
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

    fun ethResponse(): WebResourceResponse {
        return json(ethShard())
    }

    fun ethShard(): JSONObject {
        val plates = ethPlates()
        return JSONObject()
            .put("ok", true)
            .put("catalogAddress", catalogEthAddress())
            .put("count", plates.length())
            .put("plates", plates)
    }

    fun ethEncode(url: String, filename: String, title: String): JSONObject {
        val dest = File(context.cacheDir, "eth-in/${filename.substringAfterLast('/').ifBlank { "plate.jpg" }}")
        dest.parentFile?.mkdirs()
        if (!exportToFile(url, dest) { }) return JSONObject().put("ok", false)
        val bytes = dest.readBytes()
        return encodeEthPlate(bytes, title.ifBlank { dest.nameWithoutExtension }, dest.name, mimeFor(dest.name))
    }

    fun ethEncodeFolder(): JSONObject {
        var encoded = 0
        var skipped = 0
        media.values.forEach { entry ->
            val bytes = readUriBytes(entry.first) ?: run {
                skipped += 1
                return@forEach
            }
            if (bytes.isEmpty() || bytes.size > ETH_MAX_PLATE) {
                skipped += 1
                return@forEach
            }
            val name = DocumentFile.fromSingleUri(context, entry.first)?.name ?: "plate.jpg"
            val result = encodeEthPlate(bytes, name.substringBeforeLast('.'), name, entry.second)
            if (result.optBoolean("ok")) encoded += 1 else skipped += 1
        }
        return ethShard().put("encoded", encoded).put("skipped", skipped)
    }

    fun writeEthShardFile(): File {
        val dest = File(context.cacheDir, "share/Aperture-eth.json")
        dest.parentFile?.mkdirs()
        dest.writeText(ethShard().toString())
        return dest
    }

    private fun encodeEthPlate(plain: ByteArray, title: String, filename: String, mime: String): JSONObject {
        if (plain.isEmpty() || plain.size > ETH_MAX_PLATE) return JSONObject().put("ok", false)
        val secret = ethSecret()
        val imageHash = sha256(plain)
        val address = plateEthAddress(imageHash, secret)
        val catalog = catalogEthAddress(secret)
        val shard = shardId(imageHash, secret)
        val pointer = shardPointer(shard, address)
        val cert = JSONObject()
            .put("v", 1)
            .put("kind", "aperture-eth-shard")
            .put("chain", "ethereum")
            .put("shard", shard)
            .put("address", address)
            .put("catalogAddress", catalog)
            .put("pointer", pointer)
            .put("title", title.ifBlank { "Plate" })
            .put("file", filename)
            .put("mime", mime.ifBlank { mimeFor(filename) })
            .put("imageHash", toHex(imageHash))
            .put("encodedAt", java.time.Instant.now().toString().take(19))
            .put("tx", JSONObject().put("from", catalog).put("to", address).put("data", "0x" + toHex(imageHash).lowercase()))
        val vault = File(ethVaultDir(), vaultName(address))
        vault.writeBytes(plain)
        rememberEthCertificate(cert)
        return JSONObject()
            .put("ok", true)
            .put("certificate", cert)
            .put("address", address)
            .put("catalogAddress", catalog)
            .put("shard", shard)
            .put("pointer", pointer)
            .put("vault", vault.name)
    }

    fun ethOpen(code: String): JSONObject {
        return resolveShard(code)
    }

    fun ethShardResponse(code: String): WebResourceResponse {
        return json(resolveShard(code))
    }

    fun resolveShard(code: String): JSONObject {
        val located = parsePointer(code) ?: return JSONObject().put("ok", false).put("error", "invalid shard")
        val cert = lookupEthCertificate(located.optString("address"))
        val decoded = readVault(located.optString("address"))
        if (cert == null && decoded == null) return JSONObject().put("ok", false).put("error", "unknown shard")
        if (cert != null && located.has("shard") && !located.isNull("shard") && cert.optInt("shard", -1) != located.optInt("shard", -2)) {
            return JSONObject().put("ok", false).put("error", "shard mismatch")
        }
        if (cert != null) {
            located.put("address", cert.optString("address", located.optString("address")))
            located.put("shard", cert.optInt("shard"))
            located.put("pointer", cert.optString("pointer", located.optString("pointer")))
            located.put("catalogAddress", cert.optString("catalogAddress", catalogEthAddress()))
            located.put("imageHash", cert.optString("imageHash"))
        }
        val title = cert?.optString("title")?.ifBlank { "ETH plate" } ?: "ETH plate"
        located.put("certificate", cert ?: JSONObject())
        located.put("title", title)
        located.put("file", cert?.optString("file") ?: "plate")
        located.put("mime", cert?.optString("mime") ?: "application/octet-stream")
        located.put("src", if (decoded != null) "/media/eth/" + located.optString("address") else "")
        located.put("decoded", decoded != null)
        located.put("search", shardSearchQuery(located, cert))
        return located
    }

    fun ethMediaResponse(address: String): WebResourceResponse {
        val decoded = readVault(address) ?: return notFound()
        val cert = lookupEthCertificate(address)
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

    private fun checksumAddress(payload20: ByteArray): String {
        val hex = toHex(payload20.copyOf(20)).lowercase()
        val digest = sha256(hex.toByteArray(StandardCharsets.US_ASCII))
        val chars = StringBuilder("0x")
        for (index in hex.indices) {
            val ch = hex[index]
            val nibble = (digest[index shr 1].toInt() shr (if (index % 2 == 0) 4 else 0)) and 0x0F
            chars.append(if (ch.isLetter() && nibble >= 8) ch.uppercaseChar() else ch)
        }
        return chars.toString()
    }

    private fun normalizeAddress(value: String): String {
        val hex = value.trim().removePrefix("0x").removePrefix("0X").filter { it in "0123456789abcdefABCDEF" }.lowercase()
        return if (hex.length == 40) "0x$hex" else ""
    }

    private fun catalogEthAddress(secret: ByteArray = ethSecret()): String {
        return checksumAddress(sha256(ETH_CATALOG + secret).copyOf(20))
    }

    private fun plateEthAddress(imageHash: ByteArray, secret: ByteArray): String {
        return checksumAddress(sha256(imageHash + ETH_PLATE + secret).copyOf(20))
    }

    private fun shardId(imageHash: ByteArray, secret: ByteArray): Int {
        val digest = sha256(imageHash + ETH_SHARD + secret)
        return (((digest[0].toInt() and 0xFF) shl 8) or (digest[1].toInt() and 0xFF)) % ETH_SHARD_COUNT
    }

    private fun shardPointer(shard: Int, address: String): String {
        return "$ETH_PREFIX$shard/$address"
    }

    private fun parsePointer(code: String): JSONObject? {
        var raw = code.trim()
        if (raw.lowercase().startsWith(ETH_PREFIX)) raw = raw.substring(ETH_PREFIX.length)
        if (raw.isBlank()) return null
        var shard: Int? = null
        var address = raw
        val slash = raw.indexOf('/')
        if (slash >= 0 && raw.substring(0, slash).all { it.isDigit() }) {
            shard = raw.substring(0, slash).toIntOrNull()
            address = raw.substring(slash + 1)
        }
        val normalized = normalizeAddress(address)
        if (normalized.isBlank()) return null
        if (shard != null && (shard < 0 || shard >= ETH_SHARD_COUNT)) return null
        return JSONObject()
            .put("ok", true)
            .put("kind", "aperture-eth-shard")
            .put("chain", "ethereum")
            .apply { if (shard != null) put("shard", shard) else put("shard", JSONObject.NULL) }
            .put("address", normalized)
            .put("pointer", if (shard == null) normalized else shardPointer(shard, normalized))
    }

    private fun vaultName(address: String): String {
        return normalizeAddress(address).removePrefix("0x") + ".eth"
    }

    private fun lookupEthCertificate(address: String): JSONObject? {
        val wanted = normalizeAddress(address)
        if (wanted.isBlank()) return null
        val plates = ethPlates()
        for (i in 0 until plates.length()) {
            val item = plates.getJSONObject(i)
            if (normalizeAddress(item.optString("address")) == wanted) return item
        }
        return null
    }

    private fun readVault(address: String): ByteArray? {
        val name = vaultName(address)
        if (name == ".eth") return null
        val file = File(ethVaultDir(), name)
        return if (file.isFile) file.readBytes() else null
    }

    private fun shardSearchQuery(located: JSONObject, cert: JSONObject?): String {
        val title = cert?.optString("title").orEmpty().ifBlank { located.optString("title") }
        if (title.isNotBlank() && title.lowercase() !in setOf("plate", "eth plate", "ethereum plate")) return title
        val file = cert?.optString("file").orEmpty().substringBeforeLast('.').trim()
        if (file.isNotBlank() && file.lowercase() != "plate") return file
        return located.optString("address")
    }

    private fun rememberEthCertificate(cert: JSONObject) {
        val plates = ethPlates()
        val digest = cert.optString("imageHash")
        val next = JSONArray()
        next.put(cert)
        for (i in 0 until plates.length()) {
            val item = plates.getJSONObject(i)
            if (item.optString("imageHash") == digest) continue
            next.put(item)
            if (next.length() >= 80) break
        }
        prefs.edit().putString(KEY_ETH, next.toString()).apply()
    }

    private fun ethPlates(): JSONArray {
        val raw = prefs.getString(KEY_ETH, "").orEmpty()
        if (raw.isBlank()) return JSONArray()
        return try {
            JSONArray(raw)
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun ethSecret(): ByteArray {
        val raw = prefs.getString(KEY_ETH_SECRET, "").orEmpty()
        if (raw.length == 64) return hexToBytes(raw)
        val secret = ByteArray(32)
        SecureRandom().nextBytes(secret)
        prefs.edit().putString(KEY_ETH_SECRET, toHex(secret).lowercase()).apply()
        return secret
    }

    private fun ethVaultDir(): File {
        val dir = File(context.filesDir, "eth")
        dir.mkdirs()
        return dir
    }

    private fun toHex(data: ByteArray): String {
        return data.joinToString("") { byte -> "%02X".format(byte) }
    }

    private fun sha256(data: ByteArray): ByteArray {
        return MessageDigest.getInstance("SHA-256").digest(data)
    }

    private fun hexToBytes(value: String): ByteArray {
        val hex = value.replace(Regex("[^0-9A-Fa-f]"), "")
        return ByteArray(hex.length / 2) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    }

    private fun readUriBytes(uri: Uri): ByteArray? {
        return try {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (_: Exception) {
            null
        }
    }

    private fun readUriBytesLimited(uri: Uri, max: Int = ETH_MAX_PLATE): ByteArray? {
        return try {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                if (afd.length == 0L || afd.length > max) return null
            }
            val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
            if (bytes.isEmpty() || bytes.size > max) null else bytes
        } catch (_: Exception) {
            null
        }
    }

    private fun normalizeImageHash(value: String): String {
        val hex = value.trim().removePrefix("0x").removePrefix("0X")
            .filter { it in "0123456789abcdefABCDEF" }
            .uppercase(Locale.US)
        return if (hex.length == 64) hex else ""
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
        private const val KEY_ETH = "ethShard"
        private const val KEY_ETH_SECRET = "ethSecret"
        private const val MAX_RECENTS = 3
        private const val MAX_RECENT_SLIDES = 8
        private const val ETH_MAX_PLATE = 25 * 1024 * 1024
        private const val SEARCH_HIT_LIMIT = 40
        private const val SEARCH_HASH_FILE_LIMIT = 200
        private const val ETH_SHARD_COUNT = 64
        private const val ETH_PREFIX = "eths:"
        private val ETH_CATALOG = "eth-catalog".toByteArray(StandardCharsets.UTF_8)
        private val ETH_PLATE = "eth-plate".toByteArray(StandardCharsets.UTF_8)
        private val ETH_SHARD = "eth-shard".toByteArray(StandardCharsets.UTF_8)
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
