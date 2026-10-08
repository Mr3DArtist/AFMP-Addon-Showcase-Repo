/* ============================================================================
   SUPERHIVE EMBED RUNTIME — second bounded optimization pass.

   Loaded with `defer` from index.html and INERT unless the URL query carries
   ?embed=superhive, so the standalone page is completely unaffected.

   What it does, and why in this shape:

   1. OFFSCREEN VIDEOS
      The page loops many muted autoplay <video> elements. Inside the Superhive
      iframe (16000 CSS px tall; only the HOST scrolls) the child's window
      scrollY / getBoundingClientRect cannot express which slice the host
      viewport shows — the child does not scroll at all. IntersectionObserver
      with root:null computes against the top-level viewport and accounts for
      ancestor-frame clipping, so it is the only visibility mechanism used.
      No parent DOM is read; no wheel / touch / key listeners are added.

      pause()/play() are called on the media element itself — NOT shadow state —
      so the page's existing wiring runs unchanged: the per-video progress-bar
      RAF is cancelled by the existing 'pause' listener and restarted by the
      existing 'play' listener ("Clip progress bars" in index.html). An explicit
      user pause (a pause this runtime did not cause) marks the video
      user-paused and it is never auto-resumed. A play that starts while the
      video is offscreen (e.g. the hero switcher swapping src) is caught: the
      video is paused again immediately and flagged for resume on re-entry.
      Nothing is ever resumed while document.hidden.

   2. OFFSCREEN CSS ANIMATIONS
      Every running CSS animation returned by document.getAnimations() is
      observed with the same root:null observer. While its target is offscreen
      the animation is paused via the Web Animations API and resumed on
      re-entry from the same time position. Finite animations continue where
      they were paused; INFINITE ambient loops additionally advance by the time
      spent suspended, so wall-clock phase is preserved for anything that
      phase-locks against it (the fxParticles canvas/dots pair measures phases
      against performance.now() — resuming from the pause point would make the
      layers jump on hover). Speed, duration, easing and styles are untouched.

   3. ROOT SCROLL LOCK
      The host contract makes the iframe exactly 16000 px tall. When — and only
      when — the deepest painted content fits within 16000 px at the current
      width, html/body get `overflow: clip !important`, which stops user AND
      programmatic scrolling (overflow:hidden still permits programmatic
      scrolling). If the content is taller, clipping is NOT applied — that
      would cut content off — and the incompatibility is recorded in
      window.__superhiveEmbed and logged. See OPTIMIZATION-REPORT.md.

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

  var report = {
    mode: 'superhive',
    embedViewportPx: EMBED_VIEWPORT,
    innerHeightPx: window.innerHeight,
    contentHeightPx: null,
    accordionWorstHeightPx: null,
    compatible: null,            /* true = fits and is clipped            */
    rootClipped: false,
    nestedVerticalScrollers: [],
    videos: { tracked: 0, suspended: 0, resumed: 0, io: 'pending' },
    animations: { tracked: 0, suspended: 0, method: 'none' }
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
     1. VIDEOS — suspend offscreen playback, resume on re-entry.
     ====================================================================== */
  var videos = [];        /* one record per managed <video> */
  var videoIO = null;

  function recOf(v) {
    for (var i = 0; i < videos.length; i++) if (videos[i].el === v) return videos[i];
    return null;
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
    if (!rec.resumeWanted || rec.userPaused) return;
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
    if (rec.expectPlay > 0) {
      rec.expectPlay--;
      if (doc.hidden || (rec.known && !rec.visible)) {
        rec.resumeWanted = true;
        pauseByRuntime(rec);
      }
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
    if (rec.el.ended) return;                    /* end of clip is not a user pause */
    if (rec.expectPause > 0) { rec.expectPause--; return; }  /* this is our own suspension */
    /* an explicit pause (user or page code): never auto-resume this video */
    rec.userPaused = true;
    rec.resumeWanted = false;
  }

  function trackVideo(v) {
    if (!v || typeof v.pause !== 'function' || !v.addEventListener) return;
    if (recOf(v)) return;
    var rec = {
      el: v, known: false, visible: true,
      userPaused: false, resumeWanted: false,
      expectPause: 0, expectPlay: 0, timer: 0
    };
    videos.push(rec);
    report.videos.tracked = videos.length;
    v.addEventListener('play', function () { onVideoPlay(rec); });
    v.addEventListener('pause', function () { onVideoPause(rec); });
    v.addEventListener('ended', function () { rec.resumeWanted = false; });
    if (videoIO) videoIO.observe(v);
  }

  function initVideos() {
    var all = doc.querySelectorAll('video');
    if (!hasIO) {
      report.videos.io = 'unsupported';
      warn('IntersectionObserver unavailable — offscreen video suspension disabled.');
      return;
    }
    videoIO = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i];
        var rec = recOf(en.target);
        if (!rec) continue;
        rec.known = true;
        rec.visible = !!en.isIntersecting;
        if (!rec.visible) {
          if (!rec.el.paused && !rec.el.ended) {
            rec.resumeWanted = true;              /* was playing — resume on re-entry */
            pauseByRuntime(rec);
            report.videos.suspended++;
          }
        } else {
          if (rec.resumeWanted) report.videos.resumed++;
          tryResume(rec);
        }
      }
    }, { threshold: 0, rootMargin: '0px' });
    report.videos.io = 'root:null';
    for (var i = 0; i < all.length; i++) trackVideo(all[i]);
  }

  /* ========================================================================
     2. CSS ANIMATIONS — pause offscreen targets, resume on re-entry.
     ====================================================================== */
  var animEls = [];       /* { el, anims:[Animation], held, holdStart, known, visible } */
  var animIO = null;

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
     3. ROOT SCROLL LOCK — overflow:clip only when the content fits 16000 px.
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
      for (i = 0; i < videos.length; i++) tryResume(videos[i]);
      resumeVisibleAnimations();
      scanAnimations();
    }
  });

  initVideos();
  initAnimations();
  applyFit();
  setTimeout(applyFit, 2000);    /* after remote media + reveal transitions settle */

  window.addEventListener('load', function () { scanAnimations(); applyFit(); });
  if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) {
    doc.fonts.ready.then(function () { scanAnimations(); applyFit(); });
  }
})();
