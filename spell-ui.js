/* KAM PDFs - spell checking UI: the underline toggle and the review dialog. */
'use strict';
(() => {
  const CB = $('#spellUnderline');
  let underline = true;
  try { const v = localStorage.getItem('kam-spell-underline'); if (v !== null) underline = v === '1'; } catch (e) { }
  CB.checked = underline;

  // annot.js asks this before drawing the red underlines
  window.spellUnderlineOn = () => underline && KamSpell.ready;

  function setState(msg) { const el = $('#spellState'); if (el) el.textContent = msg || ''; }

  async function ensureDictionary(why) {
    if (KamSpell.ready) return true;
    setState('Loading dictionary…');
    const ok = await KamSpell.load();
    if (!ok) { setState('Dictionary unavailable'); toast('Could not load the dictionary (dict/en.txt).', 5000); return false; }
    setState(`${KamSpell.size.toLocaleString()} words loaded`);
    if (why !== 'quiet') toast('Spell check ready');
    drawOverlay();
    return true;
  }

  CB.addEventListener('change', async () => {
    underline = CB.checked;
    try { localStorage.setItem('kam-spell-underline', underline ? '1' : '0'); } catch (e) { }
    if (underline) await ensureDictionary('quiet');
    drawOverlay();
  });

  // Load in the background once a document is open, so the first check is instant.
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1500));
  idle(() => { if (underline) ensureDictionary('quiet'); });

  /* ---------- collect every misspelling across the document ---------- */
  function findAll() {
    const out = [];
    state.pageIds.forEach((pid, page) => {
      for (const a of (state.annots[pid] || [])) {
        if (a.type !== 'text' || !a.text) continue;
        const seen = new Set();
        for (const t of KamSpell.tokens(a.text)) {
          if (!KamSpell.isMisspelled(t.word) || seen.has(t.word)) continue;
          seen.add(t.word);
          out.push({ page, annot: a, word: t.word });
        }
      }
    });
    return out;
  }

  /* Replace whole-word occurrences, preserving the rest of the text. */
  function replaceWord(a, from, to) {
    const re = new RegExp('(^|[^A-Za-z\'’-])(' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![A-Za-z\'’-])', 'g');
    const next = a.text.replace(re, (m, pre) => pre + to);
    if (next === a.text) return false;
    pushAnnotUndo(state.pageIds[state.cur]);
    a.text = next; measureText(a);
    drawOverlay(); refreshThumb(state.cur);
    return true;
  }

  function render() {
    const items = findAll();
    const box = $('#spellBody');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = '<div class="spell-none">No misspellings found in the text you have added.</div>';
      return;
    }
    box.innerHTML = '';
    items.forEach(it => {
      const row = document.createElement('div'); row.className = 'spell-item';
      const w = document.createElement('span'); w.className = 'spell-word'; w.textContent = it.word;
      const where = document.createElement('span'); where.className = 'spell-where';
      where.textContent = `page ${it.page + 1} · "${it.annot.text.replace(/\s+/g, ' ').slice(0, 40)}${it.annot.text.length > 40 ? '…' : ''}"`;
      const fix = document.createElement('span'); fix.className = 'spell-fix';
      for (const s of KamSpell.suggest(it.word, 4)) {
        const b = document.createElement('button'); b.textContent = s;
        b.onclick = () => { if (replaceWord(it.annot, it.word, s)) { toast(`Changed to "${s}"`); render(); } };
        fix.appendChild(b);
      }
      const add = document.createElement('button');
      add.textContent = '+ dictionary'; add.title = 'Treat this as a correct word from now on';
      add.onclick = () => { KamSpell.addWord(it.word); drawOverlay(); refreshThumb(state.cur); render(); };
      fix.appendChild(add);
      const go = document.createElement('button');
      go.textContent = 'Show'; go.title = 'Go to this text';
      go.onclick = async () => {
        hideModal(); await goTo(it.page);
        if (state.tool !== 'select') setTool('select');
        state.selected = it.annot; updateProps(); drawOverlay();
      };
      fix.appendChild(go);
      row.append(w, where, fix);
      box.appendChild(row);
    });
  }

  $('#btnSpell').onclick = async () => {
    if (!state.doc) return toast('Open a PDF first');
    showModal(`<h3>Spelling</h3>
      <div id="spellBody" class="spell-list"><div class="muted">Loading dictionary…</div></div>
      <div class="row"><span id="spellMine" class="muted"></span><span style="flex:1"></span>
      <button id="spellForget">Clear my dictionary</button><button id="spellClose">Close</button></div>`);
    $('#spellClose').onclick = hideModal;
    $('#spellForget').onclick = () => { KamSpell.forgetAll(); drawOverlay(); refreshThumb(state.cur); render(); updateMine(); };
    function updateMine() {
      const n = KamSpell.mine.length;
      $('#spellMine').textContent = n ? `${n} word${n === 1 ? '' : 's'} in your dictionary` : '';
    }
    if (!(await ensureDictionary('quiet'))) { $('#spellBody').innerHTML = '<div class="muted">Dictionary unavailable. Check that dict/en.txt is next to index.html.</div>'; return; }
    render(); updateMine();
  };
})();
