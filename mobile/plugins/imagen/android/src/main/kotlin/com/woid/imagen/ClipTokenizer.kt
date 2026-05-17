package com.woid.imagen

import android.content.Context
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * CLIP BPE tokenizer (vocab size 49408, context length 77).
 *
 * Port of openai/CLIP's `simple_tokenizer.py`. Reads
 * `bpe_simple_vocab_16e6.txt` from app assets — same vocab the SD 1.5
 * text encoder was trained on.
 *
 * Output is `IntArray(77)` of token IDs ready to feed the QNN-compiled
 * text_encoder.onnx (which expects `tokens [1, 77] int32`).
 */
class ClipTokenizer(context: Context) {
  companion object {
    const val MAX_LEN = 77
    const val SOS_TOKEN = 49406   // <|startoftext|>
    const val EOS_TOKEN = 49407   // <|endoftext|>
    const val VOCAB_SIZE = 49408
  }

  // bytes_to_unicode: CLIP maps each of the 256 byte values to a visible
  // unicode codepoint so the BPE algorithm can operate on character
  // strings instead of bytes. Same construction as the Python ref:
  // start with ASCII printable + Latin extended, fill remaining bytes
  // with mappings into the U+0100+ range.
  private val byteEncoder: IntArray   // byte -> unicode codepoint
  private val byteDecoder: HashMap<Int, Int>

  // BPE merge ranks: pair-of-tokens -> rank (lower = applied earlier).
  private val bpeRanks: HashMap<Pair<String, String>, Int>

  // token -> id mapping
  private val encoder: HashMap<String, Int>

  // Cache pretokenized words to avoid re-running BPE on common tokens.
  private val bpeCache = HashMap<String, List<String>>()

  // Pre-tokenize pattern. Same regex CLIP uses (sans the punctuation
  // class fixes the original Python regex applies).
  private val pat = Regex(
    """<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+""",
    RegexOption.IGNORE_CASE,
  )

  init {
    val (be, bd) = buildBytesToUnicode()
    byteEncoder = be
    byteDecoder = bd

    // Load merges from assets.
    val merges = ArrayList<Pair<String, String>>(48894)
    context.assets.open("bpe_simple_vocab_16e6.txt").use { stream ->
      BufferedReader(InputStreamReader(stream)).useLines { lines ->
        var i = 0
        for (rawLine in lines) {
          // First line is a version header — skip if it doesn't look
          // like a "tokenA tokenB" merge pair.
          if (i == 0 && rawLine.startsWith("\"") || rawLine.contains("version")) { i++; continue }
          val space = rawLine.indexOf(' ')
          if (space <= 0) continue
          merges.add(Pair(rawLine.substring(0, space), rawLine.substring(space + 1)))
          i++
          if (merges.size >= 48894) break
        }
      }
    }
    bpeRanks = HashMap(merges.size * 2)
    for ((rank, m) in merges.withIndex()) bpeRanks[m] = rank

    // Build vocab. CLIP's vocab construction:
    //   0..255         -> single-byte-as-unicode tokens
    //   256..511       -> same tokens but with </w> suffix
    //   then BPE merges turned into combined tokens
    //   plus </w>-suffix variants
    //   then <|startoftext|> + <|endoftext|>
    val vocab = ArrayList<String>(VOCAB_SIZE)
    for (cp in byteEncoder) vocab.add(String(Character.toChars(cp)))
    for (cp in byteEncoder) vocab.add(String(Character.toChars(cp)) + "</w>")
    for (m in merges) vocab.add(m.first + m.second)
    vocab.add("<|startoftext|>")
    vocab.add("<|endoftext|>")
    encoder = HashMap(vocab.size * 2)
    for ((i, t) in vocab.withIndex()) encoder[t] = i
  }

  fun encode(text: String): IntArray {
    val out = IntArray(MAX_LEN)
    out[0] = SOS_TOKEN
    var idx = 1
    val cleaned = cleanText(text).lowercase()
    pat.findAll(cleaned).forEach { match ->
      val tok = match.value
      val bytes = tok.toByteArray(Charsets.UTF_8)
      val mapped = StringBuilder(bytes.size)
      for (b in bytes) mapped.appendCodePoint(byteEncoder[b.toInt() and 0xFF])
      val word = mapped.toString()
      val bpeTokens = bpe(word)
      for (bt in bpeTokens) {
        if (idx >= MAX_LEN - 1) break
        val id = encoder[bt] ?: continue
        out[idx++] = id
      }
      if (idx >= MAX_LEN - 1) return@forEach
    }
    // Fill remainder with EOS (CLIP pads to MAX_LEN with EOS).
    out[idx.coerceAtMost(MAX_LEN - 1)] = EOS_TOKEN
    for (j in (idx + 1) until MAX_LEN) out[j] = EOS_TOKEN
    return out
  }

  private fun bpe(token: String): List<String> {
    bpeCache[token]?.let { return it }
    if (token.isEmpty()) return emptyList()
    // Initial word: each character as a separate "token", with </w> on the
    // final character.
    var word = mutableListOf<String>().apply {
      val cps = token.codePoints().toArray()
      for ((i, cp) in cps.withIndex()) {
        val piece = String(Character.toChars(cp))
        if (i == cps.size - 1) add(piece + "</w>") else add(piece)
      }
    }
    if (word.size == 1) {
      val r = listOf(word[0])
      bpeCache[token] = r
      return r
    }
    while (true) {
      // Find the highest-priority adjacent pair (lowest rank value).
      var bestRank = Int.MAX_VALUE
      var bestIdx = -1
      for (i in 0 until word.size - 1) {
        val r = bpeRanks[Pair(word[i], word[i + 1])] ?: continue
        if (r < bestRank) { bestRank = r; bestIdx = i }
      }
      if (bestIdx < 0) break
      // Merge that pair.
      val merged = word[bestIdx] + word[bestIdx + 1]
      val next = ArrayList<String>(word.size - 1)
      var i = 0
      while (i < word.size) {
        if (i == bestIdx) { next.add(merged); i += 2 } else { next.add(word[i]); i++ }
      }
      word = next
      if (word.size == 1) break
    }
    bpeCache[token] = word
    return word
  }

  // CLIP "basic clean": replace fancy quotes etc. (subset of the Python
  // ref — sufficient for typical English prompts).
  private fun cleanText(s: String): String {
    val sb = StringBuilder(s.length)
    var lastSpace = true
    for (ch in s.trim()) {
      val c = when (ch) {
        '‘', '’' -> '\''
        '“', '”' -> '"'
        '–', '—' -> '-'
        else -> ch
      }
      if (c.isWhitespace()) {
        if (!lastSpace) { sb.append(' '); lastSpace = true }
      } else {
        sb.append(c); lastSpace = false
      }
    }
    return sb.toString()
  }

  // Same construction as CLIP's bytes_to_unicode().
  private fun buildBytesToUnicode(): Pair<IntArray, HashMap<Int, Int>> {
    val bs = ArrayList<Int>(188)
    val printable: (Int) -> Boolean = { b ->
      (b in 33..126) || (b in 161..172) || (b in 174..255)
    }
    for (b in 0..255) if (printable(b)) bs.add(b)
    val cs = bs.toMutableList()
    var n = 0
    for (b in 0..255) {
      if (!printable(b)) {
        bs.add(b)
        cs.add(256 + n)
        n++
      }
    }
    val encoder = IntArray(256)
    val decoder = HashMap<Int, Int>(256)
    for (i in bs.indices) {
      encoder[bs[i]] = cs[i]
      decoder[cs[i]] = bs[i]
    }
    return Pair(encoder, decoder)
  }
}
