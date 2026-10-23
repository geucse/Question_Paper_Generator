# Portal branding (Graphic Era)

The shell (`src/components/shell/`) and the sign-in screen read their identity from build-time settings in
`src/brand.js`:

| Variable | Default | Purpose |
|---|---|---|
| `VITE_INSTITUTION_NAME` | `Graphic Era` | Institution name in the header and on the sign-in screen. |
| `VITE_BRAND_LOGO_URL` | *(empty)* | URL of the **approved** logo, e.g. `/brand/graphic-era-logo.svg` after placing the file in `public/brand/`. |

While `VITE_BRAND_LOGO_URL` is empty, or if the file fails to load, the institution name is shown as plain text
(`data-brand-placeholder="true"` marks it). The logo is never redrawn or approximated.

Adding the official logo:
1. Obtain the official horizontal logo/wordmark (SVG preferred, or transparent PNG) from the institution.
2. Save it as `public/brand/graphic-era-logo.svg` (or `.png`). It is shown at 40 px tall with its aspect ratio kept.
3. Build with `VITE_BRAND_LOGO_URL=/brand/graphic-era-logo.svg` (Docker: the build arg of the same name).
4. For printed papers, also place a PNG/JPEG copy at `backend/assets/brand/institution-logo.png`.

The favicon (`public/favicon.svg`) is unchanged; replace it only with an official icon.
Do not ship the reference screenshots, unverified accreditation marks or campus photos without permission.

Design tokens (navy `#172554`, blue `#2563eb`, gold `#fbbf24`, page `#f6f8fc`, etc.) are the `--ge-*` custom
properties at the top of `src/index.css`; adjust them there if official brand standards are supplied.
