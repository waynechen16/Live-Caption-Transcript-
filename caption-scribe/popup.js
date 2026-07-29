// popup.js — Caption Scribe（DOM 版）v1.1
const $ = (id) => document.getElementById(id);
const toggle = $('toggle');
const status = $('status');
let tab = null;
let connected = false;
let capturing = false;

const FIELDS = ['provider', 'deeplKey', 'geminiKey'];

async function saveSettings() {
  const data = {};
  for (const f of FIELDS) data[f] = $(f).value.trim();
  data.cs_translate = $('translateOn').checked;
  data.recEnabled = $('recEnabled').checked;
  data.micEnabled = $('micEnabled').checked;
  await chrome.storage.local.set(data);
}
for (const f of FIELDS) $(f).addEventListener('change', saveSettings);
$('translateOn').addEventListener('change', saveSettings);
$('recEnabled').addEventListener('change', saveSettings);

// 麥克風開關：勾選時若尚未授權，開授權分頁完成一次授權（移植自參考版）
$('micEnabled').addEventListener('change', async () => {
  await saveSettings();
  if (!$('micEnabled').checked) return;
  if (!$('recEnabled').checked) { $('recEnabled').checked = true; await saveSettings(); }
  let state = 'prompt';
  try { state = (await navigator.permissions.query({ name: 'microphone' })).state; } catch {}
  if (state !== 'granted') {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
    status.textContent = '請在新分頁完成麥克風授權後再開始擷取';
  } else if (capturing) {
    status.textContent = '麥克風設定將在下次開始時生效';
  }
});

function setCapturing(on) {
  capturing = on;
  toggle.textContent = on ? '■ 停止擷取' : '▶ 開始擷取這個分頁的字幕';
  toggle.className = on ? 'stop' : 'start';
}

async function send(cmd) {
  try { return await chrome.tabs.sendMessage(tab.id, { cmd }); }
  catch { return null; }
}

async function ensureContent() {
  let res = await send('ping');
  if (res && res.ok) return res;
  // 非內建支援網站 → 用 activeTab 權限手動注入
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
    res = await send('ping');
    if (res && res.ok) return res;
  } catch { /* chrome:// 等頁面會失敗 */ }
  return null;
}

async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  const saved = await chrome.storage.local.get([...FIELDS, 'cs_translate', 'recEnabled', 'micEnabled']);
  for (const f of FIELDS) if (saved[f]) $(f).value = saved[f];
  $('translateOn').checked = saved.cs_translate !== false;   // 預設開
  $('recEnabled').checked = !!saved.recEnabled;
  $('micEnabled').checked = !!saved.micEnabled;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await ensureContent();
  if (res) {
    connected = true;
    setCapturing(!!res.capturing);
    const builtin = res.host && (res.host.includes('teams') || res.host.includes('webex') || res.host.includes('meet.google'));
    if (!builtin && !res.picked) {
      status.textContent = '這個網站需要先「框選字幕區域」再開始擷取。';
    }
  } else {
    connected = false;
    toggle.disabled = true;
    $('pick').disabled = true;
    $('clearPick').disabled = true;
    status.textContent = '此頁面無法擷取（chrome:// 或商店頁）。';
  }
}

toggle.addEventListener('click', async () => {
  if (!connected) return;
  await saveSettings();
  if (!capturing) {
    const s = await chrome.storage.local.get([...FIELDS, 'cs_translate', 'recEnabled']);
    if (s.cs_translate !== false) {
      if ((s.provider || 'deepl') === 'deepl' && !s.deeplKey) { status.textContent = '選用 DeepL 需填 DeepL API Key（或關閉翻譯）'; return; }
      if (s.provider === 'gemini' && !s.geminiKey) { status.textContent = '選用 Gemini 需填 Gemini API Key（或關閉翻譯）'; return; }
    }
    const res = await send('start');
    if (!res?.ok) { status.textContent = '啟動失敗'; return; }
    setCapturing(true);
    let note = '擷取中…面板會顯示在網頁上';
    if (s.recEnabled) {
      const r = await chrome.runtime.sendMessage({ type: 'START_REC' }).catch(() => null);
      note += r?.ok ? '（錄音中）' : `（錄音失敗：${r?.error || '未知錯誤'}）`;
    }
    status.textContent = note;
  } else {
    await send('stop');
    await chrome.runtime.sendMessage({ type: 'STOP_REC' }).catch(() => {});
    setCapturing(false);
    status.textContent = '已停止（面板上仍可匯出文字與音檔）';
  }
});

$('showPanel').addEventListener('click', async () => {
  const res = await send('showPanel');
  status.textContent = res?.ok ? '已顯示字幕面板' : '無法顯示面板';
});

$('pick').addEventListener('click', async () => {
  const res = await send('pick');
  if (res?.ok) window.close(); // 關閉 popup 讓使用者在頁面上點選
});

$('clearPick').addEventListener('click', async () => {
  const res = await send('clearPick');
  status.textContent = res?.ok ? '已清除框選，改用預設字幕位置' : '清除失敗';
});

$('dumpDom').addEventListener('click', async () => {
  const res = await send('dumpDom');
  status.textContent = res?.ok ? '已下載字幕結構檔，請把該 HTML 檔提供給開發者' : '匯出失敗';
});

init();
