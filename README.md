# PDF Editor

A browser-based PDF editor that merges, edits and compresses PDFs. Everything runs
client-side — files are read with `FileReader`, manipulated in memory and written back
out as a download. Nothing is uploaded anywhere, and there is no server component.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/
npm run preview  # serve dist/ exactly as it will be hosted
```

`dist/` is plain static files — host it anywhere.

## Deploying to GitHub Pages

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds `dist/` and publishes
it with `actions/deploy-pages` on every push to `main` (or manually via *Run workflow*).
There is no CLI step — pushing is deploying.

One-time setup:

1. Push the repo to GitHub, then in **Settings → Pages** set *Source* to **GitHub Actions**.
2. The custom domain comes from [public/CNAME](public/CNAME) (`pdfeditor.ankushguptatech.com`),
   which Vite copies into `dist/` so it survives every deploy. At your DNS provider add a
   `CNAME` record for `pdfeditor` pointing at `<your-github-username>.github.io`, then back
   in **Settings → Pages** tick **Enforce HTTPS** once the certificate is issued.
3. Serving from a custom domain means the site lives at `/`, so `base` in
   [vite.config.ts](vite.config.ts) stays at its default. If you drop the custom domain and
   serve from `<user>.github.io/<repo>/` instead, delete `public/CNAME` and set
   `base: '/<repo>/'` — see below.

The `dist/` output is plain static files, so it hosts equally well anywhere else (Netlify,
Cloudflare Pages, S3) with no changes.

### Security headers without a server

GitHub Pages does not let you set response headers, so the policies that would normally
be headers are delivered from the page itself:

- **Content-Security-Policy** is injected as a `<meta http-equiv>` tag by the `cspMeta`
  plugin in [vite.config.ts](vite.config.ts), production builds only (the dev server needs
  an inline Fast Refresh script that the policy would block). It allows
  `'wasm-unsafe-eval'` for the OCR engine and `tessdata.projectnaptha.com` in
  `connect-src`, which is where tesseract.js fetches language models on first use. Any
  third-party script you add later must be listed in `script-src` there.
- **Referrer-Policy** is a `<meta name="referrer">` tag in [index.html](index.html).
- `Cache-Control` tuning is not available, but Vite's hashed `/assets/**` filenames
  make that a non-issue. `frame-ancestors`, `Permissions-Policy` and COOP cannot be
  expressed without headers and are simply not set.

### Before you go live

- Fill in the `TODO` markers in [public/privacy.html](public/privacy.html) — entity name,
  contact email, date, and which of the analytics/error-reporting clauses actually apply
- Make `<link rel="canonical">` in [index.html](index.html) an absolute URL on your domain,
  and add `og:url` / `og:image`
- Add analytics if you want them. Prefer a cookieless option (Plausible, Fathom) so you
  don't need a consent banner and don't undercut the privacy pitch.
- Add error reporting (Sentry) if you want to hear about failed exports — scrub file names,
  never send file bytes

### Serving it under a subpath

To host at `example.com/pdf/` rather than at a domain root, set `base: '/pdf/'` in
[vite.config.ts](vite.config.ts) before building. Asset URLs and the pdf.js font/CMap
paths both derive from it, so nothing else needs changing.

## Performance and limits

First load is ~65 KB gzipped. pdf.js (~108 KB gz), pdf-lib (~182 KB gz) and the 1.4 MB
pdf.js worker are fetched only when a file is actually opened, so the landing view is
cheap. The font and CMap data under `public/pdfjs/` is copied out of `node_modules` by
`scripts/copy-pdfjs-assets.mjs` on every `dev`/`build`, and fetched per-file only when a
PDF needs it.

Because everything is held in memory, [src/lib/limits.ts](src/lib/limits.ts) caps input at
80 MB per file and 250 MB total on desktop, and 25 MB / 60 MB on screens narrower than
820 px, where browsers kill tabs far sooner. Past those it refuses with a clear message
instead of crashing; past a lower threshold it warns that things may be slow.

## What it does

**Merge & organise.** Open any number of PDFs (plus images, which become pages) and
they land in one working document. Drag thumbnails to reorder, Ctrl/Shift-click to
multi-select, then rotate, duplicate, delete, insert a blank page, or save a subset out
as its own PDF.

**Images to PDF.** Drop or pick PNG, JPEG, WebP, AVIF, GIF, BMP or SVG files and each
becomes a page. A dialog picks the page size (fit-to-image, A4, Letter, Legal, A3, A5),
orientation (auto/portrait/landscape), margin, and whether the image fits inside the
page or fills it and crops the overflow. Anything that is not already PNG or JPEG is
re-encoded through a canvas, which also rescues CMYK JPEGs and 16-bit or interlaced
PNGs that pdf-lib would otherwise reject. Images can equally be placed *on* an existing
page with the image tool rather than becoming pages of their own.

**Edit.** Text boxes (Helvetica/Times/Courier, size, colour, alignment, bold/italic),
highlighter, rectangles, ellipses, lines, freehand ink for signatures, placed images,
and an opaque whiteout box. Everything is drag-to-move, handle-to-resize, and stamped
into the page content on export — the result is real PDF content, not annotation
objects that a viewer might hide.

**Compress.** Four presets from *Keep text sharp* (repack only, text stays selectable)
through to *Strong*, with manual DPI, JPEG quality and greyscale controls. The dialog
shows before/after byte sizes and the percentage saved before you download.

## How it fits together

| File | Role |
| --- | --- |
| `src/state/store.ts` | Zustand store: sources, page list, annotations, undo/redo |
| `src/lib/export.ts` | Rebuilds the output PDF and stamps annotations onto pages |
| `src/lib/compress.ts` | Repack and rasterise compression modes |
| `src/lib/image.ts` | Image decoding/normalising and image-to-page layout |
| `src/lib/geometry.ts` | Rotation/coordinate maths shared by the editor and the exporter |
| `src/lib/render.ts` | pdf.js page rendering and thumbnail cache |
| `src/components/PageView.tsx` | Page canvas, drawing tools, move/resize gestures |

### The coordinate model

This is the part worth knowing before changing anything.

A page has a **base space**: its size as pdf.js reports it (points, already including
the page's own `/Rotate`), with the origin at the top-left and y pointing down.
Annotations are always stored in base space.

The user's own rotation is applied to the *whole layer* at once — as a CSS transform on
screen, and as an equivalent `cm` matrix in the content stream on export. Because both
paths use the same numbers from `geometry.ts`, what you see is what gets written. Page
rotation therefore never rewrites annotation coordinates.

pdf-lib embeds pages by their MediaBox while pdf.js measures them by their CropBox, so
`export.ts` embeds an explicit CropBox bounding box; without that, cropped PDFs come out
scaled rather than cropped.

### Known limits

- Text uses the 14 standard PDF fonts, so it is WinAnsi-only — characters outside that
  set (CJK, for instance) are replaced with `?` on export. Embedding a custom font via
  `@pdf-lib/fontkit` would lift this.
- Existing text in a source PDF cannot be re-typed. Editing means drawing on top of the
  page, with whiteout to cover what is underneath.
- Compression below "keep text sharp" rasterises pages, so text stops being selectable
  and searchable. That is inherent to doing this in a browser without a Ghostscript-class
  optimiser.
- Encrypted PDFs load only if they open without a password.
- pdf.js (used for display) tolerates far more damage than pdf-lib (used for
  writing). A file that displays fine can still be impossible to copy page-for-page,
  so such pages are flattened to 2.2x images on export and the app says which ones.
- Export and compression run on the main thread. The loops yield between pages so the
  progress bar keeps moving, but the final `save()` of a very long document still blocks
  briefly. Moving the work into a Web Worker with `OffscreenCanvas` is the proper fix.
- Any limit enforced here is advisory only: all the code runs on the user's machine, so
  page caps or watermarks cannot be relied upon. Real gating would need a server.

## Keyboard

`V` select · `T` text · `D` draw · `H` highlight · `R` rectangle · `O` ellipse ·
`L` line · `W` whiteout · `I` image · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo ·
`Ctrl+S` download · `Ctrl+A` select all pages · `Del` delete selection ·
`Ctrl` `+`/`-` zoom · `↑`/`↓` change page · `Esc` back to select
