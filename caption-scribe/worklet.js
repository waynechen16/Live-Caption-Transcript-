// worklet.js — AudioWorkletProcessor
// v0.4.0 起改送「原生取樣率」的 16-bit PCM（不再降採樣到 16kHz）。
// 舊版的線性插值降採樣沒有抗混疊濾波，高頻會摺疊進語音頻段造成失真，
// 影響辨識與講者分離；改由 Deepgram 端以正規 DSP 重採樣，音質更好。
// 這裡只做：雙聲道混單聲道 + float32 → int16。

class PCMConverter extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch0 = input[0];
    const ch1 = input[1];
    const out = new Int16Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      const v = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
      const s = Math.max(-1, Math.min(1, v));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}

registerProcessor('pcm-converter', PCMConverter);
