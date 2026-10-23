# Institution brand assets for printed papers

`backend/src/paper-pdf.js` prints the institution's logo at the top of every examination paper **only** when an
approved file is present. No logo is drawn, redrawn or approximated in its absence.

| File | Use |
|---|---|
| `institution-logo.png` (or `.jpg`) | Official Graphic Era logo, transparent PNG or JPEG, at least 600 px tall. Printed centred above the institution name at a height of about 54 pt, with its aspect ratio preserved. |

- PDFKit cannot embed SVG. Supply PNG/JPEG here even when the web app uses an SVG.
- Set `INSTITUTION_LOGO_PATH` to use a file elsewhere (for example a mounted secret or volume).
- Only add a file obtained from the institution's approved source. The cropped image in the redesign reference
  bundle (`graphic-era-logo-reference-only.png`) is a screenshot crop and must not be used.
- Status: **no approved logo has been supplied yet**, so papers currently print without a logo.

The fonts in `../fonts/` (DejaVu, see `LICENSE-DejaVu.txt`) are the embedded fallback for characters the standard
PDF fonts cannot draw (Greek, mathematical symbols, sub/superscripts and similar).
