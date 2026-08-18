// background.js — Caption Scribe（DOM 版）v1.1
// 職責：
//   1. 雙語翻譯服務（DeepL / Gemini）——邏輯自 meeting-scribe 移植；
//      中英夾雜時「只翻譯英文、中文原樣保留」
//   2. 錄音管理（自 meeting-scribe 移植）：tabCapture streamId → offscreen 錄音 → MP3 下載

let recTabId = null;

// ================= 翻譯 =================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'TRANSLATE') {
    translate(String(msg.text || ''))
      .then((r) => sendResponse(r))
      .catch(() => sendResponse({ zh: '(翻譯失敗)' }));
    return true; // async sendResponse
  }

  if (msg.type === 'START_REC' || msg.type === 'STOP_REC' || msg.type === 'SAVE_AUDIO' || msg.type === 'REC_ERROR') {
    handleRec(msg, sender, sendResponse);
    return true;
  }

  if (msg.type === 'AUDIO_RESET') {
    // content「清除」→ 同步清掉錄音緩衝（offscreen 若存在會收到同一則廣播）
    chrome.storage.local.set({ cs_recActive: false });
    return;
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCfg() {
  return chrome.storage.local.get(['provider', 'deeplKey', 'geminiKey', 'cs_skipFewEn']);
}

async function translate(text) {
  // 只輸出繁中譯文（不做中→英）。規則：
  //   純中文 → 不翻譯、不呼叫 API（zh = 原文）
  //   純英文 → 整句翻成繁中
  //   中英夾雜 → 中文片段一字不動，只把英文片段換成中文
  //     例：「這是一本book，放在桌上。」→「這是一本書，放在桌上。」
  //   省額度選項（預設開）：夾雜句英文 ≤ 2 個單字 → 不翻譯、不呼叫 API
  if (!text.trim()) return { zh: '' };
  const hasCJK = /[㐀-鿿豈-﫿]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  if (hasCJK && !hasLatin) return { zh: text };   // 純中文 → 不翻
  const cfg = await getCfg();
  if (hasCJK && hasLatin && cfg.cs_skipFewEn !== false) {
    const enWords = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
    if (enWords <= 2) return { zh: text };        // 只有一兩個英文單字 → 原樣顯示
  }
  if ((cfg.provider || 'deepl') === 'gemini') return geminiZh(text, cfg);
  if (!hasCJK) return { zh: await deepl(text, 'ZH-HANT', cfg) };        // 純英文 → 整句翻
  return { zh: await deeplMixed(text, cfg) };                           // 夾雜 → 只翻英文片段
}

// 中英夾雜（DeepL）：抽出英文片段逐段翻譯，中文片段原樣拼回。
// 把整句當 context 傳給 DeepL，讓短片段也能依上下文選對詞義。
async function deeplMixed(text, cfg) {
  const chunks = [];
  const re = /[A-Za-z][A-Za-z0-9'’\- ]*[A-Za-z0-9]|[A-Za-z]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    chunks.push({ start: m.index, end: m.index + m[0].length, src: m[0] });
  }
  if (!chunks.length) return text;
  const translated = await deeplBatch(chunks.map((c) => c.src), 'ZH-HANT', cfg, text);
  if (typeof translated === 'string') return translated;   // 錯誤訊息
  if (!translated) return '(翻譯連線失敗)';
  let out = '';
  let pos = 0;
  chunks.forEach((c, i) => {
    out += text.slice(pos, c.start) + (translated[i] || c.src);
    pos = c.end;
  });
  out += text.slice(pos);
  return out;
}

async function deeplBatch(texts, target, cfg, context) {
  if (!cfg.deeplKey) return null;
  const endpoint = cfg.deeplKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  try {
    const body = { text: texts, target_lang: target };
    if (context) body.context = context;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${cfg.deeplKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (res.status === 456) return '(DeepL 本月免費額度已用完)';
    if (!res.ok) return `(翻譯失敗 ${res.status})`;
    const data = await res.json();
    return texts.map((t, i) => data.translations?.[i]?.text || t);
  } catch {
    return null;
  }
}

async function deepl(text, target, cfg) {
  if (!cfg.deeplKey) return '(未設定 DeepL key)';
  const endpoint = cfg.deeplKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${cfg.deeplKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: [text], target_lang: target })
    });
    if (res.status === 456) return '(DeepL 本月免費額度已用完)';
    if (!res.ok) return `(翻譯失敗 ${res.status})`;
    const data = await res.json();
    return data.translations?.[0]?.text || '';
  } catch {
    return '(翻譯連線失敗)';
  }
}

// ================= Gemini（含穩定性強化） =================
// 失敗常見原因與對策：
//   429（免費層速率限制）→ 全域排隊、每次請求間隔 GEMINI_GAP_MS；429/5xx 退避後重試一次
//   404（模型名稱失效）→ 依 GEMINI_MODELS 備援鏈自動換模型，成功的記住下次直接用
//   JSON 解析失敗 → 去除 code fence 再解析
//   仍然失敗 → 若有 DeepL key 自動改用 DeepL 備援
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
const GEMINI_GAP_MS = 1200;
let geminiGoodModel = null;
let geminiLastAt = 0;
let geminiChain = Promise.resolve();

