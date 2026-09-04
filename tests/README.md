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
| deleting a line | the words leave the file, the rest of the page keeps its text, and the line stops coming back |
| layers panel | marks are listed, hidden, reordered and deleted; hidden ones stay out of the file |
| covers | double-clicking inside a whiteout still gives you somewhere to type |
| dragging layers | a row dropped on another lands in that position, and the page redraws to match |
| the working copy | a change is kept, survives a reload, comes back with its marks, and Forget clears it |
| shift constraints | rectangles and ellipses stay square; lines and arrows snap to 45 degrees |
| undo and redo | changes step backwards and forwards |
| scanner | page corners found in a photograph |
| the update check | a newer version raises the green bar, "Not now" is remembered for that version only, and GitHub answers when the site's own file cannot |
| updating | the offline copy is cleared and the app restarts, so the reload really gets the new files |
| the version number | core.js, version.json and the service worker cache name all agree |

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
- The update tests assert that the bar is actually on screen (it has a size, and is not
  `display:none`), not merely that the `hidden` flag was cleared. Checking the flag would be
  grading the line of code that sets it.
- The version test is the one that stops a release going out silently: if `version.json` is not
  bumped alongside `core.js`, nobody already running the app is ever told the release exists.
- The restore test waits for the marks to come back, not just for the document to open: the
  file opens first and the marks are attached a moment later, so a shorter wait passes while
  the restore is still half done.
- Hiding is not deleting. The tests assert that a whiteout and an in-place text edit leave the
  original words extractable, and that only Redact removes them. That is deliberate: it is the
  documented behaviour, and a test that expected otherwise would be encoding a false promise.
