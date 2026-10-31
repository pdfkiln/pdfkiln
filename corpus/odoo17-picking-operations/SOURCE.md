# Odoo 17 picking operations, 26 lines with barcodes (2 pages), Boxed layout

## Origin

- Application: **Odoo 17.0 Community** (`odoo/release.py`: `version_info = (17, 0, 0, FINAL, 0, '')`),
  branch `17.0` of https://github.com/odoo/odoo at commit `dca5cd22d40f25066919d722bf687be48c51b0ec`
  (committed 2026-10-23T14:40:20Z, "[FIX] mail: truncate long reaction content"), cloned 2026-10-23.
- Python 3.12.13 venv with `requirements.txt` (psycopg2-binary instead of psycopg2) plus `rl-renderPM==4.0.3`, PostgreSQL 16,
  Ubuntu 24.04. `requirements.txt` lists `rl-renderPM` for Windows only ("included in deb package"); without it in a pip
  venv, reportlab 4.1 cannot draw barcodes and every report with a barcode fails. Database created **with demo data**;
  modules installed: `account`, `sale_management`, `stock`, `purchase` (and their dependencies, 66 modules).
- Document: Picking operations of the delivery order **WH/OUT/00013** (`stock.picking` id 28), state "Ready", 26 reserved lines, customer *Deco Addict*, source "Office refit, building B". The report shows the transfer name as a Code 128 barcode and a product barcode (EAN-13) on each line, all PNG images that Odoo embeds as `data:` URIs; the table runs over two pages with its header row repeated.
  Made-up EAN-13 barcodes (in-store prefix `200`, valid check digit) were set on the 29 storable demo products with `odoo shell`; the demo products have none. Stock was added for every storable product with inventory adjustments in WH/Stock (Physical Inventory, `action_apply_inventory()`); the delivery order was created with 26 moves, confirmed and reserved (`action_confirm()`, `action_assign()`).
- Report action: `stock.action_report_picking` (report `stock.report_picking`, Print > Picking Operations).
- Templates: `stock.report_picking` → `web.external_layout` → `web.external_layout_boxed` ("Boxed"), plus `web.html_container`, `web.report_layout`, `web.address_layout`; pages wrapped by `web.minimal_layout`.
- Sources: <https://github.com/odoo/odoo/blob/dca5cd22d40f25066919d722bf687be48c51b0ec/addons/stock/report/report_stockpicking_operations.xml>, <https://github.com/odoo/odoo/blob/dca5cd22d40f25066919d722bf687be48c51b0ec/addons/stock/report/stock_report_views.xml>,
  <https://github.com/odoo/odoo/blob/dca5cd22d40f25066919d722bf687be48c51b0ec/addons/web/views/report_templates.xml> (layouts, `web.minimal_layout` with the `subst()` script),
  <https://github.com/odoo/odoo/blob/dca5cd22d40f25066919d722bf687be48c51b0ec/odoo/addons/base/models/ir_actions_report.py> (`_build_wkhtmltopdf_args`, `_prepare_html`, `_run_wkhtmltopdf`).
- Company settings: demo company "My Company (San Francisco)", demo placeholder logo ("Your logo", embedded by Odoo as a
  `data:` URI), font Lato, no custom colours, layout background "Blank", report layout `web.external_layout_boxed` ("Boxed") set on
  `res.company.external_report_layout_id`. Paper format: demo default "A4" (`base.paperformat_euro`): margins top 40 / bottom 32 / left 7 / right 7 mm, header spacing 35, dpi 90.

## Capture

- The Odoo server (threaded mode, `workers = 0`, 127.0.0.1:8069, `web.base.url` and `report.url` =
  `http://127.0.0.1:8069`) ran with `bench/capture/wkhtmltopdf-shim.py` first on `PATH` under the name
  `wkhtmltopdf`, in front of the official wkhtmltopdf 0.12.6-1 build ("0.12.6 (with patched qt)").
  At start-up Odoo logged `Will use the Wkhtmltopdf binary at ...` and reported state `ok`.
- The report was printed the way the web client does it (second capture round, 2026-10-23): log in as `admin` over HTTP,
  set the layout (Boxed) with a JSON-RPC `write` on `res.company`, then `GET /report/pdf/stock.report_picking/28`.
  Odoo itself rendered the QWeb templates, wrote the temporary files and called wkhtmltopdf once.
- `args` in `manifest.json` is the captured argument list, unchanged and in order, except:
  - the pair `--cookie-jar /tmp/report.cookie_jar.tmp.<random>.txt` is removed. Odoo 17 passes the session cookie as a
    cookie-jar file (not `--cookie session_id <value>`) whenever the print comes through an HTTP request;
  - the temporary files lose only their random part (`subst()` reads the record index with `webpage.split('.', 4)[3]`):
    `/tmp/report.body.tmp.0.<random>.html` became `input/report.body.tmp.0.html`;
    `/tmp/report.footer.tmp.<random>.html` became `input/report.footer.tmp.html`;
    `/tmp/report.header.tmp.<random>.html` became `input/report.header.tmp.html`;
  - the output `/tmp/report.tmp.<random>.pdf` became `{out}`.
- In the 3 HTML files, `<base href="http://127.0.0.1:8069?debug=0"/>` became `http://127.0.0.1:8765?debug=0`
  (the only absolute server URL; stylesheets are root-relative). No `www/` file contained the origin.
