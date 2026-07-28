// Live Caption Transcript - content script
// 監聽網頁即時字幕（Teams / Webex 自動偵測，或手動框選的區域），累積成逐字稿。
(() => {
  if (window.__lcCapLoaded) return;
  window.__lcCapLoaded = true;

  const HOST = location.hostname;
  const SEL_KEY = 'lc_sel_' + HOST;

  let capturing = false;
  let pickedSelector = null;
  let entries = [];            // [{id, t, s, x}]  t=timestamp ms, s=speaker, x=text
  let nextId = 1;
  let nodeMap = new WeakMap(); // DOM node -> entry id
  let observer = null;
  let scanTimer = null;
  let flushTimer = null;
  let dirty = false;
  let scanQueued = false;

  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

  // ---------- 初始化：讀取既有狀態 ----------
  chrome.storage.local.get(['lc_entries', 'lc_capturing', SEL_KEY], (res) => {
    entries = Array.isArray(res.lc_entries) ? res.lc_entries : [];
    nextId = entries.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
    pickedSelector = res[SEL_KEY] || null;
    if (res.lc_capturing) startCapture();
  });

  // ---------- 各平台字幕擷取 ----------
  function teamsItems() {
    const out = [];
    const renderer = document.querySelector('[data-tid="closed-captions-renderer"]');
    if (renderer) {
      let items = renderer.querySelectorAll('.fui-ChatMessageCompact');
      if (!items.length) items = renderer.querySelectorAll('li');
      for (const el of items) {
        const author = el.querySelector('[data-tid="author"]');
        const txtEl = el.querySelector('[data-tid="closed-caption-text"]');
        const text = norm(txtEl ? txtEl.innerText : el.innerText);
        if (!text) continue;
        out.push({ node: el, speaker: author ? norm(author.innerText) : '', text });
      }
      if (out.length) return out;
    }
    // 舊版 Teams fallback
    for (const el of document.querySelectorAll('[data-tid="closed-caption-text"]')) {
      const item = el.closest('li,div') || el;
      const author = item.querySelector ? item.querySelector('[data-tid="author"]') : null;
      const text = norm(el.innerText);
      if (text) out.push({ node: item, speaker: author ? norm(author.innerText) : '', text });
    }
    return out;
  }

  const WEBEX_SELS = [
    '[class*="closed-caption"] li',
    '[class*="closedCaption"] li',
    '[class*="caption-row"]',
    '[class*="captionRow"]',
    '[class*="caption-item"]',
    '[class*="captionItem"]',
    '[class*="transcript-item"]'
  ];
  function webexItems() {
    for (const sel of WEBEX_SELS) {
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      if (!els.length) continue;
      const out = [];
      for (const el of els) {
        const sp = el.querySelector('[class*="name"], [class*="speaker"], [class*="author"]');
        let speaker = sp ? norm(sp.innerText) : '';
        let text = norm(el.innerText);
        if (speaker && text.startsWith(speaker)) {
          text = norm(text.slice(speaker.length).replace(/^[:：]\s*/, ''));
        }
        if (text) out.push({ node: el, speaker, text });
      }
      if (out.length) return out;
    }
    return [];
  }

  function pickedItems() {
    if (!pickedSelector) return [];
    let rootEl = null;
    try { rootEl = document.querySelector(pickedSelector); } catch (e) { return []; }
    if (!rootEl) return [];
    const kids = rootEl.children && rootEl.children.length ? [...rootEl.children] : [rootEl];
    const out = [];
    for (const el of kids) {
      const text = norm(el.innerText || el.textContent);
      if (text) out.push({ node: el, speaker: '', text });
    }
    return out;
  }

  function collectItems() {
    // 使用者手動框選的區域優先
    const picked = pickedItems();
    if (picked.length) return picked;
    if (HOST.includes('teams')) return teamsItems();
    if (HOST.includes('webex')) return webexItems();
    return [];
  }

  // ---------- 去重與累積 ----------
  function scan() {
    let items;
    try { items = collectItems(); } catch (e) { return; }
    const now = Date.now();
    for (const it of items) {
      const knownId = nodeMap.get(it.node);
      if (knownId !== undefined) {
        // 同一個字幕節點在逐字修正 → 就地更新
        const e = entries.find((en) => en.id === knownId);
        if (e && (e.x !== it.text || (it.speaker && e.s !== it.speaker))) {
          e.x = it.text;
          if (it.speaker) e.s = it.speaker;
          dirty = true;
        }
        continue;
      }
      const last = entries.length ? entries[entries.length - 1] : null;
      const sameSpeaker = last && (!it.speaker || !last.s || it.speaker === last.s);
      if (last && sameSpeaker && last.x === it.text) {
        // 節點被回收但內容相同 → 視為同一句
        nodeMap.set(it.node, last.id);
      } else if (
        last && sameSpeaker && it.text !== last.x &&
        (it.text.startsWith(last.x) || last.x.startsWith(it.text))
      ) {
        // 漸進式修正（新文字延伸舊文字）→ 合併
        if (it.text.length >= last.x.length) { last.x = it.text; dirty = true; }
        if (it.speaker && !last.s) { last.s = it.speaker; dirty = true; }
        nodeMap.set(it.node, last.id);
      } else {
        const e = { id: nextId++, t: now, s: it.speaker || '', x: it.text };
        entries.push(e);
        nodeMap.set(it.node, e.id);
        dirty = true;
      }
    }
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    chrome.storage.local.set({ lc_entries: entries });
  }

  function queueScan() {
    if (scanQueued || !capturing) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; if (capturing) scan(); }, 250);
  }

  function startCapture() {
    if (capturing) return;
    capturing = true;
    observer = new MutationObserver(queueScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scanTimer = setInterval(() => { if (capturing) scan(); }, 700); // 保險輪詢
    flushTimer = setInterval(flush, 600);
    scan();
  }

  function stopCapture() {
    capturing = false;
    if (observer) { observer.disconnect(); observer = null; }
    clearInterval(scanTimer);
    clearInterval(flushTimer);
    dirty = true;
    flush();
  }

  // ---------- 手動框選字幕區域 ----------
  let picking = false;

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      if (cls) part += cls;
      const parent = cur.parentElement;
      if (parent) {
        const idx = [...parent.children].indexOf(cur) + 1;
        part += ':nth-child(' + idx + ')';
      }
      parts.unshift(part);
      if (cur.id) { parts[0] = '#' + CSS.escape(cur.id); break; }
      cur = parent;
      if (cur === document.body) { parts.unshift('body'); break; }
    }
    return parts.join(' > ');
  }

  function flashTip(msg, ms) {
    const tip = document.createElement('div');
    tip.textContent = msg;
    tip.style.cssText =
      'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#1a7f37;color:#fff;padding:8px 16px;border-radius:8px;' +
      'font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);';
    document.documentElement.appendChild(tip);
    setTimeout(() => tip.remove(), ms || 2500);
  }

  function startPick() {
    if (picking) return;
    picking = true;
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #e0245e;' +
      'background:rgba(224,36,94,.10);border-radius:4px;transition:all .05s;';
    const tip = document.createElement('div');
    tip.textContent = '移動滑鼠並點選「字幕所在的區塊」（按 Esc 取消）';
    tip.style.cssText =
      'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#222;color:#fff;padding:8px 16px;border-radius:8px;' +
      'font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tip);

    const move = (e) => {
      const el = e.target;
      if (!el || el === box || el === tip) return;
      const r = el.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    };
    const click = (e) => {
      e.preventDefault();
      e.stopPropagation();
      finish(e.target);
    };
    const key = (e) => { if (e.key === 'Escape') finish(null); };

    function finish(el) {
      picking = false;
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      box.remove();
      tip.remove();
      if (el) {
        pickedSelector = cssPath(el);
        chrome.storage.local.set({ [SEL_KEY]: pickedSelector });
        flashTip('已選取字幕區域 ✔ 之後這個網站都會用這個區域');
      }
    }

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  // ---------- 與 popup 溝通 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.cmd) {
      case 'ping':
        sendResponse({ ok: true, capturing, host: HOST, picked: !!pickedSelector, count: entries.length });
        break;
      case 'start':
        chrome.storage.local.set({ lc_capturing: true });
        startCapture();
        sendResponse({ ok: true, capturing: true });
        break;
      case 'stop':
        chrome.storage.local.set({ lc_capturing: false });
        stopCapture();
        sendResponse({ ok: true, capturing: false });
        break;
      case 'pick':
        startPick();
        sendResponse({ ok: true });
        break;
      case 'clearPick':
        pickedSelector = null;
        chrome.storage.local.remove(SEL_KEY);
        sendResponse({ ok: true });
        break;
      case 'clear':
        entries = [];
        nextId = 1;
        nodeMap = new WeakMap();
        chrome.storage.local.set({ lc_entries: [] });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false });
    }
    return true;
  });
})();
