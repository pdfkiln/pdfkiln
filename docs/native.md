# The pdfkiln command

Called as `pdfkiln`, PDFKiln offers its own interface, with modern print defaults: print media, paper size, margins, headers and footers from the page's CSS (`@page` and its margin boxes). Its options give what the page cannot say itself, and `pdfkiln --help` lists them all:

- for the page: a style sheet of your own (`--css`), its screen rules (`--media screen`), its scale on the paper (`--scale`, below), an element to wait for (`--wait-for`);
- for its requests: headers and cookies for the input's host (`--header`, `--cookie`), and no PDF rather than one without an image, a font or a style sheet that did not load (`--fail-on-resource-error`);
- for the PDF: its title, author, subject and keywords (`--title`, `--author`, `--subject`, `--keywords`), bookmarks from the headings (`--outline`), a tagged PDF for screen readers, from one input (`--tagged`), PDF/A and Factur-X or ZUGFeRD invoices (`--pdfa`, `--factur-x`), and a password (`--user-password`, `--owner-password`), each below;
- images instead of a PDF, and PDFs made elsewhere among the inputs, below too.

It prints Markdown too, which wkhtmltopdf never did: `pdfkiln notes.md notes.pdf`, or an http or https URL of a `.md` file, takes GitHub's dialect (tables, task lists, alerts, footnotes, emoji, raw HTML), math as `$...$` or `\(...\)`, and coloured code, lays it out for paper (page numbers, nothing cut across a page break), and takes the title, author and language from its front matter; `--css` adds to its style.

This interface is young: unlike the wkhtmltopdf command line, it may change in a minor version, as in 1.1.0 and 1.2.0, and the version's notes (`CHANGELOG.md`) say so first.

## PDF/A and Factur-X

wkhtmltopdf wrote neither. `pdfkiln --pdfa` writes PDF/A for archiving, at level 2b, 2u, 3b or 3u (`--pdfa=2u`; 3b without a level), and `pdfkiln --factur-x invoice.xml` attaches an invoice's CII XML, Factur-X or ZUGFeRD, to a PDF/A-3: the page a person reads and the XML a program reads, in one file. Called as `wkhtmltopdf`, PDFKiln keeps the options of wkhtmltopdf 0.12.6 and adds none: these two are for `pdfkiln` only, as Markdown is.

```sh
pdfkiln --factur-x invoice.xml invoice.html invoice.pdf
```

- PDFKiln checks what it can: every font embedded (Chromium embeds them), a Unicode map for each font at the u levels, and in the XML a Cross Industry Invoice with its profile (MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED or XRECHNUNG), number, type and issue date. A PDF that cannot conform is refused, not labelled; a level or an invoice that is wrong is refused before the render.
- The XML is attached as its profile requires: `factur-x.xml`, or `xrechnung.xml` for XRECHNUNG; related as Data for MINIMUM and BASIC WL, which hold only part of the invoice, as Alternative otherwise.
- PDFKiln does not write the XML, which comes from the invoicing software, nor check it against the EN 16931 business rules.
- Not offered: PDF/A-1, which forbids the transparency Chromium draws with, and level A, which needs a fully tagged document.

## Scale

`--scale` prints the page smaller or larger, from 0.1 to 2, as the scale of a browser's print dialog does. The paper keeps its size, so it holds a page as much wider: twice as wide at `--scale 0.5`. A page made for screens then prints as a wide window shows it, not in the layout it keeps for a narrow one. At scale 1, A4 with its 1 cm margins holds 718 pixels across:

```sh
pdfkiln --scale 0.56 https://example.com page.pdf     # as a window 1280 pixels wide shows it
pdfkiln --scale 1.84 https://example.com phone.pdf    # as a phone 390 pixels wide shows it
```

- The page's media queries see the width the paper holds, 718 pixels divided by the scale on A4, and its scripts load in a window at that scale.
- The margins keep their size, with the headers and footers the page puts there (`@page` margin boxes). Links and bookmarks go where the page shows their target.
- For an image, `--scale` counts the pixels per CSS pixel instead: see below.

## Images

`pdfkiln` writes an image instead of a PDF when the output is named `.png`, `.webp`, `.jpg` or `.jpeg`, or with `--to` (for the standard output): the preview of a shared link, a thumbnail, a picture in an email. The page is rendered in screen media, in a window 1280 pixels wide and 720 high, and the image holds the whole page, with the images that wait to be scrolled to (`loading="lazy"`) loaded.

```sh
pdfkiln https://example.com page.png
pdfkiln --width 1200 --height 630 card.html card.webp     # the window alone: 1200 x 630
pdfkiln --element "#chart" --scale 2 report.html chart.png
```

