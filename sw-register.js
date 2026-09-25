/* KAM PDFs - install the offline copy, and pick up a new version when one arrives. */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  var hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(function () { });
  // A new version installed: reload once so the user runs the latest code (unless they have unsaved work).
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) return; hadController = false;
    if (window.state && state.dirty) { toast('A new version of KAM PDFs is ready. Save your work, then reload.', 8000); }
    else location.reload();
  });
}
