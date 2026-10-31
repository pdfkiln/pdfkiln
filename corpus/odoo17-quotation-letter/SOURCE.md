# Odoo 17 quotation, 30 lines with sections and notes (3 pages), US Letter, Light (standard) layout

## Origin

- Application: **Odoo 17.0 Community** (`odoo/release.py`: `version_info = (17, 0, 0, FINAL, 0, '')`),
  branch `17.0` of https://github.com/odoo/odoo at commit `dca5cd22d40f25066919d722bf687be48c51b0ec`
  (committed 2026-10-23T14:40:20Z, "[FIX] mail: truncate long reaction content"), cloned 2026-10-23.
- Python 3.12.13 venv with `requirements.txt` (psycopg2-binary instead of psycopg2) plus `rl-renderPM==4.0.3`, PostgreSQL 16,
  Ubuntu 24.04. `requirements.txt` lists `rl-renderPM` for Windows only ("included in deb package"); without it in a pip
  venv, reportlab 4.1 cannot draw barcodes and every report with a barcode fails. Database created **with demo data**;
  modules installed: `account`, `sale_management`, `stock`, `purchase` (and their dependencies, 66 modules).
- Document: Quotation **S00026** (`sale.order` id 26, state "Quotation"), customer *Azure Interior*, 35 order lines: 3 sections with subtotals, 30 product lines, 2 notes, and terms and conditions. Three US Letter pages. The table header row is printed on page 1 only: the sale order template gives its `<thead>` the style `display: table-row-group`, so wkhtmltopdf does not repeat it.
  Made-up quotation created with `odoo shell` from demo customer and products (sellable demo products cycled by internal reference, quantities 1-8).
- Report action: `sale.action_report_saleorder` (report `sale.report_saleorder`).
- Templates: `sale.report_saleorder` → `sale.report_saleorder_raw` → `sale.report_saleorder_document` (extended by `sale_management` and `sale_stock`) → `web.external_layout` → `web.external_layout_standard` ("Light"), plus `web.html_container`, `web.report_layout`, `web.address_layout`, `sale.document_tax_totals`; pages wrapped by `web.minimal_layout`.
- Sources: <https://github.com/odoo/odoo/blob/dca5cd22d40f25066919d722bf687be48c51b0ec/addons/sale/report/ir_actions_report_templates.xml>, <https://github.com/odoo/odoo/blob/dca5cd22d40f25066919d722bf687be48c51b0ec/addons/sale/report/ir_actions_report.xml>,
  <https://github.com/odoo/odoo/blob/dca5cd22d40f25066919d722bf687be48c51b0ec/addons/web/views/report_templates.xml> (layouts, `web.minimal_layout` with the `subst()` script),
  <https://github.com/odoo/odoo/blob/dca5cd22d40f25066919d722bf687be48c51b0ec/odoo/addons/base/models/ir_actions_report.py> (`_build_wkhtmltopdf_args`, `_prepare_html`, `_run_wkhtmltopdf`).
- Company settings: demo company "My Company (San Francisco)", demo placeholder logo ("Your logo", embedded by Odoo as a
  `data:` URI), font Lato, no custom colours, layout background "Blank", report layout `web.external_layout_standard` ("Light") set on
  `res.company.external_report_layout_id`. Paper format: "US Letter" (`base.paperformat_us`, a record of the base module), set on the company for this print: format Letter, margins top 40 / bottom 30 / left 7 / right 7 mm, header spacing 35, dpi 90.

## Capture

- The Odoo server (threaded mode, `workers = 0`, 127.0.0.1:8069, `web.base.url` and `report.url` =
  `http://127.0.0.1:8069`) ran with `bench/capture/wkhtmltopdf-shim.py` first on `PATH` under the name
  `wkhtmltopdf`, in front of the official wkhtmltopdf 0.12.6-1 build ("0.12.6 (with patched qt)").
  At start-up Odoo logged `Will use the Wkhtmltopdf binary at ...` and reported state `ok`.
- The report was printed the way the web client does it (second capture round, 2026-10-23): log in as `admin` over HTTP,
  set the layout (Light) and the paper format (US Letter) with a JSON-RPC `write` on `res.company`, then `GET /report/pdf/sale.report_saleorder/26`.
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
  Bundles: `/web/assets/414e890/web.report_assets_pdf.min.css`, `/web/assets/bb08517/web.report_assets_common.min.css`. 57 files, 4.0 MB.
- Left out of `www/` (none of them is requested when this document is rendered):
  90 `https://fonts.odoocdn.com/fonts/noto/...` URLs (family "Odoo Unicode Support Noto",
  restricted by `unicode-range` to non-Latin scripts; external host); 154 dynamic
  `/web_editor/shape/...svg?c1=...` URLs (website section backgrounds); `/base/static/src/img/layout/play-button.png` and
  `play-button-over.png`, which answer 404 on the Odoo server itself.
- Calls and JavaScript: no `<script src>`; the header and footer carry Odoo's inline `subst()` script
  (`<body onload="subst()">`), which fills `.page` / `.topage` and keeps the header/footer of record `index`.
  `--javascript-delay 1000` comes from the `report.print_delay` default.
- After wkhtmltopdf: The module `sale_pdf_quote_builder` (auto-installed with `sale_management`) then merges demo header/footer PDF pages around the wkhtmltopdf output: Odoo returns 10 pages, wkhtmltopdf produced 3. Only the wkhtmltopdf call is in this entry.
- The PDF the real wkhtmltopdf wrote during the capture has **3 pages** (612 x 792 pt). Like
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
0, no 404, 3 pages as in the capture, same extracted text, pages identical pixel for pixel to the capture PDF
(PyMuPDF, 100 dpi). Requested files: `/web/assets/414e890/web.report_assets_pdf.min.css`, `/web/assets/bb08517/web.report_assets_common.min.css`, `/web/static/fonts/lato/Lato-Reg-webfont.woff`, `/web/static/fonts/lato/Lato-Lig-webfont.woff`, `/web/static/fonts/lato/Lato-Hai-webfont.woff`, `/web/static/fonts/lato/Lato-RegIta-webfont.woff`, `/web/static/fonts/lato/Lato-Bol-webfont.woff`, `/web/static/fonts/lato/Lato-Bla-webfont.woff`, `/web/static/fonts/lato/Lato-LigIta-webfont.woff`, `/web/static/fonts/lato/Lato-HaiIta-webfont.woff`, `/web/static/fonts/lato/Lato-BlaIta-webfont.woff`, `/web/static/fonts/lato/Lato-BolIta-webfont.woff`. The wkhtmltopdf run of the bench
(`node dist/bench/compat.js odoo17-quotation-letter`, its own server and port) gives the same pixels, and neither wkhtmltopdf nor
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
- `versioned: true`: every component allows redistribution.

## Layout in the repository

Of the 57 fetched files, the 54 that are byte-identical to `corpus/_shared/odoo17/www/` (fonts, images,
`web.report_assets_pdf`) are not copied here; this entry's `www/` holds only `web/assets/bb08517/web.report_assets_common.min.css`, the bundle of this print.
The bench serves both directories, this one first. `tiktok_only.woff` and `twitter_x_only.woff` were dropped, as in the
first Odoo entries: they carry no license of their own and no document requests them.