- `--width` and `--height` set the window; with `--height`, the image is the window alone. `--element` captures the first element that matches a CSS selector, wherever it is on the page. `--scale 2` doubles the pixels, for high-density screens.
- WebP is lossless, which keeps text sharp, unless `--quality` asks for less. JPEG takes a quality of 90 unless `--quality` says otherwise. `--transparent` leaves out the white behind a page that paints no background, in PNG and WebP.
- An image takes one input, HTML or Markdown, from a file, a URL or the standard input, under the rules of a PDF: the same access rules and options (`--css`, `--wait-for`, `--header`, `--cookie`, `--fail-on-resource-error`), and no image when the input does not load. Markdown is laid out in a column, as GitHub shows a README.
- WebP stops at 16383 pixels a side, JPEG at 65535: a longer page is refused, with its size; PNG, `--height` or `--element` capture it.

## PDF inputs

`pdfkiln` takes PDFs made elsewhere among its inputs, a file or an http or https URL named `.pdf`: their pages go into the output as they are, in the order of the inputs, before or after the pages it prints. The terms of sale after an invoice, an annex, a cover.

```sh
pdfkiln invoice.html terms.pdf invoice.pdf
pdfkiln cover.pdf report.md annex.pdf report.pdf
```

- A PDF's links to its own pages keep working, and with `--outline` its bookmarks join those of the printed pages. Scripts and attached files stay out: those of its catalog (a script run on opening, attached files, a form) and of its pages (a script run on an event, a link that runs a script or starts a program, a file attached to a page). A bookmark that leads nowhere, a folder for instance, goes to its first child's page. With a PDF first, the document takes its title.
- PDFs alone are merged without starting Chromium.
- A PDF from a URL is fetched under the rules of a page: no private address without `--allow-private-network`, its certificate checked unless `--allow-invalid-certificates`, `--header` and `--cookie` for its host.
- With `--pdfa` or `--factur-x`, a PDF input must be PDF/A itself, as its metadata declares: an invoice in Factur-X with its terms of sale in one file, `pdfkiln --factur-x invoice.xml invoice.html terms.pdf invoice.pdf`. PDFKiln checks the fonts of every page and takes the rest on the PDF's word. Refused: a PDF that is not PDF/A (export it as PDF/A-2b or 3b where it is made), a PDF/A for print, in CMYK (PDFKiln's PDF/A is in sRGB), PDF/A-4, and for a level of part 2, a PDF/A-3 with a file attached to its pages.
- Refused too: an encrypted PDF (PDFKiln does not remove a password or restrictions), a file that is not a PDF, a PDF on the standard input, and a PDF input for an image or with `--tagged`.

## Passwords

`pdfkiln` encrypts the PDF with AES-256 when asked: with a password to open it (`--user-password`), and for restrictions, the owner's password (`--owner-password`), which gives every right.

```sh
pdfkiln --user-password "$PASSWORD" payslip.html payslip.pdf
pdfkiln --owner-password "$OWNER" --no-copy --no-modify quote.html quote.pdf
```

- `--no-print`, `--no-copy` and `--no-modify` bind whoever opens the PDF without the owner's password, and need `--owner-password`, without which anyone may lift them. Screen readers still read a PDF that refuses copying.
- A restriction is a request to the reader's software, which most honour; what keeps a PDF secret is the password to open it.
- PDF/A forbids encryption: `--pdfa` and `--factur-x` take no password.

## Security

Called as `pdfkiln`, the defaults are secure: a page reads no local file but itself unless `--enable-local-file-access` or `--allow <path>` says so, and reaches no loopback, private or link-local address, checked after DNS resolution, unless `--allow-private-network` is given. Nor does it load anything from a server whose certificate does not verify, unless `--allow-invalid-certificates` is given. `--header` and `--cookie` go with the requests to the input's host only: never to another site, nor with a request that another site sends to that host by a redirect, which that site chose; only the input's own request keeps them through its redirects, a login on another site for instance. An input that does not load, refused or in HTTP error, fails the conversion: exit 1, no PDF; with `--fail-on-resource-error`, so does a resource of the page. The conversion stops after 120 s (`--timeout`), and Chromium's sandbox is on (`--no-sandbox`, not recommended).

## Frames of another origin

Chromium leaves two kinds of frames blank: in a PDF, a frame of another origin in a page opened from a file (a path, or the standard input), which it runs in a process of its own; in an image of the whole page, a frame of another origin below the window, which it paints only within the window. PDFKiln loads each again on its own, at its size and under the rules of the page that holds it (that page's host for `--header` and `--cookie`, its access to files), then draws it where it stands: printed, its links with it, in a PDF; captured, in an image. A frame whose content depends on the page that holds it (messages between the two) may come out otherwise.

Some stay as Chromium leaves them: a sandboxed frame, whose scripts would run if it were loaded apart; one hidden, transparent, under a transform or cut by an ancestor; and one that fails to load or to print, without stopping the conversion.
