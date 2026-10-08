/* ============================================================================
   SUPERHIVE EMBED RUNTIME — third bounded pass: decoder lifecycle, entry pop,
   efficient-mode defaults and honest diagnostics. NO CACHING.

   ⛔ The clip download/cache idea is REMOVED by the owner. This file contains
     NO fetch queue, NO CacheStorage, NO service worker, NO blob URLs and NO
     asset copies. Every video keeps its ORIGINAL remote/local URL: visible
     playback and re-entry both use that URL directly; nothing is revoke()d.

   Loaded with `defer` from index.html and INERT unless the URL query carries
   ?embed=superhive, so the standalone page is completely unaffected.

   What it does, and why in this shape:

   1. OFFSCREEN VIDEO DECODER LIFECYCLE
      The page loops many muted autoplay <video> elements. Inside the Superhive
      iframe (16000 CSS px tall; only the HOST scrolls) the child's window
      scrollY / getBoundingClientRect cannot express which slice the host
      viewport shows — the child does not scroll at all. IntersectionObserver
      with root:null computes against the top-level viewport and accounts for
      ancestor-frame clipping, so it is the only visibility mechanism used.
      No parent DOM is read; no wheel / touch / key listeners are added.

      Pausing alone leaves the decoder alive and burning GPU offscreen, so an
      offscreen clip is RELEASED after a hysteresis: currentTime, the ORIGINAL
      url, autoplay intent and any explicit user pause are saved, src is
      removed (mirrored into data-sh-src for editor/export metadata) and
      load() drops the decoder. On re-entry the original source is restored and
      the saved time is applied on loadedmetadata; playback resumes only when
      the clip is visible, the document is not hidden, and the user has not
      explicitly paused it. A hook in index.html parks initial sources in
      data-sh-src before the parser can start a fetch, so clips that never were
      visible never acquire a decoder at all. Releasing re-fetches nothing by
      itself: the browser's ordinary HTTP cache serves the same original URL.

      The lifecycle is exposed as window.__superhiveMedia (setSource/seekHold/
      isVisible) and is the ONE path the page's own src writers use. Pause and
      unload caused by this runtime are never marked as a user pause.

   2. REVEALS — finite entry pop owned here (embed mode)
      The two inline one-shot .reveal observers are gated off; this runtime
      toggles a held/popped state against the HOST viewport. The offscreen
      state is opacity + visibility ONLY (no transform), so the observed
      element's geometry cannot change with its state and intersection cannot
      oscillate. Entry is one 220ms keyframe; reduced-motion pops instantly.
      Media frames and focus are never hidden; layout is never collapsed.

   3. OFFSCREEN CSS ANIMATIONS + EFFICIENT MODE
      Every running CSS animation returned by document.getAnimations() is
      observed with the same root:null observer: offscreen targets are paused
      via the Web Animations API and resumed on re-entry from the same time
      position (infinite loops advance by the suspended wall-clock time). In
      efficient mode (the default) the CONTINUOUS decorative loops are held
      outright — the finite pops, progress bars and hover feedback keep
      running; ?effects=full restores everything.

   4. ROOT SCROLL LOCK
      The host contract makes the iframe exactly 16000 px tall. When — and only
      when — the deepest painted content fits within 16000 px at the current
      width, html/body get `overflow: clip !important`, which stops user AND
      programmatic scrolling (overflow:hidden still permits programmatic
      scrolling). If the content is taller, clipping is NOT applied — that
      would cut content off — and the incompatibility is recorded in
      window.__superhiveEmbed and logged.

   5. DIAGNOSTICS
      ?diagnostics=1 exposes window.__superhiveDebug (nonpersistent, live
      getters): embed state, fit, effects mode, video counts + original URLs,
      unloaded offscreen count, reveal counts, scheduler state, canvas backing
      sizes. No invented OS GPU metric and no cache controls exist anywhere.

   Preserved: nav scrollIntoView handlers are untouched (for supervisor
   testing), gallery horizontal gestures untouched, no parent access, no
   event traps. Measurement is done at defer time, load, fonts.ready, after a
   settle delay, on width-changing resizes and after accordion/tab clicks.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- gate: embed mode only ---------- */
  var search = window.location.search || '';
  var m = search.match(/[?&]embed=([^&]*)/);
  var mode = '';
  if (m) { try { mode = decodeURIComponent(m[1]); } catch (e) { mode = m[1]; } }
  if (mode !== 'superhive') return;

  var doc = document;
  var rootEl = doc.documentElement;
  var bodyEl = doc.body;
  var EMBED_VIEWPORT = 16000;   /* px — the contractual iframe height */

  /* Efficient is the DEFAULT in embed mode; ?effects=full opts the decorative
     motion back in. Reduced motion is always respected on top of either mode. */
  var EFFICIENT = !/[?&]effects=full(?:&|$)/.test(search);
  var REDUCED = false;
  try { REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}

  var report = {
    mode: 'superhive',
    pass: 3,
    effects: EFFICIENT ? 'efficient' : 'full',
    reducedMotion: REDUCED,
    embedViewportPx: EMBED_VIEWPORT,
    innerHeightPx: window.innerHeight,
    contentHeightPx: null,
    accordionWorstHeightPx: null,
    compatible: null,            /* true = fits and is clipped            */
    rootClipped: false,
    nestedVerticalScrollers: [],
    videos: { tracked: 0, suspended: 0, resumed: 0, released: 0, restored: 0, io: 'pending' },
    animations: { tracked: 0, suspended: 0, ambientHeld: 0, method: 'none' },
    reveal: { tracked: 0, visible: 0, hidden: 0 }
  };
  window.__superhiveEmbed = report;

  function warn(msg) { try { console.warn('[superhive-embed] ' + msg); } catch (e) {} }
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  rootEl.classList.add('superhive-embed');
  var styleEl = doc.createElement('style');
  styleEl.textContent =
    'html.superhive-embed.superhive-clip,html.superhive-embed.superhive-clip body{overflow:clip !important;}';
  (doc.head || rootEl).appendChild(styleEl);

  var hasIO = ('IntersectionObserver' in window);

  /* ========================================================================
     1. VIDEOS — host-visibility decoder lifecycle. Original URLs only.
     ====================================================================== */
  var videos = [];        /* one record per managed <video> */
  var videoIO = null;
  var RELEASE_DELAY = 800;   /* ms offscreen before the decoder is released */
  var MAX_VIDEOS = 400;      /* bounded guard for dynamically added nodes */

  function recOf(v) {
    for (var i = 0; i < videos.length; i++) if (videos[i].el === v) return videos[i];
    return null;
  }

  function countReleased() {
    var n = 0;
    for (var i = 0; i < videos.length; i++) if (videos[i].released) n++;
    return n;
  }

  /* Our own pause()/play() calls queue their media events as tasks, so
     attribution is a counter armed right before the call. The timer clears
     stale expectations when the event never arrives (e.g. play() rejected by
     the autoplay policy). */
  function armTimer(rec) {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(function () { rec.expectPause = 0; rec.expectPlay = 0; }, 1000);
  }

  function pauseByRuntime(rec) {
    if (rec.el.paused || rec.el.ended) return;
    rec.expectPause++;
    armTimer(rec);
    try { rec.el.pause(); } catch (e) { if (rec.expectPause > 0) rec.expectPause--; }
  }

  function tryResume(rec) {
    if (!rec.resumeWanted || rec.userPaused || rec.released) return;
    if (doc.hidden || !rec.known || !rec.visible) return;   /* never on hidden / offscreen */
    if (!rec.el.paused || rec.el.ended) { rec.resumeWanted = false; return; }
    rec.resumeWanted = false;
    rec.expectPlay++;
    armTimer(rec);
    var p;
    try { p = rec.el.play(); } catch (e) { return; }
    if (p && p.catch) p.catch(function () { /* autoplay policy may refuse — stays paused */ });
  }

  function onVideoPlay(rec) {
    if (rec.el.paused) return;             /* a queued play preceded a later pause */
    if (rec.expectPlay > 0) { rec.expectPlay--; rec.userPaused = false; return; }
    if (rec.released) {
      /* A legacy handler re-armed the element behind the shared API. Adopt its URL and
         put it straight back into the released state instead of letting it load. */
      var s = rec.el.getAttribute('src');
      if (s) { rec.url = s; rec.time = 0; }
      rec.resumeWanted = true;
      if (!rec.el.paused) pauseByRuntime(rec);
      if (rec.el.getAttribute('src')) rec.el.removeAttribute('src');
      try { rec.el.load(); } catch (e) {}
      return;
    }
    /* any other play: the user (or the page's autoplay) wants it playing */
    rec.userPaused = false;
    if (doc.hidden || (rec.known && !rec.visible)) {
      /* started while effectively offscreen — pause again and remember it */
      rec.resumeWanted = true;
      pauseByRuntime(rec);
    } else {
      rec.resumeWanted = false;
    }
  }

  function onVideoPause(rec) {
    if (!rec.el.paused) return;            /* load() pause superseded by a new play */
    if (rec.el.ended) return;                    /* end of clip is not a user pause */
    if (rec.expectPause > 0) {
      rec.expectPause--;
      /* load() can discard a queued suspension event. Its stale counter must
         never consume a later user pause on a visible, attached clip. */
      if (doc.hidden || !rec.visible || rec.released || rec.restoring) return;
    }
    if (rec.released || rec.restoring) return;   /* a manager-side unload is NOT a user pause */
    /* an explicit pause (user or page code): never auto-resume this video */
    rec.userPaused = true;
    rec.resumeWanted = false;
  }

  /* ---- detach / attach the ORIGINAL source ------------------------------------
     ⛔ No copies, no blob, no cache: the exact URL string moves to data-sh-src and
     back. data-sh-src doubles as the export/edit metadata the early head pass uses. */
  function detachSources(rec) {
    var el = rec.el, i;
    var s = el.getAttribute('src');
    if (s) {
      rec.hasSrcAttr = true;
      /* a parked source switch owns the metadata from the moment it is requested */
      if (!rec.pendingSrc) rec.url = s;
      el.setAttribute('data-sh-src', rec.pendingSrc || s);
      el.removeAttribute('src');
    }
    var kids = el.getElementsByTagName('source');
    var saved = [];
    for (i = 0; i < kids.length; i++) {
      var sv = kids[i].getAttribute('src') || kids[i].getAttribute('data-sh-src');
      if (sv) {
        saved.push(sv);
        if (!kids[i].hasAttribute('data-sh-src')) kids[i].setAttribute('data-sh-src', sv);
        kids[i].removeAttribute('src');
      }
    }
    if (saved.length) rec.sourceSrcs = saved;
    try { el.load(); } catch (e) {}   /* drops the decoder; the URL stays in data-sh-src */
  }

  function attachSources(rec, url) {
    var el = rec.el, i;
    if (!rec.hasSrcAttr && rec.sourceSrcs && rec.sourceSrcs.length) {
      var kids = el.getElementsByTagName('source');
      for (i = 0; i < kids.length && i < rec.sourceSrcs.length; i++) {
        kids[i].setAttribute('src', rec.sourceSrcs[i]);
        kids[i].setAttribute('data-sh-src', rec.sourceSrcs[i]);
      }
    } else {
      el.setAttribute('src', url);
      /* keep the export/edit metadata equal to the clip that is actually attached */
      el.setAttribute('data-sh-src', url);
    }
    rec.released = false;
    try { el.load(); } catch (e) {}
  }

  function clearDetach(rec) {
    if (rec.detachTimer) { clearTimeout(rec.detachTimer); rec.detachTimer = 0; }
  }

  function scheduleRelease(rec) {
    clearDetach(rec);
    rec.detachTimer = setTimeout(function () {
      rec.detachTimer = 0;
      if (!rec.known || rec.visible || rec.released) return;
      releaseRec(rec, false);
    }, RELEASE_DELAY);
  }

  /* Save time / URL / autoplay intent, pause, remove src, load() — the decoder is
     gone, layout and controls are untouched, and the original URL is preserved. */
  function releaseRec(rec, initial) {
    var el = rec.el;
    if (rec.released) return;
    if (!initial && (el.seeking || rec.scrub)) { scheduleRelease(rec); return; }
    var wasPlaying = !el.paused && !el.ended;
    rec.resumeWanted = rec.resumeWanted || wasPlaying;
    rec.autoIntent = !!(el.autoplay || el.hasAttribute('autoplay')) || wasPlaying || rec.autoIntent;
    if (!el.paused && !el.ended) pauseByRuntime(rec);
    if (el.readyState > 0 && isFinite(el.currentTime)) rec.time = el.currentTime;
    else if (!rec.pendingSrc) rec.time = 0;
    rec.pendingSeek = null;
    detachSources(rec);
    rec.released = true;
    report.videos.released = countReleased();
  }

  /* A switch requested while the clip was offscreen but NOT yet released: apply the
     parked URL the moment the clip becomes visible again (and on document restore). */
  function applyPending(rec) {
    if (!rec.pendingSrc) return false;
    var url = rec.pendingSrc;
    rec.pendingSrc = null;
    rec.url = url;
    rec.time = 0;                      /* the new clip starts its OWN clock */
    rec.pendingSeek = null;
    rec.hasSrcAttr = true;
    rec.restoring = true;
    attachSources(rec, url);
    rec.restoring = false;
    if (!rec.userPaused && rec.autoIntent && rec.known && rec.visible && !doc.hidden) {
      rec.resumeWanted = true;
      tryResume(rec);
    }
    return true;
  }

  /* Re-entry: original source back on, saved time applied on loadedmetadata, play
     only when visible — never on a hidden document, never against a user pause. */
  function restoreRec(rec) {
    clearDetach(rec);
    if (!rec.released) { tryResume(rec); return; }
    var fresh = !!rec.pendingSrc;
    var url = rec.pendingSrc || rec.url || rec.el.getAttribute('src') || rec.el.getAttribute('data-sh-src');
    rec.pendingSrc = null;
    if (!url) { rec.released = false; return; }
    rec.url = url;
    if (fresh) rec.time = 0;                       /* a switched clip starts its OWN clock */
    rec.pendingSeek = rec.time > 0.05 ? rec.time : null;
    rec.restoring = true;
    attachSources(rec, url);
    rec.restoring = false;
    report.videos.restored++;
    report.videos.released = countReleased();
    if (!rec.userPaused && rec.autoIntent && rec.known && rec.visible && !doc.hidden) {
      rec.resumeWanted = true;
      tryResume(rec);
    }
  }

  function trackVideo(v) {
    if (!v || typeof v.pause !== 'function' || !v.addEventListener) return null;
    var existing = recOf(v);
    if (existing) return existing;
    if (videos.length >= MAX_VIDEOS) return null;
    var rec = {
      el: v, known: false, visible: true,
      userPaused: false, resumeWanted: false,
      autoIntent: !!(v.autoplay || v.hasAttribute('autoplay')),
      released: false, restoring: false, scrub: 0,
      time: 0, pendingSeek: null, pendingSrc: null,
      url: null, hasSrcAttr: false, sourceSrcs: null,
      expectPause: 0, expectPlay: 0, timer: 0, detachTimer: 0
    };
    /* Native autoplay would restart a user-paused clip after load(). The
       lifecycle owns autoplay intent; keep the original flag for editor export. */
    if (rec.autoIntent) v.setAttribute('data-sh-autoplay', '');
    v.autoplay = false;
    var dataSrc = v.getAttribute('data-sh-src');
    var kids = v.getElementsByTagName('source');
    var saved = [];
    for (var i = 0; i < kids.length; i++) {
      var sv = kids[i].getAttribute('data-sh-src') || kids[i].getAttribute('src');
      if (sv) saved.push(sv);
    }
    if (saved.length) rec.sourceSrcs = saved;
    if (!v.getAttribute('src') && (dataSrc || saved.length)) {
      /* parked by the early head pass (or by a previous release) — nothing attached */
      rec.released = true;
      rec.hasSrcAttr = !!dataSrc;
      rec.url = dataSrc || saved[0] || null;
    } else {
      var cur = v.getAttribute('src');
      if (cur) { rec.url = cur; rec.hasSrcAttr = true; }
    }
    videos.push(rec);
    report.videos.tracked = videos.length;
    v.addEventListener('loadedmetadata', function () {
      if (rec.pendingSeek == null) return;
      var t = rec.pendingSeek;
      rec.pendingSeek = null;
      try {
        var d = rec.el.duration;
        if (isFinite(d) && d > 0) t = Math.min(t, Math.max(0, d - 0.05));
        rec.el.currentTime = t;
      } catch (e) {}
    });
    v.addEventListener('play', function () { onVideoPlay(rec); });
    v.addEventListener('pause', function () { onVideoPause(rec); });
    v.addEventListener('ended', function () { rec.resumeWanted = false; });
    if (videoIO) videoIO.observe(v);
    /* A dynamically inserted node can be stashed by the head observer AFTER this track
       call (both observers fire in the same checkpoint). Re-sync once, next task, so a
       stripped src flips the record into the released state instead of leaving it
       "attached" with no source. */
    setTimeout(function () {
      if (rec.released || rec.el.getAttribute('src')) return;
      var d = rec.el.getAttribute('data-sh-src');
      var kids = rec.el.getElementsByTagName('source');
      var anySrc = false;
      for (var k = 0; k < kids.length; k++) if (kids[k].getAttribute('src')) anySrc = true;
      if (d || anySrc) {
        rec.released = true;
        rec.hasSrcAttr = !!d;
        if (d) rec.url = d;
        report.videos.released = countReleased();
      }
    }, 0);
    return rec;
  }

  function initVideos() {
    if (!hasIO) {
      report.videos.io = 'unsupported';
      warn('IntersectionObserver unavailable — offscreen video lifecycle disabled.');
      return;
    }
    videoIO = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i];
        var rec = recOf(en.target);
        if (!rec) continue;
        var firstDelivery = !rec.known;
        rec.known = true;
        rec.visible = !!en.isIntersecting;
        if (!rec.visible) {
          if (!rec.el.paused && !rec.el.ended) {
            rec.resumeWanted = true;              /* was playing — resume on re-entry */
            pauseByRuntime(rec);
            report.videos.suspended++;
          }
          if (rec.released) continue;
          /* ⛔ First delivery + offscreen = a clip that was never visible: release it
             at once instead of waiting out the hysteresis (which exists to stop
             scroll-through thrash on LATER leaves). Clips the head pass parked never
             held a decoder at all — this covers dynamic nodes and the no-head case. */
          if (firstDelivery) releaseRec(rec, true);
          else scheduleRelease(rec);
        } else {
          clearDetach(rec);
          if (rec.released) {
            restoreRec(rec);
          } else if (rec.pendingSrc) {
            applyPending(rec);           /* switched while offscreen, not yet released */
          } else if (rec.resumeWanted) {
            report.videos.resumed++;
            tryResume(rec);
          }
        }
      }
      report.videos.released = countReleased();
    }, { threshold: 0, rootMargin: '0px' });
    report.videos.io = 'root:null';
    var all = doc.querySelectorAll('video');
    for (var i = 0; i < all.length; i++) trackVideo(all[i]);
    report.videos.released = countReleased();
  }

  /* Videos created later (the editor's setMedia, console patches) get the same
     lifecycle; bounded by MAX_VIDEOS. */
  function initVideoWatch() {
    if (!window.MutationObserver || !bodyEl) return;
    var mo = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var added = list[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'VIDEO') trackVideo(n);
          else if (n.getElementsByTagName) {
            var vs = n.getElementsByTagName('video');
            for (var k = 0; k < vs.length; k++) trackVideo(vs[k]);
          }
        }
      }
    });
    try { mo.observe(bodyEl, { childList: true, subtree: true }); } catch (e) {}
  }

  /* ========================================================================
     1b. THE SHARED VIDEO LIFECYCLE API — window.__superhiveMedia.
     The ONE entry point for page handlers that write a source or scrub a clip
     (index.html routes the hero switcher, the fresh-URL path and the clip-bar
     drag through here). "No caching" is structural: the API only ever attaches
     the caller's original URL to the element, or parks it for later.
     ====================================================================== */
  var mediaApi = {
    /* Source change request. Visible + known: attach now (time resets to 0 for the
       NEW clip — it never inherits another clip's timestamp). Offscreen/hidden: park
       the URL; it is attached when the clip becomes visible. */
    setSource: function (v, url) {
      if (!v || !url) return false;
      if (v.tagName === 'IMG') {
        v.setAttribute('data-sh-src', url);
        var image = imageRec(v);
        if (!image || image.visible) v.setAttribute('src', url);
        return true;
      }
      var rec = recOf(v) || trackVideo(v);
      if (!rec) { try { v.setAttribute('src', url); } catch (e) {} return true; }
      rec.userPaused = false;
      rec.autoIntent = true;
      rec.time = 0;
      rec.pendingSeek = null;
      /* an API-driven switch always attaches through the src attribute, whatever
         element shape (src attr or <source> children) it started with */
      rec.hasSrcAttr = true;
      if (rec.known && rec.visible && !doc.hidden) {
        rec.url = url;
        rec.pendingSrc = null;
        attachSources(rec, url);
        rec.resumeWanted = true;
        tryResume(rec);
      } else {
        rec.pendingSrc = url;
        /* parked: keep the export/edit metadata pointing at the new clip too */
        if (v.getAttribute('src') == null) v.setAttribute('data-sh-src', url);
        if (rec.known && !rec.visible && !rec.released) scheduleRelease(rec);
      }
      report.videos.released = countReleased();
      return true;
    },
    /* clip-bar drag handshake: a clip that is being scrubbed is never released. */
    seekHold: function (v, on) {
      var rec = recOf(v);
      if (!rec) return;
      rec.scrub = Math.max(0, rec.scrub + (on ? 1 : -1));
    },
    /* host-visibility answer for the shared progress scheduler */
    isVisible: function (v) {
      var rec = recOf(v);
      if (!rec) return !doc.hidden;
      return !rec.released && rec.visible && !doc.hidden;
    }
  };
  window.__superhiveMedia = mediaApi;

  /* Images have fixed media slots; keep their geometry while parking original
     URLs. In particular, detached GIFs stop contributing offscreen decode work.
     The small intrinsic-size navigation logo stays attached. */
  var images = [];
  function imageRec(el) {
    for (var i = 0; i < images.length; i++) if (images[i].el === el) return images[i];
    return null;
  }
  function initImages() {
    if (!hasIO) return;
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var el = entries[i].target, rec = imageRec(el);
        rec.visible = entries[i].isIntersecting;
        if (rec.visible) {
          var url = el.getAttribute('data-sh-src');
          if (url && el.getAttribute('src') !== url) el.setAttribute('src', url);
        } else {
          var src = el.getAttribute('src');
          if (src) { el.setAttribute('data-sh-src', src); el.removeAttribute('src'); }
        }
      }
    }, { threshold: 0, rootMargin: '0px' });
    var all = doc.querySelectorAll('img');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest('nav,header')) continue;
      el.setAttribute('decoding', 'async');
      images.push({ el: el, visible: false });
      io.observe(el);
    }
  }

  /* ========================================================================
     2. REVEALS — one owner in embed mode: finite entry pop, hidden offscreen.
     The two inline one-shot .reveal observers are gated off in index.html, so
     nothing permanently reveals behind this. The held state is opacity +
     visibility ONLY (no transform): the element's geometry is identical in
     both states, so an intersection callback can never flip itself.
     ====================================================================== */
  var rvs = [];
  var rvIO = null;

  function revealRecFor(el) {
    for (var i = 0; i < rvs.length; i++) if (rvs[i].el === el) return rvs[i];
    return null;
  }

  function updateRevealCounts() {
    var vis = 0, hid = 0;
    for (var i = 0; i < rvs.length; i++) (rvs[i].visible ? vis++ : hid++);
    report.reveal.visible = vis;
    report.reveal.hidden = hid;
  }

  function revealShow(rv) {
    var el = rv.el;
    if (rv.visible) { el.classList.remove('sh-held'); return; }
    rv.visible = true;
    el.classList.remove('sh-held');
    el.classList.remove('sh-pop');
    void el.offsetWidth;               /* restart the finite pop on every re-entry */
    el.classList.add('sh-pop');
    updateRevealCounts();
  }

  function revealHide(rv) {
    var el = rv.el;
    if (el.contains(doc.activeElement)) return;   /* never hide a focus ancestor */
    if (!rv.visible) return;
    rv.visible = false;
    el.classList.remove('sh-pop');
    el.classList.add('sh-held');       /* visibility:hidden — geometry/anchors intact */
    updateRevealCounts();
  }

  function initReveals() {
    if (!hasIO) return;   /* early head CSS leaves everything visible — graceful degrade */
    var els = doc.querySelectorAll('.reveal');
    rvIO = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i];
        var rv = revealRecFor(en.target);
        if (!rv) continue;
        if (en.isIntersecting) revealShow(rv);
        else revealHide(rv);
      }
    }, { threshold: 0, rootMargin: '0px' });
    for (var i = 0; i < els.length && i < 300; i++) {
      var el = els[i];
      /* never hide a clip/media frame or a card whose only content is the clip
         (the hero side rails): those stay always-visible. Their VIDEO is still
         handled by the lifecycle above. */
      if (el.matches('video') || (el.querySelector && el.querySelector('video'))) continue;
      rvs.push({ el: el, visible: true });
      rvIO.observe(el);
    }
    report.reveal.tracked = rvs.length;
    updateRevealCounts();
  }

  doc.addEventListener('focusin', function (e) {
    var t = e.target;
    if (!t) return;
    for (var i = 0; i < rvs.length; i++) {
      if (rvs[i].el.contains(t) && !rvs[i].visible) revealShow(rvs[i]);
    }
  });

  /* ========================================================================
     3. CSS ANIMATIONS — pause offscreen targets; efficient mode additionally
     holds the continuous decorative loops (finite pops and functional
     feedback keep running).
     ====================================================================== */
  var animEls = [];       /* { el, anims:[Animation], held, holdStart, known, visible } */
  var animIO = null;

  /* ⛔ Functional feedback that must NOT be held in efficient mode: the two bar
     gradients, the loading spinner, and the two hover rings (transient, user-driven).
     `seamOut` is exempt too: its frame 0 is a near-zero-width line, so holding it there
     would gut the section seams — it keeps its 5s beat. */
  var AMBIENT_KEEP = { clipFlow: 1, clipTrack: 1, clipSpin: 1, ringOut: 1, tipRing: 1, seamOut: 1 };

  function isAmbientDecorative(an) {
    if (!EFFICIENT || REDUCED) return false;
    var t;
    try { t = an.effect && an.effect.getComputedTiming ? an.effect.getComputedTiming() : null; } catch (e) { t = null; }
    if (!t || t.iterations !== Infinity) return false;
    if (AMBIENT_KEEP[an.animationName]) return false;
    return true;
  }

  function holdAmbient(an) {
    if (an.__sfAmbient) return;
    an.__sfAmbient = true;
    try {
      an.pause();
      /* Hold it at its REST frame, not wherever it happened to be: a sheen frozen
         mid-sweep would leave a white band parked across a card. Frame 0 of the
         ambient loops is their declared rest state. */
      an.currentTime = 0;
      report.animations.ambientHeld++;
    } catch (e) { an.__sfAmbient = false; }
  }

  function animRecFor(el) {
    for (var i = 0; i < animEls.length; i++) if (animEls[i].el === el) return animEls[i];
    return null;
  }

  function holdRec(rec) {
    if (rec.held) return;
    var any = false, list = rec.anims, i, a;
    for (i = 0; i < list.length; i++) {
      a = list[i];
      if (a.playState === 'running') {
        a.__sfHeld = true;
        try { a.pause(); } catch (e) { a.__sfHeld = false; continue; }
        any = true;
      }
    }
    if (any) { rec.held = true; rec.holdStart = nowMs(); report.animations.suspended++; }
  }

  function resumeRec(rec) {
    if (!rec.held) return;
    var heldFor = nowMs() - rec.holdStart;
    var list = rec.anims, i, a;
    for (i = 0; i < list.length; i++) {
      a = list[i];
      if (!a.__sfHeld) continue;
      a.__sfHeld = false;
      if (a.playState !== 'paused') continue;   /* cancelled/replaced while held */
      try {
        var t = (a.effect && a.effect.getComputedTiming) ? a.effect.getComputedTiming() : null;
        /* infinite ambient loops: restore wall-clock phase (see header note 2) */
        if (t && t.iterations === Infinity && typeof a.currentTime === 'number' && heldFor > 0) {
          a.currentTime = a.currentTime + heldFor;
        }
        a.play();
      } catch (e) {}
    }
    rec.held = false;
  }

  function scanAnimations() {
    if (!doc.getAnimations) { report.animations.method = 'unsupported'; return; }
    var i, j, rec, a;
    /* prune records whose animations were cancelled or replaced */
    for (i = animEls.length - 1; i >= 0; i--) {
      rec = animEls[i];
      var keep = [];
      for (j = 0; j < rec.anims.length; j++) {
        a = rec.anims[j];
        if (a.effect && a.effect.target) keep.push(a);
      }
      rec.anims = keep;
      if (!keep.length) {
        if (animIO) animIO.unobserve(rec.el);
        animEls.splice(i, 1);
      }
    }
    var list = doc.getAnimations();
    for (i = 0; i < list.length; i++) {
      var an = list[i];
      var eff = an.effect;
      if (!eff) continue;
      var t = eff.target;
      if (!t || t === rootEl || t === bodyEl) continue;   /* page-level, not decorative */
      if (an.playState !== 'running' && !an.__sfHeld) continue;  /* paused by CSS etc. */
      rec = animRecFor(t);
      if (!rec) {
        if (animEls.length >= 400) continue;              /* bounded guard */
        rec = { el: t, anims: [], held: false, holdStart: 0, known: false, visible: true };
        animEls.push(rec);
        if (animIO) animIO.observe(t);
      }
      if (rec.anims.indexOf(an) < 0) rec.anims.push(an);
      /* efficient mode: hold the continuous decorative loops outright */
      if (isAmbientDecorative(an)) holdAmbient(an);
      if (doc.hidden || (rec.known && !rec.visible)) holdRec(rec);
    }
    var total = 0;
    for (i = 0; i < animEls.length; i++) total += animEls[i].anims.length;
    report.animations.tracked = total;
  }

  function holdAllAnimations() {
    for (var i = 0; i < animEls.length; i++) holdRec(animEls[i]);
  }
  function resumeVisibleAnimations() {
    for (var i = 0; i < animEls.length; i++) {
      var r = animEls[i];
      if (r.known && r.visible) resumeRec(r);
    }
  }

  function initAnimations() {
    if (!hasIO || !doc.getAnimations) {
      report.animations.method = 'unsupported';
      if (!doc.getAnimations) warn('document.getAnimations unavailable — offscreen CSS-animation suspension disabled.');
      return;
    }
    report.animations.method = 'waapi+root:null';
    animIO = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i];
        var rec = animRecFor(en.target);
        if (!rec) continue;
        rec.known = true;
        rec.visible = !!en.isIntersecting;
        if (!rec.visible) holdRec(rec);
        else if (!doc.hidden) resumeRec(rec);
      }
    }, { threshold: 0, rootMargin: '0px' });
    scanAnimations();
    /* bounded rescans: catch animations created after load (spinners, hover
       effects, class-driven starts). They stop after ~35 s. */
    var delays = [1500, 3500, 7000, 12000, 20000, 32000];
    for (var d = 0; d < delays.length; d++) setTimeout(scanAnimations, delays[d]);
  }

  /* ========================================================================
     4. ROOT SCROLL LOCK — overflow:clip only when the content fits 16000 px.
     ====================================================================== */
  var CLIP_CLASS = 'superhive-clip';
  var fitTimer = 0;

  function deepestFlowBottom() {
    var max = 0, i;
    var kids = bodyEl ? bodyEl.children : [];
    var sy = window.scrollY || window.pageYOffset || 0;   /* read-only; 0 while clipped */
    for (i = 0; i < kids.length; i++) {
      var el = kids[i], cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.position === 'fixed') continue;
      var b = el.getBoundingClientRect().bottom + sy;
      if (b > max) max = b;
    }
    return max;
  }

  /* the accordion is single-open: worst case = the tallest body swapped in */
  function accordionWorstExtra() {
    var extra = 0;
    var items = doc.querySelectorAll('.acc-item');
    for (var i = 0; i < items.length; i++) {
      var body = items[i].querySelector('.acc-body');
      if (!body) continue;
      var shown = items[i].classList.contains('open') ? (body.clientHeight || 0) : 0;
      var delta = (body.scrollHeight || 0) - shown;
      if (delta > extra) extra = delta;
    }
    return extra;
  }

  function findNestedVerticalScrollers() {
    var out = [];
    if (!bodyEl) return out;
    var all = bodyEl.querySelectorAll('*');
    for (var i = 0; i < all.length && out.length < 12; i++) {
      var el = all[i];
      if (el.tagName === 'VIDEO' || el.tagName === 'CANVAS' || el.tagName === 'IFRAME') continue;
      if (el.clientHeight <= 0) continue;
      if (el.scrollHeight - el.clientHeight <= 2) continue;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      var oy = cs.overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      var name = el.id ? ('#' + el.id)
        : (typeof el.className === 'string' && el.className.trim()
            ? ('.' + el.className.trim().split(/\s+/).slice(0, 2).join('.'))
            : el.tagName.toLowerCase());
      out.push(name);
    }
    return out;
  }

  function applyFit() {
    // Root scrollHeight has a viewport-sized floor; it is not natural content height.
    var rootOverflow = rootEl.scrollHeight > window.innerHeight + 1 ? rootEl.scrollHeight : 0;
    var current = Math.ceil(Math.max(rootOverflow, deepestFlowBottom()));
    var worst = Math.round(current + accordionWorstExtra());
    var fits = current <= EMBED_VIEWPORT && worst <= EMBED_VIEWPORT;

    report.innerHeightPx = window.innerHeight;
    report.contentHeightPx = current;
    report.accordionWorstHeightPx = worst;
    report.compatible = fits;
    report.nestedVerticalScrollers = findNestedVerticalScrollers();

    if (fits) {
      rootEl.classList.add(CLIP_CLASS);
      report.rootClipped = true;
    } else {
      rootEl.classList.remove(CLIP_CLASS);
      report.rootClipped = false;
      warn('content does not fit the ' + EMBED_VIEWPORT + 'px embed viewport at this width ' +
           '(current ' + current + 'px; worst-case open accordion ' + worst + 'px). Root clipping NOT applied ' +
           'so no content is cut off — this is recorded in window.__superhiveEmbed as an incompatibility; ' +
           'the host iframe height must grow, or the content must be changed with the owner.');
    }
    rootEl.setAttribute('data-superhive-embed', fits ? 'active' : 'incompatible');
  }

  var lastWidth = 0;
  function scheduleFit() {
    if (window.innerWidth === lastWidth) return;   /* height-only resizes cannot change layout */
    lastWidth = window.innerWidth;
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(applyFit, 220);
  }
  window.addEventListener('resize', scheduleFit);

  /* accordion / tab interaction can change the deepest height — re-check after it settles */
  doc.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.acc-head') || t.closest('.tab-btn')) setTimeout(applyFit, 450);
  });

  /* ========================================================================
     Lifecycle
     ====================================================================== */
  doc.addEventListener('visibilitychange', function () {
    var i, rec;
    if (doc.hidden) {
      for (i = 0; i < videos.length; i++) {
        rec = videos[i];
        if (!rec.el.paused && !rec.el.ended) { rec.resumeWanted = true; pauseByRuntime(rec); }
      }
      holdAllAnimations();
    } else {
      for (i = 0; i < videos.length; i++) {
        rec = videos[i];
        if (rec.released) { if (rec.known && rec.visible) restoreRec(rec); }
        else if (rec.pendingSrc && rec.visible) applyPending(rec);
        else tryResume(rec);
      }
      resumeVisibleAnimations();
      scanAnimations();
    }
  });

  /* ========================================================================
     5. DIAGNOSTICS — ?diagnostics=1 only, nonpersistent, no invented metrics.
     Live getters, so reading it always reflects the CURRENT state.
     ====================================================================== */
  function buildDebug() {
    var dbg = {
      embed: true,
      effectsMode: EFFICIENT ? 'efficient' : 'full',
      reducedMotion: REDUCED
    };
    function live(name, fn) {
      Object.defineProperty(dbg, name, { enumerable: true, configurable: true, get: fn });
    }
    live('fit', function () {
      return {
        compatible: report.compatible,
        rootClipped: report.rootClipped,
        contentHeightPx: report.contentHeightPx,
        accordionWorstHeightPx: report.accordionWorstHeightPx,
        nestedVerticalScrollers: report.nestedVerticalScrollers
      };
    });
    live('videos', function () {
      var visible = 0, playing = 0, released = 0, urls = [];
      for (var i = 0; i < videos.length; i++) {
        var r = videos[i];
        if (r.released) released++;
        else if (r.known && r.visible) {
          visible++;
          if (!r.el.paused && !r.el.ended) playing++;
        }
        if (r.url) urls.push(r.url);
      }
      return {
        tracked: videos.length,
        attachedVisible: visible,
        visiblePlaying: playing,
        releasedOffscreen: released,
        originalUrls: urls
      };
    });
    live('reveal', function () {
      return { tracked: report.reveal.tracked, visible: report.reveal.visible, hidden: report.reveal.hidden };
    });
    live('schedulerActive', function () {
      var s = window.__clipScheduler;
      return !!(s && s.isActive && s.isActive());
    });
    live('schedulerRateHz', function () {
      var s = window.__clipScheduler;
      return (s && s.rateHz) ? Math.round(s.rateHz) : null;
    });
    live('canvas', function () {
      var cv = doc.getElementById('interactiveBg');
      return {
        interactiveBg: cv ? {
          backingWidth: cv.width,
          backingHeight: cv.height,
          cssWidth: cv.clientWidth,
          cssHeight: cv.clientHeight
        } : null,
        fxParticlesCanvases: doc.querySelectorAll('.fx-particles').length
      };
    });
    return dbg;
  }

  initVideos();
  initVideoWatch();
  initImages();
  initReveals();
  initAnimations();
  applyFit();
  setTimeout(applyFit, 2000);    /* after remote media + reveal state settles */

  window.addEventListener('load', function () { scanAnimations(); applyFit(); });
  doc.addEventListener('DOMContentLoaded', scanAnimations);  /* late-built .fx layers */
  if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) {
    doc.fonts.ready.then(function () { scanAnimations(); applyFit(); });
  }
  if (/[?&]diagnostics=1(?:&|$)/.test(search)) window.__superhiveDebug = buildDebug();
})();
