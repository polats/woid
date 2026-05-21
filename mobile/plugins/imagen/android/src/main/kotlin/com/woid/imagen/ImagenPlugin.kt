package com.woid.imagen

import android.os.Build
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
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * On-device Stable Diffusion via xororz/local-dream's native binary
 * (`libstable_diffusion_core.so`, CC-BY-NC). The binary is extracted
 * from the LocalDream APK and bundled in this plugin's jniLibs/. At
 * runtime we spawn it as a SUBPROCESS (not a JNI lib) — the subprocess
 * linker namespace can `dlopen` the unsigned QNN HTP libs we ship in
 * assets/qnnlibs/ and bind to the Hexagon DSP, which the in-process
 * JNI path on a retail S24 cannot do.
 *
 * IPC: subprocess listens on http://localhost:8081.
 *
 * Layout decisions adapted from xororz/local-dream's
 * `ModelDownloadService` (flatten-on-extract) and `BackendService`
 * (env vars + ProcessBuilder). Attribution in
 * `docs/devlog/2026-05-16-mobile-ai-attempt.md`.
 */
@CapacitorPlugin(name = "Imagen")
class ImagenPlugin : Plugin() {

  private val tag = "ImagenPlugin"
  private val binaryName = "libstable_diffusion_core.so"
  private val runtimeDirName = "imagen_runtime"
  private val modelsDirName = "imagen_models"
  private val port = 8081

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  @Volatile private var process: Process? = null
  @Volatile private var runtimeReady = false
  @Volatile private var loadedModelId: String? = null

  override fun load() {
    Log.i(tag, "Imagen plugin loaded — local-dream subprocess pattern (QNN/Hexagon NPU)")
  }

  private fun runtimeDir() = File(context.filesDir, runtimeDirName).apply { mkdirs() }
  private fun modelsDir() = File(context.filesDir, modelsDirName).apply { mkdirs() }
  private fun modelDir(id: String) = File(modelsDir(), id)
  private fun outputDir() = File(context.filesDir, "imagen").apply { mkdirs() }

  /** Maps Snapdragon SoC model -> the suffix xororz uses on their HF zips. */
  private fun chipsetSuffix(): String {
    val map = mapOf(
      "SM8475" to "8gen1", "SM8450" to "8gen1",
      "SM8550" to "8gen2", "SM8550P" to "8gen2",
      "SM8650" to "8gen2", "SM8650P" to "8gen2",
      "SM8750" to "8gen2", "SM8750P" to "8gen2",
      "SM8850" to "8gen2", "SM8850P" to "8gen2",
      "QCS8550" to "8gen2", "QCM8550" to "8gen2",
    )
    val soc = Build.SOC_MODEL ?: ""
    return map[soc] ?: if (soc.startsWith("SM")) "min" else "min"
  }

  @PluginMethod
  fun ping(call: PluginCall) {
    call.resolve(JSObject().apply {
      put("ok", true)
      put("runtime", "local-dream-subprocess")
      put("chipsetSuffix", chipsetSuffix())
      put("soc", Build.SOC_MODEL ?: "")
      put("modelLoaded", loadedModelId)
      put("backendAlive", process?.isAlive == true)
    })
  }

  @PluginMethod
  fun modelStatus(call: PluginCall) {
    val modelId = call.getString("modelId") ?: "absolute_reality"
    val dir = modelDir(modelId)
    call.resolve(JSObject().apply {
      put("modelId", modelId)
      put("present", File(dir, ".extracted").exists() && File(dir, "unet.bin").exists())
      put("path", dir.absolutePath)
      put("loaded", loadedModelId == modelId && process?.isAlive == true)
      put("backendAlive", process?.isAlive == true)
    })
  }

