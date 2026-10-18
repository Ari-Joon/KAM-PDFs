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

Eighty-six tests, grouped here by what they protect.

**Editing the PDF's own text**

| Test | Checks |
|---|---|
| existing text is edited in place | the line is retyped in its own font, size, colour and position; the saved file reads the new words, not the old ones, and uses only the fonts it had |
| a document printed from a browser | Chrome's own "Save as PDF" output (Calibri, Cambria, Arial, Times, as embedded subsets), made inside the test, is edited in its own fonts; not one pixel changes outside the edited lines; the screen matches the saved file; PDFium reads the same words |
| a Word document | a real Word "Save as PDF" file (`fixtures/word-tenancy.pdf`) keeps its fonts, tabs, bullets and justified lines |
| letters the font does not have | come from the matching bundled font (Liberation Sans for Helvetica) and read back correctly |
| kerning, letter and word spacing | a line set with all three keeps its spacing when words are added |
| alignment | justified, right-aligned and centred lines stay lined up the way they were |
| an edited paragraph flows | words move on to the next lines as a sentence grows and back as it shrinks; bold words stay bold wherever they land; no line runs past the margin; not one pixel changes outside the paragraph; the screen matches the file; PDFium reads the paragraph in order; undoing it gives back the old lines exactly |
| a paragraph that grows | takes a new line below it where there is room; with no room it adds none over the next paragraph, loses nothing typed, and says so |
| what is not a paragraph | lists, columns of amounts and an address keep each line to itself |
| deleting in a paragraph | a line of an edited paragraph can be deleted, and Ctrl+Z puts the paragraph back |
| form objects and turned pages | text drawn inside a form object (even one drawn twice) and text on a rotated page are edited where they are |
| right-to-left lines | Hebrew and Arabic are covered and retyped rather than rewritten, so their words are never scrambled |
| text the engine cannot rewrite | is still deleted, the older way, by redaction |
| deleting a line | the words leave the page and the file, nothing around them moves, and undo brings them back |
| every bundled font | each of the twenty draws every letter after being cut down to the letters used and saved, checked with PDFium |
| your own text | Polish, Greek, Russian and symbols typed in a text box are all in the saved file |
| text edits in Layers | edits can be hidden, retyped, taken back, and survive the window closing |
| selecting text | reading order, multi-line selection, copy, delete |
| find | matches across pages, in order |
| search highlight position | the highlight starts and ends on the word it found, checked against the exact glyph widths pdf-lib knows for the standard fonts |

**Your own marks, with the real mouse and keyboard**

| Test | Checks |
|---|---|
| a text box's look | the size, font and bold chosen while typing go to that box and the typing carries on in it; Esc leaves it selected so it can still be changed; double-clicking it edits it instead of starting a new box; the saved file has it in that font |
| the page stays still | no tool and no selection moves the page under the mouse (the property row keeps its place) |
| a shape just drawn | is selected, takes the colour and width chosen straight after, and the next one is drawn the same way |
| Ctrl+S in a text box | saves, with what was just typed in it |
| italic | a text box can be italic in every font, on screen and in the saved file, which uses the font's own italic |
| a text box's alignment | centred and right-aligned boxes, wrapped and not, have each line in the saved file where the screen puts it |
| a mark on every page | a selected mark is copied to the same place on every page, and one Ctrl+Z takes the copies off |

**Signatures**

| Test | Checks |
|---|---|
| saved signatures | the Signatures section lists them (one kept by an older version too), keeps a name through a reload, puts one on the page or on every page with one Ctrl+Z to take them off, and removes one |
| a photo of a signature | the paper becomes see-through, the shadowed side too; the ink keeps its own colour; the picture is cropped to it; a picture with nothing on it says so |
| today's date | goes under the signature just put on the page, written out with the month as a word, and is saved |

**Opening PDFs from Windows**

| Test | Checks |
|---|---|
| the installed app | a PDF handed over by the browser opens straight away, and Save writes back into that very file without asking where; Save As still asks |
| unsaved work from last time | is offered back before a PDF opened from Windows could replace it, and is not asked about once it was saved |
| a copy run from a folder | `setup/open-pdf.ps1` hands the PDF over byte for byte (a name with accents included), the folder copy opens it and forgets the address, and an address pointing anywhere else loads nothing |

**Saving what you see**

