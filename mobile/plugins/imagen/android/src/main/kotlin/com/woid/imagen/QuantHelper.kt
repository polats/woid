package com.woid.imagen

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.ShortBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * uint16-affine quantization helpers matching Qualcomm AI Hub's
 * w8a16 SD bundle. The metadata.json supplies (scale, zero_point)
 * per tensor; we convert raw uint16 buffers ↔ float32 here.
 *
 * Affine formula:  fp = (uint16 - zero_point) * scale
 * Inverse:         uint16 = clamp(round(fp / scale) + zero_point, 0, 65535)
 */
object QuantHelper {

  data class QParams(val scale: Float, val zeroPoint: Int)

  fun dequantize(src: ShortBuffer, dst: FloatArray, p: QParams) {
    val n = dst.size
    src.rewind()
    for (i in 0 until n) {
      val u = src.get().toInt() and 0xFFFF
      dst[i] = (u - p.zeroPoint).toFloat() * p.scale
    }
  }

  fun quantize(src: FloatArray, dstBuf: ByteBuffer, p: QParams) {
    dstBuf.order(ByteOrder.nativeOrder()).rewind()
    val sb = dstBuf.asShortBuffer()
    val invScale = 1f / p.scale
    for (v in src) {
      val q = (v * invScale).roundToInt() + p.zeroPoint
      val clamped = max(0, min(65535, q))
      sb.put(clamped.toShort())
    }
  }

  /** Allocate a direct ByteBuffer sized for `count` uint16 elements. */
  fun allocUint16(count: Int): ByteBuffer =
    ByteBuffer.allocateDirect(count * 2).order(ByteOrder.nativeOrder())
}
