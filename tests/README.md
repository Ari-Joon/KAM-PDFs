# Tests

```bash
node tests/run.js
```

Runs everything. To run a subset, pass words that appear in the test names:

```bash
node tests/run.js redact ocr
```

Needs **Node 18 or newer** and **Google Chrome**. Nothing to install: the suite serves the
project itself and drives headless Chrome over the DevTools protocol. It exits non-zero if
anything fails, so it works as a pre-commit or CI check.

## What it covers

| Test | Checks |
|---|---|
| opens a document | pages are read and tracked |
| page operations | reorder, duplicate, delete, page-range parsing |
| annotation fidelity | the saved PDF is compared pixel by pixel with the screen |
| form fields | marks over a field are not lost when saving |
| editing existing text | size, font, colour and position are picked up; the edit reaches the file |
| selecting text | reading order, multi-line selection, copy, delete |
| find | matches across pages, in order |
| spell checking | real mistakes flagged, correct words and acronyms left alone, suggestion ranking |
| redaction | the removed words are absent from the file, including inside compressed streams |
| OCR | a scan gains searchable text, in the right reading order |
| undo and redo | changes step backwards and forwards |
| scanner | page corners found in a photograph |

## Why a second engine

The form-field test also renders the saved file with **PDFium**, the engine Chrome and most
viewers use, and asserts that nothing shows through the whiteout.

That check exists because of a real bug. Saving looked correct when the export was rendered
with pdf.js, the same engine the app draws with, so an early test passed while the saved file
was wrong in every other viewer: PDF readers paint form fields on top of the page, so a mark
over a field slid underneath it. Grading pdf.js with pdf.js hid it.

The check needs Python with `pypdfium2` and `Pillow`:

```bash
pip install pypdfium2 pillow
```

Without them that one assertion is skipped and reported as skipped, not silently passed.

## Notes

- The clipboard is unavailable to headless Chrome, so the copy test stubs the clipboard API
  and asserts the right text was handed to it.
- OCR downloads nothing: it uses the recogniser bundled in `lib/ocr`. That test takes a few
  seconds longer than the rest.
- Hiding is not deleting. The tests assert that a whiteout and an in-place text edit leave the
  original words extractable, and that only Redact removes them. That is deliberate: it is the
  documented behaviour, and a test that expected otherwise would be encoding a false promise.