| Test | Checks |
|---|---|
| annotation fidelity | the saved PDF is compared pixel by pixel with the screen |
| a half-transparent pen | saves as one stroke, exactly as it looks, not beaded at every joint |
| form fields | marks over a field are not lost when saving, and fields in a combined PDF are adopted into its form |
| redaction | the removed words are absent from the file, including inside compressed streams |
| OCR | a scan gains searchable text, in the right reading order |
| spell checking | real mistakes flagged, correct words and acronyms left alone, suggestion ranking |

**Pages, links and bookmarks**

| Test | Checks |
|---|---|
| opens a document | pages are read and tracked |
| page operations | reorder, duplicate, delete, page-range parsing |
| one column | pages scroll in one column, and only the ones near the window are drawn |
| the page you work on | clicking a page makes it the active one |
| zoom | the point under the cursor stays still, and no frame is ever blank |
| a very large page | an A0 page at 800% still draws |
| links | Ctrl+click follows a link, hovering says where it goes, and bookmarks go where they say; a bookmark titled like HTML stays text |
| links on a touch screen | a tap offers a button that opens the link, and a tap elsewhere puts it away |
| bookmarks | added, renamed and removed, in page order, and saved with the file |
| password-protected PDFs | five kinds of encryption (RC4 and AES, 40 to 256 bits, with and without object streams, owner-only and user passwords) open, asking only when needed, and save unprotected |
| the password checksum | MD5 against known answers |

**Not losing work, and not being tricked**

| Test | Checks |
|---|---|
| opening another file | asks Save / Don't save / Cancel first when there are unsaved changes |
| dropping a PDF on an open document | never discards work by accident |
| text inside a PDF | can never run as code in the app |
| undo back to what was saved | clears the unsaved mark; page changes can be redone |
| paste | uses whatever was copied last, here or anywhere else |
| the working copy | a change is kept, survives a reload, comes back with its marks, and Forget clears it |
| layers panel | marks are listed, hidden, reordered and deleted; hidden ones stay out of the file |
| covers | double-clicking inside a whiteout still gives you somewhere to type |
| dragging layers | a row dropped on another lands in that position, and the page redraws to match |
| shift constraints | rectangles and ellipses stay square; lines and arrows snap to 45 degrees |
| undo and redo | changes step backwards and forwards |

**Memory**

| Test | Checks |
|---|---|
| pictures | a picture is kept once however often it is moved, and no bigger than it needs to be |
| upright photos | a phone photo taken upright is saved upright |
| turning pages | turning the pages of a big document does not fill memory, and undoes exactly |

**Phones, tablets and the scanner**

| Test | Checks |
|---|---|
| on a phone | the page gets the screen, the panels slide in and out, one finger scrolls, two fingers pinch the document and not the app |
| on a tablet | the pages list stays, the document panel waits in a drawer |
| the phone scanner | keeps its pages through a reload, and counts a page sent only when the computer confirms it |
| scanner | page corners found in a photograph |

**Updates, layout and finding your way**

| Test | Checks |
|---|---|
| the update check | a newer version raises the green bar, "Not now" is remembered for that version only, and GitHub answers when the site's own file cannot |
| updating | the offline copy is cleared and the app restarts, so the reload really gets the new files |
| the update button | it is always in the top bar, quiet until a newer version exists, then gold and naming it; it outlasts "Not now" and brings the bar back |
| checking once | it asks once when it opens and never again while it stays open, and not at all if it asked in the last six hours |
| a copy in a folder | is handed the Windows zip of the new release rather than a page to go looking on |
| the version number | core.js, version.json and the service worker cache name all agree |
| movable panels | a dragged divider actually moves the panel, collapses it, restores it, answers the keyboard, and is remembered across a reload |
| the tool row | dragging its grip into the lower half moves the tools below the page, and that survives a reload |
| the icon set | no button, Layers row, find bar, scan dialog, signature box or phone scanner page is left carrying an emoji, every icon a button asks for exists, and they render with a real size and the button's colour |
| the welcome screen | with nothing open, tools and panels are off screen and the four task cards are on it; document-only menu items are disabled; Help is still reachable; opening a document brings everything back |
| combining PDFs | the Combine card's path joins a 2-page and a 3-page PDF into 5 pages |
| the command search | Ctrl+K opens it with the cursor in it; every command points at a control that exists; "circle" finds the ellipse tool; a command in a folded section opens it and puts you in the box; document commands are marked, not run, with nothing open |
| the menus | File and Shapes open and close, clicking elsewhere closes them, Escape closes a menu without changing your tool, and the Shapes button follows the shape in use |
| sections and unsaved work | seven Document sections, only Save & export open at first, the ones you open are remembered, and unsaved changes put a dot on Save and in the window title |
| the first tip | it appears with the first document and never again once dismissed |

