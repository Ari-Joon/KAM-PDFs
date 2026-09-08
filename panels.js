/* KAM PDFs - panels you can move.
 *
 * The two side panels can be dragged to any width, collapsed out of the way, and restored,
 * and the tool row can sit above or below the page. Sizes are remembered on this computer.
 *
 * Everything here is also reachable from the keyboard: the dividers are real separators, so
 * they take focus and answer to the arrow keys. A divider you can only drag is a divider a
 * lot of people cannot use.
 */
'use strict';
const KamPanels = (() => {
  const BARS = {
    sidebar: { el: null, side: 'left', min: 150, max: 460, def: 200, key: 'kam-w-sidebar' },
    rightpanel: { el: null, side: 'right', min: 210, max: 560, def: 270, key: 'kam-w-rightpanel' },
  };
  const COLLAPSE_AT = 34;      // drag this far past the minimum and the panel folds away
  const read = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };

  function apply(name, px, collapsed) {
    const b = BARS[name]; if (!b.el) return;
    b.el.classList.toggle('collapsed', !!collapsed);
    // The width lives in a custom property that the stylesheet reads, rather than an inline
    // width on the panel. A flex child carries its own sizing rules, and setting one from
    // both sides is how you end up with a divider that moves the number but not the panel.
    document.documentElement.style.setProperty('--w-' + name, (collapsed ? 0 : px) + 'px');
    const sp = document.getElementById('split-' + name);
    if (sp) {
      sp.classList.toggle('collapsed', !!collapsed);
      sp.setAttribute('aria-valuenow', collapsed ? 0 : Math.round(px));
      sp.title = collapsed ? 'Drag out, or double-click, to bring the panel back'
        : 'Drag to resize · double-click to reset · arrow keys also work';
    }
    refit();
  }
  // Re-rendering the page on every pointermove would make dragging stutter on a big document,
  // so a fit-to-width page catches up a moment after the divider stops moving.
  let refitTimer = null;
  function refit() {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      if (typeof state !== 'undefined' && state.fit && typeof renderPage === 'function') renderPage();
    }, 120);
  }
  function get(name) {
    const b = BARS[name];
    const raw = read(b.key);
    if (raw === 'collapsed') return { px: b.def, collapsed: true };
    const n = parseInt(raw, 10);
    return { px: (n >= b.min && n <= b.max) ? n : b.def, collapsed: false };
  }
  function set(name, px, collapsed) {
    const b = BARS[name];
    px = Math.min(b.max, Math.max(b.min, Math.round(px)));
    write(b.key, collapsed ? 'collapsed' : String(px));
    apply(name, px, collapsed);
  }
  function toggle(name) {
    const s = get(name);
    set(name, s.px, !s.collapsed);
  }

  function wire(name) {
    const b = BARS[name];
    b.el = document.getElementById(name);
    const sp = document.getElementById('split-' + name);
    if (!b.el || !sp) return;
    const s = get(name); apply(name, s.px, s.collapsed);

    let dragging = false, startX = 0, startW = 0;
    const widthAt = x => (b.side === 'left' ? startW + (x - startX) : startW - (x - startX));

    sp.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      dragging = true; startX = e.clientX;
      startW = get(name).collapsed ? 0 : b.el.getBoundingClientRect().width;
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('dragging');
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    sp.addEventListener('pointermove', e => {
      if (!dragging) return;
      const w = widthAt(e.clientX);
      if (w < b.min - COLLAPSE_AT) { apply(name, b.min, true); return; }
      apply(name, Math.min(b.max, Math.max(b.min, w)), false);
    });
    const stop = e => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove('dragging');
      document.body.classList.remove('resizing');
      try { sp.releasePointerCapture(e.pointerId); } catch (err) { }
      const w = widthAt(e.clientX);
      if (w < b.min - COLLAPSE_AT) set(name, get(name).px, true);
      else set(name, w, false);
      if (typeof renderThumbs === 'function' && name === 'sidebar') renderThumbs();
    };
    sp.addEventListener('pointerup', stop);
    sp.addEventListener('pointercancel', stop);

    // Double-click means "put it back how it was", which is what people expect of a divider.
    sp.addEventListener('dblclick', () => {
      const cur = get(name);
      if (cur.collapsed) set(name, cur.px, false);
      else set(name, b.def, false);
    });

    sp.addEventListener('keydown', e => {
      const cur = get(name);
      const step = e.shiftKey ? 48 : 16;
      const grow = b.side === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = b.side === 'left' ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === grow) { set(name, (cur.collapsed ? b.min : cur.px + step), false); }
      else if (e.key === shrink) {
        if (cur.collapsed) return;
        if (cur.px - step < b.min) set(name, cur.px, true); else set(name, cur.px - step, false);
      } else if (e.key === 'Home') { set(name, b.def, false); }
      else if (e.key === 'Enter' || e.key === ' ') { toggle(name); }
      else return;
      e.preventDefault();
    });
  }

  /* ---------- the tool row, above or below the page ---------- */
  function applyDock(where) {
    const v = document.getElementById('viewer');
    if (v) v.classList.toggle('dock-bottom', where === 'bottom');
    const h = document.getElementById('toolbarGrip');
    if (h) h.title = 'Drag to put the tools ' + (where === 'bottom' ? 'above' : 'below') + ' the page';
  }
  function dock() { return read('kam-toolbar-dock') === 'bottom' ? 'bottom' : 'top'; }
  function setDock(where) { write('kam-toolbar-dock', where); applyDock(where); }

  function wireDock() {
    const grip = document.getElementById('toolbarGrip');
    const viewer = document.getElementById('viewer');
    if (!grip || !viewer) return;
    applyDock(dock());
    let dragging = false;
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      dragging = true; grip.setPointerCapture(e.pointerId);
      viewer.classList.add('docking'); e.preventDefault();
    });
    grip.addEventListener('pointermove', e => {
      if (!dragging) return;
      const r = viewer.getBoundingClientRect();
      const bottom = e.clientY > r.top + r.height / 2;
      viewer.classList.toggle('drop-bottom', bottom);
      viewer.classList.toggle('drop-top', !bottom);
    });
    const stop = e => {
      if (!dragging) return;
      dragging = false;
      try { grip.releasePointerCapture(e.pointerId); } catch (err) { }
      const r = viewer.getBoundingClientRect();
      const where = e.clientY > r.top + r.height / 2 ? 'bottom' : 'top';
      viewer.classList.remove('docking', 'drop-bottom', 'drop-top');
      if (where !== dock()) { setDock(where); toast('Tools moved ' + (where === 'bottom' ? 'below' : 'above') + ' the page.'); }
    };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
    grip.addEventListener('dblclick', () => setDock(dock() === 'bottom' ? 'top' : 'bottom'));
  }

  function reset() {
    for (const name of Object.keys(BARS)) set(name, BARS[name].def, false);
    setDock('top');
    toast('Layout put back to how it started.');
  }

  function init() {
    Object.keys(BARS).forEach(wire);
    wireDock();
    const r = document.getElementById('btnResetLayout');
    if (r) r.onclick = reset;
    document.querySelectorAll('[data-collapse]').forEach(btn => {
      btn.onclick = () => toggle(btn.getAttribute('data-collapse'));
    });
  }
  return { init, set, get, toggle, reset, dock, setDock, BARS };
})();
KamPanels.init();
