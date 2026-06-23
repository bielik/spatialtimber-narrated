/* SpatialTimber deck — navigator (thumbnail rail) collapse control.
 *
 * The Claude Design standalone export ships the rail's show/hide machinery but
 * NOT the control that drives it (that toggle lived in the design host's Tweaks
 * panel). On the published site there was therefore no way to collapse the
 * left navigator. This adds a small toggle button + "N" keyboard shortcut that
 * uses the deck's OWN public message contract — postMessage {type:
 * '__deck_rail_visible', on} — so the collapse animates, persists to
 * localStorage, and re-fits the stage exactly like the host's toggle did.
 *
 * Purpose: let the presenter hide the navigator during a talk. The button itself
 * mirrors the deck's chrome and fades out when the mouse is idle, so it doesn't
 * sit on screen in front of an audience.
 *
 * Injected into index.html by build.mjs (a discrete, idempotent processing
 * step) — it is NOT part of the vendored deck and survives every re-fetch.
 */
(function () {
  'use strict';
  var LS_KEY = 'deck-stage.railVisible';
  var IDLE_MS = 2600;

  function deck() { return document.querySelector('deck-stage'); }

  // Authoritative state: the live deck instance if upgraded, else the persisted
  // preference (default = visible). '0' is the only value that means hidden.
  function railVisible() {
    var d = deck();
    if (d && typeof d._railVisible === 'boolean') return d._railVisible;
    try { return localStorage.getItem(LS_KEY) !== '0'; } catch (e) { return true; }
  }

  // Drive the deck's own toggle path (sets _railVisible, persists, animates, refits).
  function setRail(on) {
    window.postMessage({ type: '__deck_rail_visible', on: !!on }, '*');
  }

  // ── Scheme-SVG nav bridge ─────────────────────────────────────────────
  // The click-driven scheme SVGs (slides with an <object> embed) build step by
  // step on click / →. So the presenter can also drive them from the keyboard,
  // and so → only leaves the slide once the scheme is fully built, we:
  //   (a) expose __deckNext/__deckPrev for an embedded SVG to call when done, and
  //   (b) intercept →/Space/PageDown in the CAPTURE phase (before the deck's own
  //       key handler): if the current slide holds a not-yet-built scheme,
  //       advance the scheme instead of the deck.
  // Left/Page-Up, and a fully-built scheme, fall through to the deck's normal nav.
  window.__deckNext = function () { var d = deck(); if (d) d._advance(1, 'api'); };
  window.__deckPrev = function () { var d = deck(); if (d) d._advance(-1, 'api'); };

  // The scheme API (window.__scheme) of the <object> on the current slide, if any.
  function currentScheme() {
    var d = deck();
    var sec = (d && d._slides && typeof d._index === 'number') ? d._slides[d._index] : null;
    if (!sec) sec = document.querySelector('[data-deck-active]');
    if (!sec) return null;
    var obj = sec.querySelector('object[type="image/svg+xml"]');
    if (!obj) return null;
    try { var w = obj.contentWindow; return (w && w.__scheme) ? w.__scheme : null; } catch (e) { return null; }
  }

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var k = e.key;
    if (k !== 'ArrowRight' && k !== 'PageDown' && k !== ' ' && k !== 'Spacebar') return;
    var s = currentScheme();
    if (s && !s.built() && s.forward()) {   // built the scheme -> swallow, don't change slide
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);   // capture: run before the deck's own keydown handler

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var style = document.createElement('style');
    style.textContent = [
      '.deck-navtoggle{position:fixed;left:14px;bottom:14px;z-index:2147483600;',
      'width:40px;height:40px;display:flex;align-items:center;justify-content:center;',
      'border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(20,20,19,.72);',
      'color:#f5f3ee;cursor:pointer;padding:0;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);',
      'box-shadow:0 2px 10px rgba(0,0,0,.28);',
      'transition:opacity .35s ease,background .15s ease,border-color .15s ease,transform .1s ease;}',
      '.deck-navtoggle:hover{background:rgba(42,42,40,.94);border-color:rgba(255,255,255,.32);}',
      '.deck-navtoggle:active{transform:scale(.93);}',
      '.deck-navtoggle:focus-visible{outline:2px solid #D97757;outline-offset:2px;}',
      '.deck-navtoggle svg{width:20px;height:20px;display:block;}',
      '.deck-navtoggle .bar{transition:opacity .2s ease;}',
      '.deck-navtoggle[data-collapsed="true"] .bar{opacity:.32;}',
      '.deck-navtoggle[data-idle="true"]{opacity:0;pointer-events:none;}',
      '.deck-navtoggle[data-idle="false"]{opacity:.9;}',
      '.deck-navtoggle::after{content:attr(data-tip);position:absolute;left:48px;bottom:50%;',
      'transform:translateY(50%);white-space:nowrap;font:500 12px/1 ui-sans-serif,system-ui,sans-serif;',
      'letter-spacing:.02em;color:#f5f3ee;background:rgba(20,20,19,.94);padding:6px 9px;border-radius:7px;',
      'opacity:0;transition:opacity .15s ease;pointer-events:none;}',
      '.deck-navtoggle:hover::after{opacity:1;}',
      '@media print{.deck-navtoggle{display:none!important;}}'
    ].join('');
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'deck-navtoggle';
    btn.setAttribute('aria-label', 'Toggle slide navigator');

    function render() {
      var collapsed = !railVisible();
      btn.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
      btn.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
      btn.setAttribute('data-tip', (collapsed ? 'Show navigator' : 'Hide navigator') + ' · N');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
        '<line class="bar" x1="9" y1="4" x2="9" y2="20"/>' +
        '<line class="bar" x1="5.4" y1="8" x2="6.6" y2="8"/>' +
        '<line class="bar" x1="5.4" y1="12" x2="6.6" y2="12"/>' +
        '<line class="bar" x1="5.4" y1="16" x2="6.6" y2="16"/>' +
        '</svg>';
    }
    render();

    function toggle() { setRail(!railVisible()); setTimeout(render, 12); bump(); }
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);

    window.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'n' || e.key === 'N') { e.stopPropagation(); toggle(); }
    });

    // Idle fade — mirror the deck's own auto-hiding chrome so the control
    // disappears from an audience's view when the presenter stops moving.
    var idleTimer;
    function bump() {
      btn.setAttribute('data-idle', 'false');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { btn.setAttribute('data-idle', 'true'); }, IDLE_MS);
    }
    window.addEventListener('mousemove', bump, { passive: true });
    window.addEventListener('keydown', bump);
    bump();

    // Stay in sync if rail state changes by any path (persisted load, etc.).
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.type === '__deck_rail_visible') setTimeout(render, 12);
    });
  });
})();