function geminiQueued(fn) {
  const p = geminiChain.then(async () => {
    const wait = geminiLastAt + GEMINI_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); }
    finally { geminiLastAt = Date.now(); }
  });
  geminiChain = p.catch(() => {});
  return p;
}

async function geminiOnce(text, cfg) {
  const models = geminiGoodModel
    ? [geminiGoodModel, ...GEMINI_MODELS.filter((m) => m !== geminiGoodModel)]
    : GEMINI_MODELS.slice();
  const prompt =
    'You are a meeting interpreter. The utterance below may be Chinese, English, or mixed. ' +
    'Return ONLY JSON: {"zh":"..."}. Rules: ' +
    'translate the English portions into Traditional Chinese, but keep every existing Chinese ' +
    'portion EXACTLY as written (do not rephrase it); the result reads as one natural sentence. ' +
    'If the utterance is pure English, "zh" is its full Traditional Chinese translation. ' +
    "If pure Chinese, copy it as-is.\n\nUtterance: " + text;
  let lastErr = '(翻譯連線失敗)';
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
            })
          }
        );
        if (res.status === 404) { lastErr = '(Gemini 模型不可用)'; break; }   // 換下一個模型
        if (res.status === 429 || res.status >= 500) {
          lastErr = `(翻譯失敗 ${res.status})`;
          await sleep(1500);
          continue;                                                          // 同模型重試一次
        }
        if (!res.ok) return { ok: false, err: `(翻譯失敗 ${res.status})` };
        const data = await res.json();
        let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        raw = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        const parsed = JSON.parse(raw);
        geminiGoodModel = model;
        return { ok: true, zh: parsed.zh || '' };
      } catch {
        lastErr = '(翻譯連線失敗)';
        await sleep(800);
      }
    }
  }
  return { ok: false, err: lastErr };
}

async function geminiZh(text, cfg) {
  if (!cfg.geminiKey) return { zh: '(未設定 Gemini key)' };
  const out = await geminiQueued(() => geminiOnce(text, cfg));
  if (out.ok) return { zh: out.zh };
  // Gemini 失敗 → 有 DeepL key 就自動備援
  if (cfg.deeplKey) {
    const hasCJK = /[㐀-鿿豈-﫿]/.test(text);
    const zh = hasCJK ? await deeplMixed(text, cfg) : await deepl(text, 'ZH-HANT', cfg);
    return { zh };
  }
  return { zh: out.err };
}

// ================= 錄音（自 meeting-scribe background.js 移植） =================
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '在背景擷取分頁聲音（與選用的麥克風）並編碼為 MP3 供使用者下載'
  });
}

async function handleRec(msg, sender, sendResponse) {
  switch (msg.type) {
    case 'START_REC': {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return sendResponse({ ok: false, error: '找不到目前分頁' });
        if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
          return sendResponse({ ok: false, error: '此頁面無法錄音（瀏覽器內部頁面）' });
        }
        recTabId = tab.id;
        await ensureOffscreen();
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        const s = await chrome.storage.local.get(['micEnabled']);
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START',
          streamId,
          settings: { micEnabled: !!s.micEnabled }
        });
        await chrome.storage.local.set({ cs_recActive: true });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: '錄音啟動失敗：' + e.message });
      }
      break;
    }
    case 'STOP_REC': {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
      // cs_recActive 保持 true：錄音資料仍在，面板的「音檔」按鈕留著可下載
      sendResponse({ ok: true });
      break;
    }
    case 'SAVE_AUDIO': {
      const has = await chrome.offscreen.hasDocument();
      if (!has) return sendResponse({ ok: false, error: '尚未開始過錄音，沒有資料' });
      let r = null;
      try { r = await chrome.runtime.sendMessage({ type: 'AUDIO_SAVE' }); } catch (e) {}
      if (!r || !r.ok) return sendResponse(r || { ok: false, error: '無法取得錄音資料' });
      try {
        await chrome.downloads.download({ url: r.url, filename: r.filename });
        sendResponse({ ok: true });
      } catch (e) {
        // 少數環境 downloads API 不接受 blob URL → 退回 offscreen 直接觸發下載
        try {
          await chrome.runtime.sendMessage({ type: 'AUDIO_DOWNLOAD_FALLBACK', url: r.url, filename: r.filename });
          sendResponse({ ok: true });
        } catch {
          sendResponse({ ok: false, error: '下載失敗：' + e.message });
        }
      }
      break;
    }
    case 'REC_ERROR': {
      // offscreen 的錯誤 → 轉發到錄音分頁的面板顯示
      if (recTabId != null) {
        chrome.tabs.sendMessage(recTabId, { type: 'REC_ERROR', error: msg.error }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === recTabId) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    recTabId = null;
  }
});
