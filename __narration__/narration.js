/* SpatialTimber narrated presentation — runtime controller (additive overlay).
 *
 * Injected after deck-controls.js by tools/serve_presentation.py. Turns the pristine
 * web deck into a narrated presentation WITHOUT touching the deck source.
 *
 * Two modes (chosen on a start overlay shown on every (re)load, switchable later
 * via the .deck-modetoggle button or the "A" key; the live choice persists in
 * localStorage 'deck-stage.mode' for the toggle, but reloads always re-show the
 * overlay rather than honouring the saved choice):
 *
 *   narrated  — each slide's voiceover (audio/<cut>/NN.mp3, served at
 *               /__narration__/audio/NN.mp3) auto-plays; the on-slide build-up steps
 *               that are normally advanced by hand (a column/video reveal on
 *               ArrowRight, a click overlay, or an SVG __scheme.forward()) fire
 *               AUTOMATICALLY while the narration plays; when the audio ENDS the deck
 *               auto-advances to the next slide (~1 s gap). Manual navigation still
 *               works and interrupts — it cuts the audio and jumps.
 *
 *   manual    — nothing is driven: the deck behaves exactly as it does today (native
 *               navigation, native step-by-step scheme build-up, no audio). The
 *               controller patches nothing in this mode.
 *
 * How the auto-stepping works (narrated mode):
 *   - key slides (7/16/23/28): each has its OWN capture-phase keydown handler in the
 *     deck that reveals the next block on ArrowRight and swallows the event (so the
 *     deck does not advance). We reproduce a user press by dispatching a synthetic
 *     ArrowRight on the ACTIVE SLIDE (a descendant of window) — the slide reveals; the
 *     deck never advances because that handler's capture-phase stopPropagation() blocks
 *     deck-stage's bubble-phase _onKey. (Dispatching on window directly would NOT work:
 *     target===window collapses to AT_TARGET, where listeners fire in registration order
 *     and _onKey — registered first — advances before the reveal handler runs. See
 *     fireKeyStep.)
 *   - click slide (19): we click the reveal target (#demo-media-stage).
 *   - scheme slides (14/15/18): we call the SVG's __scheme.forward() ourselves, once
 *     per phase. We also monkeypatch __scheme.built() -> true while driving so the
 *     deck-controls capture interceptor never swallows the USER's ArrowRight — i.e. a
 *     real key press always advances the SLIDE while we own the phase build-up. The
 *     original built() is restored when the slide is left or narrated mode is turned off.
 *   - furnisher slide (21): a self-playing machine — we fire nothing, just play audio.
 *   - timed steps (slide 29): a step with an 'at' fraction fires relative to the audio
 *     timeline rather than at entry — slide 29 swaps in the contact QR at the midpoint
 *     (at:0.5) of the closing voice-over. Narrated-only (it rides the audio element) and
 *     not part of the video's record_sequences tables. See driveTimedSteps.
 *   - audio-synced steps (NN.marks.json): for key/click slides, build steps fire at ABSOLUTE
 *     word-start times from forced alignment (tools/align_audio.py), so a reveal lands exactly
 *     when the voice reaches the word an author tagged with ⟦step⟧ in the script. maybeDriveSlide
 *     fetches the marks; onTimeUpdate fires them as playback crosses each time. When no marks
 *     exist the slide falls back to the settle-paced driver above (unchanged). Scheme/furnisher
 *     stay settle-paced (their phase count is read live in-browser). Narrated-web only.
 *
 * Pacing mirrors tools/record_sequences.py (_settle + RUNNING_JS): after a step we poll
 * getAnimations() across the active slide AND its SVG sub-documents and advance once the
 * finite in-slide animations have settled, plus a small gap.
 */
