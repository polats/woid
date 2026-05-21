# 2026-05-16 — mobile AI: on-device Gemma works, on-device SD blocked

Spun the Shelter game out to a real Android app via Capacitor and added
two on-device AI plugins. Text generation lands clean; image generation
hits a hardware-signing wall that's unsolvable on a retail device.

End state:
- **`@woid/capacitor-gemma`**: ✅ shipping. Gemma 4 E2B via Google's
  LiteRT-LM runtime. ~3 s per persona JSON on the Galaxy S24.
- **`@woid/capacitor-imagen`**: ⚠️ ship build uses **stable-diffusion.cpp
  at 256×256 / 8 steps** (30–90 s, lower quality). Full QNN-NPU pipeline
  is written and committed under tag `mobile-ai-qnn-attempt-2026-05-16`
  for when a Qualcomm Device Cloud / engineering-build device is
  available.

The two-line summary of why image gen is hard on retail Android: the
fast paths (Qualcomm Hexagon NPU) require **Qualcomm-signed Hexagon
skel binaries**, and modern Android's SELinux linker namespace forbids
third-party apps from `dlopen`-ing the vendor-signed copies at
`/vendor/lib64/snap/`. Every shipping consumer SD-on-Android app gets
around this through arrangements unavailable to a normal developer.

This devlog walks the four-runtime hunt that established that.

---

## What worked: Gemma 4 E2B (text)

Path: **LiteRT-LM** (Google AI Edge), Maven AAR
`com.google.ai.edge.litertlm:litertlm-android:latest.release`.

- Bundle: `gemma-4-E2B-it.litertlm` (2.59 GB) from
  `litert-community/gemma-4-E2B-it-litert-lm` on HuggingFace, anonymous.
- Plugin downloads it on first `initModel`, caches in app-private
  storage, loads on subsequent runs in ~1.5 s.
- Inference latency for a JSON-coerced persona prompt: ~3 s on the S24.
- The prompt `'You generate game NPCs… reply with ONLY a JSON object
  matching {"name", "about"}'` returned clean JSON on the first try.
  No regex hacking on the output needed beyond the existing
  `extractLivePersona()` partial-JSON tolerance.

Plugin code: `mobile/plugins/gemma/`. JS facade: `src/lib/gemmaLocal.js`.

There was no real fight here — once we found that the `.litertlm`
format is what current MediaPipe/LiteRT actually wants (after a brief
detour through the older `.task` format), it just worked.

---

## What didn't: image generation (four runtimes, four walls)

### Attempt 1 — stable-diffusion.cpp (CPU)

The first thing we built. Vendored `leejet/stable-diffusion.cpp` as a
git submodule, wrote a small JNI shim, built via NDK CMake. Works on
every Android device.

**Wall:** Speed. At 512×512 / 20 steps on the S24 (Snapdragon 8 Gen 3),
**10+ minutes per image**. The UNet sampling loop is CPU-only with
ggml; sd.cpp doesn't yet have a working OpenCL/Vulkan path on Android.

Enabled the perf flags `flash_attn=true`, `diffusion_flash_attn=true`,
and `taesd_path` pointing at `madebyollin/taesd`'s
`diffusion_pytorch_model.safetensors` — got the UNet compute buffer
from 559 → 123 MB (4.5× memory drop), but per-step wall-clock didn't
move much because the bottleneck is matmul throughput, not memory.

**Verdict:** ✅ Reliable, ❌ Too slow at production quality. Usable
at 256×256 / 8 steps (~30–90 s, noisy output) as a fallback.

### Attempt 2 — MediaPipe Image Generator (GPU via ml_drift OpenCL)

Maven AAR `com.google.mediapipe:tasks-vision-image-generator:0.10.20`.
Pure Kotlin API, no NDK. Promising on paper.

Followed the codelab (`codelabs.developers.google.com/mp-image-generation-basic-android`),
ran Google's own `mediapipe-samples/tools/image_generator_converter/convert.py`
against `v1-5-pruned-emaonly.ckpt` to produce 1040 `.bin` files.
Bundled them, called `ImageGenerator.createFromOptions(...)`.

**Wall:** Identical to what `lighteningAB/localai`'s KNOWN-ISSUES.md
documents:

```
UNKNOWN: Failed to create 2D texture (clCreateImage): Invalid image size
  at third_party/ml_drift/cl/tensor.cc:70
Calculator::Open() for "StableDiffusionIterateCalculator" failed:
  RET_CHECK failure (.../stable_diffusion_iterate_calculator.cc:253) context_
```

