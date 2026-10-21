// ==UserScript==
// @name         Tải Video Facebook HD
// @name:en      Facebook HD Video Downloader
// @namespace    https://so1.asia/
// @homepageURL  https://so1.asia/
// @version      1.2.0
// @description  Gắn nút tải vào mọi video trên Facebook (Feed, Watch, Reel và cả Story): ưu tiên lấy bản HD qua GraphQL nội bộ của Facebook, hụt thì tải thẳng từ nguồn video đang phát. Hai tầng như bản extension: vá trình phát React + quét mọi thẻ video trên trang.
// @description:en Adds a download button to every Facebook video (Feed, Watch, Reels and Stories), preferring the HD URL from Facebook's internal GraphQL with a direct-source fallback.
// @author       Game8
// @license      MIT
// @match        *://*.facebook.com/*
// @run-at       document-start
// @grant        GM_download
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   * THIẾT KẾ 2 TẦNG (học theo extension Facebook Media Downloader):
   * Tầng 1 — Vá module "VideoPlayerRelay.react" của Facebook qua
   *   hook window.__d, chèn nút tải vào từng trình phát. Bấm nút:
   *   gọi GraphQL nội bộ (doc_id 5279476072161634) lấy bản HD.
   * Tầng 2 — Quét mọi thẻ <video> xuất hiện trên trang (kể cả Story,
   *   hộp thoại, video nạp lười) và chèn nút tải vào khung chứa nó.
   *   Bấm nút: tìm ID video quanh khung để gọi GraphQL lấy HD,
   *   không có ID thì tải thẳng currentSrc của video đang phát.
   * ================================================================ */

  var GRAPHQL_DOC_ID = '5279476072161634';

  var ICON_DOWNLOAD =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/></svg>'
    );
  var ICON_SPINNER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>'
    );

  // ---------------- Dùng chung ----------------

  function fbGraphQL(docId, variables) {
    var dtsg = '';
    try {
      dtsg = unsafeWindow.require('DTSGInitialData').token || '';
    } catch (e) {}
    if (!dtsg) return Promise.reject(new Error('Không lấy được Facebook DTSG token.'));
    var body = new URLSearchParams();
    body.set('doc_id', docId);
    body.set('variables', JSON.stringify(variables));
    body.set('fb_dtsg', dtsg);
    body.set('server_timestamps', 'true');
    return fetch('https://www.facebook.com/api/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
      .then(function (res) {
        return res.text();
      })
      .then(function (text) {
        // Facebook đôi khi trả tiền tố for(;;); trước JSON — phải bóc ra.
        var firstLine = text.replace(/^for \(;;\);/, '').split('\n')[0];
        var json = JSON.parse(firstLine);
        if (json && json.errors && json.errors.length) {
          throw new Error(json.errors[0].message || 'Facebook GraphQL error.');
        }
        return json;
      });
  }

  // Lấy URL phát theo ID: ưu tiên HD, không có thì bản thường.
  function fetchPlayableUrl(videoId) {
    return fbGraphQL(GRAPHQL_DOC_ID, {
      UFI2CommentsProvider_commentsKey: 'CometTahoeSidePaneQuery',
      caller: 'CHANNEL_VIEW_FROM_PAGE_TIMELINE',
      displayCommentsContextEnableComment: null,
      displayCommentsContextIsAdPreview: null,
      displayCommentsContextIsAggregatedShare: null,
      displayCommentsContextIsStorySet: null,
      displayCommentsFeedbackContext: null,
      feedbackSource: 41,
      feedLocation: 'TAHOE',
      focusCommentID: null,
      privacySelectorRenderLocation: 'COMET_STREAM',
      renderLocation: 'video_channel',
      scale: 1,
      streamChainingSection: false,
      useDefaultActor: false,
      videoChainingContext: null,
      videoID: String(videoId),
    }).then(function (json) {
      var video = json && json.data && json.data.video;
      var url = video && (video.playable_url_quality_hd || video.playable_url);
      return url && /^https?:\/\//i.test(url) ? url : '';
    });
  }

  function saveDownload(url, videoId) {
    var name = 'Facebook/' + (videoId ? 'fb-' + videoId : 'fb-video-' + Date.now()) + '.mp4';
    if (typeof GM_download === 'function') {
      GM_download({
        url: url,
        name: name,
        onerror: function () {
          window.open(url, '_blank');
        },
      });
    } else {
      window.open(url, '_blank');
    }
  }

  // Trình tự lấy link: GraphQL theo ID -> currentSrc của video đang phát.
  function resolveAndDownload(videoId, videoEl) {
    var direct = '';
    try {
      direct = (videoEl && (videoEl.currentSrc || videoEl.src)) || '';
    } catch (e) {}
    var tryDirect = function () {
      if (direct && /^https?:\/\//i.test(direct)) {
        saveDownload(direct, videoId);
        return true;
      }
      return false;
    };
    if (!videoId) {
      if (tryDirect()) return Promise.resolve();
      return Promise.reject(new Error('Không lấy được URL video.'));
    }
    return fetchPlayableUrl(videoId)
      .then(function (url) {
        if (url) {
          saveDownload(url, videoId);
          return;
        }
        if (!tryDirect()) throw new Error('Không lấy được URL video.');
      })
      .catch(function (err) {
        if (tryDirect()) return;
        throw err;
      });
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;' +
      'padding:10px 18px;border-radius:999px;font:14px/1.4 system-ui,sans-serif;z-index:2147483647;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:86vw;text-align:center';
    document.documentElement.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 3600);
  }

  // ================================================================
  // TẦNG 1 — Vá VideoPlayerRelay.react qua hook window.__d
  // ================================================================

  function makeModulePatch(moduleName, wrapExport) {
    return function (_thisArg, dArgs) {
      if (!dArgs || dArgs[0] !== moduleName) return;
      var factory = dArgs[2];
      if (typeof factory !== 'function') return;
      dArgs[2] = function () {
        var ret = factory.apply(this, arguments);
        for (var i = arguments.length - 1; i >= 0; i--) {
          var exp = arguments[i];
          if (exp && exp.default && typeof exp.default === 'function') {
            var original = exp.default;
            if (!original.__fbDlWrapped) {
              var wrapped = function () {
                return wrapExport(original, this, Array.prototype.slice.call(arguments));
              };
              wrapped.__fbDlWrapped = true;
              exp.default = wrapped;
            }
            break;
          }
        }
        return ret;
      };
    };
  }

  function wrapVideoPlayer(originalComponent, thisArg, callArgs) {
    var React = null;
    try {
      React = unsafeWindow.require('react');
    } catch (e) {}
    // Không có React thì trả player nguyên trạng, tuyệt đối không làm vỡ trình phát.
    if (!React) return originalComponent.apply(thisArg, callArgs);

    var playerEl = originalComponent.apply(thisArg, callArgs);
    var props = callArgs[0] || {};

    function DownloadButton() {
      var state = React.useState(false);
      var loading = state[0];
      var setLoading = state[1];
      return React.createElement(
        'a',
        {
          title: 'Tải video',
          'aria-label': 'Tải video Facebook',
          style: {
            position: 'absolute',
            width: 40,
            height: 40,
            top: 60,
            right: 10,
            zIndex: 2147483000,
            backgroundColor: loading ? 'rgba(0,0,0,0.72)' : 'rgba(0,0,0,0.46)',
            border: '1px solid rgba(255,255,255,0.18)',
            boxShadow: '0 6px 18px rgba(0,0,0,0.28)',
            display: 'flex',
            borderRadius: 10,
            transition: 'all 200ms',
            cursor: 'pointer',
          },
          onClick: function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (loading) return;
            var video = props.video;
            var id = video && (video.id || video.__id);
            // Đường lùi: thẻ <video> thật trong cùng khung (dialog/article/cha).
            var btn = ev.currentTarget;
            var scope =
              (btn && btn.closest && (btn.closest('[role="dialog"]') || btn.closest('article'))) ||
              (btn && btn.parentElement && btn.parentElement.parentElement) ||
              document;
            var videoEl = scope && scope.querySelector ? scope.querySelector('video') : null;
            setLoading(true);
            resolveAndDownload(id ? String(id) : '', videoEl)
              .catch(function (err) {
                toast('Lỗi tải video: ' + (err && err.message ? err.message : err));
              })
              .finally(function () {
                setLoading(false);
              });
          },
        },
        React.createElement('img', {
          src: loading ? ICON_SPINNER : ICON_DOWNLOAD,
          style: { width: 20, height: 20, margin: 'auto', pointerEvents: 'none' },
        })
      );
    }

    return React.createElement(
      'div',
      { className: 'fbdl-player-wrap', style: { position: 'relative', width: '100%', height: '100%' } },
      playerEl,
      React.createElement(DownloadButton)
    );
  }

  var patches = [makeModulePatch('VideoPlayerRelay.react', wrapVideoPlayer)];

  function runPatches(thisArg, dArgs) {
    try {
      for (var i = 0; i < patches.length; i++) patches[i](thisArg, dArgs);
    } catch (e) {
      console.warn('[fb-dl] patch error:', e);
    }
  }

  // Hook 2 lớp: __d chưa có -> cài getter/setter chờ; đã có -> bọc luôn hàm hiện tại.
  if (typeof unsafeWindow.__d === 'undefined') {
    var realD = null;
    try {
      Object.defineProperty(unsafeWindow, '__d', {
        configurable: true,
        get: function () {
          return function () {
            runPatches(this, arguments);
            return realD && realD.apply(this, arguments);
          };
        },
        set: function (v) {
          realD = v;
        },
      });
    } catch (e) {
      console.warn('[fb-dl] __d hook failed:', e);
    }
  } else if (typeof unsafeWindow.__d === 'function' && !unsafeWindow.__d.__fbDlHooked) {
    var origD = unsafeWindow.__d;
    var hookedD = function () {
      runPatches(this, arguments);
      return origD.apply(this, arguments);
    };
    hookedD.__fbDlHooked = true;
    try {
      unsafeWindow.__d = hookedD;
    } catch (e) {
      console.warn('[fb-dl] cannot wrap existing __d:', e);
    }
  }

  // ================================================================
  // TẦNG 2 — Quét mọi thẻ <video> trên trang (fallback phủ cả Story)
  // ================================================================

  var STYLE_ID = 'fbdl-dom-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.fbdl-dom-btn{position:absolute!important;top:10px!important;right:10px!important;' +
      'z-index:2147483000!important;width:40px!important;height:40px!important;' +
      'display:inline-flex!important;align-items:center!important;justify-content:center!important;' +
      'padding:0!important;margin:0!important;box-sizing:border-box!important;' +
      'border:1px solid rgba(255,255,255,.18)!important;border-radius:10px!important;' +
      'background:rgba(0,0,0,.46)!important;box-shadow:0 6px 18px rgba(0,0,0,.28)!important;' +
      'color:#fff!important;cursor:pointer!important;opacity:.92;transition:all 160ms ease!important}' +
      '.fbdl-dom-btn:hover{background:rgba(0,0,0,.72)!important;opacity:1;transform:scale(1.06)}' +
      '.fbdl-dom-btn img{width:20px!important;height:20px!important;display:block!important;pointer-events:none!important}' +
      '.fbdl-dom-btn.is-loading{cursor:wait!important;opacity:.7!important;pointer-events:none!important}' +
      '.fbdl-dom-btn.is-error{background:rgba(239,68,68,.82)!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  function findVideoIdNear(host) {
    try {
      var u = new URL(location.href);
      var v = u.searchParams.get('v');
      if (v && /^\d+$/.test(v)) return v;
      var pm = location.pathname.match(/\/(?:videos|reel)\/(\d{6,})/);
      if (pm) return pm[1];
    } catch (e) {}
    if (host && host.querySelectorAll) {
      var links = host.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href') || '';
        var m =
          href.match(/[?&]v=(\d{6,})/) ||
          href.match(/\/(?:videos|reel)\/(\d{6,})/);
        if (m) return m[1];
      }
    }
    return '';
  }

  var seenVideos = new WeakSet();

  function scanVideos() {
    injectStyle();
    var videos = document.querySelectorAll('video');
    videos.forEach(function (video) {
      if (seenVideos.has(video)) return;
      seenVideos.add(video);
      // Video nằm trong player đã vá ở tầng 1 thì bỏ qua, tránh 2 nút.
      if (video.closest && video.closest('.fbdl-player-wrap')) return;

      var host =
        (video.closest && (video.closest('[role="dialog"]') || video.closest('article'))) ||
        video.parentElement;
      if (!host || (host.querySelector && host.querySelector('.fbdl-dom-btn'))) return;

      try {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      } catch (e) {}

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'fbdl-dom-btn';
      button.title = 'Tải video';
      button.setAttribute('aria-label', 'Tải video Facebook');
      var img = document.createElement('img');
      img.src = ICON_DOWNLOAD;
      img.alt = '';
      button.appendChild(img);

      button.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (button.classList.contains('is-loading')) return;
        button.classList.add('is-loading');
        img.src = ICON_SPINNER;
        var id = findVideoIdNear(host);
        resolveAndDownload(id, video)
          .catch(function (err) {
            button.classList.add('is-error');
            setTimeout(function () {
              button.classList.remove('is-error');
            }, 1800);
            toast('Lỗi tải video: ' + (err && err.message ? err.message : err));
          })
          .finally(function () {
            button.classList.remove('is-loading');
            img.src = ICON_DOWNLOAD;
          });
      });

      host.appendChild(button);
    });
  }

  var scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanVideos, 120);
  }

  function startDomFallback() {
    var observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', scanVideos, { once: true });
    setTimeout(scanVideos, 1200);
    setInterval(scanVideos, 4000);
  }

  if (document.documentElement) {
    startDomFallback();
  } else {
    document.addEventListener('DOMContentLoaded', startDomFallback, { once: true });
  }
})();