(function () {
  'use strict';

  var LS_MODE = 'deck-stage.mode';   // 'narrated' | 'manual'
  var IDLE_MS = 2600;                 // mirror deck chrome idle-fade
  var GAP_MS = 1000;                  // ~1 s between slides on auto-advance (Martin's pref)
  var STEP_GAP_MS = 550;              // breathing gap between auto build steps
  var SETTLE_CAP_MS = 9000;          // never wait longer than this for animations
  var ENTRY_SETTLE_MS = 700;         // min wait for a slide's entry reveal before stepping
  var STEP_SETTLE_MS = 380;          // min wait after firing a build step

  function deckEl() { return document.querySelector('deck-stage'); }
  function activeSlide() { var d = deckEl(); return d ? d.querySelector('[data-deck-active]') : null; }
  function slideNumber() {
    var d = deckEl();
    return (d && typeof d._index === 'number' ? d._index : 0) + 1;
  }

  var state = {
    narrated: false,
    unlocked: false,        // has a user gesture unlocked audio playback?
    token: 0,               // bumped on every slide entry / mode change — invalidates async work
    audio: null,
    config: { total: 29, slides: {} },
    timers: [],
    advanceTimer: null,
    pendingMarks: null,     // { token, items:[{at_s, t, sel, fired}] } — audio-synced steps
    patchedScheme: null,    // the __scheme whose built() we currently override
    btn: null,
    bump: function () {}
  };
  window.__narration = state;

  // ── timers ──────────────────────────────────────────────────────────────
  function later(fn, ms) { var id = setTimeout(fn, ms); state.timers.push(id); return id; }
  function sleep(ms) { return new Promise(function (res) { later(res, ms); }); }
  function clearPending() {
    state.timers.forEach(clearTimeout); state.timers = [];
    if (state.advanceTimer) { clearTimeout(state.advanceTimer); state.advanceTimer = null; }
    state.pendingMarks = null;
  }

  // ── audio ───────────────────────────────────────────────────────────────
  function audioUrl(n) {
    var pat = (state.config && state.config.audioPattern) || '/__narration__/audio/{nn}.mp3';
    return pat.replace('{nn}', String(n).length === 1 ? '0' + n : String(n));
  }
  function marksUrl(n) {
    var pat = state.config && state.config.marksPattern;   // absent => marks disabled
    return pat ? pat.replace('{nn}', String(n).length === 1 ? '0' + n : String(n)) : null;
  }
  function stopAudio() {
    var a = state.audio; if (!a) return;
    try { a.pause(); } catch (e) {}
    a.removeAttribute('src');
    try { a.load(); } catch (e) {}      // kill any late timeupdate/ended from the old clip
  }
  function playSlideAudio(n) {
    if (!state.audio) return;
    stopAudio();
    if (!state.narrated || !state.unlocked) return;
    var a = state.audio;
    a.src = audioUrl(n);
    try { a.currentTime = 0; } catch (e) {}
    var p = a.play(); if (p && p.catch) p.catch(function () {});
  }
  function onAudioEnded() {
    if (!state.narrated) return;
    var token = state.token;
    var d = deckEl(); if (!d) return;
    var last = (d._slides ? d._slides.length : state.config.total) - 1;
    if (typeof d._index === 'number' && d._index >= last) return;   // last slide: stop
    state.advanceTimer = setTimeout(function () {
      if (token !== state.token || !state.narrated) return;
      try { d._advance(1, 'api'); } catch (e) {}
    }, GAP_MS);
  }
  // Audio-synced build steps: fire each pending mark when playback crosses its absolute time.
  // Driven by NN.marks.json (produced by tools/align_audio.py from forced-aligned word times).
  // Fires on 'timeupdate' (~4x/s) rather than a timer, so pause/seek stay correct; idempotent
  // via the per-item `fired` flag. The token guard drops stale marks after navigation.
  function onTimeUpdate() {
    var pm = state.pendingMarks;
    if (!pm || pm.token !== state.token || !state.narrated) return;
    var t = state.audio ? state.audio.currentTime : 0;
    for (var i = 0; i < pm.items.length; i++) {
      var it = pm.items[i];
      if (!it.fired && t >= it.at_s) {
        it.fired = true;
        if (it.t === 'click') fireClickStep(it.sel); else fireKeyStep();
      }
    }
  }

  // ── animation settle (port of RUNNING_JS + _settle) ──────────────────────
  function inSlideAnimationsRunning() {
    var slide = activeSlide(); if (!slide) return 0;
    var docs = [document];
    slide.querySelectorAll('object[type="image/svg+xml"]').forEach(function (o) {
      try { if (o.contentDocument) docs.push(o.contentDocument); } catch (e) {}
    });
    var n = 0;
    for (var i = 0; i < docs.length; i++) {
      var anims = []; try { anims = docs[i].getAnimations(); } catch (e) {}
      for (var j = 0; j < anims.length; j++) {
        var a = anims[j], t = a.effect && a.effect.target;
        if (docs[i] === document && !(t && slide.contains(t))) continue;
        try { if (a.effect.getTiming().iterations === Infinity) continue; } catch (e) {}
        if (a.playState === 'running' || a.playState === 'pending') n++;
      }
    }
    return n;
  }
  function settle(token, minMs) {
    return new Promise(function (resolve) {
      var elapsed = 0, step = 100;
      function tick() {
        if (token !== state.token) return resolve();
        elapsed += step;
        if (elapsed >= SETTLE_CAP_MS) return resolve();
        if (elapsed >= minMs && inSlideAnimationsRunning() === 0) return resolve();
        later(tick, step);
      }
      later(tick, step);
    });
  }

  // ── scheme helpers ───────────────────────────────────────────────────────
  function activeScheme() {
    var s = activeSlide(); if (!s) return null;
    var o = s.querySelector('object[type="image/svg+xml"]'); if (!o) return null;
    try { var w = o.contentWindow; return (w && w.__scheme) ? w.__scheme : null; } catch (e) { return null; }
  }
  function patchScheme(sch) {
    if (!sch || sch.__narrationPatched) return;
    sch.__origBuilt = sch.built;
    sch.built = function () { return true; };   // deck-controls never swallows the user's key
    sch.__narrationPatched = true;
    state.patchedScheme = sch;
  }
  function restorePatched() {
    var sch = state.patchedScheme;
    if (sch && sch.__narrationPatched) {
      try { sch.built = sch.__origBuilt; } catch (e) {}
      sch.__narrationPatched = false;
    }
    state.patchedScheme = null;
  }

  // ── step firing ────────────────────────────────────────────────────────--
  function fireKeyStep() {
    // Dispatch on the active slide (a DESCENDANT of window), NOT on window itself.
    // The per-slide reveal handlers (7/16/28) listen on window in the CAPTURE phase
    // and stopPropagation() to swallow the press; deck-stage's _onKey listens on
    // window in the BUBBLE phase and advances the slide. Dispatching on a descendant
    // makes the browser run a real capture→target→bubble pass, so the capture handler
    // fires first and swallows the key. Dispatching directly on window collapses to
    // AT_TARGET, where ALL window listeners fire in REGISTRATION order — and _onKey is
    // registered first (deck-stage connects before the inline per-slide scripts), so it
    // advances to the next slide before the reveal handler can swallow the key.
    var target = activeSlide() || document.body || document;
    target.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
  }
  function fireClickStep(sel) {
    var s = activeSlide();
    var el = (s && s.querySelector(sel)) || document.querySelector(sel);
    if (el) el.click();
  }

  // ── drive a slide's auto build-up ──────────────────────────────────────--
  // Entry point from onSlideChange: prefer audio-synced marks (NN.marks.json) when present,
  // else fall back to the settle-paced / at-fraction driver. The fetch is cheap (tiny JSON,
  // 404 fast) and a slide with no config entry can't have steps, so we skip the fetch there.
  function maybeDriveSlide(n, token) {
    var cfg = state.config.slides[String(n)];
    if (!cfg) return;                                  // entry-only slide: nothing to drive
    var url = marksUrl(n);
    // Scheme/furnisher stay settle-paced for now (phase count is read live in-browser); only
    // fixed-step key/click slides use marks. Skip the fetch for the others.
    if (!url || cfg.kind === 'scheme' || cfg.kind === 'furnisher') { driveSlide(n, token); return; }
    fetch(url).then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        if (token !== state.token || !state.narrated) return;   // navigated away
        if (j && j.steps && j.steps.length) driveByMarks(n, token, cfg, j.steps);
        else driveSlide(n, token);                              // no marks → existing behavior
      });
  }
  // Arm audio-synced steps: map each mark to its config step's kind/selector and let
  // onTimeUpdate fire them. (cfg.steps[i] carries kind 'key'/'click' + any selector.)
  function driveByMarks(n, token, cfg, marks) {
    var cfgSteps = cfg.steps || [];
    state.pendingMarks = {
      token: token,
      items: marks.map(function (m) {
        var cs = cfgSteps[m.i] || {};
        return { at_s: m.at_s, t: cs.t || 'key', sel: cs.sel, fired: false };
      })
    };
  }
  function driveSlide(n, token) {
    var cfg = state.config.slides[String(n)];
    if (!cfg) return;                       // entry-only slide: nothing to step
    if (cfg.kind === 'furnisher') return;   // self-driving machine
    if (cfg.kind === 'scheme') { driveScheme(token); return; }
    var steps = cfg.steps || [];            // key / click
    // Steps with an 'at' fraction fire relative to the audio timeline (e.g. slide 29's
    // mid-voiceover QR swap), not the entry-settle loop. A slide mixes one or the other.
    if (steps.some(function (s) { return typeof s.at === 'number'; })) {
      driveTimedSteps(steps, token);
      return;
    }
    driveSteps(steps, token);
  }
  // Fire steps at a fraction of the narration audio's duration (step.at, 0..1). Used for
  // reveals that should land mid-voice-over rather than at slide entry — e.g. slide 29
  // swaps in the contact QR halfway through the closing line. Narrated-only by nature: it
  // rides state.audio, which only plays in narrated mode, so manual mode never triggers it.
  function driveTimedSteps(steps, token) {
    var a = state.audio;
    if (!a || !state.narrated) return;
    function fireAt(st) {
      var frac = (typeof st.at === 'number') ? st.at : 0.5;
      var dur = a.duration;
      if (!isFinite(dur) || dur <= 0) return;            // no metadata yet → caller retries
      var delay = Math.max(0, dur * frac - (a.currentTime || 0)) * 1000;
      later(function () {
        if (token !== state.token || !state.narrated) return;
        if (st.t === 'click') fireClickStep(st.sel); else fireKeyStep();
      }, delay);
    }
    function schedule() {
      if (token !== state.token) return;
      steps.forEach(fireAt);
    }
    if (isFinite(a.duration) && a.duration > 0) {
      schedule();
    } else {
      a.addEventListener('loadedmetadata', function onMeta() {  // wait for duration
        a.removeEventListener('loadedmetadata', onMeta);
        schedule();
      });
    }
  }
  function driveSteps(steps, token) {
    (async function () {
      await settle(token, ENTRY_SETTLE_MS);
      for (var i = 0; i < steps.length; i++) {
        if (token !== state.token) return;
        var st = steps[i];
        if (st.t === 'click') fireClickStep(st.sel); else fireKeyStep();
        await settle(token, STEP_SETTLE_MS);
        await sleep(STEP_GAP_MS);
      }
    })();
  }
  function driveScheme(token) {
    (async function () {
      var sch = null, waited = 0;
      while (waited < 3000) {               // the SVG <object> may still be loading
        sch = activeScheme(); if (sch) break;
        await sleep(150); waited += 150;
        if (token !== state.token) return;
      }
      if (!sch) return;
      patchScheme(sch);                     // user ArrowRight now advances the slide
      await settle(token, ENTRY_SETTLE_MS);
      var total = (typeof sch.total === 'number') ? sch.total : 0;
      for (var i = 0; i < total; i++) {
        if (token !== state.token) return;
        try { sch.forward(); } catch (e) {}
        await settle(token, STEP_SETTLE_MS);
        await sleep(STEP_GAP_MS);
      }
    })();
  }

  // ── slide change ─────────────────────────────────────────────────────────
  function onSlideChange(e) {
    var token = ++state.token;
    clearPending();
    restorePatched();                       // un-patch the scheme of the slide we left
    stopAudio();
    if (!state.narrated) return;            // manual mode: leave the deck entirely native
    var n = (e && e.detail && typeof e.detail.index === 'number') ? e.detail.index + 1 : slideNumber();
    playSlideAudio(n);
    maybeDriveSlide(n, token);
  }

  // ── mode + gesture unlock ─────────────────────────────────────────────────
  function setMode(mode) {
    state.narrated = (mode === 'narrated');
    try { localStorage.setItem(LS_MODE, mode); } catch (e) {}
    renderToggle();
    var token = ++state.token;
    clearPending();
    if (state.narrated) {
      var n = slideNumber();
      playSlideAudio(n);                    // no-op until unlocked
      maybeDriveSlide(n, token);
    } else {
      stopAudio();
      restorePatched();                     // hand the deck back to native behavior
    }
  }
  function unlock() {
    if (state.unlocked) return;
    state.unlocked = true;
    if (state.narrated) playSlideAudio(slideNumber());   // play current slide now we have a gesture
  }

  // ── mode toggle button (mirrors .deck-navtoggle in deck-controls.js) ──────
  function renderToggle() {
    var b = state.btn; if (!b) return;
    b.setAttribute('data-narrated', state.narrated ? 'true' : 'false');
    b.setAttribute('aria-pressed', state.narrated ? 'true' : 'false');
    b.setAttribute('data-tip',
      (state.narrated ? 'Narration on — switch to manual' : 'Narration off — play narrated') + ' · A');
  }
  function buildToggle() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'deck-modetoggle';
    b.setAttribute('aria-label', 'Toggle narration');
    b.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 9v6h4l5 4V5L8 9H4z"/>' +
      '<path class="wave" d="M16.5 8.5a5 5 0 0 1 0 7"/>' +
      '<path class="wave" d="M19 6a8.5 8.5 0 0 1 0 12"/>' +
      '<line class="slash" x1="3" y1="3" x2="21" y2="21"/>' +
      '</svg>';
    state.btn = b;
    renderToggle();
    function toggle() { unlock(); setMode(state.narrated ? 'manual' : 'narrated'); state.bump(); }
    b.addEventListener('click', toggle);
    document.body.appendChild(b);

    window.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'a' || e.key === 'A') { e.stopPropagation(); toggle(); }
    });

    var idleTimer;
    state.bump = function () {
      b.setAttribute('data-idle', 'false');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { b.setAttribute('data-idle', 'true'); }, IDLE_MS);
    };
    window.addEventListener('mousemove', state.bump, { passive: true });
    window.addEventListener('keydown', state.bump);
    state.bump();
  }

  // ── start overlay ─────────────────────────────────────────────────────────
  // The "SpatialTimber Intro" design (claude.ai/design): a full-bleed 1920×1080
  // canvas — generated isometric logomark, two mode cards, keyboard 1/2/Enter —
  // scaled to the viewport. The two cards drive the SAME setMode()/unlock() plumbing
  // the toggle uses; "Explore on my own" maps to manual mode. (No <a href> navigation:
  // this is an overlay on the live deck, not a separate page.)
  function markSVG() {                       // isometric stacked-timber mark, clay top slab
    var outerW = 3.8, innerW = 1.0, stroke = '#141413';
    var ink = { t: '#FBFAF6', l: '#D9D4C8', r: '#ECE8DD' };
    var clay = { t: '#D97757', l: '#B85A3C', r: '#CC6A49' };
    function slab(cy, f, cls) {
      var a = 25, b = 12, t = 6, cx = 50;
      var T = [cx, cy - b], R = [cx + a, cy], B = [cx, cy + b], L = [cx - a, cy];
      var R2 = [cx + a, cy + t], B2 = [cx, cy + b + t], L2 = [cx - a, cy + t];
      var j = function (p) { return p[0] + ' ' + p[1]; };
      var pts = function (arr) { return arr.map(function (p) { return p[0] + ',' + p[1]; }).join(' '); };
      var top = pts([T, R, B, L]), left = pts([L, B, B2, L2]), right = pts([B, R, R2, B2]);
      var innerY = 'M ' + j(L) + ' L ' + j(B) + ' M ' + j(R) + ' L ' + j(B) + ' M ' + j(B) + ' L ' + j(B2);
      var hex = 'M ' + j(T) + ' L ' + j(R) + ' L ' + j(R2) + ' L ' + j(B2) + ' L ' + j(L2) + ' L ' + j(L) + ' Z';
      return '<g class="' + cls + '" style="transform-box:view-box;transform-origin:center;">'
        + '<polygon points="' + top + '" fill="' + f.t + '"/>'
        + '<polygon points="' + left + '" fill="' + f.l + '"/>'
        + '<polygon points="' + right + '" fill="' + f.r + '"/>'
        + '<path d="' + innerY + '" fill="none" stroke="' + stroke + '" stroke-width="' + innerW + '" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="' + hex + '" fill="none" stroke="' + stroke + '" stroke-width="' + outerW + '" stroke-linejoin="round" stroke-linecap="round"/>'
        + '</g>';
    }
    var cys = [61, 47, 33], body = '';
    cys.forEach(function (cy, i) { body += slab(cy, i === 2 ? clay : ink, 'slab slab-' + i); });
    return '<svg viewBox="0 0 100 100" role="img" aria-label="SpatialTimber logomark"><title>SpatialTimber</title>' + body + '</svg>';
  }

  function buildOverlay() {
    var NARR_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="#D97757" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3.5L13 19V5L7.5 9H4z" fill="rgba(217,119,87,0.18)"></path><path d="M16.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 6a8.5 8.5 0 0 1 0 12"></path></svg>';
    var EXPL_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="#E7E3D9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5l13.5 6.2-5.6 1.9-1.9 5.6L5 3.5z"></path><path d="M13.2 13.2l5.3 5.3"></path></svg>';
    var ov = document.createElement('div');
    ov.className = 'st-narr-overlay';
    ov.setAttribute('data-hidden', 'false');
    ov.innerHTML = [
      '<div class="st-narr-canvas">',
      '  <div class="wrap">',
      '    <div class="identity anim a1">',
      '      <div class="mark" data-mark></div>',
      '      <div class="wordmark"><span class="s-spatial">Spatial</span><span class="s-timber">Timber</span></div>',
      '    </div>',
      '    <div class="eyebrow anim a2">Zukunft Bau Projekttage · 2026</div>',
      '    <h1 class="anim a2">How would you like to <span class="soft">view this presentation?</span></h1>',
      '    <div class="options">',
      '      <button type="button" class="opt primary anim a3" data-choice="narrated">',
      '        <div class="opt-head"><div class="icon">' + NARR_ICO + '</div><div class="key"><kbd>1</kbd></div></div>',
      '        <h2>Play narrated</h2>',
      '        <p>Sit back. Each slide plays with my voice-over, the animations build themselves, and the talk advances on its own — navigate any time to jump ahead.</p>',
      '        <div class="opt-cta"><span>Start the talk</span><span class="arrow">→</span></div>',
      '      </button>',
      '      <button type="button" class="opt anim a4" data-choice="manual">',
      '        <div class="opt-head"><div class="icon">' + EXPL_ICO + '</div><div class="key"><kbd>2</kbd></div></div>',
      '        <h2>Explore on my own</h2>',
      '        <p>Silent and fully interactive — step through the slides and their build-ups yourself, exactly like the live deck.</p>',
      '        <div class="opt-cta"><span>Open the deck</span><span class="arrow">→</span></div>',
      '      </button>',
      '    </div>',
      '    <div class="hint anim a5">Switch any time with the speaker button (bottom-left) or the <kbd>A</kbd> key.</div>',
      '  </div>',
      '  <div class="meta anim a6"><span>SpatialTimber</span><span>Gefördert durch Zukunft Bau</span></div>',
      '</div>'
    ].join('');
    document.body.appendChild(ov);

    var m = ov.querySelector('[data-mark]'); if (m) m.innerHTML = markSVG();

    // scale the 1920×1080 canvas to fit the viewport (mirrors the deck stage)
    var canvas = ov.querySelector('.st-narr-canvas');
    function fit() {
      var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      canvas.style.transform = 'scale(' + s + ')';
    }
    window.addEventListener('resize', fit); fit();
    requestAnimationFrame(function () { canvas.classList.add('play'); });   // entrance

    function teardown() {
      window.removeEventListener('resize', fit);
      window.removeEventListener('keydown', onKey, true);
    }
    function choose(mode) {
      if (mode === 'narrated') state.unlocked = true;   // this gesture unlocks audio
      setMode(mode);
      ov.setAttribute('data-hidden', 'true');
      teardown();
      later(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 500);
    }
    function onKey(e) {                       // 1/Enter → narrated, 2 → explore (manual)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '1' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose('narrated'); }
      else if (e.key === '2') { e.preventDefault(); e.stopPropagation(); choose('manual'); }
    }
    window.addEventListener('keydown', onKey, true);   // capture, so the deck never sees it first
    ov.querySelector('[data-choice="narrated"]').addEventListener('click', function () { choose('narrated'); });
    ov.querySelector('[data-choice="manual"]').addEventListener('click', function () { choose('manual'); });
  }

  // ── init ──────────────────────────────────────────────────────────────────
  function init() {
    state.audio = new Audio();
    state.audio.preload = 'auto';
    state.audio.addEventListener('ended', onAudioEnded);
    state.audio.addEventListener('timeupdate', onTimeUpdate);   // fire audio-synced build steps

    var url = window.__NARRATION_CONFIG_URL || '/__narration__/steps.config.json';
    fetch(url).then(function (r) { return r.json(); })
      .then(function (j) { state.config = j; })
      .catch(function () {})
      .then(function () {
        buildToggle();
        document.addEventListener('slidechange', onSlideChange);

        // Always greet with the mode-choice overlay on every (re)load, regardless
        // of any previously saved choice — Martin wants the menu on each refresh.
        // (setMode still persists the live choice in localStorage so the toggle
        // button keeps working within the session; we just don't honour it here.)
        buildOverlay();
      });
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
