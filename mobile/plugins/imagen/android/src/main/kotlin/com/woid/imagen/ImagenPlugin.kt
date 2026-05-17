package com.woid.imagen

import android.graphics.Bitmap
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * On-device SD 1.5 via ONNX Runtime + Qualcomm QNN EP. Model bundle
 * comes from Qualcomm AI Hub, precompiled for Snapdragon 8 Gen 3 / V75
 * (Samsung Galaxy S24 is the reference device).
 *
 * Surface unchanged from earlier MediaPipe-backed attempt:
 *   ping / modelStatus / downloadModel / initModel / generate
 */
@CapacitorPlugin(name = "Imagen")
class ImagenPlugin : Plugin() {

  private val tag = "ImagenPlugin"
  private val zipFilename  = "sd15-qnn.zip"
  private val modelDirName = "sd15-qnn"

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var pipeline: SDPipeline? = null

  override fun load() {
    Log.i(tag, "Imagen plugin loaded — ONNX Runtime + QNN EP (Snapdragon NPU)")
  }

  private fun zipFile()   = File(context.filesDir, zipFilename)
  private fun modelDir()  = File(context.filesDir, modelDirName)
  private fun extractedMarker() = File(modelDir(), ".extracted")
  private fun outputDir() = File(context.filesDir, "imagen").also { it.mkdirs() }

  @PluginMethod
  fun ping(call: PluginCall) {
    call.resolve(JSObject().apply {
      put("ok", true)
      put("runtime", "onnxruntime-qnn")
      put("modelPresent", zipFile().exists())
      put("modelExtracted", extractedMarker().exists())
      put("modelLoaded", pipeline != null)
    })
  }

  @PluginMethod
  fun modelStatus(call: PluginCall) {
    val z = zipFile()
    call.resolve(JSObject().apply {
      put("present", z.exists())
      put("path", z.absolutePath)
      put("sizeBytes", if (z.exists()) z.length() else 0L)
      put("extracted", extractedMarker().exists())
      put("loaded", pipeline != null)
      put("taesdPresent", true) // unused — kept so existing JS doesn't break
    })
  }