`ml_drift`'s OpenCL backend tries to pack certain UNet weight tensors
into 2D textures larger than the device's `CL_DEVICE_IMAGE2D_MAX_WIDTH`.
There's no API knob to work around this. Hits Adreno 750 (top-tier),
hits older GPUs, hits everyone.

Secondary confirmation: **Google's own AI Edge Gallery
`model_allowlist.json` ships zero image-generation models** in 2026,
only LLMs. They have the UI but no working bundles. They quietly
deprecated their own runtime.

**Verdict:** ❌ Library is effectively abandoned. Don't use.

### Attempt 3 — MNN (Alibaba)

After learning that Off Grid and Local Dream both use MNN (not sd.cpp),
vendored `alibaba/MNN` and configured the build for its built-in
`MNN::DIFFUSION::StableDiffusion` engine. MNN compiled clean on
Android once we worked through `MNN_KLEIDIAI=OFF`, the
`MNN_BUILD_FOR_ANDROID_COMMAND=ON` for an OBJECT-library POST_BUILD
bug, and added the `cv/cv.hpp` include path manually.

**Wall:** Two flavors of incompatibility:

1. **xororz/sd-mnn bundles** (anonymous on HF, ~1.2 GB) are
   pre-converted for **local-dream's** *custom* MNN pipeline.
   File names don't match MNN's official engine (`clip_v2.mnn` vs
   `text_encoder.mnn`), tokenizer format is `tokenizer.json` vs
   `tokenizer.mtok`. Also, local-dream is **CC-BY-NC** — we can read
   it but can't ship code derived from it commercially.
2. **wangzhaode/mnn-stable-diffusion** does ship pre-converted bundles
   with the right names — but the GitHub repo has **no LICENSE file
   at all**. Default copyright applies; legally unsafe to vendor.
3. MNN's official `StableDiffusion::load()` also requires
   `MNN_BUILD_LLM=ON` to provide the `MtokTokenizer`, AND a
   `tokenizer.mtok` file we'd have to convert ourselves (~hours of
   desktop Python work).

**Verdict:** ❌ The fast path requires non-commercial-safe code or
significant offline conversion infrastructure. Not viable for shipping.

### Attempt 4 — ONNX Runtime + Qualcomm QNN HTP (the "correct" path)

This is what `qualcomm/Stable-Diffusion-v1.5` on HF is for.
- Qualcomm AI Hub ships **precompiled QNN context binaries** for SM8650
  (~680 MB zip, anonymous S3 download). Reference device on the model
  card is literally "Samsung Galaxy S24" — same chip as ours.
- Qualcomm's published latencies: **text_encoder 2 ms + unet 80 ms/step
  + vae 205 ms** → end-to-end ~1.6 s for 20 steps on this device.
- Maven AAR: `com.microsoft.onnxruntime:onnxruntime-android-qnn:1.24.3`
  — pure Java/Kotlin, no NDK on our side.

