/* KAM PDFs - the first thing to run, before anything is drawn: pick the saved light or dark
   theme so the page never flashes the wrong colours. Its own file (rather than inline) so the
   content security policy can forbid inline scripts altogether. */
try { var t = localStorage.getItem('kam-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) { }