## Fixtures

`fixtures/` holds files the tests cannot make for themselves:

- `word-tenancy.pdf`, a document saved from Microsoft Word, made by `make-word.ps1` (it drives Word
  itself, so it needs Word to rebuild).
- `enc-*.pdf`, the password-protected PDFs, made by `node tests/fixtures/make-encrypted.js`. The
  passwords are `kam-user` and `kam-owner`, and `pässwörd` for the one that tests a password
  with accents.

Everything else, including the browser-printed documents, is generated inside the test that uses it.

## Why a second engine

Several tests also read the saved file with **PDFium**, the engine Chrome, Edge and most
viewers use: the form-field test asserts that nothing shows through the whiteout, and the
text-editing tests assert that PDFium reads the new words, finds none of the old ones, and
draws ink on every line.

That check exists because of a real bug. Saving looked correct when the export was rendered
with pdf.js, the same engine the app draws with, so an early test passed while the saved file
was wrong in every other viewer: PDF readers paint form fields on top of the page, so a mark
over a field slid underneath it. Grading pdf.js with pdf.js hid it.

It happened again with fonts. A font cut down to the letters an edit uses came out blank in
Chrome and Edge, because of a bug in how fontkit writes some fonts, and pdf.js drew those
same letters blank too, so comparing the two engines found nothing wrong. The bundled-font
test now counts PDFium's ink on each line against the whole font's.

The check needs Python with `pypdfium2` and `Pillow`:

```bash
pip install pypdfium2 pillow
```

Without them that one assertion is skipped and reported as skipped, not silently passed.

## Notes

- Some tests use real mouse and keyboard input (the DevTools Input domain) rather than events
  made inside the page. Only real input moves the focus the way a person does, and that is where
  the text box bug lived: clicking the Size field took the focus out of the box, which closed it,
  and the new size went to the next box instead. Events dispatched by script never move the
  focus, so the old tests could not see it. Two side effects are handled by the harness: real
  input lets a page with unsaved work ask "Leave site?" on reload (the harness answers it), and a
  real click on a dropdown would open the browser's own popup (those tests move the focus instead).
- A page that stops answering fails its test after 90 seconds, rather than stopping the run. The
  first time the Windows tests ran after the others, the app was rightly asking whether to restore
  work an earlier test had left, and nothing was there to answer.

- The clipboard is unavailable to headless Chrome, so the copy test stubs the clipboard API
  and asserts the right text was handed to it.
- OCR downloads nothing: it uses the recogniser bundled in `lib/ocr`. That test takes a few
  seconds longer than the rest.
- The update tests assert that the bar is actually on screen (it has a size, and is not
  `display:none`), not merely that the `hidden` flag was cleared. Checking the flag would be
  grading the line of code that sets it.
- The panel test measures the panel, not the number that was stored. An early version of the
  feature wrote the new width to storage while the panel stayed exactly where it was, because
  a flex child was being sized from two places at once; a test that checked the stored value
  would have passed the whole time.
- The highlight test also proves its own probe is a hard one: it checks that spacing letters evenly,
  which is what the app used to do, misses by more than the test allows (by 4.7pt on that line,
  against an allowance of 2.1pt). A test that the old code would also have passed proves nothing.
- The command search is audited, not sampled: `KamPalette.audit()` checks that every one of its
  commands still points at a control that exists. Moving a button into a menu is exactly the kind of
  change that leaves a command quietly doing nothing.
- The version test is the one that stops a release going out silently: if `version.json` is not
  bumped alongside `core.js`, nobody already running the app is ever told the release exists.
- The restore test waits for the marks to come back, not just for the document to open: the
  file opens first and the marks are attached a moment later, so a shorter wait passes while
  the restore is still half done.
- Hiding is not deleting. The tests assert that a whiteout leaves the words under it
  extractable, and that editing or deleting a line of the PDF's own text, or redacting it,
  takes them out of the file. Each test states the documented behaviour, so neither can drift.
- The text-editing tests compare the saved page with the original pixel by pixel outside the
  edited lines, and allow no difference at all. "Looks about the same" is how an edit ends up
  moving a table border or the line below.