  @PluginMethod
  fun downloadModel(call: PluginCall) {
    val modelId = call.getString("modelId") ?: "absolute_reality"
    val url = call.getString("url") ?: defaultModelUrl()
    val dst = modelDir(modelId)
    val markerOk = File(dst, ".extracted")
    if (markerOk.exists()) {
      call.resolve(JSObject().apply {
        put("modelId", modelId); put("alreadyPresent", true)
        put("path", dst.absolutePath)
      }); return
    }
    dst.mkdirs()
    val zipFile = File(dst, "bundle.zip")
    val tmp = File(dst, "bundle.zip.part")
    scope.launch {
      var conn: HttpURLConnection? = null
      try {
        // 1. Download.
        conn = (URL(url).openConnection() as HttpURLConnection).apply {
          instanceFollowRedirects = true; connectTimeout = 30_000; readTimeout = 60_000
          connect()
        }
        if (conn.responseCode / 100 != 2) { call.reject("HTTP ${conn.responseCode} from $url"); return@launch }
        val total = conn.contentLengthLong
        val startMs = System.currentTimeMillis(); var got = 0L; var lastEmit = 0L
        conn.inputStream.use { input ->
          FileOutputStream(tmp).use { out ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf); if (n <= 0) break
              out.write(buf, 0, n); got += n
              val now = System.currentTimeMillis()
              if (now - lastEmit > 250 || got == total) {
                val elapsed = (now - startMs).coerceAtLeast(1)
                notifyListeners("download-progress", JSObject().apply {
                  put("phase", "downloading")
                  put("got", got); put("total", total)
                  put("bytesPerSec", (got * 1000L) / elapsed)
                })
                lastEmit = now
              }
            }
            out.flush()
          }
        }
        if (!tmp.renameTo(zipFile)) { call.reject("rename failed"); return@launch }

        // 2. Extract — match local-dream/ModelDownloadService.unzipFile.
        // Take only the file basename and write FLAT into the model dir,
        // ignoring directory entries and macOS metadata.
        notifyListeners("download-progress", JSObject().apply {
          put("phase", "extracting"); put("filesExtracted", 0)
        })
        var extracted = 0
        ZipInputStream(zipFile.inputStream().buffered()).use { zis ->
          var entry = zis.nextEntry
          while (entry != null) {
            if (!entry.isDirectory) {
              val fileName = entry.name.substringAfterLast('/')
              if (fileName.isNotEmpty() && !fileName.startsWith(".") && !fileName.startsWith("__MACOSX")) {
                BufferedOutputStream(FileOutputStream(File(dst, fileName))).use { out ->
                  zis.copyTo(out)
                }
                extracted++
                notifyListeners("download-progress", JSObject().apply {
                  put("phase", "extracting"); put("filesExtracted", extracted)
                })
              }
            }
            zis.closeEntry()
            entry = zis.nextEntry
          }
        }
        markerOk.createNewFile()
        zipFile.delete()
        Log.i(tag, "Extracted $extracted files into ${dst.absolutePath}")
        call.resolve(JSObject().apply {
          put("modelId", modelId); put("path", dst.absolutePath); put("filesExtracted", extracted)
        })
      } catch (e: Throwable) {
        Log.e(tag, "download failed", e)
        try { tmp.delete() } catch (_: Throwable) {}
        call.reject("download failed: ${e.message}", e as? Exception ?: Exception(e))
      } finally {
        conn?.disconnect()
      }
    }
  }

  private fun defaultModelUrl(): String {
    val suffix = chipsetSuffix()
    return "https://huggingface.co/xororz/sd-qnn/resolve/main/AbsoluteReality_qnn2.28_${suffix}.zip"
  }

  @PluginMethod
  fun initModel(call: PluginCall) {
    val modelId = call.getString("modelId") ?: "absolute_reality"
    val width = call.getInt("width") ?: 512
    val height = call.getInt("height") ?: 512
    scope.launch {
      try {
        if (process?.isAlive == true && loadedModelId != modelId) {
          Log.i(tag, "switching model, killing prior backend"); stopBackend()
        }
        if (process?.isAlive == true && loadedModelId == modelId) {
          call.resolve(JSObject().apply { put("alreadyLoaded", true); put("modelId", modelId) }); return@launch
        }
        prepareRuntimeDir()
        if (!File(modelDir(modelId), "unet.bin").exists()) {
          call.reject("model not downloaded or extract incomplete: $modelId"); return@launch
        }
        // No convert step needed for xororz/sd-qnn bundles — they ship
        // clip_v2.mnn ready to be loaded with --use_cpu_clip per the
        // model's config in local-dream/data/Model.kt (AbsoluteReality
        // sets useCpuClip=true). The --convert mode of the binary is
        // only for raw .safetensors → MNN conversion on the CPU path.

        val t0 = System.currentTimeMillis()
        if (!startBackend(modelId, width, height)) { call.reject("backend spawn failed"); return@launch }
        val health = waitForHealthWithReason(timeoutMs = 30_000)
        if (health != "ok") {
          stopBackend(); call.reject("backend init failed: $health"); return@launch
        }
        loadedModelId = modelId
        val dt = System.currentTimeMillis() - t0
        Log.i(tag, "backend ready for $modelId in ${dt}ms")
        call.resolve(JSObject().apply { put("modelId", modelId); put("loadedMs", dt) })
      } catch (e: Throwable) {
        Log.e(tag, "initModel failed", e); call.reject("initModel failed: ${e.message}")
      }
    }
  }

  @PluginMethod
  fun generate(call: PluginCall) {
    if (process?.isAlive != true) { call.reject("backend not running — call initModel first"); return }
    val prompt = call.getString("prompt") ?: run { call.reject("prompt is required"); return }
    val negative = call.getString("negativePrompt") ?: ""
    val steps = call.getInt("steps") ?: 20
    val cfg = (call.getDouble("cfg") ?: 7.0).toFloat()
    val width = call.getInt("width") ?: 512
    val height = call.getInt("height") ?: 512
    val seed = call.getInt("seed")?.toLong()
    val outFile = File(outputDir(), "gen_${System.currentTimeMillis()}.png")
    scope.launch {
      val t0 = System.currentTimeMillis()
      try {
        val body = JSONObject().apply {
          put("prompt", prompt); put("negative_prompt", negative)
          put("steps", steps); put("cfg", cfg); put("use_cfg", true)
          put("width", width); put("height", height)
          put("denoise_strength", 1.0)
          put("use_opencl", false); put("scheduler", "euler_a")
          put("show_diffusion_process", false); put("show_diffusion_stride", 0)
          if (seed != null) put("seed", seed)
        }
        val conn = (URL("http://127.0.0.1:$port/generate").openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"; doOutput = true
          setRequestProperty("Content-Type", "application/json")
          connectTimeout = 30_000; readTimeout = 600_000
        }
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        if (conn.responseCode / 100 != 2) {
          val err = conn.errorStream?.bufferedReader()?.readText() ?: "HTTP ${conn.responseCode}"
          call.reject("backend rejected /generate: $err"); return@launch
        }
        // SSE stream: progress events carry "step"/"total_steps" (+ optional
        // "image" preview); the final "complete" event carries "image" plus
        // width/height/channels. "image" is base64 of RAW HWC uint8 pixels
        // (NOT a PNG) — we encode to PNG ourselves with Bitmap.
        var finalImgB64: String? = null; var finalW = width; var finalH = height; var finalCh = 3
        BufferedReader(InputStreamReader(conn.inputStream)).use { reader ->
          while (true) {
            val line = reader.readLine() ?: break
            if (!line.startsWith("data: ")) continue
            val data = line.substring(6).trim()
            try {
              val ev = JSONObject(data)
              val evType = ev.optString("type")
              if (evType == "progress") {
                notifyListeners("step", JSObject().apply {
                  put("step", ev.optInt("step")); put("total", ev.optInt("total_steps", steps))
                })
              } else if (evType == "complete") {
                finalImgB64 = ev.optString("image")
                finalW = ev.optInt("width", finalW)
                finalH = ev.optInt("height", finalH)
                finalCh = ev.optInt("channels", finalCh)
              }
              if (ev.has("error")) { call.reject("backend error: ${ev.optString("error")}"); return@launch }
            } catch (_: Throwable) { /* tolerated */ }
          }
        }
        val b64 = finalImgB64
        if (b64.isNullOrEmpty()) { call.reject("backend produced no image"); return@launch }
        val raw = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
        val expected = finalW * finalH * finalCh
        if (raw.size != expected) {
          call.reject("image size mismatch: got ${raw.size}, expected $expected (${finalW}x${finalH}x$finalCh)")
          return@launch
        }
        // RGB → ARGB_8888 bitmap. Backend emits HWC uint8 in RGB order.
        val pixels = IntArray(finalW * finalH)
        if (finalCh == 3) {
          var p = 0; var i = 0
          while (p < pixels.size) {
            val r = raw[i].toInt() and 0xFF
            val g = raw[i + 1].toInt() and 0xFF
            val b = raw[i + 2].toInt() and 0xFF
            pixels[p] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            p++; i += 3
          }
        } else if (finalCh == 4) {
          var p = 0; var i = 0
          while (p < pixels.size) {
            val r = raw[i].toInt() and 0xFF
            val g = raw[i + 1].toInt() and 0xFF
            val b = raw[i + 2].toInt() and 0xFF
            val a = raw[i + 3].toInt() and 0xFF
            pixels[p] = (a shl 24) or (r shl 16) or (g shl 8) or b
            p++; i += 4
          }
        } else { call.reject("unsupported channels=$finalCh"); return@launch }
        val bmp = android.graphics.Bitmap.createBitmap(pixels, finalW, finalH, android.graphics.Bitmap.Config.ARGB_8888)
        FileOutputStream(outFile).use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        call.resolve(JSObject().apply {
          put("path", outFile.absolutePath); put("ms", System.currentTimeMillis() - t0)
          put("steps", steps); put("width", width); put("height", height)
        })
      } catch (e: Throwable) {
        Log.e(tag, "generate failed", e); call.reject("generate failed: ${e.message}")
      }
    }
  }

  @PluginMethod
  fun stop(call: PluginCall) {
    stopBackend(); call.resolve(JSObject().apply { put("stopped", true) })
  }

  // ------------------------------------------------------------------
  // Runtime + subprocess management
  // ------------------------------------------------------------------

  private fun prepareRuntimeDir() {
    if (runtimeReady) return
    val dir = runtimeDir()
    val assetNames = context.assets.list("qnnlibs") ?: throw RuntimeException("qnnlibs assets missing")
    for (name in assetNames) {
      val target = File(dir, name)
      val sourceSize = context.assets.open("qnnlibs/$name").use { it.available().toLong() }
      if (target.exists() && target.length() == sourceSize) continue
      context.assets.open("qnnlibs/$name").use { input ->
        target.outputStream().use { out -> input.copyTo(out) }
      }
      target.setReadable(true, true); target.setExecutable(true, true)
    }
    dir.setReadable(true, true); dir.setExecutable(true, true)
    Log.i(tag, "Runtime libs ready at ${dir.absolutePath} (${assetNames.size} files)")
    runtimeReady = true
  }

  /**
   * Runs `libstable_diffusion_core.so --convert <modelDir>` once to
   * fuse clip_v2.mnn + token_emb.bin + pos_emb.bin into clip.bin.
   * Blocks until the subprocess exits. Returns true if the binary
   * wrote the "finished" sentinel.
   */
  private fun runConvertStep(modelId: String): Boolean {
    val nativeDir = File(context.applicationInfo.nativeLibraryDir)
    val exe = File(nativeDir, binaryName)
    val md = modelDir(modelId); val rd = runtimeDir()
    val cmd = listOf(exe.absolutePath, "--convert", md.absolutePath)
    val env = mapOf(
      "LD_LIBRARY_PATH" to listOf(rd.absolutePath, "/system/lib64", "/vendor/lib64", "/vendor/lib64/egl").joinToString(":"),
      "DSP_LIBRARY_PATH" to rd.absolutePath,
      "ADSP_LIBRARY_PATH" to rd.absolutePath,
    )
    Log.i(tag, "running convert: ${cmd.joinToString(" ")}")
    return try {
      val pb = ProcessBuilder(cmd).apply {
        directory(nativeDir); redirectErrorStream(true); environment().putAll(env)
      }
      val p = pb.start()
      // Drain stdout/stderr so the subprocess doesn't block on full pipe.
      p.inputStream.bufferedReader().use { r ->
        var line: String?
        while (r.readLine().also { line = it } != null) Log.i("Convert", line ?: "")
      }
      val code = p.waitFor()
      val finishedExists = File(md, "finished").exists()
      Log.i(tag, "convert exited code=$code, finished=$finishedExists")
      finishedExists
    } catch (e: Throwable) {
      Log.e(tag, "convert spawn failed", e); false
    }
  }

  private fun startBackend(modelId: String, width: Int, height: Int): Boolean {
    val nativeDir = File(context.applicationInfo.nativeLibraryDir)
    val executable = File(nativeDir, binaryName)
    if (!executable.exists()) { Log.e(tag, "missing $binaryName at ${executable.absolutePath}"); return false }
    val md = modelDir(modelId); val rd = runtimeDir()

    // xororz/sd-qnn bundles ship clip_v2.mnn alongside pos_emb.bin +
    // token_emb.bin. The native binary's arg parser requires the --clip
    // path to END in "clip.mnn" — when that suffix matches, it looks
    // for clip_v2.mnn in the same dir and auto-upgrades (main.cpp
    // line 690+). Passing clip_v2.mnn directly skips the upgrade and
    // never loads pos_emb/token_emb, causing a segfault later.
    val clipV2 = File(md, "clip_v2.mnn")
    if (!clipV2.exists()) {
      Log.e(tag, "clip_v2.mnn missing under ${md.absolutePath}")
      return false
    }
    val clipArgPath = File(md, "clip.mnn").absolutePath
    val vaeEncoder = File(md, "vae_encoder.bin").takeIf { it.exists() }
    val cmd = mutableListOf(
      executable.absolutePath,
      "--clip", clipArgPath,
      "--unet", File(md, "unet.bin").absolutePath,
      "--vae_decoder", File(md, "vae_decoder.bin").absolutePath,
      "--tokenizer", File(md, "tokenizer.json").absolutePath,
      "--backend", File(rd, "libQnnHtp.so").absolutePath,
      "--system_library", File(rd, "libQnnSystem.so").absolutePath,
      "--port", port.toString(),
      "--text_embedding_size", "768",
      "--use_cpu_clip",
    )
    if (vaeEncoder != null) cmd += listOf("--vae_encoder", vaeEncoder.absolutePath)
    if (width != 512 || height != 512) {
      val patch = if (width == height) File(md, "${width}.patch")
                  else File(md, "${width}x${height}.patch")
      if (patch.exists()) cmd += listOf("--patch", patch.absolutePath)
      else Log.w(tag, "no patch for ${width}x${height}; backend will likely 512×512 anyway")
    }

    // Mirror local-dream's Mali symlink resolution: the GLES_mali.so
    // symlink in /system/vendor/lib64/egl points into a SoC-specific
    // subdir (e.g. /vendor/lib64/egl/sm8650); that subdir holds vendor
    // libs the binary may dlopen. Without it we hit obscure load
    // failures depending on chipset.
    val systemLibPaths = mutableListOf(
      rd.absolutePath, "/system/lib64", "/vendor/lib64", "/vendor/lib64/egl"
    )
    try {
      val maliSymlink = File("/system/vendor/lib64/egl/libGLES_mali.so")
      if (maliSymlink.exists()) {
        val realPath = maliSymlink.canonicalPath
        val parts = realPath.split("/")
        val soc = parts.getOrNull(parts.size - 2)
        if (soc != null) {
          listOf("/vendor/lib64/$soc", "/vendor/lib64/egl/$soc").forEach {
            if (!systemLibPaths.contains(it)) systemLibPaths.add(it)
          }
        }
      }
    } catch (e: Throwable) { Log.w(tag, "Mali path resolution failed: ${e.message}") }
    val env = mutableMapOf(
      "LD_LIBRARY_PATH" to systemLibPaths.joinToString(":"),
      "DSP_LIBRARY_PATH" to rd.absolutePath,
      "ADSP_LIBRARY_PATH" to rd.absolutePath,
    )
    Log.i(tag, "spawning backend: ${cmd.joinToString(" ")}")
    return try {
      val pb = ProcessBuilder(cmd).apply {
        directory(nativeDir); redirectErrorStream(true); environment().putAll(env)
      }
      process = pb.start(); startMonitor(); true
    } catch (e: Throwable) {
      Log.e(tag, "spawn failed", e); false
    }
  }

  private fun startMonitor() {
    Thread {
      try {
        process?.let { p ->
          p.inputStream.bufferedReader().use { r ->
            var line: String?
            while (r.readLine().also { line = it } != null) Log.i("Backend", line ?: "")
          }
          val code = p.waitFor()
          Log.i(tag, "backend exited code=$code")
          loadedModelId = null
        }
      } catch (e: Throwable) { Log.e(tag, "monitor failed", e) }
    }.apply { isDaemon = true; name = "imagen-backend-mon" }.start()
  }

  private fun waitForHealth(timeoutMs: Long): Boolean =
    waitForHealthWithReason(timeoutMs) == "ok"

  /**
   * Returns "ok" if /health responds 200 before timeout, or one of:
   *   "subprocess died (exit code N, last log: \"…\")"
   *   "timeout after Ns (no /health response)"
   */
  private fun waitForHealthWithReason(timeoutMs: Long): String {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      val p = process
      if (p == null) return "subprocess never started"
      if (!p.isAlive) {
        val code = try { p.exitValue() } catch (_: Throwable) { -1 }
        return "subprocess died (exit code $code; check Backend logcat tag for native trace)"
      }
      try {
        val c = (URL("http://127.0.0.1:$port/health").openConnection() as HttpURLConnection).apply {
          connectTimeout = 500; readTimeout = 500
        }
        if (c.responseCode == 200) { c.disconnect(); return "ok" }
        c.disconnect()
      } catch (_: Throwable) {}
      Thread.sleep(200)
    }
    return "timeout after ${timeoutMs / 1000}s (subprocess alive but /health not responding)"
  }

  private fun stopBackend() {
    try { process?.destroyForcibly() } catch (_: Throwable) {}
    process = null; loadedModelId = null
  }

  override fun handleOnDestroy() { stopBackend(); super.handleOnDestroy() }
}
