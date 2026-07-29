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
  // 版本號顯示在面板標題，方便確認載入的是新版
  let VER = '';
  try { VER = 'v' + chrome.runtime.getManifest().version; } catch {}
  const TITLE = 'Caption Scribe ' + VER;
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
      <span id="cs-title"></span>
      <span id="cs-buttons">
        <button class="cs-btn" id="cs-save-src" title="下載原文逐字稿">原文</button>
        <button class="cs-btn" id="cs-save-zh" title="下載中文">中文</button>
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
  titleEl.textContent = TITLE + '（未擷取）';
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
    const zhDiv = e.el.querySelector('.cs-zh');
    if (zhDiv) zhDiv.classList.toggle('cs-tentative', e.state !== 'done');  // 暫定譯文半透明
    if (stick) historyEl.scrollTop = historyEl.scrollHeight;
  }

  // ================= 講者解析輔助 =================
  // 出現過的講者名（跨掃描累積；也從歷史記錄還原）——用來辨認「名字塊」
  const knownSpeakers = new Set();

  // 名字的長相：短、不含任何句中/句末標點
  function looksLikeName(t) {
    return !!t && t.length <= 40 && !/[。．.！!？?，,、；;：:…]/.test(t);
  }

  // 「Name: 內容」前綴 → 拆出講者（名字不含標點、不超過 30 字）
  function splitSpeakerPrefix(text) {
    const m = text.match(/^([^:：]{1,30})[:：]\s*(.+)$/s);
    if (m && looksLikeName(norm(m[1]))) return { speaker: norm(m[1]), text: norm(m[2]) };
    return { speaker: '', text };
  }

  // 結構式解析：區塊內第一個「有文字的」子元素是名字、其餘是內容。
  // 頭像常是 img 或無文字的 div → 過濾掉；只剩一個有字的子元素（包裝層）就遞迴下探。
  function splitByStructure(el, depth = 0) {
    if (!el || !el.children) return null;
    const kids = [...el.children].filter((c) => c.tagName !== 'IMG' && textOf(c));
    if (kids.length >= 2) {
      const name = textOf(kids[0]);
      const rest = kids.slice(1).map(textOf).filter(Boolean).join(' ');
      if (rest && looksLikeName(name)) return { speaker: name, text: norm(rest) };
      return null;
    }
    if (kids.length === 1 && depth < 3) return splitByStructure(kids[0], depth + 1);
    return null;
  }

  // 「單一字幕項」vs「整個清單」的分辨：
  // 能結構式解析、且直接子區塊中「名字長相」的不超過一個，才視為單項。
  // （名字/內容成對排列的清單會有多個名字塊 → 應該繼續下探逐項處理）
  function isCaptionItem(el) {
    if (!splitByStructure(el)) return false;
    const kids = [...el.children].filter((c) => c.tagName !== 'IMG' && textOf(c));
    const nameish = kids.filter((c) => looksLikeName(textOf(c))).length;
    return nameish <= 1;
  }

  // 通用擷取：下探到「一句一項」層級後，逐項解析。
  // 支援三種型態：
  //   A. 單項內含名字+文字（結構式，含巢狀包裝層）
  //   B. 名字塊與內容塊是「兄弟區塊成對出現」（Teams 常見）——
  //      名字塊短且無標點，且（已知講者 / 在後面重複出現 / 下一塊像句子）
  //   C. 純文字「Name: 內容」前綴
  function extractItems(rootEl) {
    const blocks = findItemBlocks(rootEl);
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const st = isCaptionItem(el) ? splitByStructure(el) : null;
      if (st) {
        knownSpeakers.add(st.speaker);
        out.push({ node: el, speaker: st.speaker, text: st.text });
        continue;
      }
      const t = textOf(el);
      if (!t) continue;
      // 型態 B：名字塊 + 內容塊 成對
      if (looksLikeName(t) && i + 1 < blocks.length) {
        const nxt = blocks[i + 1];
        const st2 = splitByStructure(nxt);
        const ntext = st2 ? st2.text : textOf(nxt);
        const nameEvidence =
          knownSpeakers.has(t) ||
          (ntext && !looksLikeName(ntext)) ||
          blocks.slice(i + 1).some((b) => textOf(b) === t);
        if (ntext && nameEvidence) {
          knownSpeakers.add(t);
          out.push({ node: nxt, speaker: (st2 && st2.speaker) || t, text: ntext });
          i++;
          continue;
        }
      }
      // 型態 C
      const sp = splitSpeakerPrefix(t);
      if (sp.speaker) knownSpeakers.add(sp.speaker);
      out.push({ node: el, speaker: sp.speaker, text: sp.text });
    }
    return out;
  }

  // ================= 各平台字幕擷取 =================
  function teamsItems() {
    const out = [];
    // 新版 Teams（實測 2026-07 DOM）：沒有 closed-captions-renderer 外層 data-tid。
    // 每句是一個 .fui-ChatMessageCompact__body，名字(author)與文字(closed-caption-text)
    // 在不同的兄弟分支 → 從字幕文字「往上走」找到同時包含 author 的訊息容器。
    for (const el of document.querySelectorAll('[data-tid="closed-caption-text"]')) {
      const text = textOf(el);
      if (!text) continue;
      let item = el.parentElement || el;   // 找不到 author 時的近端容器
      let author = null;
      let cur = el.parentElement;
      for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
        const a = cur.querySelector('[data-tid="author"]');
        if (a) {
          // 若這一層已含多句字幕，代表走過頭（到清單層了）→ 放棄，避免抓錯人
          if (cur.querySelectorAll('[data-tid="closed-caption-text"]').length > 1) break;
          item = cur; author = a; break;
        }
      }
      out.push({ node: item, speaker: author ? textOf(author) : '', text });
    }
    if (out.length) return out;
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
      // data-tid 抓得到字幕但全部沒講者名 → 改用通用擷取（結構/成對/前綴）再試一次
      if (out.length && out.every((i) => !i.speaker)) {
        const generic = extractItems(renderer);
        if (generic.length && generic.some((i) => i.speaker)) return generic;
      }
      if (out.length) return out;
      // renderer 存在但 data-tid 全失效 → 直接通用擷取
      const generic = extractItems(renderer);
      if (generic.length) return generic;
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
      if (kids.length === 1 && !isCaptionItem(kids[0])) { root = kids[0]; continue; }
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
    return extractItems(rootEl);
  }

  function platformItems() {
    if (HOST.includes('teams')) return teamsItems();
    if (HOST.includes('webex')) return webexItems();
    if (HOST.includes('meet.google')) return meetItems();
    return [];
  }

  function collectItems() {
    // 手動框選優先；但若框選解析不到任何講者、平台內建偵測解析得到 → 自動改用內建結果
    const picked = pickedItems();
    if (picked.length) {
      if (picked.every((i) => !i.speaker)) {
        const platform = platformItems();
        if (platform.length && platform.some((i) => i.speaker)) return platform;
      }
      return picked;
    }
    return platformItems();
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

  // ================= 預先翻譯 + 定稿 =================
  // 不等斷句：字幕還在變動時就先翻（每個條目最快 PRETRANS_MS 送一次），
  // 畫面先顯示「暫定譯文」（半透明）；文字停止變動 FINAL_IDLE_MS 後，
  // 若最後一次譯文已對應最終文字就直接轉正（不再重翻一次，省 API 額度），
  // 否則補送最後一次翻譯。
  const PRETRANS_MS = 1000;

  function requestTranslate(e) {
    if (e.inflight) return;
    e.inflight = true;
    const snapshot = e.x;
    e.sentText = snapshot;
    e.lastReq = Date.now();
    chrome.runtime.sendMessage({ type: 'TRANSLATE', text: snapshot })
      .then((r) => {
        const cur = entryById(e.id);
        if (cur) {
          cur.inflight = false;
          cur.zh = r?.zh || '';
          cur.zhFor = snapshot;   // 這份譯文對應的原文快照
          // 原文已停止變動（或已停止擷取）且譯文對應最終文字 → 定稿
          if (cur.zhFor === cur.x && (!capturing || Date.now() - cur.lastChange >= FINAL_IDLE_MS)) {
            cur.state = 'done';
          }
          dirtyStore = true;
          renderEntry(cur);
        }
        e.inflight = false;
      })
      .catch(() => { e.inflight = false; });
  }

  function finalizeCheck() {
    const now = Date.now();
    for (const e of entries) {
      if (e.state === 'done') continue;
      const idle = now - e.lastChange;
      if (!translateOn) {
        if (idle >= FINAL_IDLE_MS) { e.state = 'done'; dirtyStore = true; renderEntry(e); }
        continue;
      }
      // 預先翻譯：文字有變、且距上次送出 ≥ PRETRANS_MS（首次立即送）
      if (e.x !== e.sentText && !e.inflight && now - (e.lastReq || 0) >= PRETRANS_MS) {
        requestTranslate(e);
        continue;
      }
      // 定稿判斷
      if (idle >= FINAL_IDLE_MS) {
        if (e.zhFor === e.x) {
          e.state = 'done';
          dirtyStore = true;
          renderEntry(e);
        } else if (!e.inflight && now - (e.lastReq || 0) >= PRETRANS_MS) {
          // 上次請求失敗或落後 → 補送（同樣受節流限制，避免失敗時連環重送）
          e.sentText = null;
          requestTranslate(e);
        }
      }
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
    titleEl.textContent = TITLE + (translateOn ? ' 記錄中…' : ' 記錄中（翻譯關閉）');
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
    // 停止時把尚未定稿的條目全部立即定稿（補送翻譯或直接完成）
    for (const e of entries) {
      if (e.state !== 'done') { e.lastChange = 0; e.lastReq = 0; }
    }
    finalizeCheck();
    dirtyStore = true;
    storeSnapshot();
    titleEl.textContent = TITLE + ' 已停止（可匯出）';
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
  box.querySelector('#cs-save-md').addEventListener('click', () => {
    const d = new Date();
    const md = [
      `# 會議記錄 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      '',
      ...entries.map((e) =>
        `**[${timestamp(e.t)}] ${e.s || '字幕'}**\n> ${e.x}\n> 中：${e.zh}\n`)
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
      if (e.state === 'done') e.zhFor = e.x;    // 已定稿的譯文對應最終原文，避免重翻
      if (e.s) knownSpeakers.add(e.s);          // 歷史講者名 → 名字塊辨識依據
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
      if (capturing) titleEl.textContent = TITLE + (translateOn ? ' 記錄中…' : ' 記錄中（翻譯關閉）');
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
      case 'dumpDom': {
        // 除錯用：把可能的字幕容器結構匯出成 HTML 檔（給開發者調解析規則）
        const parts = [];
        const add = (label, el) => {
          if (!el) return;
          let html = el.outerHTML || '';
          if (html.length > 400000) html = html.slice(0, 400000) + '\n<!-- ...截斷... -->';
          parts.push(`\n\n<!-- ========== ${label} ========== -->\n` + html);
        };
        try {
          if (pickedSelector) add('手動框選 ' + pickedSelector, document.querySelector(pickedSelector));
          add('Teams closed-captions-renderer', document.querySelector('[data-tid="closed-captions-renderer"]'));
          const ccText = document.querySelector('[data-tid="closed-caption-text"]');
          if (ccText) add('Teams closed-caption-text 往上三層', ccText.parentElement?.parentElement?.parentElement || ccText);
          for (const sel of WEBEX_SELS) {
            const el = document.querySelector(sel);
            if (el) { add('Webex ' + sel + ' 往上兩層', el.parentElement?.parentElement || el); break; }
          }
          for (const r of document.querySelectorAll('div[role="region"][aria-label]')) {
            const label = r.getAttribute('aria-label') || '';
            if (/caption|字幕/i.test(label)) { add('Meet region: ' + label, r); break; }
          }
        } catch (err) {
          parts.push('<!-- dump error: ' + err.message + ' -->');
        }
        if (!parts.length) parts.push('<!-- 找不到任何已知的字幕容器；請先手動框選字幕區域再匯出一次 -->');
        const head = `<!-- Caption Scribe ${VER} DOM dump | ${location.hostname} | ${new Date().toISOString()} -->`;
        download(`caption-dom-dump-${fileStamp()}.html`, head + parts.join(''));
        sendResponse({ ok: true, found: parts.length });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
    return true;
  });
})();
