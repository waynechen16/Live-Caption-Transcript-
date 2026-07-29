// offscreen.js — Caption Scribe（DOM 版）
// 自 meeting-scribe offscreen.js 移植，只保留錄音功能（去掉 Deepgram 辨識）：
// 分頁聲音（＋選用麥克風混音）→ worklet PCM → lamejs 即時增量 MP3 編碼
// 記憶體只留壓縮後資料 ≈ 18MB / 小時（40kbps 單聲道）

let audioCtx = null;
let mediaStream = null;
let micStream = null;

const MP3_KBPS = 40;
let mp3 = null;        // { chunks: [Uint8Array], encoder, rate }
let pcmQueue = [];
let pcmQueued = 0;

function mp3NewEncoder(rate) {
  if (typeof lamejs === 'undefined') return;  // 編碼器載入失敗時不影響主流程
  if (!mp3) mp3 = { chunks: [], encoder: null, rate };
  mp3.rate = rate;
  mp3.encoder = new lamejs.Mp3Encoder(1, rate, MP3_KBPS);
}

function feedPcm(buf) {
  if (!mp3 || !mp3.encoder) return;
  const arr = new Int16Array(buf);
  pcmQueue.push(arr);
  pcmQueued += arr.length;
  if (pcmQueued >= 4608) flushPcmQueue();  // 湊滿數個 MP3 frame 再編碼
}

function flushPcmQueue() {
  if (!mp3 || !mp3.encoder || !pcmQueued) { pcmQueue = []; pcmQueued = 0; return; }
  const all = new Int16Array(pcmQueued);
  let o = 0;
  for (const a of pcmQueue) { all.set(a, o); o += a.length; }
  pcmQueue = []; pcmQueued = 0;
  const d = mp3.encoder.encodeBuffer(all);
  if (d.length) mp3.chunks.push(new Uint8Array(d));
}

function mp3FinishEncoder() {
  if (!mp3 || !mp3.encoder) return;
  flushPcmQueue();
  const d = mp3.encoder.flush();
  if (d.length) mp3.chunks.push(new Uint8Array(d));
  mp3.encoder = null;
}

// 「清除」：丟掉累積的錄音；若正在擷取中則立刻以新 encoder 續錄
function audioReset() {
  pcmQueue = []; pcmQueued = 0;
  if (!mp3) return;
  const wasEncoding = !!mp3.encoder;
  mp3.chunks = [];
  mp3.encoder = null;
  if (wasEncoding) mp3NewEncoder(mp3.rate);
}

// 「音檔」存檔：收尾目前的流 → blob URL 交給 background 下載；
// 若仍在錄音中就開新 encoder 續錄（之後再存仍包含全程，MP3 流串接可正常播放）
function audioSave() {
  if (!mp3) return { ok: false, error: '尚無錄音資料' };
  mp3FinishEncoder();
  if (!mp3.chunks.length) return { ok: false, error: '尚無錄音資料' };
  const blob = new Blob(mp3.chunks, { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  if (mediaStream) mp3NewEncoder(mp3.rate);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const filename = `caption-audio-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.mp3`;
  return { ok: true, url, filename };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'OFFSCREEN_START') start(msg.streamId, msg.settings || {});
  if (msg.type === 'OFFSCREEN_STOP') stop();
  if (msg.type === 'AUDIO_RESET') audioReset();
  if (msg.type === 'AUDIO_SAVE') sendResponse(audioSave());
  if (msg.type === 'AUDIO_DOWNLOAD_FALLBACK') {
    const a = document.createElement('a');
    a.href = msg.url;
    a.download = msg.filename;
    a.click();
    sendResponse({ ok: true });
  }
});

async function start(streamId, settings) {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (e) {
    return reportError('無法擷取分頁聲音：' + e.message);
  }

  // 麥克風混音（把「我自己的發言」也錄進去）
  // echoCancellation 會把喇叭放出的遠端聲音從麥克風訊號中消掉；戴耳機效果最好。
  // 授權失敗時降級為只錄分頁聲音。
  micStream = null;
  if (settings.micEnabled) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      reportError('無法取得麥克風，將只錄分頁聲音（請從外掛設定重新授權）');
    }
  }

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  source.connect(audioCtx.destination); // 保持原音播放（僅分頁聲音；麥克風不外放避免回授）

  await audioCtx.audioWorklet.addModule('worklet.js');
  const worklet = new AudioWorkletNode(audioCtx, 'pcm-converter');
  const mixer = audioCtx.createGain();
  source.connect(mixer);
  if (micStream) {
    audioCtx.createMediaStreamSource(micStream).connect(mixer);
  }
  mixer.connect(worklet);

  // 上一段若未收尾先收，然後開新 encoder（既有 chunks 保留＝接續錄）
  mp3FinishEncoder();
  mp3NewEncoder(audioCtx.sampleRate);

  worklet.port.onmessage = (e) => feedPcm(e.data);
}

function reportError(error) {
  chrome.runtime.sendMessage({ type: 'REC_ERROR', error }).catch(() => {});
}

function stop() {
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  mp3FinishEncoder();  // 收尾 MP3 流；資料保留，停止後仍可按「音檔」匯出
}
