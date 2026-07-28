// Live Caption Transcript - popup
const $ = (id) => document.getElementById(id);

let tab = null;
let connected = false;
let capturing = false;
let entries = [];

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtDate(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
}

function toText() {
  return entries
    .map((e) => '[' + fmtTime(e.t) + ']' + (e.s ? ' ' + e.s + ':' : '') + ' ' + e.x)
    .join('\n');
}

function render() {
  const list = $('list');
  list.innerHTML = '';
  if (!entries.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.innerHTML = '尚無逐字稿。<br/>在會議中開啟即時字幕後，按「開始擷取」。';
    list.appendChild(div);
  } else {
    for (const e of entries) {
      const item = document.createElement('div');
      item.className = 'entry';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = fmtTime(e.t);
      if (e.s) {
        const sp = document.createElement('span');
        sp.className = 'speaker';
        sp.textContent = e.s;
        meta.appendChild(sp);
      }
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = e.x;
      item.appendChild(meta);
      item.appendChild(text);
      list.appendChild(item);
    }
    list.scrollTop = list.scrollHeight;
  }
  $('count').textContent = entries.length + ' 句';
}

function setState() {
  const dot = $('statusDot');
  const st = $('statusText');
  const btn = $('btnToggle');
  if (!connected) {
    dot.className = 'dot off';
    st.textContent = '此頁面無法擷取';
    btn.disabled = true;
    $('btnPick').disabled = true;
    return;
  }
  btn.disabled = false;
  $('btnPick').disabled = false;
  if (capturing) {
    dot.className = 'dot on';
    st.textContent = '擷取中…';
    btn.textContent = '停止擷取';
    btn.className = 'primary stop';
  } else {
    dot.className = 'dot';
    st.textContent = '已連線，未擷取';
    btn.textContent = '開始擷取';
    btn.className = 'primary';
  }
}

function notice(msg) {
  const n = $('notice');
  if (!msg) { n.classList.add('hidden'); return; }
  n.textContent = msg;
  n.classList.remove('hidden');
}

async function send(cmd) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { cmd });
  } catch (e) {
    return null;
  }
}

async function ensureContent() {
  let res = await send('ping');
  if (res && res.ok) return res;
  // 尚未注入（非 Teams/Webex 網站）→ 用 activeTab 權限注入
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content.js']
    });
    res = await send('ping');
    if (res && res.ok) return res;
  } catch (e) { /* chrome:// 等頁面會失敗 */ }
  return null;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { setState(); return; }

  const { lc_entries } = await chrome.storage.local.get('lc_entries');
  entries = Array.isArray(lc_entries) ? lc_entries : [];
  render();

  const res = await ensureContent();
  if (res) {
    connected = true;
    capturing = !!res.capturing;
    if (res.host && !res.host.includes('teams') && !res.host.includes('webex') && !res.picked) {
      notice('這個網站不是 Teams / Webex：請先按「框選字幕區域」，在頁面上點選字幕所在的區塊。');
    }
  } else {
    connected = false;
  }
  setState();
}

// 即時更新：storage 變動就重新渲染
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.lc_entries) {
    entries = changes.lc_entries.newValue || [];
    render();
  }
  if (changes.lc_capturing) {
    capturing = !!changes.lc_capturing.newValue;
    setState();
  }
});

$('btnToggle').addEventListener('click', async () => {
  const res = await send(capturing ? 'stop' : 'start');
  if (res && res.ok) {
    capturing = !!res.capturing;
    setState();
  }
});

$('btnPick').addEventListener('click', async () => {
  const res = await send('pick');
  if (res && res.ok) window.close(); // 關閉 popup，讓使用者在頁面上點選
});

$('btnCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(toText());
  $('btnCopy').textContent = '已複製 ✔';
  setTimeout(() => ($('btnCopy').textContent = '複製'), 1500);
});

$('btnDownload').addEventListener('click', () => {
  const blob = new Blob(['﻿' + toText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transcript_' + fmtDate(entries.length ? entries[0].t : Date.now()) + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('btnClear').addEventListener('click', async () => {
  if (!confirm('確定要清除目前的逐字稿嗎？')) return;
  await send('clear');
  entries = [];
  await chrome.storage.local.set({ lc_entries: [] });
  render();
});

init();