- `www/` was fetched from the Odoo server right after the print, before the next change of the company settings: every
  same-origin `href`/`src` of the HTML files, then every `url()` of the CSS bundles (all formats listed in each
  `@font-face src`). The CSS bundle depends on the company settings (`web.styles_company_report`), and Odoo gives it a
  new hash at each change and redirects the old hash with a 303, so it cannot be re-fetched later.
  Bundles: `/web/assets/414e890/web.report_assets_pdf.min.css`, `/web/assets/0c08155/web.report_assets_common.min.css`. 57 files, 4.0 MB.
- Left out of `www/` (none of them is requested when this document is rendered):
  90 `https://fonts.odoocdn.com/fonts/noto/...` URLs (family "Odoo Unicode Support Noto",
  restricted by `unicode-range` to non-Latin scripts; external host); 154 dynamic
  `/web_editor/shape/...svg?c1=...` URLs (website section backgrounds); `/base/static/src/img/layout/play-button.png` and
  `play-button-over.png`, which answer 404 on the Odoo server itself.
- Calls and JavaScript: no `<script src>`; the header and footer carry Odoo's inline `subst()` script
  (`<body onload="subst()">`), which fills `.page` / `.topage` and keeps the header/footer of record `index`.
  `--javascript-delay 1000` comes from the `report.print_delay` default.
- After wkhtmltopdf: Odoo returns the wkhtmltopdf output unchanged in substance (same page count).
- The PDF the real wkhtmltopdf wrote during the capture has **2 pages** (595 x 842 pt). Like
  the other Odoo entries, it is not versioned; it is kept with the capture, outside the repository.

## Serving `www/`: cache headers matter

Odoo serves `/web/assets/...` with `Cache-Control: public, max-age=31536000, immutable` and `/web/static/...` with
`Cache-Control: public, max-age=604800` (the values recorded when `www/` was fetched). wkhtmltopdf 0.12.6 loads the body
first, then the header and footer pages; with those headers it takes the CSS and fonts from its memory cache. Served
**without** cache headers, wkhtmltopdf fetches the fonts again for the header and footer and draws them before the fonts
arrive, and their text is missing (found in the first capture round, see `odoo17-invoice`). `httpHeaders` in
`manifest.json` holds Odoo's two values.

## Offline check (2026-10-23)

Entry copied to a directory without dots, `127.0.0.1:8765` replaced by the port, the manifest's `www` directories
(this entry's `www/`, then `../_shared/odoo17/www`) served by a logging static server sending the manifest's
`httpHeaders`, Odoo stopped, real wkhtmltopdf 0.12.6 run from the entry directory with the manifest `args`: exit code
0, no 404, 2 pages as in the capture, same extracted text, pages identical pixel for pixel to the capture PDF
(PyMuPDF, 100 dpi). Requested files: `/web/assets/414e890/web.report_assets_pdf.min.css`, `/web/assets/0c08155/web.report_assets_common.min.css`, `/web/static/fonts/lato/Lato-Reg-webfont.woff`, `/web/static/fonts/lato/Lato-Lig-webfont.woff`, `/web/static/src/libs/fontawesome/fonts/fontawesome-webfont.woff?v=4.7.0`, `/web/static/fonts/lato/Lato-Hai-webfont.woff`, `/web/static/fonts/lato/Lato-Bol-webfont.woff`, `/web/static/fonts/lato/Lato-Bla-webfont.woff`. The wkhtmltopdf run of the bench
(`node dist/bench/compat.js odoo17-picking-operations`, its own server and port) gives the same pixels, and neither wkhtmltopdf nor
PDFKiln requests a file missing from the two directories.

## License

- Odoo Community is published under the **LGPL-3.0** (`LICENSE`, `COPYRIGHT` of the repository); the templates, the
  CSS compiled from Odoo's SCSS, the demo data (company, partners, products, placeholder logo) and the Odoo images
  in `../_shared/odoo17/www` (`empty_folder.svg`, `openhand.cur`, `curved_arrow.svg`) fall under it. Redistribution is allowed.
  The records created for these captures are made up.
- Third-party parts bundled in `web.report_assets_common.min.css` or served from `../_shared/odoo17/www`:
  - Bootstrap 5 SCSS (`web/static/lib/bootstrap`): MIT. Odoo's bundler drops the license comments of Bootstrap and
    Font Awesome from the minified CSS (only `/* /path */` markers remain); this file names them.
  - Font Awesome 4.7 (`web/static/src/libs/fontawesome`): font SIL OFL 1.1, CSS MIT.
  - Lato (`web/static/fonts/lato`, eot/woff/ttf/svg): SIL OFL 1.1, Łukasz Dziedzic (license file next to the fonts in Odoo).
  - Montserrat, Oswald, Raleway, Tajawal (`web/static/fonts/google`): SIL OFL 1.1 (`OFL.txt` next to them in Odoo).
  - Open Sans, Roboto (`web/static/fonts/google`): Apache-2.0 (`LICENSE.txt` next to them in Odoo).
  - odoo_ui_icons (`web/static/lib/odoo_ui_icons`, made with Fontello): Apache-2.0 (`LICENSE.md` in Odoo).
  - Barcodes: PNG images that Odoo draws with reportlab at print time from the made-up barcode values, embedded in the
    body as `data:` URIs; nothing third-party in them.
- `versioned: true`: every component allows redistribution.

## Layout in the repository

Of the 57 fetched files, the 54 that are byte-identical to `corpus/_shared/odoo17/www/` (fonts, images,
`web.report_assets_pdf`) are not copied here; this entry's `www/` holds only `web/assets/0c08155/web.report_assets_common.min.css`, the bundle of this print.
The bench serves both directories, this one first. `tiktok_only.woff` and `twitter_x_only.woff` were dropped, as in the
first Odoo entries: they carry no license of their own and no document requests them.
