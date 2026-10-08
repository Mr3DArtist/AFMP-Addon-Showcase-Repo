/* ============================================================================
   ParticleField — a drifting node network with lines between neighbours.

   Owner: *"replace the animated live mouse reactive particles with this"*, pasting
   an AetherFlow hero whose canvas draws violet nodes joined by lines on black, with
   the lines turning WHITE near the cursor.

   ⛔⛔ THIS IS A FAITHFUL PORT OF THAT PARTICLE SYSTEM, NOT A REDESIGN. Node count,
     sizes, velocities, edge bounce, the link threshold, the opacity falloff, the
     cursor repulsion and the two line colours are all read off the supplied code:
       nodes    (w * h) / 9000, size 1–3px, velocity ±0.2, bounce off the edges
       colour   rgba(191,128,255,.8) dots
       links    any pair whose SQUARED distance < (w/7)*(h/7)
       opacity  1 - dist2/20000
       lines    rgba(200,150,255,a) — rgba(255,255,255,a) when inside the cursor's
                200px radius
       cursor   particles within 200px are PUSHED AWAY, force = (R-d)/R * 5

   ⛔⛔ FIVE THINGS THE ORIGINAL DOES WRONG AND THIS DELIBERATELY DOES NOT. The LOOK is
     copied exactly; the defects are not, because each one is visible or costs something:
       1. `dist < (w/7)*(h/7)` compares a SQUARED distance against a product of
          lengths. It happens to give a sane link range at 16:9 and drifts badly at
          other aspects. Kept as a squared comparison against the same number, so the
          on-screen result is identical where the original looked right.
       2. `rgba(…, ${opacityValue})` goes NEGATIVE once dist2 > 20000. A negative alpha
          is an invalid colour, the assignment is IGNORED, and the stroke silently
          keeps the PREVIOUS pair's colour. Clamped to 0 — same pixels, no stale lines.
       3. `if (mouse.x && …)` is falsy at x === 0, so the leftmost 1px column never
          lights up. Now an explicit null check.
       4. The canvas is filled OPAQUE BLACK every frame. `#interactiveBg` sits at
          `z-index:-2`, so that would erase the page's navy gradient — the ramp built
          from the owner's thumbnail — and flatten the whole page. `clearRect` instead,
          leaving the field transparent over the gradient. ⚠ To match the reference's
          black exactly, swap `clearRect` for a black `fillRect`; that is the one line.
       5. No `devicePixelRatio`, so the nodes are soft on any retina display. Sized at
          DPR here.
     ⛔ Also kept from this page's own conventions rather than the original: a
       `prefers-reduced-motion` path that paints one static frame and stops, and a
       `visibilitychange` pause so a hidden tab is not burning a frame budget.
     ⛔ v2 no-cache pass: in the Superhive embed the field additionally defaults to a
       REPRESENTATIVE STATIC frame — one paint per visible host window, no continuous
       loop — because the human's GPU budget cannot carry an ambient canvas behind a
       page of playing clips. `?effects=full` restores the strip animation. Standalone
       (no `embed=superhive`) is untouched. No caching, no downloads, no copies.
   ========================================================================== */
