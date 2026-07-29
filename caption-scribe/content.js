// content.js — Caption Scribe（DOM 版）v1.1
// 來源：頁面即時字幕（Teams / Webex / Google Meet 自動偵測，或手動框選區域；框選優先）
// 流程：DOM 擷取 → 逐字修正就地更新 → 閒置定稿 → 送翻譯（可關閉）→ 譯文補入同一條目
// 面板 UI / 匯出 / 錄音下載移植自 meeting-scribe
(() => {
  if (window.__csInjected && !window.__csForceReinject) return;
  if (window.__csInjected) document.getElementById('cs-box')?.remove();
  window.__csForceReinject = false;
  window.__csInjected = true;

  const HOST = location.hostname;
  const SEL_KEY = 'cs_sel_' + HOST;
  const FINAL_IDLE_MS = 1800;  // 字幕條目多久沒變視為定稿 → 送翻譯
  const CHECK_MS = 500;

  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  // innerText 在部分環境（測試/舊引擎）不存在 → 退回 textContent
  const textOf = (el) => {
    if (!el) return '';
    const t = el.innerText;
    return norm(t !== undefined && t !== null ? t : el.textContent);
  };

  // ================= 面板 =================
  const box = document.createElement('div');
  box.id = 'cs-box';
  box.innerHTML = `
    <div id="cs-header">
      <span id="cs-title">Caption Scribe（未擷取）</span>
      <span id="cs-buttons">
        <button class="cs-btn" id="cs-save-src" title="下載原文逐字稿">原文</button>
        <button class="cs-btn" id="cs-save-zh" title="下載中文">中文</button>
        <button class="cs-btn" id="cs-save-en" title="下載英文">英文</button>
        <button class="cs-btn" id="cs-save-md" title="下載 Markdown 會議記錄">MD</button>
        <button class="cs-btn" id="cs-save-audio" title="下載錄音 (MP3)" hidden>音檔</button>
        <button class="cs-btn" id="cs-clear" title="清除記錄">清除</button>
        <button class="cs-btn" id="cs-close" title="關閉面板（記錄照常進行）">✕</button>
      </span>
    </div>
    <div id="cs-history"></div>
    <div id="cs-status"></div>
  `;
  document.documentElement.appendChild(box);

  const historyEl = box.querySelector('#cs-history');
  const statusEl = box.querySelector('#cs-status');
  const titleEl = box.querySelector('#cs-title');
  const audioBtn = box.querySelector('#cs-save-audio');
  box.querySelector('#cs-close').addEventListener('click', () => { box.style.display = 'none'; });

  // ---- 拖曳（移植自參考版）----
  const headerEl = box.querySelector('#cs-header');
  let dragging = false, offX = 0, offY = 0;
  headerEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cs-btn')) return;
    dragging = true;
    const r = box.getBoundingClientRect();
    offX = e.clientX - r.left;
    offY = e.clientY - r.top;
    headerEl.setPointerCapture(e.pointerId);
  });
  headerEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    box.style.left = `${e.clientX - offX}px`;
    box.style.top = `${e.clientY - offY}px`;
    box.style.bottom = 'auto';
    box.style.transform = 'none';
  });
  headerEl.addEventListener('pointerup', () => { dragging = false; });
  headerEl.addEventListener('pointercancel', () => { dragging = false; });

  const SPK_COLORS = ['#4f9cf9', '#f97066', '#4fd1a5', '#e3b341', '#b98af9', '#f472b6', '#67d4e4', '#a3b18a'];
  function colorOf(name) {
    if (!name) return '#999';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return SPK_COLORS[h % SPK_COLORS.length];
  }
  function timestamp(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function nearBottom() {
    return historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 48;
  }
  function setStatus(msg) { statusEl.textContent = msg || ''; }

  // ================= 記錄 =================
  // entry: { id, t, s(peaker), x(原文), zh, en, state: 'live'|'sent'|'done', lastChange, sentText, el }
  let entries = [];
  let nextId = 1;
  let nodeMap = new WeakMap();
  let capturing = false;
  let pickedSelector = null;
  let translateOn = true;
  let dirtyStore = false;

  function entryById(id) { return entries.find((e) => e.id === id); }

  // 譯文與原文相同時不重複顯示（匯出仍保留完整欄位）——移植自參考版
  function setTransLine(el, cls, text, src) {
    let div = el.querySelector('.' + cls);
    if (!text || text.trim() === src.trim()) { if (div) div.remove(); return; }
    if (!div) {
      div = document.createElement('div');
      div.className = cls;
      el.append(div);
    }
    div.textContent = text;
  }

  function renderEntry(e) {
    const stick = nearBottom();
    if (!e.el) {
      const el = document.createElement('div');
      el.className = 'cs-entry';
      const head = document.createElement('div');
      head.className = 'cs-entry-head';
      const chip = document.createElement('span');
      chip.className = 'cs-chip';
      chip.style.background = colorOf(e.s);
      chip.textContent = e.s || '字幕';
      const time = document.createElement('span');
      time.className = 'cs-time';
      time.textContent = timestamp(e.t);
      head.append(chip, time);
      const src = document.createElement('div');
      src.className = 'cs-src';
      el.append(head, src);
      historyEl.appendChild(el);
      e.el = el;
    }
    const chipEl = e.el.querySelector('.cs-chip');
    if (e.s && chipEl.textContent !== e.s) {
      chipEl.textContent = e.s;
      chipEl.style.background = colorOf(e.s);
    }
    const srcEl = e.el.querySelector('.cs-src');
    if (srcEl.textContent !== e.x) srcEl.textContent = e.x;
    srcEl.classList.toggle('cs-live', translateOn && e.state !== 'done');
    setTransLine(e.el, 'cs-zh', e.zh, e.x);
    setTransLine(e.el, 'cs-en', e.en, e.x);
    if (stick) historyEl.scrollTop = historyEl.scrollHeight;
  }

  // ================= 講者解析輔助 =================
  // 「Name: 內容」前綴 → 拆出講者（名字不含句末標點、不超過 30 字）
  function splitSpeakerPrefix(text) {
    const m = text.match(/^([^:：]{1,30})[:：]\s*(.+)$/s);
    if (m && !/[.。！？!?，,]/.test(m[1])) return { speaker: norm(m[1]), text: norm(m[2]) };
    return { speaker: '', text };
  }
  // 結構式解析：區塊內第一個子元素是短名字、其餘是內容
  function splitByStructure(el) {
    const kids = [...el.children].filter((c) => c.tagName !== 'IMG');
    if (kids.length >= 2) {
      const name = textOf(kids[0]);
      const rest = kids.slice(1).map(textOf).filter(Boolean).join(' ');
      if (rest && name && name.length <= 40 && !/[.。！？!?]$/.test(name)) {
        return { speaker: name, text: norm(rest) };
      }
    }
    return null;
  }

  // ================= 各平台字幕擷取 =================
  function teamsItems() {
    const out = [];
    const renderer = document.querySelector('[data-tid="closed-captions-renderer"]');
    if (renderer) {
      let items = renderer.querySelectorAll('.fui-ChatMessageCompact');
      if (!items.length) items = renderer.querySelectorAll('li');
      for (const el of items) {
        const author = el.querySelector('[data-tid="author"], .ui-chat__message__author, [class*="author"]');
        const txtEl = el.querySelector('[data-tid="closed-caption-text"]');
        let speaker = author ? textOf(author) : '';
        let text = txtEl ? textOf(txtEl) : textOf(el);
        if (!speaker) {
          const st = splitByStructure(el) || splitSpeakerPrefix(text);
          if (st && st.speaker) { speaker = st.speaker; if (!txtEl) text = st.text; }
        }
        if (text) out.push({ node: el, speaker, text });
      }
      if (out.length) return out;
    }
    for (const el of document.querySelectorAll('[data-tid="closed-caption-text"]')) {
      const item = el.closest('li,div') || el;
      const author = item.querySelector ? item.querySelector('[data-tid="author"], [class*="author"]') : null;
      const text = textOf(el);
      if (text) out.push({ node: item, speaker: author ? textOf(author) : '', text });
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
      try { els = document.querySelectorAll(sel); } catch { continue; }
      if (!els.length) continue;
      const out = [];
      for (const el of els) {
        const sp = el.querySelector('[class*="name"], [class*="speaker"], [class*="author"]');
        let speaker = sp ? textOf(sp) : '';
        let text = textOf(el);
        if (speaker && text.startsWith(speaker)) {
          text = norm(text.slice(speaker.length).replace(/^[:：]\s*/, ''));
        }
        if (!speaker) {
          const st = splitByStructure(el) || splitSpeakerPrefix(text);
          if (st && st.speaker) { speaker = st.speaker; text = st.text; }
        }
        if (text) out.push({ node: el, speaker, text });
      }
      if (out.length) return out;
    }
    return [];
  }

  // Google Meet：字幕在 aria-label 為 Captions/字幕 的 region 中，
  // 每項為「頭像 + 名字區塊 + 文字區塊」
  function meetItems() {
    let region = null;
    for (const r of document.querySelectorAll('div[role="region"][aria-label], div[aria-label][jsname]')) {
      const label = r.getAttribute('aria-label') || '';
      if (/caption|字幕|字元|субтит|subt[ií]t|untertitel|자막|字幕表示/i.test(label)) { region = r; break; }
    }
    if (!region) region = document.querySelector('.a4cQT');  // 舊版 class fallback
    if (!region) return [];
    // 逐層下探包裝層——但若唯一子元素本身就是「名字+文字」的字幕項就停住
    let root = region;
    for (let i = 0; i < 3 && root.children.length === 1 && !splitByStructure(root.children[0]); i++) {
      root = root.children[0];
    }
    const out = [];
    for (const b of root.children) {
      const st = splitByStructure(b);
      if (st) { out.push({ node: b, speaker: st.speaker, text: st.text }); continue; }
      const t = textOf(b);
      if (!t) continue;
      const sp = splitSpeakerPrefix(t);
      out.push({ node: b, speaker: sp.speaker, text: sp.text });
    }
    return out;
  }

  // 從使用者框選的元素往下探，找出「一句一項」的字幕項層級。
  // 使用者常會框到整個字幕外框（下面還有捲動容器、清單等包裝層）：
  // 只要這一層只有一個「有文字的」子元素、而且它還不是字幕項本身，就繼續往下走。
  function findItemBlocks(rootEl) {
    let root = rootEl;
    for (let i = 0; i < 6; i++) {
      const kids = [...root.children].filter((c) => textOf(c));
      if (kids.length === 1 && !splitByStructure(kids[0])) { root = kids[0]; continue; }
      break;
    }
    const kids = [...root.children].filter((c) => textOf(c));
    return kids.length ? kids : [root];
  }

  function pickedItems() {
    if (!pickedSelector) return [];
    let rootEl = null;
    try { rootEl = document.querySelector(pickedSelector); } catch { return []; }
    if (!rootEl) return [];
    const out = [];
    for (const el of findItemBlocks(rootEl)) {
      // 結構式：頭像(img) + 名字區塊 + 文字區塊 → speaker / transcript 分離
      const st = splitByStructure(el);
      if (st) { out.push({ node: el, speaker: st.speaker, text: st.text }); continue; }
      const t = textOf(el);
      if (!t) continue;
      // 純文字式：「名字: 內容」前綴
      const sp = splitSpeakerPrefix(t);
      out.push({ node: el, speaker: sp.speaker, text: sp.text });
    }
    return out;
  }

  function collectItems() {
    // 使用者手動框選的區域永遠優先；沒框選才用各平台預設位置
    const picked = pickedItems();
    if (picked.length) return picked;
    if (HOST.includes('teams')) return teamsItems();
    if (HOST.includes('webex')) return webexItems();
    if (HOST.includes('meet.google')) return meetItems();
    return [];
  }

  // ================= 去重、聚合與定稿 =================
  function touch(e, text, speaker) {
    let changed = false;
    if (e.x !== text) { e.x = text; changed = true; }
    if (speaker && e.s !== speaker) { e.s = speaker; changed = true; }
    if (changed) {
      e.lastChange = Date.now();
      // 定稿甚至翻譯後原文又長出來（長停頓後續講）→ 回到 live，之後重新定稿重翻
      if (e.state !== 'live') e.state = 'live';
      dirtyStore = true;
      renderEntry(e);
    }
  }

  function scan() {
    let items;
    try { items = collectItems(); } catch { return; }
    const now = Date.now();
    for (const it of items) {
      const knownId = nodeMap.get(it.node);
      if (knownId !== undefined) {
        const e = entryById(knownId);
        if (e) touch(e, it.text, it.speaker);
        continue;
      }
      const last = entries.length ? entries[entries.length - 1] : null;
      const sameSpeaker = last && (!it.speaker || !last.s || it.speaker === last.s);
      if (last && sameSpeaker && last.x === it.text) {
        nodeMap.set(it.node, last.id);           // 節點被回收但內容相同
      } else if (
        last && sameSpeaker && it.text !== last.x &&
        (it.text.startsWith(last.x) || last.x.startsWith(it.text))
      ) {
        nodeMap.set(it.node, last.id);           // 漸進式修正 → 合併
        if (it.text.length >= last.x.length) touch(last, it.text, it.speaker);
      } else {
        const e = {
          id: nextId++, t: now, s: it.speaker || '', x: it.text,
          zh: '', en: '', state: 'live', lastChange: now, sentText: '', el: null
        };
        entries.push(e);
        nodeMap.set(it.node, e.id);
        dirtyStore = true;
        renderEntry(e);
      }
    }
  }

  // 定稿檢查：live 且閒置超過 FINAL_IDLE_MS → 送翻譯（翻譯關閉時直接定稿）
  function finalizeCheck() {
    const now = Date.now();
    for (const e of entries) {
      if (e.state !== 'live') continue;
      if (now - e.lastChange < FINAL_IDLE_MS) continue;
      if (!translateOn) {
        e.state = 'done';
        dirtyStore = true;
        renderEntry(e);
        continue;
      }
      e.state = 'sent';
      e.sentText = e.x;
      chrome.runtime.sendMessage({ type: 'TRANSLATE', text: e.x })
        .then((r) => {
          const cur = entryById(e.id);
          if (!cur) return;
          if (cur.x !== cur.sentText) { cur.state = 'live'; return; } // 原文又變了 → 重翻
          cur.zh = r?.zh || '';
          cur.en = r?.en || '';
          cur.state = 'done';
          dirtyStore = true;
          renderEntry(cur);
        })
        .catch(() => {
          const cur = entryById(e.id);
          if (cur && cur.state === 'sent') cur.state = 'live'; // 稍後重試
        });
    }
  }

  // ================= 持久化（面板重建 / 匯出保險） =================
  function storeSnapshot() {
    if (!dirtyStore) return;
    dirtyStore = false;
    const slim = entries.map(({ id, t, s, x, zh, en, state }) => ({ id, t, s, x, zh, en, state }));
    try { chrome.storage.local.set({ cs_entries: slim }); } catch {}
  }

  // ================= 擷取控制 =================
  let observer = null;
  let scanTimer = null;
  let finalTimer = null;
  let storeTimer = null;
  let scanQueued = false;

  function queueScan() {
    if (scanQueued || !capturing) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; if (capturing) scan(); }, 250);
  }

  function startCapture() {
    if (capturing) return;
    capturing = true;
    box.style.display = '';
    titleEl.textContent = translateOn ? 'Caption Scribe 記錄中…' : 'Caption Scribe 記錄中（翻譯關閉）';
    observer = new MutationObserver(queueScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scanTimer = setInterval(() => { if (capturing) scan(); }, 700);
    finalTimer = setInterval(finalizeCheck, CHECK_MS);
    storeTimer = setInterval(storeSnapshot, 800);
    scan();
    setStatus(pickedSelector ? '使用手動框選的字幕區域' : '');
  }

  function stopCapture() {
    if (!capturing) return;
    capturing = false;
    if (observer) { observer.disconnect(); observer = null; }
    clearInterval(scanTimer);
    clearInterval(finalTimer);
    clearInterval(storeTimer);
    // 停止時把尚未定稿的條目全部立即定稿（送翻譯或直接完成）
    for (const e of entries) {
      if (e.state === 'live') e.lastChange = 0;
    }
    finalizeCheck();
    dirtyStore = true;
    storeSnapshot();
    titleEl.textContent = '已停止（可匯出）';
  }

  function resetAll() {
    entries = [];
    nextId = 1;
    nodeMap = new WeakMap();
    historyEl.innerHTML = '';
    dirtyStore = true;
    storeSnapshot();
    chrome.runtime.sendMessage({ type: 'AUDIO_RESET' }).catch(() => {});
    setStatus('');
  }

  // ================= 匯出（移植自參考版） =================
  function download(filename, text) {
    const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function fileStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  const line = (e, field) => `[${timestamp(e.t)}]${e.s ? ' ' + e.s + ':' : ''} ${e[field] || ''}`;

  box.querySelector('#cs-save-src').addEventListener('click', () => {
    download(`caption-source-${fileStamp()}.txt`, entries.map((e) => line(e, 'x')).join('\n'));
  });
  box.querySelector('#cs-save-zh').addEventListener('click', () => {
    download(`caption-zh-${fileStamp()}.txt`, entries.map((e) => line(e, 'zh')).join('\n'));
  });
  box.querySelector('#cs-save-en').addEventListener('click', () => {
    download(`caption-en-${fileStamp()}.txt`, entries.map((e) => line(e, 'en')).join('\n'));
  });
  box.querySelector('#cs-save-md').addEventListener('click', () => {
    const d = new Date();
    const md = [
      `# 會議記錄 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      '',
      ...entries.map((e) =>
        `**[${timestamp(e.t)}] ${e.s || '字幕'}**\n> ${e.x}\n> 中：${e.zh}\n> EN: ${e.en}\n`)
    ].join('\n');
    download(`caption-notes-${fileStamp()}.md`, md);
  });
  box.querySelector('#cs-clear').addEventListener('click', () => {
    if (!confirm('確定要清除目前的記錄（含錄音）嗎？')) return;
    resetAll();
  });

  // 音檔（MP3）：向 background 要（background 轉問 offscreen → chrome.downloads）
  audioBtn.addEventListener('click', async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SAVE_AUDIO' });
      if (!r?.ok) setStatus('⚠ ' + (r?.error || '無法儲存錄音'));
    } catch {
      setStatus('⚠ 無法儲存錄音');
    }
  });

  // ================= 手動框選字幕區域 =================
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

  function startPick() {
    if (picking) return;
    picking = true;
    const hi = document.createElement('div');
    hi.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #e0245e;' +
      'background:rgba(224,36,94,.10);border-radius:4px;transition:all .05s;';
    const tip = document.createElement('div');
    tip.textContent = '移動滑鼠並點選「字幕所在的區塊」（按 Esc 取消）';
    tip.style.cssText =
      'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#222;color:#fff;padding:8px 16px;border-radius:8px;' +
      'font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);';
    document.documentElement.appendChild(hi);
    document.documentElement.appendChild(tip);

    const move = (e) => {
      const el = e.target;
      if (!el || el === hi || el === tip || box.contains(el)) return;
      const r = el.getBoundingClientRect();
      hi.style.left = r.left + 'px';
      hi.style.top = r.top + 'px';
      hi.style.width = r.width + 'px';
      hi.style.height = r.height + 'px';
    };
    const click = (e) => {
      if (box.contains(e.target)) return;
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
      hi.remove();
      tip.remove();
      if (el) {
        pickedSelector = cssPath(el);
        chrome.storage.local.set({ [SEL_KEY]: pickedSelector });
        setStatus('已選取字幕區域 ✔ 之後這個網站都會優先用這個區域');
      }
    }

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  // ================= 初始化與訊息 =================
  function applyRecActive(on) {
    audioBtn.hidden = !on;
  }

  chrome.storage.local.get(['cs_entries', 'cs_capturing', 'cs_translate', 'cs_recActive', SEL_KEY], (res) => {
    pickedSelector = res[SEL_KEY] || null;
    translateOn = res.cs_translate !== false;   // 預設開
    applyRecActive(!!res.cs_recActive);
    const saved = Array.isArray(res.cs_entries) ? res.cs_entries : [];
    for (const s of saved) {
      const e = { ...s, sentText: '', el: null };
      if (e.state === 'sent') e.state = 'live'; // 重載時把送出中的重新排隊
      entries.push(e);
      renderEntry(e);
    }
    nextId = entries.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
    if (res.cs_capturing) startCapture();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.cs_translate) {
      translateOn = changes.cs_translate.newValue !== false;
      if (capturing) titleEl.textContent = translateOn ? 'Caption Scribe 記錄中…' : 'Caption Scribe 記錄中（翻譯關閉）';
    }
    if (changes.cs_recActive) applyRecActive(!!changes.cs_recActive.newValue);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'REC_ERROR') {
      setStatus('⚠ ' + msg.error);
      sendResponse({ ok: true });
      return true;
    }
    switch (msg && msg.cmd) {
      case 'ping':
        sendResponse({ ok: true, capturing, host: HOST, picked: !!pickedSelector, count: entries.length });
        break;
      case 'start':
        chrome.storage.local.set({ cs_capturing: true });
        startCapture();
        sendResponse({ ok: true, capturing: true });
        break;
      case 'stop':
        chrome.storage.local.set({ cs_capturing: false });
        stopCapture();
        sendResponse({ ok: true, capturing: false });
        break;
      case 'showPanel':
        box.style.display = '';
        sendResponse({ ok: true });
        break;
      case 'pick':
        startPick();
        sendResponse({ ok: true });
        break;
      case 'clearPick':
        pickedSelector = null;
        chrome.storage.local.remove(SEL_KEY);
        setStatus('已清除框選，改用預設字幕位置');
        sendResponse({ ok: true });
        break;
      case 'clear':
        resetAll();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false });
    }
    return true;
  });
})();
