package com.woid.imagen

import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * Euler-A scheduler for SD 1.5 (1000-step DDIM training schedule,
 * resampled to N inference steps). Standard HF Diffusers maths.
 */
class EulerAncestralScheduler(
  numTrainSteps: Int = 1000,
  betaStart: Float = 0.00085f,
  betaEnd: Float = 0.012f,
) {
  private val alphasCumprod: FloatArray
  private val sigmasAll: FloatArray   // length = numTrainSteps

  init {
    // Linear-beta schedule in sqrt-space (the SD 1.5 convention).
    val betas = FloatArray(numTrainSteps) {
      val t = sqrt(betaStart) + (sqrt(betaEnd) - sqrt(betaStart)) * (it.toFloat() / (numTrainSteps - 1))
      t * t
    }
    alphasCumprod = FloatArray(numTrainSteps)
    var acc = 1f
    for (i in 0 until numTrainSteps) {
      acc *= (1f - betas[i])
      alphasCumprod[i] = acc
    }
    sigmasAll = FloatArray(numTrainSteps) {
      sqrt((1f - alphasCumprod[it]) / alphasCumprod[it])
    }
  }

  /**
   * Sample uniformly-spaced N timesteps + their sigmas. Returns
   * (timesteps[N], sigmas[N+1])  — last sigma is 0 to terminate.
   */
  fun configure(numInferenceSteps: Int): Pair<IntArray, FloatArray> {
    val step = (sigmasAll.size - 1).toFloat() / (numInferenceSteps - 1)
    val timesteps = IntArray(numInferenceSteps) {
      (sigmasAll.size - 1 - (it * step)).toInt().coerceAtLeast(0)
    }
    val sigmas = FloatArray(numInferenceSteps + 1)
    for (i in 0 until numInferenceSteps) sigmas[i] = sigmasAll[timesteps[i]]
    sigmas[numInferenceSteps] = 0f
    return Pair(timesteps, sigmas)
  }

  /** Initial scaled noise. SD 1.5 init = N(0,1) * sigmas[0]. */
  fun initLatents(shapeTotal: Int, sigma0: Float, seed: Long): FloatArray {
    val rng = Random(seed)
    val out = FloatArray(shapeTotal)
    var i = 0
    while (i < shapeTotal) {
      // Box-Muller
      val u1 = (rng.nextDouble().coerceAtLeast(1e-7)).toFloat()
      val u2 = rng.nextDouble().toFloat()
      val r = sqrt(-2f * ln(u1))
      val z1 = r * kotlin.math.cos(2f * Math.PI.toFloat() * u2)
      val z2 = r * kotlin.math.sin(2f * Math.PI.toFloat() * u2)
      out[i] = z1 * sigma0
      if (i + 1 < shapeTotal) out[i + 1] = z2 * sigma0
      i += 2
    }
    return out
  }

  /**
   * Euler-A step: given current latents x_i, the model's noise
   * prediction at sigma_i, and the next sigma_{i+1}, advance to x_{i+1}.
   * Mutates `latent` in place.
   */
  fun step(
    latent: FloatArray,
    noisePred: FloatArray,
    sigma: Float,
    sigmaNext: Float,
    seed: Long,
  ) {
    // Euler-A: split sigmaNext into a deterministic "down" component and
    // a stochastic "up" component. HF Diffusers reference:
    //   sigma_down = sqrt(sigma_next^2 - sigma_up^2)
    //   sigma_up   = min(sigma_next, sqrt(sigma_next^2 * (sigma^2 - sigma_next^2) / sigma^2))
    val sigmaUp: Float
    val sigmaDown: Float
    if (sigmaNext == 0f) {
      sigmaUp = 0f; sigmaDown = 0f
    } else {
      val sigmaNext2 = sigmaNext * sigmaNext
      val sigma2 = sigma * sigma
      val candidate = sqrt(sigmaNext2 * (sigma2 - sigmaNext2) / sigma2)
      sigmaUp = if (candidate.isNaN()) 0f else kotlin.math.min(sigmaNext, candidate)
      sigmaDown = sqrt(kotlin.math.max(0f, sigmaNext2 - sigmaUp * sigmaUp))
    }
    val dt = sigmaDown - sigma
    val rng = Random(seed * 1000003L + sigma.toRawBits().toLong())
    val n = latent.size
    var i = 0
    while (i < n) {
      val denoised = latent[i] - sigma * noisePred[i]
      // Euler step toward denoised
      val derivative = (latent[i] - denoised) / sigma
      var next = latent[i] + derivative * dt
      // Add stochastic noise scaled by sigma_up
      if (sigmaUp > 0f) {
        val u1 = rng.nextDouble().coerceAtLeast(1e-7).toFloat()
        val u2 = rng.nextDouble().toFloat()
        val z = sqrt(-2f * ln(u1)) * kotlin.math.cos(2f * Math.PI.toFloat() * u2)
        next += sigmaUp * z
      }
      latent[i] = next
      i++
    }
  }

  /** Maps the scheduler's logical timestep index back to the model's
   *  expected timestep value (here it's just the same int).  */
  fun timestepFor(i: Int, timesteps: IntArray): Float = timesteps[i].toFloat()
}
