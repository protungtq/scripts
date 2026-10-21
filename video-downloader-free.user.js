// ==UserScript==
// @name         Tải Video Miễn Phí
// @namespace    https://so1.asia/
// @homepageURL  https://so1.asia/
// @version      1.1.1
// @description  Tự động phát hiện video/audio trên trang và tải về. Miễn phí 100%, không premium, không server.
// @match        *://*/*
// @grant        GM_download
// @grant        GM_setClipboard
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const MEDIA_RE = /\.(mp4|webm|mov|mkv|avi|flv|m4v|3gp|ogv|ts|mp3|wav|ogg|oga|m4a|flac|aac|opus|weba|m3u8|mpd)(\?|#|$)/i;
  const KIND = { mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', flv: 'video', m4v: 'video', '3gp': 'video', ogv: 'video', ts: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio', opus: 'audio', weba: 'audio', m3u8: 'stream', mpd: 'stream' };
  const found = new Map();

  function extOf(url) {
    const m = url.match(/\.([a-z0-9]{2,5})(\?|#|$)/i);
    return m ? m[1].toLowerCase() : '';
  }
  function fileNameOf(url, ext) {
    try {
      let n = decodeURIComponent(url.split('?')[0].split('#')[0].split('/').pop() || '');
      n = n.replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!n || n.length < 3) n = 'media-' + Date.now().toString(36);
      if (ext && !new RegExp('\\.' + ext + '$', 'i').test(n)) n += '.' + ext;
      return n.slice(0, 180);
    } catch { return 'media-' + Date.now().toString(36); }
  }
  function fmtSize(b) {
    if (!b) return '';
    return b > 1048576 ? ' · ' + (b / 1048576).toFixed(1) + ' MB' : ' · ' + Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  function record(url, size, via) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:') || url.startsWith('data:')) return; // không tải được
    if (!/^https?:\/\//i.test(url)) return;
    if (!MEDIA_RE.test(url)) return;
    if (found.has(url)) return;
    const ext = extOf(url);
    found.set(url, { url, ext, kind: KIND[ext] || 'video', filename: fileNameOf(url, ext), size: size || 0, via: via || '' });
    refreshBadge();
  }

  // 1) Móc fetch của trang
  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url);
        if (u) record(u);
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  } catch (e) {}

  // 2) Móc XMLHttpRequest
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { record(String(url)); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  } catch (e) {}

  // 3) Theo dõi resource trình duyệt đã tải (kèm dung lượng khi lấy được)
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name) record(e.name, e.transferSize || 0);
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {}

  // 4) Quét thẻ <video>/<audio> trên trang
  function scanDom() {
    document.querySelectorAll('video, audio').forEach((el) => {
      const src = el.currentSrc || el.src;
      if (src) record(src);
    });
    document.querySelectorAll('source[src]').forEach((el) => record(el.src));
  }

  // 5) Đọc page source, lọc link media (kể cả link escape kiểu Facebook)
  const SRC_URL_RE = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(mp4|webm|mov|m4v|m3u8|mpd|flv|avi|mkv|3gp|ogv|ts|mp3|m4a|wav|ogg|oga|opus|weba|flac|aac)(\?[^\s"'<>\\]*)?/gi;
  function unescapeUrl(u) {
    return u.replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=').replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  }
  function scanSource() {
    const html = (document.documentElement && document.documentElement.outerHTML) || '';
    const before = found.size;
    SRC_URL_RE.lastIndex = 0;
    let m;
    while ((m = SRC_URL_RE.exec(html)) !== null) {
      try { record(unescapeUrl(m[0]), 0, 'từ source'); } catch (e) {}
      if (found.size - before >= 200) break; // giới hạn chống treo trang nặng
    }
    return found.size - before;
  }

  // ---------- Giao diện ----------
  let btn, panel, listEl, emptyEl, countEl;

  const CSS = `
    #vdf-btn{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:48px;height:48px;border-radius:50%;
      background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border:none;cursor:pointer;font-size:22px;
      box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
    #vdf-count{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;border-radius:10px;background:#e0245e;
      color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px}
    #vdf-panel{position:fixed;right:16px;bottom:76px;z-index:2147483647;width:360px;max-height:440px;display:none;
      flex-direction:column;background:#faf9ff;border-radius:12px;overflow:hidden;font:13px/1.45 sans-serif;color:#1e1b2e;
      box-shadow:0 8px 30px rgba(0,0,0,.35);border:1px solid #e6e1f7}
    #vdf-panel.open{display:flex}
    #vdf-head{background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;padding:10px 12px;font-weight:700;
      display:flex;justify-content:space-between;align-items:center}
    #vdf-head button{background:none;border:none;color:#fff;font-size:16px;cursor:pointer}
    #vdf-list{list-style:none;overflow-y:auto;padding:6px;margin:0;flex:1}
    #vdf-list li{display:flex;align-items:center;gap:8px;padding:8px;margin-bottom:6px;background:#fff;
      border:1px solid #e6e1f7;border-radius:10px}
    #vdf-list .b{font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 7px;border-radius:6px;color:#fff;flex-shrink:0}
    #vdf-list .b.video{background:#7c3aed}#vdf-list .b.audio{background:#0ea5e9}#vdf-list .b.stream{background:#f59e0b}
    #vdf-list .i{flex:1;min-width:0}#vdf-list .n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #vdf-list .m{font-size:11px;color:#6b6584}
    #vdf-list .dl{border:none;background:#7c3aed;color:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;flex-shrink:0}
    #vdf-list .cp{border:none;background:#e6e1f7;color:#4c1d95;border-radius:8px;padding:6px 8px;cursor:pointer;flex-shrink:0}
    #vdf-empty{padding:24px;text-align:center;color:#8a84a3;font-size:12px}
    #vdf-foot{padding:8px 12px;border-top:1px solid #e6e1f7;font-size:11px;color:#8a84a3;display:flex;justify-content:space-between}
    #vdf-foot button{border:1px solid #c9c2e8;background:#fff;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:11px}
  `;

  function buildUi() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    btn = document.createElement('button');
    btn.id = 'vdf-btn';
    btn.innerHTML = '⬇<span id="vdf-count" style="display:none">0</span>';
    btn.title = 'Tải Video Miễn Phí';
    btn.onclick = () => { scanDom(); render(); panel.classList.toggle('open'); };
    document.body.appendChild(btn);

    panel = document.createElement('div');
    panel.id = 'vdf-panel';
    panel.innerHTML = `
      <div id="vdf-head"><span>Media phát hiện được</span><button id="vdf-x">✕</button></div>
      <ul id="vdf-list"></ul>
      <div id="vdf-empty">Chưa thấy media nào.<br>Hãy phát video rồi mở lại.</div>
      <div id="vdf-foot"><span id="vdf-total"></span><span><button id="vdf-src">⌕ Lọc source</button> <button id="vdf-clear">Xóa danh sách</button></span></div>`;
    document.body.appendChild(panel);
    listEl = panel.querySelector('#vdf-list');
    emptyEl = panel.querySelector('#vdf-empty');
    countEl = panel.querySelector('#vdf-total');
    panel.querySelector('#vdf-x').onclick = () => panel.classList.remove('open');
    panel.querySelector('#vdf-clear').onclick = () => { found.clear(); render(); refreshBadge(); };
    panel.querySelector('#vdf-src').onclick = (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = '⌕ Đang lọc…';
      setTimeout(() => {
        const added = scanSource();
        render();
        b.textContent = added > 0 ? `⌕ +${added}` : '⌕ Lọc source';
        b.disabled = false;
        setTimeout(() => (b.textContent = '⌕ Lọc source'), 2500);
      }, 30);
    };
  }

  function refreshBadge() {
    const c = document.getElementById('vdf-count');
    if (!c) return;
    c.style.display = found.size ? 'flex' : 'none';
    c.textContent = found.size;
  }

  function download(item, btnEl) {
    const fallback = () => {
      const a = document.createElement('a');
      a.href = item.url; a.download = item.filename; a.target = '_blank'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    };
    try {
      if (typeof GM_download === 'function') {
        GM_download({
          url: item.url, name: item.filename, saveAs: false,
          onload: () => { btnEl.textContent = '✓'; },
          onerror: () => fallback()
        });
      } else fallback();
    } catch (e) { fallback(); }
  }

  function copyLink(url, btnEl) {
    const done = () => { btnEl.textContent = '✓'; setTimeout(() => (btnEl.textContent = '⧉'), 1200); };
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(url); done(); }
      else navigator.clipboard.writeText(url).then(done);
    } catch (e) {}
  }

  function render() {
    const arr = [...found.values()].sort((a, b) => b.size - a.size);
    listEl.innerHTML = '';
    emptyEl.style.display = arr.length ? 'none' : 'block';
    countEl.textContent = arr.length ? arr.length + ' mục' : '';
    for (const it of arr) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="b ${it.kind}">${it.ext}</span>
        <div class="i"><div class="n"></div><div class="m"></div></div>
        <button class="dl">⬇ Tải</button><button class="cp" title="Chép link">⧉</button>`;
      li.querySelector('.n').textContent = it.filename;
      li.querySelector('.n').title = it.url;
      li.querySelector('.m').textContent = (it.kind === 'stream' ? 'playlist' : it.kind) + fmtSize(it.size) + (it.via ? ' · ' + it.via : '');
      li.querySelector('.dl').onclick = (e) => download(it, e.target);
      li.querySelector('.cp').onclick = (e) => copyLink(it.url, e.target);
      listEl.appendChild(li);
    }
  }

  // ---------- Khởi động ----------
  function init() {
    buildUi();
    scanDom();
    // Quét định kỳ để bắt video load muộn / SPA
    setInterval(scanDom, 2500);
    // Bắt thẻ video được thêm động
    try {
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && (n.tagName === 'VIDEO' || n.tagName === 'AUDIO' || n.querySelector)) {
              const v = n.tagName === 'VIDEO' || n.tagName === 'AUDIO' ? [n] : [...n.querySelectorAll('video,audio')];
              v.forEach((el) => { if (el.currentSrc || el.src) record(el.currentSrc || el.src); });
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // document-start: body có thể chưa có -> đợi một nhịp
    const t = setInterval(() => {
      if (document.body) { clearInterval(t); init(); }
    }, 50);
  }
})();
