/* KAM PDFs scanner UI: corner editor + clean-up preview. Used by scan.html (phone) and the desktop Scan dialog.
   KamScanUI.open(file, { mount, mode, onDone({blob, canvas}), onCancel }) */
'use strict';
const KamScanUI = (() => {
  const CSS = `
  .ks-wrap{display:flex;flex-direction:column;height:100%;min-height:320px;gap:8px}
  .ks-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#111;border-radius:8px;overflow:hidden;position:relative}
  .ks-stage canvas{max-width:100%;max-height:100%;touch-action:none;display:block}
  .ks-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .ks-bar .ks-step{flex:1;min-width:120px;font-size:12px;opacity:.8}
  .ks-modes button.active{outline:2px solid #f5b400}
  .ks-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;font-size:15px}
  `;
  function ensureCss() { if (!document.getElementById('ks-css')) { const s = document.createElement('style'); s.id = 'ks-css'; s.textContent = CSS; document.head.appendChild(s); } }
  const next = () => new Promise(r => setTimeout(r, 30));

  async function open(file, opts) {
    ensureCss();
    const mount = opts.mount; mount.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'ks-wrap'; mount.appendChild(wrap);
    const stage = document.createElement('div'); stage.className = 'ks-stage'; wrap.appendChild(stage);
    const bar = document.createElement('div'); bar.className = 'ks-bar'; wrap.appendChild(bar);
    const busy = (msg) => { let b = stage.querySelector('.ks-busy'); if (!msg) { if (b) b.remove(); return; } if (!b) { b = document.createElement('div'); b.className = 'ks-busy'; stage.appendChild(b); } b.textContent = msg; };

    busy('Loading photo…'); await next();
    const photo = await KamScan.loadToCanvas(file, 1800);
    let corners = KamScan.detectCorners(photo) || KamScan.fullCorners(photo);
    const autoFound = !!KamScan.detectCorners(photo);
    busy('');

    /* ----- step 1: corners ----- */
    const view = document.createElement('canvas'); stage.appendChild(view);
    const vctx = view.getContext('2d');
    let scale = 1;
    function layout() {
      const maxW = stage.clientWidth || 600, maxH = stage.clientHeight || 400;
      scale = Math.min(maxW / photo.width, maxH / photo.height, 1);
      const dpr = window.devicePixelRatio || 1;
      view.width = Math.round(photo.width * scale * dpr); view.height = Math.round(photo.height * scale * dpr);
      view.style.width = Math.round(photo.width * scale) + 'px'; view.style.height = Math.round(photo.height * scale) + 'px';
      draw();
    }
    function draw() {
      const dpr = window.devicePixelRatio || 1, s = scale * dpr;
      vctx.setTransform(1, 0, 0, 1, 0, 0); vctx.clearRect(0, 0, view.width, view.height);
      vctx.drawImage(photo, 0, 0, view.width, view.height);
      // dim outside the quad
      vctx.save(); vctx.fillStyle = 'rgba(0,0,0,.45)'; vctx.beginPath(); vctx.rect(0, 0, view.width, view.height);
      vctx.moveTo(corners[0][0] * s, corners[0][1] * s); for (let i = 1; i < 4; i++) vctx.lineTo(corners[i][0] * s, corners[i][1] * s); vctx.closePath(); vctx.fill('evenodd'); vctx.restore();
      vctx.strokeStyle = '#f5b400'; vctx.lineWidth = 2 * dpr; vctx.beginPath();
      vctx.moveTo(corners[0][0] * s, corners[0][1] * s); for (let i = 1; i < 4; i++) vctx.lineTo(corners[i][0] * s, corners[i][1] * s); vctx.closePath(); vctx.stroke();
      for (const [x, y] of corners) { vctx.beginPath(); vctx.arc(x * s, y * s, 11 * dpr, 0, Math.PI * 2); vctx.fillStyle = 'rgba(245,180,0,.35)'; vctx.fill(); vctx.beginPath(); vctx.arc(x * s, y * s, 6 * dpr, 0, Math.PI * 2); vctx.fillStyle = '#f5b400'; vctx.fill(); vctx.strokeStyle = '#000'; vctx.lineWidth = dpr; vctx.stroke(); }
    }
    let dragIdx = -1;
    const pt = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]; };
    view.addEventListener('pointerdown', e => {
      const [x, y] = pt(e); let best = -1, bd = Infinity;
      corners.forEach(([cx, cy], i) => { const d = Math.hypot(cx - x, cy - y); if (d < bd) { bd = d; best = i; } });
      if (bd * scale < 48) { dragIdx = best; view.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    view.addEventListener('pointermove', e => { if (dragIdx < 0) return; const [x, y] = pt(e); corners[dragIdx] = [Math.max(0, Math.min(photo.width, x)), Math.max(0, Math.min(photo.height, y))]; draw(); });
    view.addEventListener('pointerup', () => dragIdx = -1);
    view.addEventListener('pointercancel', () => dragIdx = -1);

    bar.innerHTML = `<span class="ks-step">${autoFound ? 'Page found. Drag the corners if needed.' : 'Drag the corners to the page edges.'}</span>
      <button class="ks-auto" type="button">Auto</button><button class="ks-full" type="button">Whole photo</button>
      <button class="ks-cancel" type="button">Cancel</button><button class="ks-next primary" type="button">Next ▸</button>`;
    bar.querySelector('.ks-auto').onclick = () => { corners = KamScan.detectCorners(photo) || KamScan.fullCorners(photo); draw(); };
    bar.querySelector('.ks-full').onclick = () => { corners = KamScan.fullCorners(photo); draw(); };
    bar.querySelector('.ks-cancel').onclick = () => { mount.innerHTML = ''; opts.onCancel && opts.onCancel(); };
    bar.querySelector('.ks-next').onclick = () => step2();
    const ro = new ResizeObserver(layout); ro.observe(stage);
    layout();

    /* ----- step 2: clean-up preview ----- */
    let mode = opts.mode || 'color', rot = 0, warped = null, result = null;
    async function step2() {
      ro.disconnect();
      busy('Straightening…'); await next();
      // order corners: sort by y then x so TL,TR,BR,BL is well-defined even after dragging
      const c = [...corners].sort((a, b) => a[1] - b[1]); const top = c.slice(0, 2).sort((a, b) => a[0] - b[0]), bot = c.slice(2).sort((a, b) => a[0] - b[0]);
      warped = KamScan.warp(photo, [top[0], top[1], bot[1], bot[0]], 2000);
      busy('');
      view.remove();
      const prev = document.createElement('canvas'); stage.appendChild(prev);
      const fit = () => { const maxW = stage.clientWidth || 600, maxH = stage.clientHeight || 400; const sc = Math.min(maxW / prev.width, maxH / prev.height, 1); prev.style.width = Math.round(prev.width * sc) + 'px'; prev.style.height = Math.round(prev.height * sc) + 'px'; };
      const ro2 = new ResizeObserver(fit); ro2.observe(stage);
      async function render() {
        busy('Cleaning up…'); await next();
        const base = KamScan.rotate90(warped, rot);
        const work = document.createElement('canvas'); work.width = base.width; work.height = base.height; work.getContext('2d').drawImage(base, 0, 0);
        result = KamScan.enhance(work, mode);
        prev.width = result.width; prev.height = result.height; prev.getContext('2d').drawImage(result, 0, 0); fit();
        bar.querySelectorAll('.ks-modes button').forEach(b => b.classList.toggle('active', b.dataset.m === mode));
        busy('');
      }
      bar.innerHTML = `<span class="ks-step">Choose a look, then add the page.</span>
        <span class="ks-modes"><button type="button" data-m="color">Colour</button><button type="button" data-m="gray">Grey</button><button type="button" data-m="bw">B&amp;W</button><button type="button" data-m="none">Original</button></span>
        <button class="ks-rl" type="button" title="Rotate left">⟲</button><button class="ks-rr" type="button" title="Rotate right">⟳</button>
        <button class="ks-back" type="button">◂ Corners</button><button class="ks-done primary" type="button">Add page ✓</button>`;
      bar.querySelectorAll('.ks-modes button').forEach(b => b.onclick = () => { mode = b.dataset.m; render(); });
      bar.querySelector('.ks-rl').onclick = () => { rot = (rot + 3) % 4; render(); };
      bar.querySelector('.ks-rr').onclick = () => { rot = (rot + 1) % 4; render(); };
      bar.querySelector('.ks-back').onclick = () => { ro2.disconnect(); prev.remove(); stage.appendChild(view); bar.innerHTML = ''; open(file, Object.assign({}, opts, { corners })); };
      bar.querySelector('.ks-done').onclick = async () => {
        busy('Saving…'); await next();
        const blob = await KamScan.toJpeg(result, 0.88);
        ro2.disconnect(); mount.innerHTML = '';
        opts.onDone({ blob, canvas: result, mode });
      };
      await render();
    }
    if (opts.corners) { corners = opts.corners; draw(); }
  }
  return { open };
})();
