// ==UserScript==
// @name         Tải Video Facebook HD
// @name:en      Facebook HD Video Downloader
// @namespace    https://so1.asia/
// @homepageURL  https://so1.asia/
// @version      1.0.1
// @description  Thêm nút tải xuống vào mọi video trên Facebook (Feed, Watch, Reel): bấm là tải bản HD (nếu có) về máy. Cơ chế port từ MonokaiToolkit — chỉ giữ phần tải video, bỏ hết reaction, bot Messenger, MQTT và theo dõi.
// @description:en Adds a download button to every Facebook video player (Feed, Watch, Reels) and downloads the HD version when available.
// @author       Game8
// @license      MIT
// @match        *://*.facebook.com/*
// @run-at       document-start
// @grant        GM_download
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   * CƠ CHẾ (giữ đúng của bản gốc MonokaiToolkit):
   * 1. Móc vào bộ nạp module của Facebook (window.__d), vá component
   *    "VideoPlayerRelay.react" để chèn thêm nút tải vào trình phát.
   * 2. Bấm nút -> lấy ID video -> gọi GraphQL nội bộ của Facebook
   *    (doc_id 5279476072161634, kèm fb_dtsg) -> lấy
   *    playable_url_quality_hd (hoặc playable_url nếu không có HD).
   * 3. Tải file bằng GM_download.
   * Ngoài ra có nút dự phòng ở góc màn hình cho trang Watch/Reel
   * (phòng khi Facebook đổi tên module thì vẫn tải được theo ID trên URL).
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

  // ---------- GraphQL nội bộ của Facebook ----------
  function fbGraphQL(docId, variables) {
    var dtsg = unsafeWindow.require('DTSGInitialData').token;
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
    });
  }

  // ---------- Lấy link và tải video theo ID ----------
  function downloadFacebookVideo(videoId) {
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
    })
      .then(function (res) {
        return res.text();
      })
      .then(function (text) {
        var json = JSON.parse(text.split('\n')[0]);
        var video = json && json.data && json.data.video;
        var url = video && (video.playable_url_quality_hd || video.playable_url);
        if (!url) throw new Error('Không lấy được link video (video riêng tư hoặc đã bị gỡ).');
        var name = 'fb-video-' + videoId + '.mp4';
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

  // ---------- Vá module của Facebook ----------
  // Gói một module theo tên: sau khi factory chạy, tìm object exports
  // có thuộc tính "default" (chính là component) rồi bọc nó lại.
  function makeModulePatch(moduleName, wrapExport) {
    return function (_thisArg, dArgs) {
      if (!dArgs || dArgs[0] !== moduleName) return;
      var factory = dArgs[2];
      if (typeof factory !== 'function') return;
      dArgs[2] = function () {
        var ret = factory.apply(this, arguments);
        for (var i = arguments.length - 1; i >= 0; i--) {
          var exp = arguments[i];
          if (exp && typeof exp === 'object' && 'default' in exp) {
            var original = exp.default;
            if (typeof original === 'function' && !original.__fbDlWrapped) {
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

  // Bọc VideoPlayerRelay: render lại player gốc + thêm nút tải ở góc phải.
  function wrapVideoPlayer(originalComponent, thisArg, callArgs) {
    var React = unsafeWindow.require('react');
    var playerEl = originalComponent.bind(thisArg).apply(null, callArgs);
    var props = callArgs[0] || {};

    function DownloadButton() {
      var state = React.useState(false);
      var loading = state[0];
      var setLoading = state[1];
      return React.createElement(
        'a',
        {
          title: 'Tải video này',
          style: {
            position: 'absolute',
            width: 40,
            height: 40,
            top: 60,
            right: 10,
            zIndex: 99999,
            backgroundColor: loading ? '#00000088' : '#00000044',
            display: 'flex',
            borderRadius: 8,
            transition: 'all 200ms',
            cursor: 'pointer',
          },
          onClick: function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (loading) return;
            var video = props.video;
            var id = video && (video.id || video.__id);
            if (!id) return;
            setLoading(true);
            downloadFacebookVideo(id)
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
      { style: { position: 'relative', height: '100%' } },
      playerEl,
      React.createElement(DownloadButton)
    );
  }

  var patches = [makeModulePatch('VideoPlayerRelay.react', wrapVideoPlayer)];

  // Cài hook vào window.__d giống bản gốc: khi Facebook gán __d thật,
  // giữ lại và bọc nó bằng hàm chạy các patch trước.
  var realD = null;
  if (typeof unsafeWindow.__d === 'undefined') {
    Object.defineProperty(unsafeWindow, '__d', {
      configurable: true,
      get: function () {
        return function () {
          try {
            for (var i = 0; i < patches.length; i++) patches[i](this, arguments);
          } catch (e) {
            console.warn('[fb-dl] patch error:', e);
          }
          return realD && realD.apply(this, arguments);
        };
      },
      set: function (v) {
        realD = v;
      },
    });
  }

  // ---------- Nút dự phòng cho trang Watch / Reel / Videos ----------
  function videoIdFromUrl() {
    try {
      var u = new URL(location.href);
      var v = u.searchParams.get('v');
      if (v && /^\d+$/.test(v)) return v;
      var m = location.pathname.match(/\/(?:videos|reel)\/(\d{6,})/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }

  function ensureFloatButton() {
    var id = videoIdFromUrl();
    var btn = document.querySelector('.fb-dl-float');
    if (!id) {
      if (btn) btn.remove();
      return;
    }
    if (btn) {
      btn.dataset.videoId = id;
      return;
    }
    btn = document.createElement('button');
    btn.className = 'fb-dl-float';
    btn.dataset.videoId = id;
    btn.textContent = '⬇ Tải video HD';
    btn.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#0866ff;color:#fff;border:0;' +
      'padding:10px 16px;border-radius:999px;font:600 14px/1 system-ui,sans-serif;cursor:pointer;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.3)';
    btn.addEventListener('click', function () {
      var vid = btn.dataset.videoId;
      if (!vid || btn.disabled) return;
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = 'Đang lấy link…';
      downloadFacebookVideo(vid)
        .catch(function (err) {
          toast('Lỗi tải video: ' + (err && err.message ? err.message : err));
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = old;
        });
    });
    document.documentElement.appendChild(btn);
  }

  setInterval(ensureFloatButton, 1500);
})();
