// ==UserScript==
// @name         X.com — Nút tải video MP4 trong khung phát
// @namespace    https://game8.info/
// @version      1.1.0
// @description  Hiện nút tải MP4 đẹp ở góc phải khung video trên X.com. Bấm là tải MP4 về máy, tên file theo tài khoản + mã bài đăng, không mở tab mới.
// @author       Be Soc
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      api.fxtwitter.com
// @connect      api.vxtwitter.com
// @connect      video.twimg.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  var PROCESSED = 'data-soc-xdl';

  // ---- CSS + icon cho nút tải ----
  var ICON_DL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M12 3v12"/><polyline points="6 10 12 16 18 10"/><path d="M4 21h16"/></svg>';
  var ICON_OK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><polyline points="4 12.5 9.5 18 20 6.5"/></svg>';
  var ICON_ERR = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" style="flex:none"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
  var SPINNER = '<span style="width:12px;height:12px;flex:none;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;display:inline-block;animation:socXdlSpin .7s linear infinite"></span>';

  var BTN_BG = 'linear-gradient(135deg, rgba(20,28,38,.82), rgba(10,14,20,.78))';
  var BTN_BG_HOVER = 'linear-gradient(135deg,#1d9bf0,#0a7fd4)';
  var BTN_BG_OK = 'linear-gradient(135deg,#00ba7c,#00945f)';
  var BTN_BG_ERR = 'linear-gradient(135deg,#f4212e,#c81e2b)';

  function ensureStyle() {
    if (document.getElementById('soc-xdl-style')) return;
    var st = document.createElement('style');
    st.id = 'soc-xdl-style';
    st.textContent = '@keyframes socXdlSpin{to{transform:rotate(360deg)}}';
    (document.head || document.documentElement).appendChild(st);
  }

  function btnContent(icon, label) {
    return icon + '<span>' + label + '</span>';
  }

  function setBtnState(btn, state) {
    if (state === 'loading') {
      btn.style.background = BTN_BG;
      btn.innerHTML = btnContent(SPINNER, 'Đang tải…');
    } else if (state === 'ok') {
      btn.style.background = BTN_BG_OK;
      btn.innerHTML = btnContent(ICON_OK, 'Đã tải');
    } else if (state === 'err') {
      btn.style.background = BTN_BG_ERR;
      btn.innerHTML = btnContent(ICON_ERR, 'Lỗi');
    } else {
      btn.style.background = BTN_BG;
      btn.innerHTML = btnContent(ICON_DL, 'MP4');
    }
  }
  var API_HOSTS = ['https://api.fxtwitter.com', 'https://api.vxtwitter.com'];

  // ---- Lấy username + id bài đăng từ thẻ article ----
  function getTweetInfo(article) {
    var a = article.querySelector('a[href*="/status/"]');
    if (!a) return null;
    var m = (a.getAttribute('href') || '').match(/\/([^\/\?]+)\/status\/(\d+)/);
    if (!m) return null;
    return { user: m[1], id: m[2] };
  }

  // ---- Chọn file mp4 chất lượng cao nhất ----
  function collectMp4s(videos) {
    var out = [];
    (videos || []).forEach(function (v) {
      if (v.url && /\.mp4/i.test(v.url)) {
        out.push({ url: v.url, score: (v.width || 0) * (v.height || 0) || v.bitrate || 0 });
      }
      (v.variants || []).forEach(function (x) {
        if (x.url && /\.mp4/i.test(x.url)) {
          out.push({ url: x.url, score: x.bitrate || 0 });
        }
      });
    });
    return out;
  }
  function pickBestMp4(videos) {
    var all = collectMp4s(videos);
    if (!all.length) return null;
    all.sort(function (a, b) { return b.score - a.score; });
    return all[0].url;
  }

  // ---- Gọi API FXTwitter lấy link mp4 trực tiếp ----
  function fetchMp4(info, hostIdx, done) {
    var api = API_HOSTS[hostIdx] + '/' + info.user + '/status/' + info.id;
    GM_xmlhttpRequest({
      method: 'GET',
      url: api,
      timeout: 15000,
      onload: function (res) {
        try {
          var data = JSON.parse(res.responseText);
          var videos = (((data || {}).tweet || {}).media || {}).videos || [];
          var mp4 = pickBestMp4(videos);
          if (mp4) { done(null, mp4); return; }
        } catch (e) { /* thử host khác */ }
        if (hostIdx + 1 < API_HOSTS.length) fetchMp4(info, hostIdx + 1, done);
        else done(new Error('no-mp4'));
      },
      onerror: function () {
        if (hostIdx + 1 < API_HOSTS.length) fetchMp4(info, hostIdx + 1, done);
        else done(new Error('api-error'));
      },
      ontimeout: function () {
        if (hostIdx + 1 < API_HOSTS.length) fetchMp4(info, hostIdx + 1, done);
        else done(new Error('api-timeout'));
      }
    });
  }

  // ---- Tải file ----
  function downloadVideo(btn, info) {
    if (btn.disabled) return;
    btn.disabled = true;
    setBtnState(btn, 'loading');
    fetchMp4(info, 0, function (err, mp4url) {
      if (err || !mp4url) {
        setBtnState(btn, 'err');
        setTimeout(function () { btn.disabled = false; setBtnState(btn, 'idle'); }, 2000);
        return;
      }
      var name = info.user + '_' + info.id + '.mp4';
      var failed = false;
      try {
        GM_download({
          url: mp4url,
          name: name,
          saveAs: false,
          onerror: function () {
            failed = true;
            setBtnState(btn, 'err');
            setTimeout(function () { btn.disabled = false; setBtnState(btn, 'idle'); }, 2000);
          },
          ontimeout: function () {
            failed = true;
            setBtnState(btn, 'err');
            setTimeout(function () { btn.disabled = false; setBtnState(btn, 'idle'); }, 2000);
          }
        });
        setBtnState(btn, 'ok');
      } catch (e) {
        failed = true;
        setBtnState(btn, 'err');
      }
      setTimeout(function () {
        if (!failed) { btn.disabled = false; setBtnState(btn, 'idle'); }
      }, 2500);
    });
  }

  // ---- Tạo nút tải ----
  function makeButton(info) {
    ensureStyle();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Tải video MP4 về máy';
    btn.style.cssText =
      'position:absolute;top:10px;right:10px;z-index:9999;' +
      'display:inline-flex;align-items:center;gap:6px;' +
      'font-size:12px;font-weight:700;line-height:1;letter-spacing:.3px;' +
      'padding:7px 12px;border-radius:999px;cursor:pointer;' +
      'border:1px solid rgba(255,255,255,.35);' +
      'background:' + BTN_BG + ';color:#fff;' +
      'backdrop-filter:blur(8px) saturate(150%);-webkit-backdrop-filter:blur(8px) saturate(150%);' +
      'box-shadow:0 4px 14px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.18);' +
      'font-family:inherit;transition:all .18s ease;';
    setBtnState(btn, 'idle');
    btn.addEventListener('mouseenter', function () {
      if (btn.disabled) return;
      btn.style.background = BTN_BG_HOVER;
      btn.style.transform = 'translateY(-1px) scale(1.05)';
      btn.style.boxShadow = '0 6px 18px rgba(29,155,240,.45), inset 0 1px 0 rgba(255,255,255,.25)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.transform = '';
      btn.style.boxShadow = '0 4px 14px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.18)';
      if (!btn.disabled) btn.style.background = BTN_BG;
    });
    btn.addEventListener('mousedown', function () { btn.style.transform = 'scale(.96)'; });
    btn.addEventListener('mouseup', function () { btn.style.transform = ''; });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      downloadVideo(btn, info);
    }, true);
    return btn;
  }

  // ---- Gắn nút vào từng khung video trong 1 bài đăng ----
  function attachToArticle(article) {
    var info = getTweetInfo(article);
    if (!info) return;
    var players = article.querySelectorAll('div[data-testid="videoPlayer"]');
    players.forEach(function (p) {
      if (p.hasAttribute(PROCESSED)) return;
      p.setAttribute(PROCESSED, '1');
      if (getComputedStyle(p).position === 'static') p.style.position = 'relative';
      p.appendChild(makeButton(info));
    });
  }

  function scan() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(attachToArticle);
  }

  // ---- Theo dõi nội dung tải động khi cuộn ----
  var scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      try { scan(); } catch (e) {}
    }, 400);
  }

  scan();
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  // Lưới an toàn: quét lại mỗi 5 giây
  setInterval(function () { try { scan(); } catch (e) {} }, 5000);
})();
