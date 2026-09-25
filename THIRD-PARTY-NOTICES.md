# Third-party notices

KAM PDFs itself is MIT licensed (see [LICENSE](LICENSE)). It bundles the following
open-source work, unmodified unless noted, under their own licences.

## Libraries (`lib/`)

| Library | Version | Licence |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla) | 3.11.174 | Apache License 2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) (Andrew Dillon) | 1.17.1 | MIT |
| [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) (Andrew Dillon, a fork of [fontkit](https://github.com/foliojs/fontkit) by Devon Govett) | 1.1.1 | MIT |
| [PeerJS](https://github.com/peers/peerjs) | 1.5.4 | MIT |
| [qrcode.js](https://github.com/davidshimjs/qrcodejs) (David Shim) | 1.0.0 | MIT |
| [Tesseract.js](https://github.com/naptha/tesseract.js) with [tesseract.js-core](https://github.com/naptha/tesseract.js-core) (`lib/ocr/`) | 5.1.1 | Apache License 2.0 |
| English OCR data `eng.traineddata` from [tessdata](https://github.com/tesseract-ocr/tessdata) (`lib/ocr/`) | - | Apache License 2.0 |

The Apache License 2.0 text is in [lib/LICENSE-Apache-2.0.txt](lib/LICENSE-Apache-2.0.txt), and
fontkit's MIT licence is in [lib/LICENSE-fontkit.txt](lib/LICENSE-fontkit.txt). The other
licence texts are in the header comments of the bundled files and at the project links above.

## Fonts (`fonts/`)

Used to show and save letters that a PDF's own font does not have, and in the Text tool's
font menu. Each font file is stored as base64 inside a small script (`fonts/NAME.js`) so it
loads without a web server; the font data itself is unchanged.

| Fonts | Version | Licence |
|---|---|---|
| [Liberation](https://github.com/liberationfonts/liberation-fonts) Sans, Serif and Mono (Red Hat; Arimo, Tinos and Cousine by Google) | 2.1.5 | SIL Open Font License 1.1 ([text](fonts/LICENSE-Liberation.txt)) |
| [Carlito](https://github.com/googlefonts/carlito) (The Carlito Project Authors) | 1.104 | SIL Open Font License 1.1 ([text](fonts/LICENSE-Carlito.txt)) |
| [Caladea](https://github.com/huertatipografica/Caladea) (The Caladea Project Authors) | 1.001 | SIL Open Font License 1.1 ([text](fonts/LICENSE-Caladea.txt)) |

When you save, only the letters used are embedded in your PDF, which the font licence allows.

## Spelling dictionary (`dict/`)

`dict/en.js` combines the word list from [dwyl/english-words](https://github.com/dwyl/english-words)
(The Unlicense) with a ranking of common words adapted from
[FrequencyWords](https://github.com/hermitdave/FrequencyWords) by Hermit Dave
([CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)). See
[dict/SOURCES.txt](dict/SOURCES.txt) for the details and the changes made.