(function () {
  'use strict';

  var canvas = document.getElementById('interactiveBg');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  /* the supplied constants */
  var DENSITY = 9000;            // node count = (w * h) / DENSITY
  /* ⛔⛔ THE PAGE'S PALETTE, NOT THE REFERENCE'S VIOLET — owner: *"use the pages theme
     colors"*. The AetherFlow original runs `rgba(191,128,255)` nodes and
     `rgba(200,150,255)` links; violet appears NOWHERE else on this page, which is azure
     throughout. Only the three colours change — every one of the reference's
     BEHAVIOURS (count, sizes, velocities, link threshold, falloff, repulsion) is
     untouched, so the field moves exactly as it did.
     ⛔ The three take the page's own tokens rather than one flat colour: the nodes carry
     the BRAND azure (`#0096ff`, the same value as `.btn-primary`, the coupon border and
     the wordmark's middle span), while the LINKS stay in the muted blue-grey wireframe
     family the page already used — a 1px line at full brand saturation reads as a
     cable, not a wireframe. The cursor's highlight is the light cyan `#8fd8ff` that the
     offer band and the ring glow already use, in place of the reference's pure white. */
  var NODE_FILL = 'rgba(0, 150, 255, 0.9)';
  var LINE_FAR = [110, 130, 190];
  var LINE_NEAR = [143, 216, 255];
  var FADE = 20000;              // opacity = 1 - dist2 / FADE
  var CURSOR_R = 200;            // px
  /* ⛔ HALVED, on the owner's word: *"reduce the repaltion instansity to 50%"*. The
     supplied original uses 5, which it applies as `force * 5` per frame — a hard shove
     that empties the whole 200px radius almost instantly.
     ⛔ This scales the STRENGTH of the push, not its REACH: `CURSOR_R` is untouched, so
     the cursor still clears the same circle, it just does it more gently and the field
     takes longer to settle. Halving the radius instead would have made the cursor
     affect a smaller area, which is a different change. */
  var PUSH = 2.5;
  var SIZE_MIN = 1, SIZE_MAX = 3;

  var W = 0, H = 0, DPR = 1, linkDist2 = 0;
  var docW = 0, docH = 0;        // the field's own extent — the whole DOCUMENT
  var parts = [];
  var vis = [];                  // reused each frame: no allocation in the loop
  var mouse = { x: null, y: null };
  var raf = 0, started = false, visible = true;
  var MAX_NODES = 2600;          // guard: the update pass is O(n), the connect O(visible^2)

  /* ------------------------------------------------- connect() scratch
     ⛔ Reused between frames and grown only when the grid needs it, so a steady
     frame allocates nothing here. `cand` holds the candidate b indices for one
     `a`; the comparator is numeric because bucket order has no meaning of its own. */
  var cand = [];
  var gCells = 0;                // cell count the two grid arrays below can hold
  var gCounts = null, gStarts = null, gItems = null, gCell = null;
  function byIndex(u, v) { return u - v; }

  // Embed-only paint window. Physics retains the full child viewport universe.
  var stripMode = /[?&]embed=superhive(?:&|$)/.test(window.location.search) && 'IntersectionObserver' in window;
  /* ⛔ EFFICIENT EMBED DEFAULT (no-cache pass): the canvas keeps a REPRESENTATIVE STATIC
     frame — one paint per visible host window — instead of a 60Hz loop over the whole
     field. `?effects=full` restores the strip animation, standalone is untouched, and
     prefers-reduced-motion stays static as it already was. Nothing here caches or
     fetches anything; this only decides how often the existing draw runs. */
  var fullMotion = !stripMode || /[?&]effects=full(?:&|$)/.test(window.location.search);
  var staticMode = reduce || !fullMotion;
  var paintTop = 0, paintBottom = 0, hostVisible = true;
  var tileIO = null, tileBox = null, tileRects = [];
  var TILE = 256, OVER = 768;
  function setPaintWindow(top, bottom) {
    paintTop = top; paintBottom = bottom;
    var pixels = Math.round((bottom - top) * DPR);
    if (canvas.height !== pixels) canvas.height = pixels;
    canvas.style.top = top + 'px';
    canvas.style.height = (bottom - top) + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, -top * DPR);
  }
  function rebuildTiles() {
    if (!stripMode) return;
    if (tileIO) tileIO.disconnect();
    if (tileBox) tileBox.remove();
    tileRects = []; hostVisible = false;
    tileBox = document.createElement('div');
    tileBox.setAttribute('data-particle-visibility', '');
    tileBox.setAttribute('aria-hidden', 'true');
    tileBox.style.cssText = 'position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:-100;';
    document.body.appendChild(tileBox);
    tileIO = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i], r = e.intersectionRect;
        tileRects[e.target._particleTile] = e.isIntersecting && r.height > 0 && r.width > 0 ? { top: r.top, bottom: r.bottom } : null;
      }
      var lo = Infinity, hi = -Infinity;
      for (i = 0; i < tileRects.length; i++) if (tileRects[i]) {
        lo = Math.min(lo, tileRects[i].top); hi = Math.max(hi, tileRects[i].bottom);
      }
      hostVisible = hi > lo;
      if (!hostVisible || document.hidden) { stop(); return; }
      var top = Math.max(0, Math.floor((lo - OVER) / TILE) * TILE);
      var bottom = Math.min(H, Math.ceil((hi + OVER) / TILE) * TILE);
      if (top !== paintTop || bottom !== paintBottom) setPaintWindow(top, bottom);
      /* static mode: repaint the ONE frame for the new window, never start the loop */
      if (staticMode) paintOnce(); else start();
    }, { root: null, threshold: [0, .25, .5, .75, 1] });
    for (var y = 0, index = 0; y < H; y += TILE, index++) {
      var tile = document.createElement('div');
      tile._particleTile = index;
      tile.style.cssText = 'position:absolute;left:0;right:0;top:' + y + 'px;height:' + Math.min(TILE, H - y) + 'px;pointer-events:none;';
      tileBox.appendChild(tile); tileIO.observe(tile);
    }
    // Safe full-frame initial backing until the first visibility delivery.
    paintTop = 0; paintBottom = H;
  }

  /* ------------------------------------------------------------- sizing
     ⛔⛔ THE CANVAS STAYS VIEWPORT-SIZED, BUT THE FIELD DOES NOT.
     Owner: *"why the background is locked to view i want new particles to appear when i
     scroll"*. The canvas is still `position: fixed` and still one screenful — but the
     PARTICLES are seeded across the whole DOCUMENT and drawn at their scroll offset, so
     scrolling walks through a field far larger than the window and new ones come into
     view. Two reasons it is done this way rather than by making the element
     document-sized:
       1. a document-sized canvas is ~18.5M px here (74M at DPR 2 — roughly 300MB of
          backing store), against 1.1M for the viewport-sized one;
       2. the reference's density formula, applied to a 13,000px-tall page, asks for
          ~2,060 nodes, and its connect pass is O(n²) — about 4 MILLION distance checks
          per frame. Here the same field costs one O(n) pass to update and an O(visible²)
          pass to link, which is ~150–200 nodes and ~20k checks.
     ⛔ The link range stays tied to the VIEWPORT `(W/7)*(H/7)`, exactly as the reference
     computes it against its canvas. Tying it to the document instead would make every
     pair within hundreds of pixels connect and the field would read as a web. */
  function measure() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    linkDist2 = (W / 7) * (H / 7);
    /* ⛔ the DOCUMENT's size, not the window's — this is what the field is seeded across */
    docW = Math.max(W, document.documentElement.scrollWidth || 0);
    docH = Math.max(H, document.documentElement.scrollHeight || 0);
  }

  function seed() {
    parts = [];
    var n = Math.round((docW * docH) / DENSITY);
    if (n > MAX_NODES) n = MAX_NODES;
    for (var i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * docW,
        y: Math.random() * docH,
        dx: Math.random() * 0.4 - 0.2,
        dy: Math.random() * 0.4 - 0.2,
        size: Math.random() * (SIZE_MAX - SIZE_MIN) + SIZE_MIN,
        vx: 0, vy: 0, on: false      // viewport coords + visibility, recomputed per frame
      });
    }
  }

  /* -------------------------------------------------------------- frame
     ⛔ The drift and the cursor repulsion both happen in DOCUMENT space, so a particle
     keeps its position in the page while the window moves over it. Only the DRAW is
     offset by the scroll. */
  function step(p) {
    if (p.x > docW || p.x < 0) p.dx = -p.dx;
    if (p.y > docH || p.y < 0) p.dy = -p.dy;

    if (mouse.x !== null && mouse.y !== null) {
      /* ⛔⛔ THE VECTOR POINTS FROM THE CURSOR **TO** THE PARTICLE, AND IS THEN ADDED.
         The supplied original writes `dx = mouse.x - this.x` (particle→cursor) and then
         SUBTRACTS. When this was rewritten for document space the subtraction was kept
         but the operands were swapped — `p.vx - mouse.x` — which silently turned the
         repulsion into ATTRACTION and pulled the field into the cursor. The owner caught
         it: *"the particles are now coming towards the mouse instead of repaling"*.
         ⛔ Keep these two in step: swap the operand order and the sign must swap with it.
         ⛔ `p.vx`/`p.vy` are the VIEWPORT coords and `p.x`/`p.y` the DOCUMENT ones, but the
         two differ only by the scroll offset — a constant translation — so the DIRECTION
         is identical in both spaces and no correction is needed between them. */
      var dx = p.vx - mouse.x, dy = p.vy - mouse.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < CURSOR_R + p.size && d > 0.001) {
        var f = (CURSOR_R - d) / CURSOR_R;
        p.x += (dx / d) * f * PUSH;
        p.y += (dy / d) * f * PUSH;
      }
    }

    p.x += p.dx;
    p.y += p.dy;
  }

  function draw(p) {
    ctx.beginPath();
    ctx.arc(p.vx, p.vy, p.size, 0, 6.2832, false);
    ctx.fillStyle = NODE_FILL;
    ctx.fill();
  }

  /* ---------------------------------------------------------- connect
     ⛔⛔ BUCKETED PAIR SEARCH — THE OUTPUT IS NOT OPTIMISED, ONLY THE SEARCH.
     The original scans every pair a<b — O(n²) — but a stroke is emitted only when
     BOTH tests pass: `d2 < linkDist2` AND `alpha = 1 - d2/FADE > 0`, i.e.
     d2 < min(linkDist2, FADE). No drawn pair is farther apart than
     R = sqrt(min(linkDist2, FADE)), so the search visits only pairs inside R: a
     uniform grid of cell size R, where any pair within R sits in the same or an
     adjacent cell per axis — the 3×3 block around `a`.
     ⛔ The DRAW ORDER is part of the output: the original emits pairs with `a`
     ascending and, within each `a`, `b` ascending. A bucket walk has no order of
     its own, so each a's candidates are COLLECTED AND SORTED ASCENDING before the
     unchanged test runs — same pairs, same colours, same sequence, same pixels;
     only the tests that used to fail are no longer executed. */
  function connect() {
    var n = vis.length;
    ctx.lineWidth = 1;
    if (n === 0) return;

    var R2 = Math.min(linkDist2, FADE);   // a drawn pair needs d2 < R2 (both tests)
    if (!(R2 > 0)) return;                // degenerate viewport: no pair can draw
    var R = Math.sqrt(R2);

    /* the grid spans the visible set's OWN viewport-space bounds, so the 3×3
       neighbourhood below needs no margin bookkeeping */
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var i, p;
    for (i = 0; i < n; i++) {
      p = vis[i];
      if (p.vx < minX) minX = p.vx;
      if (p.vx > maxX) maxX = p.vx;
      if (p.vy < minY) minY = p.vy;
      if (p.vy > maxY) maxY = p.vy;
    }
    var cols = Math.floor((maxX - minX) / R) + 1;
    var rows = Math.floor((maxY - minY) / R) + 1;
    var cells = cols * rows;

    if (gCells < cells) {                 // grow the grid scratch, once
      gCells = cells;
      gCounts = new Int32Array(cells);
      gStarts = new Int32Array(cells + 1);
    }
    if (gCell === null || gCell.length < n) {
      gCell = new Int32Array(n);
      gItems = new Int32Array(n);
    }

    /* counting sort: cell index per particle, prefix sums, then scatter */
    for (i = 0; i < cells; i++) gCounts[i] = 0;
    for (i = 0; i < n; i++) {
      p = vis[i];
      var ci = Math.floor((p.vy - minY) / R) * cols + Math.floor((p.vx - minX) / R);
      gCell[i] = ci;
      gCounts[ci]++;
    }
    gStarts[0] = 0;
    for (i = 0; i < cells; i++) gStarts[i + 1] = gStarts[i] + gCounts[i];
    for (i = 0; i < cells; i++) gCounts[i] = gStarts[i];   // counts become the fill cursor
    for (i = 0; i < n; i++) gItems[gCounts[gCell[i]]++] = i;

    for (var a = 0; a < n; a++) {
      var pa = vis[a];
      /* ⛔ the cursor test is hoisted out of the inner loop: it depends only on `a`,
         and the original recomputes it for every b. Same output, a fraction of the
         work in the pair pass. */
      var nearCursor = false;
      if (mouse.x !== null && mouse.y !== null) {
        var mx = pa.vx - mouse.x, my = pa.vy - mouse.y;
        nearCursor = (mx * mx + my * my) < CURSOR_R * CURSOR_R;
      }
      var col = nearCursor ? LINE_NEAR : LINE_FAR;

      /* the candidates: the 3×3 cell block around `a`'s own cell */
      var ca = gCell[a];
      var cxa = ca % cols, cya = (ca / cols) | 0;
      var x0 = cxa > 0 ? cxa - 1 : 0, x1 = cxa + 1 < cols ? cxa + 2 : cols;
      var y0 = cya > 0 ? cya - 1 : 0, y1 = cya + 1 < rows ? cya + 2 : rows;
      cand.length = 0;
      for (var gy = y0; gy < y1; gy++) {
        var row = gy * cols;
        for (var gx = x0; gx < x1; gx++) {
          var c = row + gx, end = gStarts[c + 1];
          for (var t = gStarts[c]; t < end; t++) {
            var b = gItems[t];
            if (b > a) cand.push(b);      // pairs are (a<b), once, as before
          }
        }
      }
      /* ⛔ the bucket walk emits in no particular order — the original emits b
         ASCENDING inside each a, and stroke order shows under alpha, so sort the
         candidates before the exact test decides which of them draw */
      cand.sort(byIndex);

      for (var k = 0; k < cand.length; k++) {
        var pb = vis[cand[k]];
        var ax = pa.vx - pb.vx, ay = pa.vy - pb.vy;
        var d2 = ax * ax + ay * ay;
        if (d2 >= linkDist2) continue;
        /* ⛔ clamped — see note 2 at the top of the file */
        var alpha = 1 - d2 / FADE;
        if (alpha <= 0) continue;
        if (alpha > 1) alpha = 1;
        ctx.strokeStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha.toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(pa.vx, pa.vy);
        ctx.lineTo(pb.vx, pb.vy);
        ctx.stroke();
      }
    }
  }

  /* ⛔ ONE viewport pass, shared by the animated frame and the reduced-motion still —
     `connect()` reads `vis`, so any path that draws MUST run this first or it links
     against the previous frame's list. */
  function computeViewport() {
    var sx = window.scrollX || 0, sy = window.scrollY || 0;
    /* ⛔ a margin of one link range past each edge, or the links would POP as their
       particles crossed the boundary — a pair is drawn while both ends are inside */
    var M = Math.sqrt(linkDist2);
    var i, p;
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      p.vx = p.x - sx;
      p.vy = p.y - sy;
      p.on = (p.vx > -M && p.vx < W + M && p.vy > -M && p.vy < H + M);
    }
    vis.length = 0;
    var stripMargin = Math.sqrt(Math.min(linkDist2, FADE)) + SIZE_MAX + 2;
    for (i = 0; i < parts.length; i++) if (parts[i].on &&
      (!stripMode || (parts[i].vy > paintTop - stripMargin && parts[i].vy < paintBottom + stripMargin))) vis.push(parts[i]);
  }

  function frame() {
    if (stripMode && (!hostVisible || document.hidden)) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    ctx.clearRect(0, 0, W, H);

    for (var i = 0; i < parts.length; i++) step(parts[i]);
    computeViewport();

    for (i = 0; i < vis.length; i++) draw(vis[i]);
    connect();
  }

  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  /* ---------------------------------------------------------- lifecycle */
  function start() {
    if (raf || staticMode || document.hidden || (stripMode && !hostVisible)) return;
    raf = requestAnimationFrame(frame);
  }

  function paintOnce() {
    /* the reduced-motion state: a real frame, held still */
    ctx.clearRect(0, 0, W, H);
    computeViewport();                 // ⛔ before any draw — `connect()` reads `vis`
    for (var i = 0; i < vis.length; i++) draw(vis[i]);
    connect();
  }

  function rebuild() {
    measure();
    seed();
    rebuildTiles();
    if (staticMode && (!stripMode || hostVisible)) paintOnce();
  }

  var rt = 0;
  window.addEventListener('resize', function () {
    if (rt) clearTimeout(rt);
    rt = setTimeout(rebuild, 160);
  });

  /* ⛔ a hidden tab must not keep animating — the original never pauses */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { visible = false; stop(); }
    else {
      visible = true;
      if (staticMode) { if (!stripMode || hostVisible) paintOnce(); }
      else start();
    }
  });

  /* the cursor is tracked on the window: the canvas itself is `pointer-events:none` */
  window.addEventListener('mousemove', function (e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }, { passive: true });
  window.addEventListener('mouseout', function (e) {
    if (!e.relatedTarget) { mouse.x = null; mouse.y = null; }
  });

  rebuild();
  if (!visible) return;
  start();
})();
