/* KAM PDFs - find any command by typing what you want. Ctrl+K.
 *
 * An editor with this many abilities cannot show them all without becoming a wall of
 * buttons, and hiding them in menus means hunting. Typing "watermark" or "rotate" and
 * pressing Enter needs neither: you do not have to know where a thing lives to use it.
 */
'use strict';
const KamPalette = (() => {
  const el = $('#palette'), input = $('#paletteInput'), listEl = $('#paletteList');

  // Each command names the control it drives, so audit() can prove none of them points at
  // something that no longer exists after the layout changes.
  const byClick = sel => ({ run: () => { const b = $(sel); if (b) b.click(); }, target: sel });
  const byTool = t => ({ run: () => setTool(t), target: `#tools [data-tool="${t}"]` });
  const byReveal = (where, focus) => ({ run: () => KamUX.reveal(where, focus), target: focus || null });
  const cmd = (group, icon, label, keys, how, extra = {}) => Object.assign({ group, icon, label, keys }, how, extra);
  const DOC = { doc: true };

  const COMMANDS = [
    cmd('File', 'folder', 'Open a PDF', 'file load browse', byClick('#btnOpen'), { kbd: 'Ctrl+O' }),
    cmd('File', 'plus', 'New blank document', 'create empty page start', byClick('#btnNew')),
    cmd('File', 'merge', 'Combine with other PDFs', 'merge join append add pdf', byClick('#btnMerge'), DOC),
    cmd('File', 'image', 'Add images as pages', 'photos pictures jpg png convert import', byClick('#btnAddImages')),
    cmd('File', 'camera', 'Scan with your phone or webcam', 'camera scanner photo qr', byClick('#btnScan')),
    cmd('File', 'download', 'Save the PDF', 'download export write keep', byClick('#btnSave'), { kbd: 'Ctrl+S', doc: true }),
    cmd('File', 'download', 'Save as a new file', 'copy rename export', byClick('#btnSaveAs'), { kbd: 'Ctrl+Shift+S', doc: true }),
    cmd('File', 'print', 'Print', 'paper printer', byClick('#btnPrint'), { kbd: 'Ctrl+P', doc: true }),
    cmd('File', 'image', 'Export this page as a PNG image', 'picture screenshot jpg convert', byClick('#btnPng'), DOC),
    cmd('File', 'undo', 'Restore last session', 'recover crash autosave working copy', byClick('#btnRestoreEmpty'),
      { when: () => { const b = $('#btnRestoreEmpty'); return !!b && !b.hidden; } }),

    cmd('Edit', 'undo', 'Undo', 'back revert', { run: () => undo(), target: '#btnUndo' }, { kbd: 'Ctrl+Z', doc: true }),
    cmd('Edit', 'redo', 'Redo', 'forward again', { run: () => redo(), target: '#btnRedo' }, { kbd: 'Ctrl+Y', doc: true }),
    cmd('Edit', 'find', 'Find text in the document', 'search look locate word', byClick('#btnFind'), { kbd: 'Ctrl+F', doc: true }),
    cmd('Edit', 'text', 'Edit text that is already in the PDF', 'change modify rewrite typo fix words existing',
      { run: () => { setTool('select'); toast('Double-click any line of text in the PDF to edit it.', 4000); }, target: '#tools [data-tool="select"]' }, DOC),

    cmd('Tool', 'cursor', 'Select and move', 'pick choose arrow pointer', byTool('select'), { kbd: 'V', doc: true }),
    cmd('Tool', 'text', 'Add text', 'type write words label note', byTool('text'), { kbd: 'T', doc: true }),
    cmd('Tool', 'pen', 'Draw freehand', 'pen ink scribble sketch', byTool('pen'), { kbd: 'P', doc: true }),
    cmd('Tool', 'highlight', 'Highlight', 'marker yellow emphasise', byTool('highlight'), { kbd: 'H', doc: true }),
    cmd('Tool', 'rect', 'Rectangle', 'box square shape outline', byTool('rect'), { kbd: 'R', doc: true }),
    cmd('Tool', 'ellipse', 'Ellipse', 'circle oval round shape', byTool('ellipse'), { kbd: 'E', doc: true }),
    cmd('Tool', 'line', 'Line', 'stroke rule shape', byTool('line'), { kbd: 'L', doc: true }),
    cmd('Tool', 'arrow', 'Arrow', 'pointer point shape', byTool('arrow'), { kbd: 'A', doc: true }),
    cmd('Tool', 'whiteout', 'Whiteout', 'cover hide white erase paint over tippex', byTool('whiteout'), { kbd: 'W', doc: true }),
    cmd('Tool', 'redact', 'Redact', 'black out remove censor permanently hide private', byTool('redact'), { kbd: 'X', doc: true }),
    cmd('Tool', 'image', 'Insert an image', 'picture photo logo stamp', byClick('#btnImage'), DOC),
    cmd('Tool', 'sign', 'Add a signature', 'sign autograph initial', byClick('#btnSign'), DOC),

    cmd('Page', 'rot-left', 'Rotate page left', 'turn anticlockwise counterclockwise', byClick('.side-actions [data-act="rotL"]'), DOC),
    cmd('Page', 'rot-right', 'Rotate page right', 'turn clockwise', byClick('.side-actions [data-act="rotR"]'), DOC),
    cmd('Page', 'duplicate', 'Duplicate page', 'copy clone', byClick('.side-actions [data-act="dup"]'), DOC),
    cmd('Page', 'plus', 'Insert a blank page', 'add new empty', byClick('.side-actions [data-act="blank"]'), DOC),
    cmd('Page', 'trash', 'Delete page', 'remove', byClick('.side-actions [data-act="del"]'), DOC),
    cmd('Page', 'extract', 'Extract pages to a new PDF', 'split save separate pull out range', byReveal('export', '#extractRange'), DOC),
    cmd('Page', 'next', 'Next page', 'forward', { run: () => goTo(state.cur + 1), target: '#btnNext' }, DOC),
    cmd('Page', 'prev', 'Previous page', 'back', { run: () => goTo(state.cur - 1), target: '#btnPrev' }, DOC),

    cmd('Document', 'stamp', 'Add a watermark', 'confidential draft stamp text every page', byReveal('stamp', '#wmText'), DOC),
    cmd('Document', 'stamp', 'Add page numbers', 'numbering footer header every page', byReveal('stamp', '#pnFormat'), DOC),
    cmd('Document', 'find', 'Make a scanned page searchable', 'ocr recognise read text scan copy', byReveal('ocr', '#btnOcrPage'), DOC),
    cmd('Document', 'text', 'Check spelling', 'spell typos mistakes', byClick('#btnSpell'), DOC),
    cmd('Document', 'text', 'Copy out the text of this page', 'extract plain words', byClick('#btnExtractText'), DOC),
    cmd('Document', 'info', 'Edit title, author and keywords', 'metadata properties info details', byReveal('details', '#mTitle'), DOC),
    cmd('Document', 'download', 'Flatten form fields', 'lock fields non-editable', byReveal('export', '#flattenForm'), DOC),
    cmd('Document', 'text', 'Fill in form fields', 'form fields fill checkbox dropdown', byReveal('form'), DOC),
    cmd('Document', 'duplicate', 'Show layers', 'marks annotations stack order buried', byReveal('layers'), DOC),

    cmd('View', 'plus', 'Zoom in', 'bigger larger magnify', byClick('#btnZoomIn'), DOC),
    cmd('View', 'minus', 'Zoom out', 'smaller', byClick('#btnZoomOut'), DOC),
    cmd('View', 'fit-width', 'Fit page width', 'zoom wide', byClick('#btnFit'), DOC),
    cmd('View', 'fit-page', 'Fit whole page', 'zoom all', byClick('#btnFitPage'), DOC),
    cmd('View', 'sun', 'Switch light or dark mode', 'theme night day colour color', byClick('#btnTheme')),
    cmd('View', 'prev', 'Show or hide the pages panel', 'sidebar thumbnails left',
      { run: () => KamPanels.toggle('sidebar'), target: '#split-sidebar' }, DOC),
    cmd('View', 'next', 'Show or hide the side panel', 'document panel right',
      { run: () => KamPanels.toggle('rightpanel'), target: '#split-rightpanel' }, DOC),
    cmd('View', 'fit-page', 'Move the tools above or below the page', 'toolbar dock bottom top',
      { run: () => KamPanels.setDock(KamPanels.dock() === 'bottom' ? 'top' : 'bottom'), target: '#toolbarGrip' }, DOC),
    cmd('View', 'settings', 'Reset layout', 'panels default restore sizes', byClick('#btnResetLayout')),

    cmd('Help', 'settings', 'Turn the automatic working copy on or off', 'autosave backup crash recover', byReveal('settings', '#autosaveOn')),
    cmd('Help', 'app', 'Check for updates', 'new version upgrade latest', byClick('#btnUpdate')),
    cmd('Help', 'keyboard', 'Keyboard shortcuts and help', 'help shortcuts keys how guide tips', byReveal('help')),
  ];

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const html = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Every word typed has to appear somewhere; a word the label starts with counts for most.
  function score(c, q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 1;
    const label = c.label.toLowerCase(), hay = `${label} ${c.keys} ${c.group}`.toLowerCase();
    let s = 0;
    for (const w of words) {
      const start = new RegExp('\\b' + esc(w));
      if (label.startsWith(w)) s += 30;
      else if (start.test(label)) s += 20;
      else if (label.includes(w)) s += 12;
      else if (start.test(hay)) s += 8;
      else if (hay.includes(w)) s += 4;
      else return 0;
    }
    return s;
  }

  let shown = [], active = 0, lastFocus = null;
  const usable = c => !c.doc || !!state.doc;

  function results(q) {
    return COMMANDS
      .filter(c => !c.when || c.when())
      .map((c, i) => ({ c, s: score(c, q), i }))
      .filter(r => r.s > 0)
      .sort((a, b) => (b.s - a.s) || (usable(b.c) - usable(a.c)) || (a.i - b.i))
      .map(r => r.c);
  }

  function render() {
    const q = input.value.trim();
    shown = results(q).slice(0, 60);
    if (active >= shown.length) active = Math.max(0, shown.length - 1);
    if (!shown.length) {
      listEl.innerHTML = `<div class="pal-empty">Nothing matches "${html(q)}". Try one simple word, like <b>rotate</b> or <b>sign</b>.</div>`;
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    listEl.innerHTML = shown.map((c, i) => `
      <div class="pal-item${i === active ? ' on' : ''}" role="option" id="pal-${i}" data-i="${i}"
           aria-selected="${i === active}" aria-disabled="${!usable(c)}">
        <svg class="ic" aria-hidden="true"><use href="#i-${c.icon}"/></svg>
        <span class="pal-label">${html(c.label)}</span>${usable(c) ? '' : '<span class="pal-note">open a PDF first</span>'}
        <span class="pal-group">${c.group}</span>
        ${c.kbd ? `<kbd>${html(c.kbd)}</kbd>` : ''}
      </div>`).join('');
    input.setAttribute('aria-activedescendant', 'pal-' + active);
  }
  function setActive(i) {
    if (!shown.length) return;
    active = (i + shown.length) % shown.length;
    listEl.querySelectorAll('.pal-item').forEach((row, k) => {
      row.classList.toggle('on', k === active);
      row.setAttribute('aria-selected', String(k === active));
    });
    input.setAttribute('aria-activedescendant', 'pal-' + active);
    const row = listEl.querySelector(`[data-i="${active}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function runAt(i) {
    const c = shown[i]; if (!c) return;
    if (!usable(c)) { toast('Open a PDF first, then try that again.', 3500); return; }
    close(false);
    setTimeout(() => c.run(), 0);
  }

  function open(prefill = '') {
    if (!el.hidden) return;
    lastFocus = document.activeElement;
    if (typeof commitTextEdit === 'function') commitTextEdit();
    KamUX.closeMenu();
    el.hidden = false;
    input.value = prefill; active = 0;
    render();
    input.focus();
  }
  function close(restoreFocus = true) {
    if (el.hidden) return;
    el.hidden = true;
    if (restoreFocus && lastFocus && lastFocus.focus) lastFocus.focus();
  }

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(active); }
  });
  listEl.addEventListener('pointermove', e => {
    const row = e.target.closest('.pal-item'); if (row && +row.dataset.i !== active) setActive(+row.dataset.i);
  });
  listEl.addEventListener('click', e => { const row = e.target.closest('.pal-item'); if (row) runAt(+row.dataset.i); });
  el.addEventListener('pointerdown', e => { if (e.target === el) close(); });

  // Captured, so Ctrl+K works from inside a text box too, and Escape closes this before the
  // page's own Escape handling can switch tools underneath it.
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (el.hidden) open(); else close();
      return;
    }
    if (!el.hidden && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, true);
  const btn = $('#btnCommand'); if (btn) btn.onclick = () => open();

  // The labels of any commands whose control is missing. Empty means every one still works.
  function audit() {
    return COMMANDS.filter(c => c.target && !document.querySelector(c.target)).map(c => c.label);
  }
  return { open, close, audit, results: q => results(q).map(c => c.label), COMMANDS };
})();
