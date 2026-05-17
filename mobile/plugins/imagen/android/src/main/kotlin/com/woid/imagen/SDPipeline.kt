package com.woid.imagen

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.IntBuffer

/**
 * SD 1.5 inference pipeline on Qualcomm QNN via ONNX Runtime.
 *
 * Layout from Qualcomm AI Hub metadata.json:
 *   text_encoder: int32[1,77]        -> uint16[1,77,768]   (text_embedding)
 *   unet:         uint16[1,64,64,4]   latent
 *                 uint16[1,1]         timestep
 *                 uint16[1,77,768]    text_emb
 *               -> uint16[1,64,64,4]  output_latent
 *   vae:          uint16[1,64,64,4]  -> uint16[1,512,512,3] image (NHWC)
 *
 * All tensors are NHWC. All inter-stage I/O is uint16 affine-quantized
 * — we dequantize to float32 for scheduler math then re-quantize for
 * the next QNN call.
 */
class SDPipeline(
  context: Context,
  modelDir: File,
) {
  private val tag = "SDPipeline"
  private val env = OrtEnvironment.getEnvironment()
  private val tokenizer = ClipTokenizer(context)

  private val textEncoder: OrtSession
  private val unet: OrtSession
  private val vae: OrtSession

  // Quantization params from metadata.json (snapdragon_8gen3 bundle).
  // These would normally be read out of metadata.json — hard-coded
  // here since they're stable for the bundle we ship.
  private val qTextEmbOut = QuantHelper.QParams(0.0009303585393354297f, 30063)
  private val qLatentIn   = QuantHelper.QParams(0.00024176308943424374f, 33983)
  private val qTimestepIn = QuantHelper.QParams(0.014770733192563057f, 0)
  private val qTextEmbIn  = QuantHelper.QParams(0.0009331560577265918f, 30103)
  private val qLatentOut  = QuantHelper.QParams(0.0001881735515780747f, 32340)
  private val qVaeIn      = QuantHelper.QParams(0.00034003707696683705f, 34382)
  private val qVaeOut     = QuantHelper.QParams(0.000015259021893143654f, 0)

  init {
    val opts = OrtSession.SessionOptions().apply {
      // Tell QNN exactly which Hexagon arch + SoC we're targeting; without
      // these hints the backend tries auto-detect, which fails on some
      // retail Snapdragon builds (error 1002 "Failed to load skel").
      // Values come from the bundle's metadata.json:
      //   htp_version = 75 (Hexagon V75 / Snapdragon 8 Gen 3)
      //   soc_model   = 57 (SM8650)
      // Use the OEM-signed QNN install on the phone instead of the
      // unsigned libs that ORT bundles. Samsung's Galaxy AI ships these
      // under /vendor/lib64/snap/ and the DSP daemon will pair the
      // matching signed skel (V75 for Snapdragon 8 Gen 3) automatically.
      // Falls back to the bundled libs if the file isn't readable at
      // runtime (e.g. on non-Samsung Snapdragon devices).
      val systemQnn = "/vendor/lib64/snap/libQnnHtp.so"
      val backend = if (java.io.File(systemQnn).canRead()) systemQnn else "libQnnHtp.so"
      Log.i("SDPipeline", "QNN backend_path=$backend")
      addQnn(mapOf(
        "backend_path" to backend,
        "htp_arch" to "75",
        "soc_model" to "57",
        "enable_htp_fp16_precision" to "1",
        "qnn_context_priority" to "high",
        "htp_performance_mode" to "burst",
      ))
    }
    fun load(name: String) = env.createSession(File(modelDir, name).absolutePath, opts)
    textEncoder = load("text_encoder.onnx")
    unet = load("unet.onnx")
    vae = load("vae.onnx")
    Log.i(tag, "All 3 sessions loaded with QNN EP")
  }

  fun close() {
    try { textEncoder.close() } catch (_: Throwable) {}
    try { unet.close() } catch (_: Throwable) {}
    try { vae.close() } catch (_: Throwable) {}
  }

  data class Result(val bitmap: Bitmap, val totalMs: Long, val stepMs: List<Long>)

  fun generate(
    prompt: String,
    negativePrompt: String,
    steps: Int,
    seed: Long,
    cfgScale: Float = 7.5f,
    onStep: (Int, Int) -> Unit = { _, _ -> },
  ): Result {
    val t0 = System.currentTimeMillis()

    // 1. Tokenize.
    val tokCond = tokenizer.encode(prompt)
    val tokUncond = tokenizer.encode(negativePrompt)

    // 2. Run text encoder twice.
    val textCond = runTextEncoder(tokCond)
    val textUncond = runTextEncoder(tokUncond)

    // Dequantize text embeddings → fp32 once (we re-quantize each
    // unet call against the unet's input scale).
    val textCondF = FloatArray(1 * 77 * 768)
    val textUncondF = FloatArray(1 * 77 * 768)
    QuantHelper.dequantize(textCond, textCondF, qTextEmbOut)
    QuantHelper.dequantize(textUncond, textUncondF, qTextEmbOut)

    // 3. Init latent in fp32.
    val scheduler = EulerAncestralScheduler()
    val (timesteps, sigmas) = scheduler.configure(steps)
    val latentSize = 1 * 64 * 64 * 4
    var latent = scheduler.initLatents(latentSize, sigmas[0], seed)

    // 4. Denoise loop with classifier-free guidance.
    val stepMs = ArrayList<Long>(steps)
    val noisePred = FloatArray(latentSize)
    val noisePredCond = FloatArray(latentSize)
    val noisePredUncond = FloatArray(latentSize)
    val latentDeq = FloatArray(latentSize)
    val outLatentBuf = QuantHelper.allocUint16(latentSize)

    val latentBuf = QuantHelper.allocUint16(latentSize)
    val timestepBuf = QuantHelper.allocUint16(1)
    val condEmbBuf = QuantHelper.allocUint16(1 * 77 * 768)
    val uncondEmbBuf = QuantHelper.allocUint16(1 * 77 * 768)
    QuantHelper.quantize(textCondF, condEmbBuf, qTextEmbIn)
    QuantHelper.quantize(textUncondF, uncondEmbBuf, qTextEmbIn)
    val condEmbTensor = Uint16TensorFactory.create(env, condEmbBuf, longArrayOf(1, 77, 768))
    val uncondEmbTensor = Uint16TensorFactory.create(env, uncondEmbBuf, longArrayOf(1, 77, 768))

    for (i in 0 until steps) {
      val sStart = System.currentTimeMillis()

      // (a) Quantize current latent for unet input.
      QuantHelper.quantize(latent, latentBuf, qLatentIn)
      // (b) Quantize timestep.
      val tsFloat = scheduler.timestepFor(i, timesteps)
      QuantHelper.quantize(floatArrayOf(tsFloat), timestepBuf, qTimestepIn)

      val latentTensor = Uint16TensorFactory.create(env, latentBuf, longArrayOf(1, 64, 64, 4))
      val tsTensor = Uint16TensorFactory.create(env, timestepBuf, longArrayOf(1, 1))

      // (c) Run unet once for cond, once for uncond.
      val unetIn1 = mapOf(
        "latent" to latentTensor,
        "timestep" to tsTensor,
        "text_emb" to condEmbTensor,
      )
      val outCond = unet.run(unetIn1).use { it[0].value as ShortArray }
      val outCondBuf = ByteBuffer.allocateDirect(latentSize * 2).order(ByteOrder.nativeOrder())
      outCondBuf.asShortBuffer().put(outCond)
      QuantHelper.dequantize(outCondBuf.asShortBuffer(), noisePredCond, qLatentOut)

      val unetIn2 = mapOf(
        "latent" to latentTensor,
        "timestep" to tsTensor,
        "text_emb" to uncondEmbTensor,
      )
      val outUncond = unet.run(unetIn2).use { it[0].value as ShortArray }
      val outUncondBuf = ByteBuffer.allocateDirect(latentSize * 2).order(ByteOrder.nativeOrder())
      outUncondBuf.asShortBuffer().put(outUncond)
      QuantHelper.dequantize(outUncondBuf.asShortBuffer(), noisePredUncond, qLatentOut)

      latentTensor.close(); tsTensor.close()

      // (d) CFG blend.
      for (j in 0 until latentSize) {
        noisePred[j] = noisePredUncond[j] + cfgScale * (noisePredCond[j] - noisePredUncond[j])
      }

      // (e) Euler-A step.
      scheduler.step(latent, noisePred, sigmas[i], sigmas[i + 1], seed)

      stepMs.add(System.currentTimeMillis() - sStart)
      onStep(i + 1, steps)
    }

    condEmbTensor.close(); uncondEmbTensor.close()

    // 5. VAE decode.
    val vaeInBuf = QuantHelper.allocUint16(latentSize)
    QuantHelper.quantize(latent, vaeInBuf, qVaeIn)
    val vaeTensor = Uint16TensorFactory.create(env, vaeInBuf, longArrayOf(1, 64, 64, 4))
    val imageOut = vae.run(mapOf("latent" to vaeTensor)).use { it[0].value as ShortArray }
    vaeTensor.close()

    // 6. uint16 → float32 → uint8 → Bitmap. Output is NHWC [1,512,512,3].
    val pixels = IntArray(512 * 512)
    var p = 0
    var idx = 0
    while (p < pixels.size) {
      val r = ((imageOut[idx].toInt() and 0xFFFF) * qVaeOut.scale * 255f).toInt().coerceIn(0, 255)
      val g = ((imageOut[idx + 1].toInt() and 0xFFFF) * qVaeOut.scale * 255f).toInt().coerceIn(0, 255)
      val b = ((imageOut[idx + 2].toInt() and 0xFFFF) * qVaeOut.scale * 255f).toInt().coerceIn(0, 255)
      pixels[p] = Color.rgb(r, g, b)
      idx += 3
      p++
    }
    val bmp = Bitmap.createBitmap(pixels, 512, 512, Bitmap.Config.ARGB_8888)

    return Result(bmp, System.currentTimeMillis() - t0, stepMs)
  }

  private fun runTextEncoder(tokens: IntArray): java.nio.ShortBuffer {
    val tokensBuf = ByteBuffer.allocateDirect(tokens.size * 4).order(ByteOrder.nativeOrder())
    val ib = tokensBuf.asIntBuffer()
    ib.put(tokens)
    val tensor = OnnxTensor.createTensor(env, IntBuffer.wrap(tokens), longArrayOf(1, 77))
    val out = textEncoder.run(mapOf("tokens" to tensor))
    tensor.close()
    val result = out[0].value as ShortArray
    val buf = ByteBuffer.allocateDirect(result.size * 2).order(ByteOrder.nativeOrder())
    buf.asShortBuffer().put(result)
    out.close()
    return buf.asShortBuffer()
  }
}