  @PluginMethod
  fun downloadModel(call: PluginCall) {
    val url = call.getString("url")
    if (url.isNullOrEmpty()) { call.reject("url is required"); return }
    val dst = zipFile()
    if (dst.exists() && dst.length() > 0) {
      call.resolve(JSObject().apply {
        put("alreadyPresent", true)
        put("path", dst.absolutePath); put("sizeBytes", dst.length())
      })
      return
    }
    val tmp = File(dst.absolutePath + ".part")
    scope.launch {
      var conn: HttpURLConnection? = null
      try {
        conn = (URL(url).openConnection() as HttpURLConnection).apply {
          instanceFollowRedirects = true; connectTimeout = 30_000; readTimeout = 60_000
          connect()
        }
        if (conn.responseCode / 100 != 2) { call.reject("HTTP ${conn.responseCode} from $url"); return@launch }
        val total = conn.contentLengthLong
        val startMs = System.currentTimeMillis()
        var lastEmitMs = 0L; var got = 0L
        conn.inputStream.use { input ->
          FileOutputStream(tmp).use { out ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf); if (n <= 0) break
              out.write(buf, 0, n); got += n
              val now = System.currentTimeMillis()
              if (now - lastEmitMs > 250 || got == total) {
                val elapsed = (now - startMs).coerceAtLeast(1)
                notifyListeners("download-progress", JSObject().apply {
                  put("got", got); put("total", total)
                  put("bytesPerSec", (got * 1000L) / elapsed)
                })
                lastEmitMs = now
              }
            }
            out.flush()
          }
        }
        if (!tmp.renameTo(dst)) { call.reject("rename failed"); return@launch }
        call.resolve(JSObject().apply {
          put("path", dst.absolutePath); put("sizeBytes", dst.length())
        })
      } catch (e: Throwable) {
        Log.e(tag, "download failed", e)
        try { if (tmp.exists()) tmp.delete() } catch (_: Throwable) {}
        call.reject("download failed: ${e.message}", e as? Exception ?: Exception(e))
      } finally {
        conn?.disconnect()
      }
    }
  }

  private fun extractZipIfNeeded(): File? {
    if (extractedMarker().exists()) return locateInnerDir(modelDir())
    val zip = zipFile()
    if (!zip.exists()) return null
    val dir = modelDir().also { it.mkdirs() }
    try {
      ZipInputStream(zip.inputStream().buffered()).use { zin ->
        while (true) {
          val entry = zin.nextEntry ?: break
          val rel = entry.name.replace("\\", "/").trimStart('/')
          if (rel.contains("..")) { zin.closeEntry(); continue }
          val out = File(dir, rel)
          if (entry.isDirectory) out.mkdirs()
          else { out.parentFile?.mkdirs(); FileOutputStream(out).use { os -> zin.copyTo(os, 256 * 1024) } }
          zin.closeEntry()
        }
      }
      extractedMarker().createNewFile()
      return locateInnerDir(dir)
    } catch (e: Throwable) {
      Log.e(tag, "extract failed", e); return null
    }
  }

  private fun locateInnerDir(top: File): File? {
    // Qualcomm bundle layout: one top-level dir containing the .onnx/.bin
    // files. Find it.
    if (File(top, "text_encoder.onnx").exists()) return top
    top.listFiles()?.forEach { c ->
      if (c.isDirectory && File(c, "text_encoder.onnx").exists()) return c
    }
    return null
  }

  @PluginMethod
  fun initModel(call: PluginCall) {
    if (!zipFile().exists()) { call.reject("model not downloaded"); return }
    if (pipeline != null) { call.resolve(JSObject().apply { put("alreadyLoaded", true) }); return }
    scope.launch {
      val t0 = System.currentTimeMillis()
      try {
        val dir = extractZipIfNeeded()
        if (dir == null) { call.reject("model dir not found after extract"); return@launch }
        pipeline = SDPipeline(context, dir)
        val dt = System.currentTimeMillis() - t0
        Log.i(tag, "Pipeline ready in ${dt}ms")
        call.resolve(JSObject().apply { put("loadedMs", dt) })
      } catch (e: Throwable) {
        Log.e(tag, "init failed", e)
        call.reject("init failed: ${e.message}")
      }
    }
  }

  @PluginMethod
  fun generate(call: PluginCall) {
    val prompt = call.getString("prompt", "") ?: ""
    if (prompt.isEmpty()) { call.reject("prompt is required"); return }
    val pl = pipeline ?: run { call.reject("model not initialized"); return }
    val negativePrompt = call.getString("negativePrompt") ?: ""
    val steps = call.getInt("steps") ?: 20
    val seed = (call.getInt("seed") ?: (System.nanoTime() and 0x7FFFFFFF).toInt()).toLong()
    val outFile = File(outputDir(), "gen_${System.currentTimeMillis()}.png")
    scope.launch {
      try {
        val res = pl.generate(prompt, negativePrompt, steps, seed) { step, total ->
          notifyListeners("step", JSObject().apply { put("step", step); put("total", total) })
        }
        FileOutputStream(outFile).use { os -> res.bitmap.compress(Bitmap.CompressFormat.PNG, 92, os) }
        res.bitmap.recycle()
        call.resolve(JSObject().apply {
          put("path", outFile.absolutePath)
          put("ms", res.totalMs)
          put("steps", steps); put("seed", seed)
          put("width", 512); put("height", 512)
          put("avgStepMs", res.stepMs.average())
        })
      } catch (e: Throwable) {
        Log.e(tag, "generate failed", e)
        call.reject("generate failed: ${e.message}")
      }
    }
  }

  override fun handleOnDestroy() {
    pipeline?.close(); pipeline = null
    super.handleOnDestroy()
  }
}
