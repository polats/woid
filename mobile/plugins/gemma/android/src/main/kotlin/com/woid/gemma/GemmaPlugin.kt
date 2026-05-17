package com.woid.gemma

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * On-device Gemma 4 inference via Google's LiteRT-LM runtime.
 * Surface mirrors the JS facade in src/lib/gemmaLocal.js:
 *   downloadModel({url}) -> { path, sizeBytes }   (emits "download-progress")
 *   modelStatus()        -> { present, path, sizeBytes, loaded }
 *   initModel()          -> { loadedMs }
 *   generate({prompt})   -> { full, ms }          (emits "token")
 *   ping()               -> sanity probe
 */
@CapacitorPlugin(name = "Gemma")
class GemmaPlugin : Plugin() {

  private val tag = "GemmaPlugin"
  // LiteRT-LM .litertlm format. The earlier MediaPipe .task we tried
  // is web-only; LiteRT-LM is the canonical Android path for Gemma 4.
  private val modelFilename = "gemma-4-E2B-it.litertlm"

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var engine: Engine? = null
  private var conversation: Conversation? = null

  override fun load() {
    Log.i(tag, "Gemma plugin loaded — LiteRT-LM runtime")
  }

  private fun modelFile(): File = File(context.filesDir, modelFilename)

  @PluginMethod
  fun ping(call: PluginCall) {
    val ret = JSObject().apply {
      put("ok", true)
      put("phase", "C")
      put("runtime", "litert-lm")
      put("modelPresent", modelFile().exists())
      put("modelLoaded", engine != null)
    }
    call.resolve(ret)
  }

  @PluginMethod
  fun modelStatus(call: PluginCall) {
    val f = modelFile()
    val ret = JSObject().apply {
      put("present", f.exists())
      put("path", f.absolutePath)
      put("sizeBytes", if (f.exists()) f.length() else 0L)
      put("loaded", engine != null)
    }
    call.resolve(ret)
  }

  @PluginMethod
  fun downloadModel(call: PluginCall) {
    val url = call.getString("url")
    if (url.isNullOrEmpty()) { call.reject("url is required"); return }
    val dst = modelFile()
    if (dst.exists() && dst.length() > 0) {
      call.resolve(JSObject().apply {
        put("alreadyPresent", true)
        put("path", dst.absolutePath)
        put("sizeBytes", dst.length())
      })
      return
    }
    val tmp = File(dst.absolutePath + ".part")
    scope.launch {
      var conn: HttpURLConnection? = null
      try {
        conn = (URL(url).openConnection() as HttpURLConnection).apply {
          instanceFollowRedirects = true
          connectTimeout = 30_000
          readTimeout = 60_000
          connect()
        }
        val code = conn.responseCode
        if (code / 100 != 2) { call.reject("HTTP $code from $url"); return@launch }
        val total = conn.contentLengthLong
        val startMs = System.currentTimeMillis()
        var lastEmitMs = 0L
        var got = 0L
        conn.inputStream.use { input ->
          FileOutputStream(tmp).use { out ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf)
              if (n <= 0) break
              out.write(buf, 0, n)
              got += n
              val now = System.currentTimeMillis()
              if (now - lastEmitMs > 250 || got == total) {
                val elapsed = (now - startMs).coerceAtLeast(1)
                val ev = JSObject().apply {
                  put("got", got)
                  put("total", total)
                  put("bytesPerSec", (got * 1000L) / elapsed)
                }
                notifyListeners("download-progress", ev)
                lastEmitMs = now
              }
            }
            out.flush()
          }
        }
        if (!tmp.renameTo(dst)) { call.reject("rename failed: $tmp -> $dst"); return@launch }
        call.resolve(JSObject().apply {
          put("path", dst.absolutePath)
          put("sizeBytes", dst.length())
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

  @PluginMethod
  fun initModel(call: PluginCall) {
    val f = modelFile()
    if (!f.exists()) { call.reject("model not downloaded"); return }
    if (engine != null) {
      call.resolve(JSObject().apply { put("alreadyLoaded", true) })
      return
    }
    scope.launch {
      try {
        val t0 = System.currentTimeMillis()
        val cfg = EngineConfig(modelPath = f.absolutePath, backend = Backend.CPU())
        val e = Engine(cfg)
        e.initialize()
        engine = e
        conversation = e.createConversation()
        val dt = System.currentTimeMillis() - t0
        Log.i(tag, "LiteRT-LM engine loaded in ${dt}ms")
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
    val conv = conversation
    if (conv == null) { call.reject("model not initialized — call initModel first"); return }
    scope.launch {
      try {
        val t0 = System.currentTimeMillis()
        val sb = StringBuilder()
        conv.sendMessageAsync(prompt).collect { chunk ->
          sb.append(chunk)
          val ev = JSObject().apply { put("delta", chunk) }
          notifyListeners("token", ev)
        }
        val dt = System.currentTimeMillis() - t0
        call.resolve(JSObject().apply {
          put("full", sb.toString())
          put("ms", dt)
        })
      } catch (e: Throwable) {
        Log.e(tag, "generate failed", e)
        call.reject("generate failed: ${e.message}")
      }
    }
  }

  override fun handleOnDestroy() {
    try { conversation?.close() } catch (_: Throwable) {}
    try { engine?.close() } catch (_: Throwable) {}
    conversation = null
    engine = null
    super.handleOnDestroy()
  }
}
