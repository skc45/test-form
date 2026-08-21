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
            importChainFromTree(tree)
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

    fun chainResponse(): WebResourceResponse {
        val blocks = chainArray()
        return json(
            JSONObject()
                .put("ok", true)
                .put("valid", verifyChain(blocks))
                .put("blocks", blocks),
        )
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

    fun chainAppend(title: String, caption: String, file: String, imageHash: String): JSONObject {
        val blocks = chainArray()
        val prev = blocks.getJSONObject(blocks.length() - 1)
        val block = mineBlock(
            JSONObject()
                .put("height", prev.optInt("height") + 1)
                .put("timestamp", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(java.util.Date()))
                .put("title", title)
                .put("caption", caption)
                .put("file", file)
                .put("imageHash", imageHash)
                .put("prevHash", prev.optString("hash"))
                .put("nonce", 0),
        )
        blocks.put(block)
        prefs.edit().putString(KEY_CHAIN, blocks.toString()).apply()
        persistChainFile()
        return JSONObject()
            .put("ok", true)
            .put("valid", verifyChain(blocks))
            .put("block", block)
            .put("blocks", blocks)
    }

    fun vaultResponse(): WebResourceResponse {
        return json(vaultPayload())
    }

    fun vaultMediaResponse(rel: String): WebResourceResponse {
        val name = rel.substringAfterLast('/').substringAfterLast('\\')
        val packed = readVaultFile(name) ?: return notFound()
        val unlocked = unlockBytes(packed, chainArray()) ?: return notFound()
        val mime = unlocked.first.optString("mime").ifBlank { mimeFor(unlocked.first.optString("file").ifBlank { name }) }
        return WebResourceResponse(
            mime,
            null,
            200,
            "OK",
            mapOf("Cache-Control" to "no-store", "Content-Length" to unlocked.second.size.toString()),
            ByteArrayInputStream(unlocked.second),
        )
    }

    fun openVaultTree(uri: Uri) {
        context.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        val name = DocumentFile.fromTreeUri(context, uri)?.name ?: "blockchain"
        prefs.edit()
            .putString(KEY_VAULT, uri.toString())
            .putString(KEY_VAULT_NAME, name)
            .apply()
        importChainFromTree(uri)
    }

    private fun importChainFromTree(tree: Uri) {
        val root = DocumentFile.fromTreeUri(context, tree) ?: return
        val chainFile = root.findFile("chain.json")
            ?: root.listFiles().firstOrNull { it.isDirectory && it.name.equals("blockchain", ignoreCase = true) }?.findFile("chain.json")
            ?: return
        val text = readUriBytes(chainFile.uri)?.toString(Charsets.UTF_8) ?: return
        try {
            val data = JSONObject(text)
            val blocks = data.optJSONArray("blocks") ?: return
            if (!verifyChain(blocks)) return
            val merged = mergeChains(chainArray(), blocks, true)
            prefs.edit().putString(KEY_CHAIN, merged.toString()).apply()
            persistChainFile()
        } catch (_: Exception) {
        }
    }

    fun chainLock(url: String, filename: String, blockJson: String): JSONObject {
        val block = try {
            JSONObject(blockJson)
        } catch (_: Exception) {
            return JSONObject().put("ok", false)
        }
        val dest = File(context.cacheDir, "vault-in/${filename.substringAfterLast('/').ifBlank { "plate.jpg" }}")
        if (!exportToFile(url, dest) { }) {
            return JSONObject().put("ok", false)
        }
        val plain = dest.readBytes()
        dest.delete()
        val name = vaultFilename(block, filename)
        val packed = lockBytes(
            plain,
            block,
            filename,
            block.optString("title"),
            block.optString("caption"),
            mimeFor(filename),
        )
        writeVaultFile(name, packed)
        return vaultPayload().put("vault", name).put("block", block)
    }

    fun encodeFolder(): JSONObject {
        currentTrees.forEach { importChainFromTree(it) }
        val seen = mutableSetOf<String>()
        val existing = chainArray()
        for (index in 0 until existing.length()) {
            val hash = existing.getJSONObject(index).optString("imageHash")
            if (hash.isNotBlank()) seen += hash
        }
        var encoded = 0
        var skipped = 0
        for ((key, entry) in media.entries.toList()) {
            if (key.split('/').any { it.equals("blockchain", ignoreCase = true) }) {
                skipped += 1
                continue
            }
            val plain = readUriBytes(entry.first)
            if (plain == null || plain.isEmpty() || plain.size > 25 * 1024 * 1024) {
                skipped += 1
                continue
            }
            val imageHash = sha256HexBytes(plain)
            if (imageHash in seen) {
                skipped += 1
                continue
            }
            val filename = key.substringAfterLast('/')
            val title = filename.substringBeforeLast('.')
            val folderName = prefs.getString(KEY_NAME, "Folder").orEmpty().ifBlank { "Folder" }
            val sealed = chainAppend(title, folderName, key, imageHash)
            val block = sealed.optJSONObject("block")
            if (block == null) {
                skipped += 1
                continue
            }
            val name = vaultFilename(block, filename)
            val packed = lockBytes(plain, block, key, title, folderName, entry.second)
            writeVaultFile(name, packed)
            writeLocalVault(key, name, packed)
            writeLocalChain(key)
            seen += imageHash
            encoded += 1
        }
        return vaultPayload().put("encoded", encoded).put("skipped", skipped)
    }

    fun writeSyncPack(): File {
        persistChainFile()
        val packed = buildSyncPack()
        val dest = File(context.cacheDir, "share/Aperture-sync.apsync")
        dest.parentFile?.mkdirs()
        dest.writeBytes(packed)
        return dest
    }

    fun syncResponse(): WebResourceResponse {
        val packed = buildSyncPack()
        return WebResourceResponse(
            "application/octet-stream",
            null,
            200,
            "OK",
            mapOf(
                "Content-Disposition" to "attachment; filename=\"Aperture-sync.apsync\"",
                "Content-Length" to packed.size.toString(),
                "Cache-Control" to "no-store",
            ),
            ByteArrayInputStream(packed),
        )
    }

    fun receiveSyncBytes(data: ByteArray): JSONObject {
        val parsed = parseSyncPack(data) ?: return JSONObject().put("ok", false).put("error", "undecodable")
        val blocks = parsed.first
        if (!verifyChain(blocks)) return JSONObject().put("ok", false).put("error", "invalid chain")
        val merged = mergeChains(chainArray(), blocks, true)
        prefs.edit().putString(KEY_CHAIN, merged.toString()).apply()
        persistChainFile()
        for (plate in parsed.second) {
            writeVaultFile(plate.first, plate.second)
        }
        return vaultPayload().put("ok", true).put("received", parsed.second.size)
    }

    fun receiveSyncUri(uri: Uri): JSONObject {
        val bytes = readUriBytes(uri) ?: return JSONObject().put("ok", false)
        if (bytes.size >= 4 && bytes.copyOfRange(0, 4).contentEquals(SYNC_MAGIC)) {
            return receiveSyncBytes(bytes)
        }
        return JSONObject().put("ok", false).put("error", "undecodable")
    }

    private fun persistChainFile() {
        val text = JSONObject()
            .put("v", 1)
            .put("kind", "aperture-sync")
            .put("difficulty", CHAIN_DIFFICULTY)
            .put("blocks", chainArray())
            .toString()
        try {
            File(defaultVaultDir(), "chain.json").writeText(text)
        } catch (_: Exception) {
        }
        val raw = prefs.getString(KEY_VAULT, "").orEmpty()
        if (raw.isBlank()) return
        try {
            val root = DocumentFile.fromTreeUri(context, Uri.parse(raw)) ?: return
            root.findFile("chain.json")?.delete()
            val created = root.createFile("application/json", "chain.json") ?: return
            context.contentResolver.openOutputStream(created.uri)?.use {
                it.write(text.toByteArray(StandardCharsets.UTF_8))
            }
        } catch (_: Exception) {
        }
    }

    private fun mergeChains(local: JSONArray, remote: JSONArray, preferRemote: Boolean): JSONArray {
        if (remote.length() == 0 || !verifyChain(remote)) return local
        if (local.length() == 0 || !verifyChain(local)) return remote
        if (local.getJSONObject(0).optString("hash") == remote.getJSONObject(0).optString("hash")) {
            val shared = minOf(local.length(), remote.length())
            var samePrefix = true
            for (index in 0 until shared) {
                if (local.getJSONObject(index).optString("hash") != remote.getJSONObject(index).optString("hash")) {
                    samePrefix = false
                    break
                }
            }
            if (samePrefix) return if (remote.length() >= local.length()) remote else local
        }
        return if (preferRemote) remote else local
    }

    private fun buildSyncPack(): ByteArray {
        persistChainFile()
        val plates = listVaultEntries()
        val blocks = chainArray()
        val files = JSONArray()
        for (plate in plates) {
            files.put(JSONObject().put("name", plate.first).put("size", plate.second.size))
        }
        val header = JSONObject()
            .put("v", 1)
            .put("kind", "aperture-sync")
            .put("difficulty", CHAIN_DIFFICULTY)
            .put("height", if (blocks.length() > 0) blocks.getJSONObject(blocks.length() - 1).optInt("height") else 0)
            .put("blocks", blocks)
            .put("files", files)
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
        val total = plates.sumOf { it.second.size }
        val out = ByteArray(9 + header.size + total)
        SYNC_MAGIC.copyInto(out, 0)
        out[4] = 1
        val n = header.size
        out[5] = (n ushr 24).toByte()
        out[6] = (n ushr 16).toByte()
        out[7] = (n ushr 8).toByte()
        out[8] = n.toByte()
        header.copyInto(out, 9)
        var cursor = 9 + header.size
        for (plate in plates) {
            plate.second.copyInto(out, cursor)
            cursor += plate.second.size
        }
        return out
    }

    private fun parseSyncPack(data: ByteArray): Pair<JSONArray, List<Pair<String, ByteArray>>>? {
        if (data.size < 9 || !data.copyOfRange(0, 4).contentEquals(SYNC_MAGIC) || data[4].toInt() != 1) return null
        val n = ((data[5].toInt() and 0xFF) shl 24) or
            ((data[6].toInt() and 0xFF) shl 16) or
            ((data[7].toInt() and 0xFF) shl 8) or
            (data[8].toInt() and 0xFF)
        if (n < 2 || 9 + n > data.size) return null
        return try {
            val header = JSONObject(String(data.copyOfRange(9, 9 + n), StandardCharsets.UTF_8))
            val blocks = header.optJSONArray("blocks") ?: return null
            val files = header.optJSONArray("files") ?: return null
            var cursor = 9 + n
            val plates = mutableListOf<Pair<String, ByteArray>>()
            for (index in 0 until files.length()) {
                val item = files.getJSONObject(index)
                val name = item.optString("name").substringAfterLast('/').substringAfterLast('\\')
                val size = item.optInt("size", -1)
                if (name.isBlank() || size < 0 || cursor + size > data.size) return null
                plates += name to data.copyOfRange(cursor, cursor + size)
                cursor += size
            }
            blocks to plates
        } catch (_: Exception) {
            null
        }
    }

    private fun vaultPayload(): JSONObject {
        val blocks = chainArray()
        val valid = verifyChain(blocks)
        val files = JSONArray()
        val photos = JSONArray()
        for (entry in listVaultEntries()) {
            val parsed = parseEnvelope(entry.second)
            val header = parsed?.first ?: JSONObject().put("file", entry.first).put("title", entry.first.substringBeforeLast('.'))
            val unlocked = if (valid) unlockBytes(entry.second, blocks) else null
            val item = JSONObject()
                .put("name", entry.first)
                .put("height", header.optInt("height"))
                .put("title", header.optString("title").ifBlank { header.optString("file").substringBeforeLast('.').ifBlank { entry.first } })
                .put("caption", header.optString("caption"))
                .put("file", header.optString("file").ifBlank { entry.first })
                .put("unlocked", unlocked != null)
                .put("src", if (unlocked != null) "/media/vault/" + Uri.encode(entry.first) else "")
                .put("error", if (unlocked != null) "" else if (parsed != null) "locked" else "undecodable")
            files.put(item)
            if (unlocked != null) {
                val src = "/media/vault/" + Uri.encode(entry.first)
                val title = unlocked.first.optString("title").ifBlank { unlocked.first.optString("file").substringBeforeLast('.').ifBlank { entry.first } }
                photos.put(
                    JSONObject()
                        .put("id", "vault/${entry.first}")
                        .put("title", title)
                        .put("photographer", "Aperture chain")
                        .put("location", unlocked.first.optString("caption").ifBlank { "Unlocked plate" })
                        .put("year", Calendar.getInstance().get(Calendar.YEAR))
                        .put("category", "blockchain")
                        .put("src", src)
                        .put("thumb", src)
                        .put("hero", src)
                        .put("local", true)
                        .put("featured", photos.length() == 0)
                        .put("height", unlocked.first.optInt("height")),
                )
            }
        }
        val tip = if (blocks.length() > 0) blocks.getJSONObject(blocks.length() - 1).optInt("height") else 0
        val folder = vaultFolderName()
        return JSONObject()
            .put("ok", true)
            .put("valid", valid)
            .put("folder", folder)
            .put("path", prefs.getString(KEY_VAULT, "").orEmpty().ifBlank { defaultVaultDir().absolutePath })
            .put("height", tip)
            .put("files", files)
            .put("photos", photos)
            .put("blocks", blocks)
    }

    private fun vaultFolderName(): String {
        val named = prefs.getString(KEY_VAULT_NAME, "").orEmpty()
        if (named.isNotBlank()) return named
        val raw = prefs.getString(KEY_VAULT, "").orEmpty()
        if (raw.isNotBlank()) return DocumentFile.fromTreeUri(context, Uri.parse(raw))?.name ?: "blockchain"
        return "blockchain"
    }

    private fun defaultVaultDir(): File {
        val dir = File(context.filesDir, "blockchain")
        dir.mkdirs()
        return dir
    }

    private fun listVaultEntries(): List<Pair<String, ByteArray>> {
        val out = mutableListOf<Pair<String, ByteArray>>()
        val raw = prefs.getString(KEY_VAULT, "").orEmpty()
        if (raw.isNotBlank()) {
            val root = DocumentFile.fromTreeUri(context, Uri.parse(raw))
            if (root != null) {
                collectVaultFiles(root, out)
                return out.sortedBy { it.first.lowercase(Locale.US) }
            }
        }
        defaultVaultDir().listFiles()?.sortedBy { it.name.lowercase(Locale.US) }?.forEach { file ->
            if (file.isFile && isVaultName(file.name)) {
                out += file.name to file.readBytes()
            }
        }
        return out
    }

    private fun collectVaultFiles(dir: DocumentFile, out: MutableList<Pair<String, ByteArray>>) {
        for (child in dir.listFiles().sortedBy { it.name?.lowercase(Locale.US) ?: "" }) {
            val name = child.name ?: continue
            if (child.isDirectory) {
                collectVaultFiles(child, out)
                continue
            }
            if (!isVaultName(name)) continue
            val bytes = readUriBytes(child.uri) ?: continue
            out += name to bytes
        }
    }

    private fun isVaultName(name: String): Boolean {
        val lower = name.lowercase(Locale.US)
        return lower.endsWith(".apc") || lower.endsWith(".aplate")
    }

    private fun readVaultFile(name: String): ByteArray? {
        listVaultEntries().firstOrNull { it.first == name }?.let { return it.second }
        val local = File(defaultVaultDir(), name)
        return if (local.isFile) local.readBytes() else null
    }

    private fun writeVaultFile(name: String, bytes: ByteArray) {
        val raw = prefs.getString(KEY_VAULT, "").orEmpty()
        if (raw.isNotBlank()) {
            val root = DocumentFile.fromTreeUri(context, Uri.parse(raw))
            if (root != null) {
                root.findFile(name)?.delete()
                val created = root.createFile("application/octet-stream", name) ?: return
                context.contentResolver.openOutputStream(created.uri)?.use { it.write(bytes) }
                return
            }
        }
        File(defaultVaultDir(), name).writeBytes(bytes)
    }

    private fun writeLocalVault(key: String, name: String, bytes: ByteArray) {
        val tree = treeForMediaKey(key) ?: return
        val root = DocumentFile.fromTreeUri(context, tree) ?: return
        val dir = root.findFile("blockchain")?.takeIf { it.isDirectory } ?: root.createDirectory("blockchain") ?: return
        dir.findFile(name)?.delete()
        val created = dir.createFile("application/octet-stream", name) ?: return
        context.contentResolver.openOutputStream(created.uri)?.use { it.write(bytes) }
    }

    private fun writeLocalChain(key: String) {
        val tree = treeForMediaKey(key) ?: return
        val root = DocumentFile.fromTreeUri(context, tree) ?: return
        val dir = root.findFile("blockchain")?.takeIf { it.isDirectory } ?: root.createDirectory("blockchain") ?: return
        dir.findFile("chain.json")?.delete()
        val created = dir.createFile("application/json", "chain.json") ?: return
        val text = JSONObject()
            .put("v", 1)
            .put("kind", "aperture-sync")
            .put("difficulty", CHAIN_DIFFICULTY)
            .put("blocks", chainArray())
            .toString()
        context.contentResolver.openOutputStream(created.uri)?.use { it.write(text.toByteArray(StandardCharsets.UTF_8)) }
    }

    private fun treeForMediaKey(key: String): Uri? {
        if (currentTrees.isEmpty()) return null
        if (currentTrees.size == 1) return currentTrees.first()
        val index = key.substringBefore('/').toIntOrNull() ?: return currentTrees.first()
        return currentTrees.getOrNull(index)
    }

    private fun sha256HexBytes(data: ByteArray): String {
        return MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xFF)
        }
    }

    private fun readUriBytes(uri: Uri): ByteArray? {
        return context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    }

    private fun vaultFilename(block: JSONObject, filename: String): String {
        val height = block.optInt("height")
        val stem = filename.substringAfterLast('/').substringBeforeLast('.').replace(Regex("[^A-Za-z0-9._-]+"), "-").ifBlank { "plate" }
        return "%04d-%s.apc".format(Locale.US, height, stem)
    }

    private fun xorBytes(data: ByteArray, key: ByteArray): ByteArray {
        if (key.isEmpty()) return data
        return ByteArray(data.size) { index -> (data[index].toInt() xor key[index % key.size].toInt()).toByte() }
    }

    private fun vaultKey(block: JSONObject): ByteArray {
        return MessageDigest.getInstance("SHA-256").digest(block.optString("hash").toByteArray(StandardCharsets.UTF_8))
    }

    private fun lockBytes(
        plain: ByteArray,
        block: JSONObject,
        filename: String,
        title: String,
        caption: String,
        mime: String,
    ): ByteArray {
        val imageHash = MessageDigest.getInstance("SHA-256").digest(plain).joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xFF)
        }
        val header = JSONObject()
            .put("v", 1)
            .put("height", block.optInt("height"))
            .put("file", filename)
            .put("title", title)
            .put("caption", caption)
            .put("imageHash", imageHash)
            .put("mime", mime.ifBlank { "application/octet-stream" })
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
        val cipher = xorBytes(plain, vaultKey(block))
        val out = ByteArray(9 + header.size + cipher.size)
        VAULT_MAGIC.copyInto(out, 0)
        out[4] = 1
        val n = header.size
        out[5] = (n ushr 24).toByte()
        out[6] = (n ushr 16).toByte()
        out[7] = (n ushr 8).toByte()
        out[8] = n.toByte()
        header.copyInto(out, 9)
        cipher.copyInto(out, 9 + header.size)
        return out
    }

    private fun parseEnvelope(data: ByteArray): Pair<JSONObject, ByteArray>? {
        if (data.size < 9 || !data.copyOfRange(0, 4).contentEquals(VAULT_MAGIC) || data[4].toInt() != 1) return null
        val n = ((data[5].toInt() and 0xFF) shl 24) or
            ((data[6].toInt() and 0xFF) shl 16) or
            ((data[7].toInt() and 0xFF) shl 8) or
            (data[8].toInt() and 0xFF)
        if (n < 2 || 9 + n > data.size) return null
        return try {
            val header = JSONObject(String(data.copyOfRange(9, 9 + n), StandardCharsets.UTF_8))
            header to data.copyOfRange(9 + n, data.size)
        } catch (_: Exception) {
            null
        }
    }

    private fun unlockBytes(data: ByteArray, blocks: JSONArray): Pair<JSONObject, ByteArray>? {
        val parsed = parseEnvelope(data) ?: return null
        if (!verifyChain(blocks)) return null
        val height = parsed.first.optInt("height", -1)
        val block = (0 until blocks.length()).map { blocks.getJSONObject(it) }.firstOrNull { it.optInt("height") == height }
            ?: return null
        val plain = xorBytes(parsed.second, vaultKey(block))
        val digest = MessageDigest.getInstance("SHA-256").digest(plain).joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xFF)
        }
        if (digest != parsed.first.optString("imageHash")) return null
        return parsed.first to plain
    }

    private fun chainArray(): JSONArray {
        val raw = prefs.getString(KEY_CHAIN, "").orEmpty()
        if (raw.isNotBlank()) {
            try {
                val blocks = JSONArray(raw)
                if (blocks.length() > 0) return blocks
            } catch (_: Exception) {
                /* seed genesis */
            }
        }
        val genesis = JSONArray().put(mineBlock(genesisSeed()))
        prefs.edit().putString(KEY_CHAIN, genesis.toString()).apply()
        return genesis
    }

    private fun genesisSeed(): JSONObject {
        return JSONObject()
            .put("height", 0)
            .put("timestamp", "1970-01-01T00:00:00")
            .put("title", "Aperture")
            .put("caption", "Genesis plate")
            .put("file", "")
            .put("imageHash", GENESIS_PREV)
            .put("prevHash", GENESIS_PREV)
            .put("nonce", 0)
    }

    private fun blockPayload(block: JSONObject): String {
        return listOf(
            block.optInt("height").toString(),
            block.optString("prevHash"),
            block.optString("timestamp"),
            block.optString("title"),
            block.optString("caption"),
            block.optString("file"),
            block.optString("imageHash"),
            block.optInt("nonce").toString(),
        ).joinToString("|")
    }

    private fun hashBlock(block: JSONObject): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(blockPayload(block).toByteArray(StandardCharsets.UTF_8))
        return digest.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xFF) }
    }

    private fun mineBlock(block: JSONObject, difficulty: Int = CHAIN_DIFFICULTY): JSONObject {
        val prefix = "0".repeat(difficulty)
        var nonce = 0
        while (true) {
            block.put("nonce", nonce)
            val digest = hashBlock(block)
            if (digest.startsWith(prefix)) {
                block.put("hash", digest)
                return block
            }
            nonce += 1
        }
    }

    private fun verifyChain(blocks: JSONArray): Boolean {
        val prefix = "0".repeat(CHAIN_DIFFICULTY)
        if (blocks.length() == 0) return false
        for (index in 0 until blocks.length()) {
            val block = blocks.getJSONObject(index)
            val digest = hashBlock(block)
            if (digest != block.optString("hash") || !digest.startsWith(prefix)) return false
            if (index == 0) {
                if (block.optInt("height") != 0 || block.optString("prevHash") != GENESIS_PREV) return false
                continue
            }
            val prev = blocks.getJSONObject(index - 1)
            if (block.optInt("height") != prev.optInt("height") + 1) return false
            if (block.optString("prevHash") != prev.optString("hash")) return false
        }
        return true
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
        private const val KEY_CHAIN = "chain"
        private const val KEY_SKIN = "skin"
        private const val KEY_VAULT = "blockchainFolder"
        private const val KEY_VAULT_NAME = "blockchainFolderName"
        private const val MAX_RECENTS = 3
        private const val MAX_RECENT_SLIDES = 8
        private const val CHAIN_DIFFICULTY = 1
        private const val GENESIS_PREV = "0000000000000000000000000000000000000000000000000000000000000000"
        private val VAULT_MAGIC = byteArrayOf(0x41, 0x50, 0x43, 0x48)
        private val SYNC_MAGIC = byteArrayOf(0x41, 0x50, 0x53, 0x59)
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
