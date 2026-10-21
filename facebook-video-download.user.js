// ==UserScript==
// @name         Tải Video Facebook HD
// @name:en      Facebook HD Video Downloader
// @namespace    https://so1.asia/
// @homepageURL  https://so1.asia/
// @version      1.4.0
// @description  Gắn nút tải vào mọi video trên Facebook (Feed, Watch, Reel và cả Story). Kiến trúc 3 lớp như extension: lớp chạy trong trang vá trình phát VideoPlayerRelay để lấy ID và link HD qua GraphQL nội bộ, lớp Tampermonkey nhận link và tải file xuống; thêm tầng quét thẻ video dự phòng cho mọi video trên màn hình.
// @description:en Adds a download button to every Facebook video (Feed, Watch, Reels and Stories). A page-context layer patches the VideoPlayerRelay player to fetch HD URLs via Facebook's internal GraphQL, the userscript layer downloads the file, plus a DOM fallback for any on-screen video.
// @author       Game8
// @license      MIT
// @match        *://*.facebook.com/*
// @run-at       document-start
// @grant        GM_download
// ==/UserScript==

(function () {
  'use strict';

  /* ================================================================
   * KIẾN TRÚC 3 LỚP (theo extension Facebook Media Downloader):
   * Lớp TRANG (pageMain): chạy ngay trong trang Facebook từ
   *   document-start, hook window.__d, vá VideoPlayerRelay.react,
   *   gắn nút tải vào từng trình phát (kể cả Story). Bấm nút ->
   *   GraphQL nội bộ lấy link HD -> postMessage ra lớp ngoài.
   * Lớp TAMPERMONKEY (phần còn lại của file): nhận link qua
   *   postMessage rồi GM_download; đồng thời chạy tầng quét thẻ
   *   <video> dự phòng cho video nào lớp trang chưa phủ tới.
   * Nếu việc chèn lớp trang bị chặn, lớp ngoài tự cài hook qua
   *   unsafeWindow như phương án dự phòng cuối.
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

  /* ================================================================
   * LỚP TRANG — hàm này được stringify và chèn vào trang, phải TỰ
   * CHỨA hoàn toàn (chỉ dùng window/document và __FBDL_CONFIG).
   * ================================================================ */
  function pageMain() {
    if (window.__fbDlPageHook) return;
    window.__fbDlPageHook = true;

    var DOC_ID = '5279476072161634';
    var CFG = window.__FBDL_CONFIG || {};
    var ICON_DL = CFG.iconDownload || '';
    var ICON_SPIN = CFG.iconSpinner || '';

    function postToSandbox(type, payload) {
      window.postMessage({ source: 'FBDL_PAGE', type: type, payload: payload }, '*');
    }

    function graphql(docId, variables) {
      var dtsg = '';
      try {
        dtsg = window.require('DTSGInitialData').token || '';
      } catch (e) {}
      if (!dtsg) return Promise.reject(new Error('[token] Không lấy được Facebook DTSG token.'));
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
          var firstLine = text.replace(/^for \(;;\);/, '').split('\n')[0];
          var json;
          try {
            json = JSON.parse(firstLine);
          } catch (e) {
            throw new Error('[graphql] Phản hồi không phải JSON: ' + firstLine.slice(0, 80));
          }
          if (json && json.errors && json.errors.length) {
            throw new Error('[graphql] ' + (json.errors[0].message || 'Facebook GraphQL error.'));
          }
          return json;
        });
    }

    function fetchPlayableUrl(videoId) {
      return graphql(DOC_ID, {
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

    function h(React, type, props, children) {
      if (typeof React.jsx === 'function') {
        var p = props || {};
        if (children !== undefined) p.children = children;
        return React.jsx(type, p);
      }
      var args = [type, props || null];
      if (children !== undefined) args = args.concat(children);
      return React.createElement.apply(null, args);
    }

    function getReact() {
      try {
        return window.require('react') || null;
      } catch (e) {
        return null;
      }
    }

    function wrapVideoPlayer(original, context, renderArgs) {
      var React = getReact();
      if (!React) return original.apply(context, renderArgs);
      var player = original.apply(context, renderArgs);
      var videoData = (renderArgs && renderArgs[0] && renderArgs[0].video) || {};
      var videoId = videoData.id || videoData.__id || '';

      function DownloadButton() {
        var st = React.useState(false);
        var loading = st[0];
        var setLoading = st[1];
        var er = React.useState(false);
        var hasError = er[0];
        var setError = er[1];

        function handleClick(ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (loading) return;
          if (!videoId) {
            postToSandbox('FBDL_ERROR', '[link] Trình phát không kèm ID video.');
            return;
          }
          setLoading(true);
          setError(false);
          fetchPlayableUrl(videoId)
            .then(function (url) {
              if (!url) throw new Error('[link] Facebook không trả link phát cho video này.');
              postToSandbox('FBDL_DOWNLOAD', {
                url: url,
                filename: 'Facebook/fb-' + videoId + '.mp4',
              });
            })
            .catch(function (err) {
              setError(true);
              setTimeout(function () {
                setError(false);
              }, 1800);
              postToSandbox('FBDL_ERROR', err && err.message ? err.message : String(err));
            })
            .finally(function () {
              setLoading(false);
            });
        }

        return h(
          React,
          'button',
          {
            type: 'button',
            className: 'fbdl-download-btn',
            title: loading ? 'Đang chuẩn bị tải...' : 'Tải video',
            'aria-label': 'Tải video Facebook',
            onClick: handleClick,
            style: {
              position: 'absolute',
              width: 40,
              height: 40,
              top: 60,
              right: 10,
              zIndex: 2147483000,
              backgroundColor: hasError
                ? 'rgba(239,68,68,0.82)'
                : loading
                  ? 'rgba(0,0,0,0.72)'
                  : 'rgba(0,0,0,0.46)',
              border: '1px solid rgba(255,255,255,0.18)',
              boxShadow: '0 6px 18px rgba(0,0,0,0.28)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 10,
              cursor: 'pointer',
              padding: 0,
            },
          },
          h(React, 'img', {
            src: loading ? ICON_SPIN : ICON_DL,
            alt: '',
            style: { width: 20, height: 20, display: 'block', pointerEvents: 'none' },
          })
        );
      }

      return h(
        React,
        'div',
        {
          className: 'fbdl-player-wrap',
          style: { position: 'relative', width: '100%', height: '100%' },
        },
        [player, h(React, DownloadButton, { key: 'fbdl-download' })]
      );
    }

    function patchModule(moduleName, moduleArgs, wrapper) {
      if (!moduleArgs || moduleArgs[0] !== moduleName) return;
      var originalFactory = moduleArgs[2];
      if (typeof originalFactory !== 'function') return;
      moduleArgs[2] = function () {
        var result = originalFactory.apply(this, arguments);
        for (var i = arguments.length - 1; i >= 0; i--) {
          var candidate = arguments[i];
          if (candidate && candidate.default && typeof candidate.default === 'function') {
            var original = candidate.default;
            if (!original.__fbDlWrapped) {
              var wrapped = function () {
                return wrapper(original, this, Array.prototype.slice.call(arguments));
              };
              wrapped.__fbDlWrapped = true;
              candidate.default = wrapped;
            }
            break;
          }
        }
        return result;
      };
    }

    function installPatch(self, moduleArgs) {
      patchModule('VideoPlayerRelay.react', moduleArgs, wrapVideoPlayer);
    }

    // Hook __d hai lớp, giống extension: đã có hàm thì bọc luôn,
    // chưa có thì cài getter/setter chờ Facebook gán.
    var patches = [installPatch];
    var originalDefine;
    function runPatches(self, args) {
      try {
        for (var i = 0; i < patches.length; i++) patches[i](self, args);
      } catch (e) {
        if (window.console) console.debug('[fb-dl] module patch error:', e);
      }
    }

    if (typeof window.__d === 'function') {
      originalDefine = window.__d;
      window.__d = function () {
        runPatches(this, arguments);
        return originalDefine.apply(this, arguments);
      };
    } else {
      try {
        Object.defineProperty(window, '__d', {
          configurable: true,
          get: function () {
            return function () {
              runPatches(this, arguments);
              return originalDefine && originalDefine.apply(this, arguments);
            };
          },
          set: function (value) {
            originalDefine = value;
          },
        });
      } catch (e) {
        if (window.console) console.debug('[fb-dl] __d hook failed:', e);
      }
    }
  }

  /* ================================================================
   * LỚP TAMPERMONKEY
   * ================================================================ */

  function toast(msg, ms) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;' +
      'padding:10px 18px;border-radius:999px;font:14px/1.4 system-ui,sans-serif;z-index:2147483647;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:86vw;text-align:center';
    document.documentElement.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, ms || 6000);
  }

  function anchorFallback(url, name) {
    try {
      var a = document.createElement('a');
      a.href = url;
      a.download = (name || 'video.mp4').split('/').pop();
      a.target = '_blank';
      a.rel = 'noopener';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      window.open(url, '_blank');
    }
  }

  function doDownload(url, filename) {
    var name = filename || 'Facebook/fb-video-' + Date.now() + '.mp4';
    toast('Đã lấy được link — đang tải video xuống…', 2600);
    if (typeof GM_download === 'function') {
      try {
        GM_download({
          url: url,
          name: name,
          onerror: function () {
            anchorFallback(url, name);
          },
        });
        return;
      } catch (e) {}
    }
    anchorFallback(url, name);
  }

  // Nhận lệnh từ lớp trang.
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== 'FBDL_PAGE') return;
    if (data.type === 'FBDL_DOWNLOAD' && data.payload) {
      var url = data.payload.url;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        doDownload(url, data.payload.filename);
      }
    } else if (data.type === 'FBDL_ERROR') {
      toast('Lỗi tải video: ' + data.payload, 6000);
    }
  });

  // Chèn lớp trang vào page context.
  var pageInjected = false;
  try {
    unsafeWindow.__FBDL_CONFIG = { iconDownload: ICON_DOWNLOAD, iconSpinner: ICON_SPINNER };
    var scriptEl = document.createElement('script');
    scriptEl.textContent = '(' + pageMain.toString() + ')();';
    (document.head || document.documentElement).appendChild(scriptEl);
    scriptEl.remove();
    pageInjected = !!unsafeWindow.__fbDlPageHook;
  } catch (e) {
    pageInjected = false;
  }

  /* ---------- GraphQL phía sandbox (dùng cho tầng 2 và dự phòng) ---------- */

  function fbGraphQL(docId, variables) {
    var dtsg = '';
    try {
      dtsg = unsafeWindow.require('DTSGInitialData').token || '';
    } catch (e) {}
    if (!dtsg) return Promise.reject(new Error('[token] Không lấy được Facebook DTSG token.'));
    var body = new URLSearchParams();
    body.set('doc_id', docId);
    body.set('variables', JSON.stringify(variables));
    body.set('fb_dtsg', dtsg);
    body.set('server_timestamps', 'true');
    var pageFetch = (unsafeWindow && unsafeWindow.fetch) || fetch;
    return pageFetch
      .call(unsafeWindow, 'https://www.facebook.com/api/graphql/', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      .then(function (res) {
        return res.text();
      })
      .then(
        function (text) {
          var firstLine = text.replace(/^for \(;;\);/, '').split('\n')[0];
          var json;
          try {
            json = JSON.parse(firstLine);
          } catch (e) {
            throw new Error('[graphql] Phản hồi không phải JSON: ' + firstLine.slice(0, 80));
          }
          if (json && json.errors && json.errors.length) {
            throw new Error('[graphql] ' + (json.errors[0].message || 'Facebook GraphQL error.'));
          }
          return json;
        },
        function (netErr) {
          throw new Error(
            '[graphql] Lỗi mạng khi gọi GraphQL: ' + (netErr && netErr.message ? netErr.message : netErr)
          );
        }
      );
  }

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

  function resolveAndDownload(videoId, videoEl) {
    var direct = '';
    try {
      direct = (videoEl && (videoEl.currentSrc || videoEl.src)) || '';
    } catch (e) {}
    var tryDirect = function () {
      if (direct && /^https?:\/\//i.test(direct)) {
        doDownload(direct, videoId ? 'Facebook/fb-' + videoId + '.mp4' : '');
        return true;
      }
      return false;
    };
    if (!videoId) {
      if (tryDirect()) return Promise.resolve();
      return Promise.reject(
        new Error('[link] Không có ID video và nguồn phát không phải link trực tiếp (blob/DASH).')
      );
    }
    return fetchPlayableUrl(videoId)
      .then(function (url) {
        if (url) {
          doDownload(url, 'Facebook/fb-' + videoId + '.mp4');
          return;
        }
        if (!tryDirect()) throw new Error('[link] Facebook không trả link phát cho video này.');
      })
      .catch(function (err) {
        if (tryDirect()) return;
        throw err;
      });
  }

  /* ---------- Dự phòng cuối: hook qua unsafeWindow (khi lớp trang bị chặn) ---------- */

  function installSandboxHook() {
    function makePatch(moduleName, wrapExport) {
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

    function wrapPlayerSandbox(originalComponent, thisArg, callArgs) {
      var React = null;
      try {
        React = unsafeWindow.require('react');
      } catch (e) {}
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
              cursor: 'pointer',
            },
            onClick: function (ev) {
              ev.preventDefault();
              ev.stopPropagation();
              if (loading) return;
              var video = props.video;
              var id = video && (video.id || video.__id);
              var scope = ev.currentTarget
                ? ev.currentTarget.closest('[role="dialog"], [role="article"], article') ||
                  ev.currentTarget.parentElement
                : document;
              var videoEl = scope && scope.querySelector ? scope.querySelector('video') : null;
              setLoading(true);
              resolveAndDownload(id ? String(id) : '', videoEl)
                .catch(function (err) {
                  toast('Lỗi tải video: ' + (err && err.message ? err.message : err), 6000);
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
        {
          className: 'fbdl-player-wrap',
          style: { position: 'relative', width: '100%', height: '100%' },
        },
        playerEl,
        React.createElement(DownloadButton)
      );
    }

    var patches = [makePatch('VideoPlayerRelay.react', wrapPlayerSandbox)];
    function runPatches(thisArg, dArgs) {
      try {
        for (var i = 0; i < patches.length; i++) patches[i](thisArg, dArgs);
      } catch (e) {
        console.warn('[fb-dl] patch error:', e);
      }
    }

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
      } catch (e) {}
    } else if (typeof unsafeWindow.__d === 'function' && !unsafeWindow.__d.__fbDlHooked) {
      var origD = unsafeWindow.__d;
      var hookedD = function () {
        runPatches(this, arguments);
        return origD.apply(this, arguments);
      };
      hookedD.__fbDlHooked = true;
      try {
        unsafeWindow.__d = hookedD;
      } catch (e) {}
    }
  }

  if (!pageInjected) {
    installSandboxHook();
  }

  /* ================================================================
   * TẦNG 2 — Quét mọi thẻ <video> trên trang (dự phòng)
   * ================================================================ */

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

  function idFromHref(href) {
    if (!href) return '';
    var m = href.match(/[?&]v=(\d{6,})/) || href.match(/\/(?:videos|reel)\/(\d{6,})/);
    return m ? m[1] : '';
  }

  // Tìm ID video: URL trang trước, rồi leo dần lên các khung cha của
  // video và quét link ở từng tầng (bài Feed bọc trong [role=article]).
  function findVideoIdNear(video) {
    try {
      var u = new URL(location.href);
      var v = u.searchParams.get('v');
      if (v && /^\d+$/.test(v)) return v;
      var pm = location.pathname.match(/\/(?:videos|reel)\/(\d{6,})/);
      if (pm) return pm[1];
    } catch (e) {}
    var node = video;
    for (var depth = 0; node && depth < 9; depth++) {
      if (node.querySelectorAll) {
        var links = node.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
          var id = idFromHref(links[i].getAttribute('href') || '');
          if (id) return id;
        }
      }
      node = node.parentElement;
    }
    return '';
  }

  var seenVideos = new WeakSet();

  function scanVideos() {
    injectStyle();
    document.querySelectorAll('video').forEach(function (video) {
      if (seenVideos.has(video)) return;
      seenVideos.add(video);
      if (video.closest && video.closest('.fbdl-player-wrap')) return;

      var host =
        (video.closest &&
          (video.closest('[role="dialog"]') ||
            video.closest('[role="article"]') ||
            video.closest('article'))) ||
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
        var id = findVideoIdNear(video);
        resolveAndDownload(id, video)
          .catch(function (err) {
            button.classList.add('is-error');
            setTimeout(function () {
              button.classList.remove('is-error');
            }, 1800);
            toast('Lỗi tải video: ' + (err && err.message ? err.message : err), 6000);
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
