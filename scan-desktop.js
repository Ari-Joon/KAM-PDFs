/* KAM PDFs — Scan dialog on the computer: receive pages from the phone, use the webcam, or clean up photos. */
'use strict';
(() => {
  const SCAN_PAGE = (location.protocol.startsWith('http') ? location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '') : 'https://ari-joon.github.io/KAM-PDFs/') + 'scan.html';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let peer = null, stream = null, received = 0;

  function makeCode() { const a = new Uint8Array(6); crypto.getRandomValues(a); return [...a].map(v => ALPHABET[v % ALPHABET.length]).join(''); }
  function setStatus(msg, cls) { const el = $('#scanStatus'); if (!el) return; el.textContent = msg; el.className = 'muted ' + (cls || ''); }

  async function addScannedPages(files) {
    if (!state.doc) { await newBlank(); await addImagePages(files); await deletePages([0]); }
    else await addImagePages(files);
    await goTo(state.pageIds.length - 1);
    received += files.length;
    const c = $('#scanCount'); if (c) c.textContent = `${received} page${received === 1 ? '' : 's'} added to the document`;
  }

  /* ----- phone link ----- */
  function startPeer(code) {
    stopPeer();
    if (typeof Peer === 'undefined') { setStatus('Phone link unavailable (peerjs library missing).', 'err'); return; }
    setStatus('Starting phone link…');
    peer = new Peer('kam-pdfs-' + code, { debug: 1 });
    peer.on('open', () => setStatus('Waiting for your phone… (keep this window open)'));
    peer.on('connection', conn => {
      setStatus('Phone connected. Take photos on the phone and tap Send.', 'ok');
      conn.on('data', async d => {
        if (!d || d.type !== 'page') return;
        try {
          setStatus(`Receiving page ${d.k + 1} of ${d.n}…`, 'ok');
          const file = new File([d.data], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
          await addScannedPages([file]);
          conn.send({ type: 'ack', i: d.i });
          setStatus(d.k + 1 === d.n ? `Received ${d.n} page${d.n > 1 ? 's' : ''}. Phone still connected.` : `Receiving page ${d.k + 2} of ${d.n}…`, 'ok');
          toast(`Scanned page ${d.k + 1} of ${d.n} added`);
        } catch (e) { console.error(e); setStatus('Failed to add page: ' + e.message, 'err'); }
      });
      conn.on('close', () => setStatus('Phone disconnected. Reopen scan.html on the phone to reconnect.'));
    });
    peer.on('error', e => {
      console.error(e);
      if (e.type === 'unavailable-id') { startPeer(makeCode()); return; }
      setStatus('Phone link failed (' + e.type + '). You need internet for the initial handshake. You can still save the PDF on the phone and open it here.', 'err');
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { } });
  }
  function stopPeer() { if (peer) { try { peer.destroy(); } catch (e) { } peer = null; } }
  function stopCam() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } const box = $('#scanCamBox'); if (box) box.hidden = true; }

  /* ----- run the corner editor for local photos / webcam frames ----- */
  let queue = [], running = false;
  async function editFiles(files) {
    queue.push(...files); if (running) return; running = true;
    const grid = $('#scanGrid'), ed = $('#scanEditor');
    while (queue.length) {
      const f = queue.shift();
      grid.hidden = true; ed.hidden = false;
      await new Promise(res => KamScanUI.open(f, {
        mount: ed, mode: 'color',
        onDone: ({ blob }) => { res(); addScannedPages([new File([blob], 'scan.jpg', { type: 'image/jpeg' })]).then(() => toast('Scanned page added')).catch(e => toast('Could not add page: ' + e.message)); },
        onCancel: () => res(),
      }));
    }
    ed.hidden = true; grid.hidden = false; running = false;
  }

  function openScanDialog() {
    const code = makeCode(); received = 0;
    showModal(`<h3>📷 Scan documents</h3>
      <div id="scanGrid" class="scan-grid">
        <div class="scan-col">
          <h4>From your phone</h4>
          <div id="qr" class="qr"></div>
          <div class="muted" style="margin-top:8px">Point your phone camera at the code, or open<br><b>${SCAN_PAGE.replace(/^https?:\/\//, '')}</b><br>and enter code <b class="scan-code">${code}</b></div>
          <div id="scanStatus" class="muted" style="margin-top:8px">Starting…</div>
        </div>
        <div class="scan-col">
          <h4>On this computer</h4>
          <div class="row"><button id="scanPhotos">🖼 Clean up photos…</button><button id="scanCam">🎥 Use webcam</button></div>
          <div class="muted">Photos of documents get straightened and cleaned up, then added as pages.</div>
          <div id="scanCamBox" hidden style="margin-top:8px"><video id="scanVideo" autoplay playsinline muted style="width:100%;border-radius:8px;background:#000"></video>
            <div class="row" style="margin-top:6px"><button id="scanSnap" class="primary">Capture</button><button id="scanCamStop">Stop camera</button></div></div>
        </div>
      </div>
      <div id="scanEditor" hidden style="height:70vh;width:min(90vw,1000px)"></div>
      <div class="row" style="margin-top:10px"><span id="scanCount" class="muted"></span><span style="flex:1"></span><button id="scanClose">Close</button></div>`);
    try { new QRCode($('#qr'), { text: SCAN_PAGE + '#' + code, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { $('#qr').textContent = SCAN_PAGE + '#' + code; }
    startPeer(code);
    $('#scanClose').onclick = () => { stopPeer(); stopCam(); hideModal(); };
    $('#scanPhotos').onclick = () => $('#scanPhotoInput').click();
    $('#scanCam').onclick = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        $('#scanVideo').srcObject = stream; $('#scanCamBox').hidden = false;
      } catch (e) { toast('Could not open the camera: ' + e.message, 4000); }
    };
    $('#scanCamStop').onclick = stopCam;
    $('#scanSnap').onclick = () => {
      const v = $('#scanVideo'); if (!v.videoWidth) return;
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob(b => editFiles([new File([b], 'webcam.jpg', { type: 'image/jpeg' })]), 'image/jpeg', 0.95);
    };
  }
  $('#scanPhotoInput').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) editFiles(fs); });
  $('#btnScan').onclick = openScanDialog;
  window.addEventListener('beforeunload', () => { stopPeer(); stopCam(); });
})();
