# Options of the compatible mode

Called as `wkhtmltopdf`, PDFKiln accepts the 122 options of wkhtmltopdf 0.12.6, with the same sections: global options before the first page (page options there are defaults for every page), page options after a page or `cover`. Generated from `src/wk/options.ts` by `node dist/scripts/options-doc.js`.

## Implemented (98)

| Option | Short | Section | Description |
| --- | --- | --- | --- |
| `--help` | `-h` | global | Display help |
| `--version` | `-V` | global | Output version information and exit |
| `--license` |  | global | Output license information and exit |
| `--extended-help` | `-H` | global | Display help, including less common options |
| `--manpage` |  | global | Output the help as a man page |
| `--htmldoc` |  | global | Output the help as HTML |
| `--readme` |  | global | Output the help as plain text |
| `--quiet` | `-q` | global | Same as --log-level none |
| `--log-level <level>` |  | global | Set log level to: none, error, warn or info |
| `--no-collate` |  | global | Do not collate copies |
| `--collate` |  | global | Collate copies |
| `--copies <number>` |  | global | Number of copies in the PDF |
| `--orientation <orientation>` | `-O` | global | Set orientation to Landscape or Portrait |
| `--page-size <size>` | `-s` | global | Set paper size: A4, Letter... |
| `--grayscale` | `-g` | global | Render in grayscale |
| `--title <text>` |  | global | Document title (default: title of the first page) |
| `--read-args-from-stdin` |  | global | Read one command line per line of the standard input |
| `--margin-bottom <unitreal>` | `-B` | global | Bottom margin |
| `--margin-left <unitreal>` | `-L` | global | Left margin (default 10mm) |
| `--margin-right <unitreal>` | `-R` | global | Right margin (default 10mm) |
| `--margin-top <unitreal>` | `-T` | global | Top margin |
| `--page-height <unitreal>` |  | global | Page height |
| `--page-width <unitreal>` |  | global | Page width |
| `--cookie-jar <path>` |  | global | Read and write cookies from and to this file |
| `--outline` |  | global | Add an outline (default) |
| `--no-outline` |  | global | Do not add an outline |
| `--outline-depth <level>` |  | global | Depth of the outline (default 4) |
| `--dump-outline <file>` |  | global | Dump the outline to a file |
| `--dump-default-toc-xsl` |  | global | Dump the default TOC style sheet |
| `--default-header` |  | page | Page name on the left, page number on the right, top margin 2cm |
| `--viewport-size <size>` |  | page | Viewport size, WIDTHxHEIGHT, for media queries |
| `--minimum-font-size <int>` |  | page | Minimum font size |
| `--user-style-sheet <path>` |  | page | Style sheet loaded with every page |
| `--no-images` |  | page | Do not load or print images |
| `--images` |  | page | Load and print images (default) |
| `--disable-javascript` | `-n` | page | Do not run JavaScript |
| `--enable-javascript` |  | page | Run JavaScript (default) |
| `--encoding <encoding>` |  | page | Default text encoding of the input |
| `--no-background` |  | page | Do not print backgrounds |
| `--background` |  | page | Print backgrounds (default) |
| `--include-in-outline` |  | page | Include the page in the outline (default) |
| `--exclude-from-outline` |  | page | Leave the page out of the outline |
| `--disable-smart-shrinking` |  | page | Chromium's natural scale instead of WebKit's shrinking |
| `--enable-smart-shrinking` |  | page | WebKit's shrinking, scale 0.8 (default) |
| `--print-media-type` |  | page | Use the print media type instead of screen |
| `--no-print-media-type` |  | page | Use the screen media type (default) |
| `--disable-internal-links` |  | page | Do not make internal links |
| `--disable-external-links` |  | page | Do not make links to web pages |
| `--keep-relative-links` |  | page | Keep relative links relative |
| `--enable-toc-back-links` |  | page | Link headings back to the TOC |
| `--proxy <proxy>` | `-p` | page | Use a proxy: [http://\|socks5://][user[:password]@]host[:port], or none |
| `--bypass-proxy-for <value>` |  | page | Do not use the proxy for this host (repeatable) |
| `--username <username>` |  | page | HTTP authentication user name |
| `--password <password>` |  | page | HTTP authentication password |
| `--ssl-key-path <path>` |  | page | Client certificate private key, PEM |
| `--ssl-key-password <password>` |  | page | Password of the client certificate key |
| `--ssl-crt-path <path>` |  | page | Client certificate, PEM |
| `--load-error-handling <handler>` |  | page | Pages that fail to load: abort, ignore or skip |
| `--load-media-error-handling <handler>` |  | page | Media that fail to load: abort, ignore or skip |
| `--custom-header <name> <value>` |  | page | Add an HTTP header (repeatable) |
| `--custom-header-propagation` |  | page | Send --custom-header with every request |
| `--no-custom-header-propagation` |  | page | Same as --custom-header-propagation, as in wkhtmltopdf 0.12.6 |
| `--javascript-delay <msec>` |  | page | Wait up to this long after loading (default 200), less once nothing can change the page |
| `--window-status <windowStatus>` |  | page | Wait until window.status equals this string |
| `--zoom <float>` |  | page | Zoom factor |
| `--cookie <name> <value>` |  | page | Add a cookie, URL-encoded (repeatable) |
| `--post <name> <value>` |  | page | Add a POST field (repeatable) |
| `--post-file <name> <path>` |  | page | POST a file (repeatable) |
| `--disable-local-file-access` |  | page | Local pages may not read other local files, except --allow (default) |
| `--enable-local-file-access` |  | page | Local pages may read other local files |
| `--allow <path>` |  | page | Allow the files of this folder (repeatable) |
| `--run-script <js>` |  | page | Run this JavaScript after loading (repeatable) |
| `--page-offset <offset>` |  | page | Number added to page numbers (default 0) |
| `--footer-center <text>` |  | page | Centered footer text |
| `--footer-font-name <name>` |  | page | Footer font (default Arial) |
| `--footer-font-size <size>` |  | page | Footer font size (default 12) |
| `--footer-left <text>` |  | page | Left footer text |
| `--footer-line` |  | page | Line above the footer |
| `--no-footer-line` |  | page | No line above the footer (default) |
| `--footer-right <text>` |  | page | Right footer text |
| `--footer-spacing <real>` |  | page | Space between footer and content, mm |
| `--footer-html <url>` |  | page | HTML footer |
| `--header-center <text>` |  | page | Centered header text |
| `--header-font-name <name>` |  | page | Header font (default Arial) |
| `--header-font-size <size>` |  | page | Header font size (default 12) |
| `--header-left <text>` |  | page | Left header text |
| `--header-line` |  | page | Line below the header |
| `--no-header-line` |  | page | No line below the header (default) |
| `--header-right <text>` |  | page | Right header text |
| `--header-spacing <real>` |  | page | Space between header and content, mm |
| `--header-html <url>` |  | page | HTML header |
| `--replace <name> <value>` |  | page | Replace [name] by value in headers and footers (repeatable) |
| `--xsl-style-sheet <file>` |  | toc | XSL style sheet of the TOC |
| `--toc-header-text <text>` |  | toc | Title of the TOC |
| `--disable-toc-links` |  | toc | No links from the TOC |
| `--disable-dotted-lines` |  | toc | No dotted lines in the TOC |
| `--toc-text-size-shrink <real>` |  | toc | Font scale per TOC level |
| `--toc-level-indentation <width>` |  | toc | Indentation per TOC level |

## Accepted without effect (24)

A warning unless `--quiet`, never an effect on the exit code; none for `--lowquality`, which knp-snappy passes on every call, nor for the options that restate the default.

| Option | Short | Section | Description |
| --- | --- | --- | --- |
| `--lowquality` | `-l` | global | Accepted, no effect |
| `--dpi <dpi>` | `-d` | global | Accepted, no effect |
| `--image-quality <integer>` |  | global | Accepted, no effect |
| `--image-dpi <integer>` |  | global | Accepted, no effect |
| `--no-pdf-compression` |  | global | Accepted, no effect |
| `--use-xserver` |  | global | Accepted, no effect |
| `--enable-plugins` |  | page | Accepted, no effect |
| `--disable-plugins` |  | page | Accepted, no effect (default) |
| `--enable-forms` |  | page | Accepted, no effect |
| `--disable-forms` |  | page | Accepted, no effect (default) |
| `--enable-internal-links` |  | page | Make internal links (default) |
| `--enable-external-links` |  | page | Make links to web pages (default) |
| `--resolve-relative-links` |  | page | Make relative links absolute (default) |
| `--disable-toc-back-links` |  | page | No links back to the TOC (default) |
| `--proxy-hostname-lookup` |  | page | Accepted, no effect |
| `--cache-dir <path>` |  | page | Accepted, no effect |
| `--debug-javascript` |  | page | Accepted, no effect |
| `--no-debug-javascript` |  | page | Accepted, no effect (default) |
| `--stop-slow-scripts` |  | page | Accepted; --kiln-timeout bounds the conversion |
| `--no-stop-slow-scripts` |  | page | Accepted; --kiln-timeout bounds the conversion |
| `--checkbox-svg <path>` |  | page | Accepted, no effect |
| `--checkbox-checked-svg <path>` |  | page | Accepted, no effect |
| `--radiobutton-svg <path>` |  | page | Accepted, no effect |
| `--radiobutton-checked-svg <path>` |  | page | Accepted, no effect |

## Ours

| Option | Short | Section | Description |
| --- | --- | --- | --- |
| `--kiln-timeout <seconds>` |  | global | Stop the conversion and Chromium after this many seconds (default 120, 0: none) |
| `--kiln-block-private-network` |  | global | Refuse loopback, private and link-local addresses |
| `--kiln-no-sandbox` |  | global | Run Chromium without its sandbox (not recommended) |

## Kept as in wkhtmltopdf 0.12.6

`--no-custom-header-propagation` turns the propagation on, like `--custom-header-propagation`: a mistake in wkhtmltopdf's code, which the commands written for it rely on.

## wkhtmltoimage

Called as `wkhtmltoimage`, PDFKiln accepts the 63 options of wkhtmltoimage 0.12.6, all global, followed by the input and the output; 50 have an effect, the others are accepted without effect, as in wkhtmltopdf. The `--kiln-` options above apply too.

| Option | Short | Description |
| --- | --- | --- |
| `--allow <path>` |  | Allow the files of this folder (repeatable) |
| `--bypass-proxy-for <value>` |  | Do not use the proxy for this host (repeatable) |
| `--cache-dir <path>` |  | Accepted, no effect |
| `--checkbox-checked-svg <path>` |  | Accepted, no effect |
| `--checkbox-svg <path>` |  | Accepted, no effect |
| `--cookie <name> <value>` |  | Add a cookie, URL-encoded (repeatable) |
| `--cookie-jar <path>` |  | Read and write cookies from and to this file |
| `--crop-h <int>` |  | Height of the cropped area |
| `--crop-w <int>` |  | Width of the cropped area |
| `--crop-x <int>` |  | Left of the cropped area |
| `--crop-y <int>` |  | Top of the cropped area |
| `--custom-header <name> <value>` |  | Add an HTTP header (repeatable) |
| `--custom-header-propagation` |  | Send --custom-header with every request |
| `--debug-javascript` |  | Accepted, no effect |
| `--disable-javascript` | `-n` | Do not run JavaScript |
| `--disable-local-file-access` |  | Local pages may not read other local files, except --allow (default) |
| `--disable-plugins` |  | Accepted, no effect (default) |
| `--disable-smart-width` |  | Keep --width even if the content is wider |
| `--enable-javascript` |  | Run JavaScript (default) |
| `--enable-local-file-access` |  | Local pages may read other local files |
| `--enable-plugins` |  | Accepted, no effect |
| `--enable-smart-width` |  | Widen --width to fit the content (default) |
| `--encoding <encoding>` |  | Default text encoding of the input |
| `--extended-help` | `-H` | Display help, including less common options |
| `--format <format>` | `-f` | jpg, png, bmp, ppm, xpm, xbm or svg (default: the extension of the output, jpg for -) |
| `--height <int>` |  | Screen height (default: the height of the content) |
| `--help` | `-h` | Display help |
| `--htmldoc` |  | Output the help as HTML |
| `--images` |  | Load and print images (default) |
| `--javascript-delay <msec>` |  | Wait up to this long after loading (default 200), less once nothing can change the page |
| `--license` |  | Output license information and exit |
| `--load-error-handling <handler>` |  | Pages that fail to load: abort, ignore or skip |
| `--load-media-error-handling <handler>` |  | Media that fail to load: abort, ignore or skip |
| `--log-level <level>` |  | Set log level to: none, error, warn or info |
| `--manpage` |  | Output the help as a man page |
| `--minimum-font-size <int>` |  | Minimum font size |
| `--no-custom-header-propagation` |  | Same as --custom-header-propagation, as in wkhtmltopdf 0.12.6 |
| `--no-debug-javascript` |  | Accepted, no effect (default) |
| `--no-images` |  | Do not load or print images |
| `--no-stop-slow-scripts` |  | Accepted; --kiln-timeout bounds the conversion |
| `--password <password>` |  | HTTP authentication password |
| `--post <name> <value>` |  | Add a POST field (repeatable) |
| `--post-file <name> <path>` |  | POST a file (repeatable) |
| `--proxy <proxy>` | `-p` | Use a proxy: [http://\|socks5://][user[:password]@]host[:port], or none |
| `--proxy-hostname-lookup` |  | Accepted, no effect |
| `--quality <int>` |  | JPEG quality, 0 to 100 (default 94) |
| `--quiet` | `-q` | Same as --log-level none |
| `--radiobutton-checked-svg <path>` |  | Accepted, no effect |
| `--radiobutton-svg <path>` |  | Accepted, no effect |
| `--readme` |  | Output the help as plain text |
| `--run-script <js>` |  | Run this JavaScript after loading (repeatable) |
| `--ssl-crt-path <path>` |  | Client certificate, PEM |
| `--ssl-key-password <password>` |  | Password of the client certificate key |
| `--ssl-key-path <path>` |  | Client certificate private key, PEM |
| `--stop-slow-scripts` |  | Accepted; --kiln-timeout bounds the conversion |
| `--transparent` |  | Transparent background, in PNG and SVG |
| `--use-xserver` |  | Accepted, no effect |
| `--user-style-sheet <path>` |  | Style sheet loaded with every page |
| `--username <username>` |  | HTTP authentication user name |
| `--version` | `-V` | Output version information and exit |
| `--width <int>` |  | Screen width (default 1024), widened to fit the content unless --disable-smart-width |
| `--window-status <windowStatus>` |  | Wait until window.status equals this string |
| `--zoom <float>` |  | Zoom factor |
