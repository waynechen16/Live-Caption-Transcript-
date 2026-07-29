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

async function getCfg() {
  return chrome.storage.local.get(['provider', 'deeplKey', 'geminiKey']);
}

async function translate(text) {
  // 只輸出繁中譯文（不做中→英）。
  // 純中文句直接原樣回傳（不呼叫 API）；含英文的句子才翻譯，
  // 中英夾雜時只翻英文片段、中文片段原樣保留。
  if (!text.trim()) return { zh: '' };
  const hasCJK = /[㐀-鿿豈-﫿]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  if (hasCJK && !hasLatin) return { zh: text };   // 純中文 → 不翻
  const cfg = await getCfg();
  if ((cfg.provider || 'deepl') === 'gemini') return geminiZh(text, cfg);
  return { zh: await deepl(text, 'ZH-HANT', cfg) };
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
    if (!res.ok) return `(翻譯失敗 ${res.status})`;
    const data = await res.json();
    return data.translations?.[0]?.text || '';
  } catch {
    return '(翻譯連線失敗)';
  }
}

async function geminiZh(text, cfg) {
  if (!cfg.geminiKey) return { zh: '(未設定 Gemini key)' };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=' + cfg.geminiKey;
  // 中英夾雜規則：只翻譯英文片段、中文片段一字不動保留。
  // 例：「這是 Apple.」→ zh:「這是蘋果.」
  const prompt =
    'You are a meeting interpreter. The utterance below may be Chinese, English, or mixed. ' +
    'Return ONLY JSON: {"zh":"..."}. Rules: ' +
    'translate the English portions into Traditional Chinese, but keep every existing Chinese ' +
    'portion EXACTLY as written (do not rephrase it); the result reads as one natural sentence. ' +
    'If the utterance is pure English, "zh" is its full Traditional Chinese translation. ' +
    'If pure Chinese, copy it as-is.\n\nUtterance: ' + text;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });
    if (!res.ok) return { zh: `(翻譯失敗 ${res.status})` };
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(raw);
    return { zh: parsed.zh || '' };
  } catch {
    return { zh: '(翻譯連線失敗)' };
  }
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
