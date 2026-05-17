package com.woid.imagen

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import java.lang.reflect.Method
import java.nio.Buffer
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The ONNX Runtime Android-QNN AAR (1.24.3) doesn't expose UINT16 via
 * the public `OnnxJavaType` enum, but the SD bundle from Qualcomm AI
 * Hub uses UINT16 on every inter-stage tensor. We reach through to
 * the private native `OnnxTensor.createTensorFromBuffer(...)` helper
 * with the raw ONNX dtype code (4 = UINT16). The constructor of
 * `OnnxTensor` is package-private; we invoke it reflectively.
 *
 * If ORT ever ships a public UINT16 path, swap this out for that.
 */
object Uint16TensorFactory {

  private const val ONNX_TENSOR_TYPE_UINT16 = 4

  // Resolved once on first use; the reflection is mildly expensive.
  private val createNative: Method by lazy {
    val cls = OnnxTensor::class.java
    val m = cls.getDeclaredMethod(
      "createTensorFromBuffer",
      java.lang.Long.TYPE,
      java.lang.Long.TYPE,
      Buffer::class.java,
      java.lang.Integer.TYPE,
      java.lang.Long.TYPE,
      LongArray::class.java,
      java.lang.Integer.TYPE,
    )
    m.isAccessible = true
    m
  }

  // OnnxTensor's package-private constructor:
  //   OnnxTensor(long nativeHandle, long allocatorHandle, TensorInfo info)
  private val onnxTensorCtor by lazy {
    val tensorInfoCls = Class.forName("ai.onnxruntime.TensorInfo")
    val ctors = OnnxTensor::class.java.declaredConstructors
    ctors.first { it.parameterCount == 3 && it.parameterTypes[2] == tensorInfoCls }
      .apply { isAccessible = true }
  }

  private val tensorInfoCtor by lazy {
    val cls = Class.forName("ai.onnxruntime.TensorInfo")
    val ctors = cls.declaredConstructors
    // Pick the (long[] shape, OnnxJavaType, OnnxTensorType) ctor.
    val tt = Class.forName("ai.onnxruntime.TensorInfo\$OnnxTensorType")
    ctors.first { it.parameterCount == 3 && it.parameterTypes[0] == LongArray::class.java &&
                  it.parameterTypes[1] == OnnxJavaType::class.java &&
                  it.parameterTypes[2] == tt }
      .apply { isAccessible = true }
  }

  private val onnxTensorTypeUint16 by lazy {
    val tt = Class.forName("ai.onnxruntime.TensorInfo\$OnnxTensorType")
    @Suppress("UNCHECKED_CAST")
    val enums = tt.enumConstants as Array<Enum<*>>
    enums.first { it.name == "ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT16" }
  }

  private val apiHandleField by lazy {
    OrtEnvironment::class.java.getDeclaredField("apiHandle").apply { isAccessible = true }
  }

  private val defaultAllocator by lazy {
    val m = OrtEnvironment::class.java.getDeclaredMethod("defaultAllocator")
    m.isAccessible = true
    m.invoke(OrtEnvironment.getEnvironment())
  }

  private val allocHandleField by lazy {
    Class.forName("ai.onnxruntime.OrtAllocator")
      .getDeclaredField("handle").apply { isAccessible = true }
  }

  fun create(env: OrtEnvironment, buf: ByteBuffer, shape: LongArray): OnnxTensor {
    require(buf.isDirect) { "ByteBuffer must be direct" }
    buf.order(ByteOrder.nativeOrder()).rewind()
    val apiHandle = apiHandleField.getLong(env)
    val alloc = defaultAllocator
    val allocHandle = allocHandleField.getLong(alloc)
    val elementSize = 2L
    val bufferSize = buf.remaining()
    val nativePtr = createNative.invoke(
      null,
      apiHandle, allocHandle, buf as Buffer,
      bufferSize, elementSize, shape, ONNX_TENSOR_TYPE_UINT16,
    ) as Long

    val info = tensorInfoCtor.newInstance(shape, OnnxJavaType.UNKNOWN, onnxTensorTypeUint16)
    return onnxTensorCtor.newInstance(nativePtr, allocHandle, info) as OnnxTensor
  }
}