Wrote the full pipeline: CLIP BPE tokenizer (~200 LOC port of
`openai/CLIP`'s `simple_tokenizer.py`), Euler-A scheduler (~100 LOC),
uint16↔fp32 quantization helpers, SD pipeline orchestrator with
classifier-free guidance (~300 LOC). Plus a reflection-based UINT16
tensor factory because the ORT Java API's public `OnnxJavaType` enum
inexplicably omits UINT16 even though the C++ side fully supports it.

Build passed. Plugin loaded.

**Wall (the real one):** Three nested SELinux/signing issues, hit in
order as we worked through them:

1. `libcdsprpc.so` not found.
   → Fixed by adding
   `<uses-native-library android:name="libcdsprpc.so" android:required="true"/>`
   to the app manifest. (`libcdsprpc.so` is on Android's public vendor
   lib allowlist.)

2. `QnnDsp <E> Failed to load skel, error: 1002` —
   `QNN_DEVICE_ERROR_INVALID_CONFIG`.
   The ORT AAR's bundled `libQnnHtpV75Skel.so` is **unsigned**. The
   Hexagon DSP on a retail device's FastRPC framework refuses to load
   unsigned skels. Verified by examining
   `/opt/qcom/aistack/qairt/2.45.0.260326/lib/hexagon-v75/unsigned/`
   in the QAIRT SDK — Qualcomm only distributes the unsigned variant
   to general developers; the signed variant is bundled into device
   firmware via OEM channels.

3. Trying to point ORT at the **OEM-signed** copy at
   `/vendor/lib64/snap/libQnnHtp.so` (Samsung's Galaxy AI install)
   produced:
   ```
   library "/vendor/lib64/snap/libQnnHtp.so" is not accessible for the
   namespace: [name="clns-9", permitted_paths="/data:/mnt/expand:/data/data/com.woid.shelter"]
   ```
   The app's linker namespace has `/data` paths in its permitted list
   but **no `/vendor` path**. `<uses-native-library>` only works for
   libs on Android's *public* vendor allowlist, not arbitrary
   vendor-partition files. Samsung's `Galaxy AI` apps reach these libs
   because they're privileged system apps (signed by Samsung with
   `system_app` certificate).

4. Couldn't override DSP signing via system property:
   `setprop vendor.fastrpc.process.attrs 1` requires root and
   `/system/bin/su` doesn't exist on this device.

**Verdict:** The QNN HTP path is architecturally correct and would
work on:
- A Qualcomm Device Cloud (QDC) device with engineering-mode Android
- A rooted Snapdragon device
- A device where the OEM whitelisted QNN libs for third-party apps

It does **not** work on a sealed retail consumer device like the S24.
This matches Qualcomm's own warning in
`ai-hub-apps/apps/chatapp_android/README.md`:
> "This app requires a **mobile** device with Android 15+. It may work
> on select Android 14 devices... The Genie SDK requires newer
> meta-build... Depending on which meta-build is picked by your phone
> vendor, this feature may or may not work."

---

## How the published apps actually do it

Every consumer-facing app with fast on-device SD on Android in 2026
falls into one of these:

| App | Stack | How they get DSP access |
|-----|-------|------------------------|
| Local Dream (xororz) | MNN + QNN + custom C++ pipeline | Vendors local-dream's CC-BY-NC code (won't fly for a commercial product without negotiation) |
| Off Grid (alichherawalla) | local-dream lib + MNN/QNN | Same |
| lighteningAB/localai | QNN direct after MediaPipe + LiteRT dead-ends | Documents the same wall and pivots to QDC test devices |
| Google AI Edge Gallery | MediaPipe Image Generator | **Doesn't ship any SD models in 2026** — only LLMs |
| Samsung Galaxy AI | QNN direct | OEM-privileged system app, accesses `/vendor/lib64/snap/` directly |

There isn't a permissive-license, anonymous-download, retail-device-
compatible recipe for fast on-device SD on Android as of May 2026.

---

## What we shipped instead

`@woid/capacitor-imagen` reverts to **stable-diffusion.cpp at
256×256 / 8 steps**, with `flash_attn` + TAESD. Realistic latency
on the S24: 30–90 s per portrait. Quality is noticeably below cloud
SDXL but adequate for a stylized game NPC headshot.

UX shape: the existing Personas page button now reads
**"Download model + generate"** (1.57 GB + 5 MB TAESD on first run),
then **"Generate avatar"** for subsequent calls.

When a fast path becomes possible on commodity Android (Samsung opens
Galaxy AI to third-parties, Qualcomm signs distribution skels, or
Snapdragon Elite Gen 5 changes the signing model), checkout the tag
`mobile-ai-qnn-attempt-2026-05-16` and resume from there — the
pipeline code, CLIP tokenizer, scheduler, and quantization helpers
are all production-ready, just gated on the signing question.

---

## Notes for the next time someone touches this

- The native `android/` Capacitor project is gitignored. It gets
  regenerated by `npm run mobile:add:android`. Two manifest edits
  need to be re-applied each time:
  - `<application android:networkSecurityConfig="@xml/network_security_config">`
    + a `res/xml/network_security_config.xml` allowing cleartext to
    `127.0.0.1` (for adb-reverse-served dev model files).
  - `<uses-native-library android:name="libcdsprpc.so" android:required="true"/>`
    (needed by the QNN path; harmless when running sd.cpp).
- QPM3 / QAIRT SDK install on Ubuntu 25.10 needs older libldap-2.4 +
  heimdal-gssapi compat libs (we extracted them from Ubuntu 20.04
  archives at `/tmp/ldap24` and `/tmp/heimdal`). See the install
  thread in this devlog's commit history for the exact apt URLs.
- `mobile/build-mobile.mjs` is the canonical mobile build entry point.
  Runs `vite build`, copies `dist/` → `dist-mobile/`, patches
  `index.html` to set `location.hash = '#/shelter'` on launch and add
  `viewport-fit=cover`. The original `dist/` is untouched so the
  Vercel web deploy is unaffected.
- `@woid/capacitor-gemma` is sound and unrelated to the SD mess; it
  was working from Phase B onward and didn't need any of this.
