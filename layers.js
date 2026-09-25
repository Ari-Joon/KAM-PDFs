/* KAM PDFs - the Layers panel: everything you have added to this page, newest on top.
   Marks pile up quickly once you start covering and retyping things, and without a list
   there is no way to tell what is under what, or to reach something buried. */
'use strict';
(() => {
  const listEl = $('#layerList');
  let signature = '';

  const quote = (t, n) => { t = (t || '').replace(/\s+/g, ' ').trim(); return `"${t.slice(0, n)}${t.length > n ? '…' : ''}"`; };
  function describe(a) {
    if (a.type === 'textedit') {
      const was = a.src ? a.src.text : '';
      return a.text ? { kind: 'Edited', detail: `${quote(was, 16)} → ${quote(a.text, 16)}` } : { kind: 'Deleted text', detail: quote(was, 26) };
    }
    if (a.type === 'text') {
      const t = (a.text || '').replace(/\s+/g, ' ').trim();
      return { kind: 'Text', detail: t ? `"${t.slice(0, 28)}${t.length > 28 ? '…' : ''}"` : '(empty)' };
    }
    if (a.type === 'image') return { kind: 'Image', detail: `${Math.round(a.w)} × ${Math.round(a.h)}` };
    if (a.pts) return { kind: a.type === 'pen' ? 'Pen' : a.type === 'arrow' ? 'Arrow' : 'Line', detail: `${a.pts.length} points` };
    if (a.type === 'ellipse') return { kind: 'Ellipse', detail: `${Math.round(a.w)} × ${Math.round(a.h)}` };
    if (a.redact) {
      const t = (a.note || '').replace(/\s+/g, ' ').trim();
      return { kind: 'Deleted', detail: t ? `"${t.slice(0, 26)}${t.length > 26 ? '…' : ''}"` : 'removed from the file' };
    }
    if (a.blend === 'multiply') return { kind: 'Highlight', detail: a.fill };
    if (!a.stroke && a.fill) return { kind: 'Cover', detail: a.fill === '#ffffff' ? 'white' : a.fill };
    return { kind: 'Rectangle', detail: `${Math.round(a.w)} × ${Math.round(a.h)}` };
  }

  const swatch = a => {
    const c = a.type === 'textedit' ? '#3b82f6' : a.redact ? '#000000' : a.type === 'text' ? a.color : (a.fill || a.stroke || a.color || '#888888');
    return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#888888';
  };
  // the same drawn icons as the rest of the app, rather than glyphs that render differently everywhere
  const icon = n => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;

  function sig() {
    if (!state.pageIds.length) return 'empty';
    const list = state.annots[state.pageIds[state.cur]] || [];
    return state.cur + '|' + list.map(a => `${a.id}:${a.hidden ? 'h' : 'v'}:${(a.text || '').length}:${(a.text || '').slice(0, 40)}`).join(',')
      + '|' + (state.selected ? state.selected.id : '-');
  }

  function render(force) {
    if (!listEl) return;
    const s = sig();
    if (!force && s === signature) return;
    signature = s;
    const list = state.pageIds.length ? (state.annots[state.pageIds[state.cur]] || []) : [];
    listEl.innerHTML = '';
    if (!list.length) {
      listEl.innerHTML = '<div class="muted">Nothing added to this page yet. Anything you draw, type, cover or redact appears here, newest first.</div>';
      return;
    }
    // newest on top, matching what you see on the page
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i], d = describe(a);
      const row = document.createElement('div');
      row.className = 'layer' + (state.selected === a ? ' on' : '') + (a.hidden ? ' off' : '');
      row.draggable = true;
      row.dataset.i = i;
      row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('dropinto'); });
      row.addEventListener('dragleave', () => row.classList.remove('dropinto'));
      row.addEventListener('drop', e => {
        e.preventDefault(); row.classList.remove('dropinto');
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (isNaN(from) || from === i) return;
        commitTextEdit();
        pushAnnotUndo(state.pageIds[state.cur]);
        const [moved] = list.splice(from, 1);
        list.splice(i, 0, moved);
        updateProps(); drawOverlay(); refreshThumb(state.cur); render(true);
      });
      // Built from text nodes, never HTML: the label quotes text that can come straight out of
      // the PDF, and a PDF must never be able to put markup (or script) into the app.
      const dot = document.createElement('span'); dot.className = 'layer-dot'; dot.style.background = swatch(a);
      const name = document.createElement('span'); name.className = 'layer-name';
      const kind = document.createElement('b'); kind.textContent = d.kind;
      const detail = document.createElement('span'); detail.className = 'muted'; detail.textContent = d.detail;
      name.append(kind, ' ', detail);
      row.append(dot, name);
      const btn = (act, label, ic, disabled) => {
        const b = document.createElement('button'); b.className = 'layer-btn'; b.dataset.act = act;
        b.title = label; b.setAttribute('aria-label', label); b.disabled = !!disabled; b.innerHTML = icon(ic);
        row.appendChild(b);
      };
      // An edit to the PDF's own text is part of the page, not a layer on it: it has no place
      // in the stacking order, and removing it brings the original words back.
      const inPage = a.type === 'textedit';
      btn('eye', a.hidden ? (inPage ? 'Show the edit' : 'Show') : (inPage ? 'Show the original words' : 'Hide'), a.hidden ? 'eye-off' : 'eye');
      btn('up', 'Bring forward', 'up', inPage || i === list.length - 1);
      btn('down', 'Send back', 'down', inPage || i === 0);
      btn('del', inPage ? 'Undo this edit (the original words come back)' : 'Delete', 'trash');
      row.onclick = e => {
        const act = e.target.dataset && e.target.dataset.act;
        if (!act) {                                   // clicking the row selects it on the page
          commitTextEdit();
          if (inPage) { if (!a.hidden) KamView.reveal(state.cur, a.x + a.w / 2, a.y + a.h / 2); render(true); return; }
          state.selected = a.hidden ? null : a;
          if (typeof pdfTextClearPick === 'function') pdfTextClearPick();
          if (state.tool !== 'select') setTool('select');
          updateProps(); drawOverlay(); render(true);
          return;
        }
        e.stopPropagation();
        pushAnnotUndo(state.pageIds[state.cur]);
        if (act === 'eye') { a.hidden = !a.hidden; if (a.hidden && state.selected === a) state.selected = null; }
        else if (act === 'del') {
          list.splice(i, 1); if (state.selected === a) state.selected = null;
          if (inPage) toast('Edit undone: the original words are back. Ctrl+Z to redo it.', 4500);
        }
        else {
          const j = act === 'up' ? i + 1 : i - 1;
          if (j < 0 || j >= list.length) return;
          list.splice(i, 1); list.splice(j, 0, a);
        }
        updateProps(); drawOverlay(); refreshThumb(state.cur); render(true);
      };
      listEl.appendChild(row);
    }
  }

  window.refreshLayers = force => render(force);
  $('#btnLayersClear').onclick = () => {
    const list = state.pageIds.length ? (state.annots[state.pageIds[state.cur]] || []) : [];
    if (!list.length) return;
    const edits = list.filter(a => a.type === 'textedit').length;
    if (!confirm(`Remove all ${list.length} of your changes to this page?` + (edits ? ` Text you edited goes back to how it was.` : ' The page itself is untouched.'))) return;
    commitTextEdit();
    pushAnnotUndo(state.pageIds[state.cur]);
    list.length = 0; state.selected = null;
    updateProps(); drawOverlay(); refreshThumb(state.cur); render(true);
  };
  render(true);
})();
