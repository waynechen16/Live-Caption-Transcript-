// mic-permission.js — 在可見的外掛分頁中完成麥克風授權。
// offscreen 文件無法顯示權限詢問視窗，因此授權必須先在這裡完成一次；
// 之後 offscreen 的 getUserMedia 就會直接成功（權限屬於整個外掛 origin）。
const stateEl = document.getElementById('state');
const retryBtn = document.getElementById('retry');

async function ask() {
  stateEl.className = '';
  stateEl.textContent = '等待授權…';
  retryBtn.hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());   // 只要權限，不留串流
    stateEl.className = 'ok';
    stateEl.textContent = '✅ 已授權！此分頁將自動關閉，回到外掛即可開始記錄。';
    setTimeout(() => window.close(), 1800);
  } catch (e) {
    stateEl.className = 'err';
    stateEl.textContent = '❌ 授權失敗：' + e.message +
      '（若誤按封鎖，請點網址列左側的圖示改為允許，再按重新嘗試）';
    retryBtn.hidden = false;
  }
}

retryBtn.addEventListener('click', ask);
ask();
