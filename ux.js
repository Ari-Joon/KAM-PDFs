/* KAM PDFs - keeping it calm to use.
 *
 * Nothing here adds an ability. It decides what is on screen and when: with no document open
 * you see only the things you can actually do, rarely used actions live one click away in a
 * menu instead of all at once, and the long list of document options folds into sections.
 * The app used to show every control it had, all the time, which is what made it feel like
 * work before you had done anything.
 */
'use strict';
const KamUX = (() => {
  const read = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };

  /* ---------- state the screen depends on ----------
     state.doc, state.dirty and state.fileName are plain fields assigned from half a dozen
     files. Watching the fields themselves keeps the Save dot, the window title and the
     no-document screen honest, without having to remember to call something at each place. */
  function watch(key, onChange) {
    let v = state[key];
    Object.defineProperty(state, key, {
      configurable: true, enumerable: true,
      get: () => v,
      set: x => { const was = v; v = x; if (was !== x) onChange(); },
    });
  }

  function syncDoc() {
    const has = !!state.doc;
    document.body.classList.toggle('no-doc', !has);
    $$('[data-needs-doc]').forEach(b => { b.disabled = !has; });
    syncTitle();
  }
  function syncTitle() {
    const dirty = !!(state.doc && state.dirty);
    const save = $('#btnSave');
    if (save) {
      save.classList.toggle('dirty', dirty);
      save.title = dirty ? 'You have unsaved changes. Save the PDF (Ctrl+S)' : 'Save the PDF (Ctrl+S)';
    }
    document.title = state.doc ? `${dirty ? '• ' : ''}${state.fileName} - KAM PDFs` : 'KAM PDFs';
  }

  /* ---------- menus ---------- */
  let current = null;
  const items = menu => [...menu.querySelectorAll('button')].filter(b => !b.disabled && !b.hidden);
  function closeMenu() {
    if (!current) return;
    current.menu.hidden = true;
    current.trigger.setAttribute('aria-expanded', 'false');
    current.trigger.classList.remove('open');
    current = null;
  }
  function openMenu(trigger, menu, focusFirst) {
    if (current && current.menu === menu) { closeMenu(); return; }
    closeMenu();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('open');
    current = { trigger, menu };
    if (focusFirst) { const first = items(menu)[0]; if (first) first.focus(); }
  }
  function wireMenu(trigger, menu) {
    // a click from the keyboard has detail 0, and should land focus inside the menu
    trigger.addEventListener('click', e => { e.stopPropagation(); openMenu(trigger, menu, e.detail === 0); });
    trigger.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!current || current.menu !== menu) openMenu(trigger, menu, true); }
    });
    menu.addEventListener('click', e => { if (e.target.closest('button')) closeMenu(); });
    menu.addEventListener('keydown', e => {
      const list = items(menu), i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
      else if (e.key === 'Tab') closeMenu();
    });
  }
  document.addEventListener('pointerdown', e => {
    if (current && !current.menu.contains(e.target) && !current.trigger.contains(e.target)) closeMenu();
  });
  // Escape closes the menu and stops there. Without stopping it, the same key press would also
  // reach the page's own Escape handling and quietly switch you back to the Select tool.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !current) return;
    const trigger = current.trigger;
    e.preventDefault(); e.stopImmediatePropagation();
    closeMenu(); trigger.focus();
  }, true);

  /* ---------- shapes share one button ---------- */
  const SHAPES = { rect: 'i-rect', ellipse: 'i-ellipse', line: 'i-line', arrow: 'i-arrow' };
  let lastShape = SHAPES[read('kam-last-shape')] ? read('kam-last-shape') : null;
  function syncShapes(tool) {
    const btn = $('#btnShapes'); if (!btn) return;
    const on = !!SHAPES[tool];
    if (on && tool !== lastShape) { lastShape = tool; write('kam-last-shape', tool); }
    btn.classList.toggle('active', on);
    // the button wears the last shape you used, so the one you want is recognisable at a glance
    const use = $('#shapesIcon use');
    if (use) use.setAttribute('href', '#' + (lastShape ? SHAPES[lastShape] : 'i-shapes'));
  }
  document.addEventListener('kam:tool', e => syncShapes(e.detail));

  /* ---------- document options fold into sections ---------- */
  function wireSections() {
    $$('details.sec').forEach(d => {
      const key = 'kam-sec-' + d.dataset.sec, saved = read(key);
      if (saved !== null) d.open = saved === '1';
      d.addEventListener('toggle', () => write(key, d.open ? '1' : '0'));
    });
  }
  function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

  // Bring a part of the side panel into view, open, and ready to type in. Used by the command
  // search, so asking for "watermark" lands you on the watermark box rather than near it.
  function reveal(where, focusSel) {
    if (!state.doc) document.body.classList.add('show-panel');
    if (typeof KamPanels !== 'undefined' && KamPanels.get('rightpanel').collapsed) KamPanels.toggle('rightpanel');
    const tab = ['layers', 'form', 'help'].includes(where) ? where : 'doc';
    const tb = $(`.tabs button[data-tab="${tab}"]`); if (tb) tb.click();
    const sec = tab === 'doc' ? $(`details.sec[data-sec="${where}"]`) : null;
    if (sec) { sec.open = true; sec.scrollIntoView({ block: 'nearest' }); flash(sec); }
    if (focusSel) {
      const f = $(focusSel);
      if (f) setTimeout(() => { f.focus(); if (f.select && f.type !== 'checkbox') f.select(); }, 40);
    }
  }

  /* ---------- the welcome screen ---------- */
  function wireWelcome() {
    const combine = $('#taskCombine'), input = $('#taskCombineInput');
    if (combine && input) {
      combine.onclick = () => input.click();
      input.addEventListener('change', async () => {
        const files = [...input.files]; input.value = '';
        if (!files.length) return;
        await handleDroppedFiles(files);
        if (files.length > 1 && state.doc) toast(`Combined ${files.length} PDFs into one. Save when you are ready.`, 4500);
      });
    }
    const imgs = $('#taskImages'); if (imgs) imgs.onclick = () => $('#imgInput').click();
    const help = $('#btnHelpEmpty');
    if (help) help.onclick = () => {
      const showing = document.body.classList.toggle('show-panel');
      if (showing) reveal('help');
    };
  }

  /* ---------- one tip, once ---------- */
  function maybeCoach() {
    if (read('kam-coach-seen')) return;
    const c = $('#coach'); if (!c || !c.hidden) return;
    c.hidden = false;
    $('#coachClose').onclick = () => { c.hidden = true; write('kam-coach-seen', '1'); };
  }

  function init() {
    watch('doc', () => { syncDoc(); if (state.doc) maybeCoach(); });
    watch('dirty', syncTitle);
    watch('fileName', syncTitle);
    syncDoc();
    const f = $('#btnFile'), fm = $('#fileMenu'); if (f && fm) wireMenu(f, fm);
    const s = $('#btnShapes'), sm = $('#shapeMenu'); if (s && sm) wireMenu(s, sm);
    syncShapes(state.tool);
    wireSections();
    wireWelcome();
    // the status bar has room for one line of tip; hovering it shows the rest
    const hint = $('#hint');
    if (hint) new MutationObserver(() => { hint.title = hint.textContent; })
      .observe(hint, { childList: true, characterData: true, subtree: true });
  }
  init();
  return { reveal, closeMenu, syncDoc };
})();
