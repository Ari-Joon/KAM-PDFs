/* KAM PDFs - spell checking for text you add to a page.
   The dictionary (dict/en.txt) is fetched the first time it is needed, then cached by the
   service worker so it keeps working offline. Words you add yourself live in localStorage. */
'use strict';
const KamSpell = (() => {
  const words = new Set();      // every known word, lower case
  const rank = new Map();       // word -> position in the frequency list (lower is commoner)
  let state = 'idle';           // idle | loading | ready | failed
  let loadPromise = null;

  // Common misspellings that happen to be archaic or dialect words, so the dictionary
  // would otherwise accept them. Value is the correction we offer first.
  const ALWAYS_WRONG = {
    untill: 'until', wich: 'which', ther: 'there', beleive: 'believe', thier: 'their',
    alot: 'a lot', teh: 'the', adn: 'and', nad: 'and', hte: 'the', ot: 'to', si: 'is',
    tow: 'two', fo: 'of', ist: 'its', dont: "don't", cant: "can't", wont: "won't",
    isnt: "isn't", didnt: "didn't", doesnt: "doesn't", wasnt: "wasn't", arent: "aren't",
    couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't", havent: "haven't",
    hasnt: "hasn't", wernt: "weren't", ive: "I've", im: "I'm", youre: "you're",
    theyre: "they're", thats: "that's", lets: "let's", its_: null,
  };

  function personal() {
    try { return new Set(JSON.parse(localStorage.getItem('kam-spell-ok') || '[]')); }
    catch (e) { return new Set(); }
  }
  let mine = personal();
  function addWord(w) {
    mine.add(w.toLowerCase());
    try { localStorage.setItem('kam-spell-ok', JSON.stringify([...mine])); } catch (e) { }
  }
  function forgetAll() {
    mine = new Set();
    try { localStorage.removeItem('kam-spell-ok'); } catch (e) { }
  }

  function load() {
    if (loadPromise) return loadPromise;
    state = 'loading';
    loadPromise = fetch('dict/en.txt')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(text => {
        const lines = text.split('\n');
        if (lines[0] !== 'KAMDICT1') throw new Error('unexpected dictionary format');
        const nCommon = parseInt(lines[1], 10);
        for (let i = 0; i < nCommon; i++) rank.set(lines[2 + i], i);
        let prev = '';
        for (let i = 2 + nCommon; i < lines.length; i++) {
          const l = lines[i];
          if (!l) continue;
          const shared = l.charCodeAt(0) - 48;
          const w = prev.slice(0, shared) + l.slice(1);
          words.add(w);
          prev = w;
        }
        state = 'ready';
        return true;
      })
      .catch(e => { console.error('spell: dictionary failed to load', e); state = 'failed'; loadPromise = null; return false; });
    return loadPromise;
  }

  const known = w => words.has(w) || mine.has(w);

  /* A token is worth checking only if it is a plain word: no digits, long enough,
     and not a short all-caps acronym like PDF or NHS. */
  function checkable(token) {
    if (token.length < 3 || /\d/.test(token)) return false;
    if (token === token.toUpperCase() && token.length <= 5) return false;
    return /^[A-Za-z][A-Za-z'’-]*$/.test(token);
  }

  function isMisspelled(token) {
    if (state !== 'ready' || !checkable(token)) return false;
    const w = token.toLowerCase().replace(/[’']s$/, '').replace(/^[’'-]+|[’'-]+$/g, '');
    if (!w || w.length < 3) return false;
    if (mine.has(w)) return false;
    if (Object.prototype.hasOwnProperty.call(ALWAYS_WRONG, w) && ALWAYS_WRONG[w]) return true;
    if (known(w)) return false;
    // hyphenated or apostrophed compounds are fine if every part is a word
    if (/[-’']/.test(w)) {
      const parts = w.split(/[-’']/).filter(Boolean);
      if (parts.length > 1 && parts.every(p => p.length < 3 || known(p))) return false;
    }
    return true;
  }

  const A = 'abcdefghijklmnopqrstuvwxyz'.split('');
  function edits1(w) {
    const out = new Set();
    for (let i = 0; i <= w.length; i++) {
      const L = w.slice(0, i), R = w.slice(i);
      if (R) out.add(L + R.slice(1));                                   // delete
      if (R.length > 1) out.add(L + R[1] + R[0] + R.slice(2));          // transpose
      for (const c of A) {
        if (R) out.add(L + c + R.slice(1));                             // replace
        out.add(L + c + R);                                             // insert
      }
    }
    out.delete(w);
    return out;
  }

  function suggest(token, limit = 6) {
    if (state !== 'ready') return [];
    const w = token.toLowerCase().replace(/[’']s$/, '');
    const forced = ALWAYS_WRONG[w];
    // dist maps a candidate to how many edits away it is: a one-edit fix always beats a
    // two-edit one, however common the other word happens to be.
    const dist = new Map();
    if (forced) dist.set(forced, 0);
    for (const c of edits1(w)) if (known(c) && !dist.has(c)) dist.set(c, 1);
    if (dist.size < 3 && w.length <= 9) {                               // widen the net when nothing close fits
      outer: for (const c1 of edits1(w)) {
        for (const c2 of edits1(c1)) {
          if (known(c2) && !dist.has(c2)) dist.set(c2, 2);
          if (dist.size > 40) break outer;
        }
      }
    }
    dist.delete(w);
    const score = s => dist.get(s) * 1e6 + (rank.has(s) ? rank.get(s) : 400000) + Math.abs(s.length - w.length) * 300;
    const out = [...dist.keys()].sort((a, b) => score(a) - score(b)).slice(0, limit);
    // keep the original capitalisation style
    if (/^[A-Z]/.test(token)) return out.map(s => s[0].toUpperCase() + s.slice(1));
    return out;
  }

  /* Split a line into word tokens, keeping each one's character offset. */
  function tokens(line) {
    const out = [];
    const re = /[A-Za-z][A-Za-z'’-]*/g;
    let m;
    while ((m = re.exec(line))) out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
    return out;
  }

  return {
    load, addWord, forgetAll, isMisspelled, suggest, tokens, checkable,
    get state() { return state; },
    get ready() { return state === 'ready'; },
    get size() { return words.size; },
    get mine() { return [...mine]; },
  };
})();
