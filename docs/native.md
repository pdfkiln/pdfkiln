# The pdfkiln command

Called as `pdfkiln`, PDFKiln offers its own interface, with modern print defaults: print media, paper size, margins, headers and footers from the page's CSS (`@page` and its margin boxes). A few options give what the page cannot say itself: a style sheet of your own (`--css`), its screen rules (`--media screen`), the request's headers and cookies (`--header`, `--cookie`), an element to wait for (`--wait-for`), the PDF's title, author, subject and keywords (`--title`, `--author`, `--subject`, `--keywords`), no PDF rather than one without an image, a font or a style sheet that did not load (`--fail-on-resource-error`), PDF/A for archiving and Factur-X or ZUGFeRD invoices (`--pdfa`, `--factur-x`, below); `pdfkiln --help` lists them all. `--outline` adds bookmarks from the headings, and `--tagged` writes a tagged PDF, for screen readers, from one input.

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

## Security

Called as `pdfkiln`, the defaults are secure: a page reads no local file but itself unless `--enable-local-file-access` or `--allow <path>` says so, and reaches no loopback, private or link-local address, checked after DNS resolution, unless `--allow-private-network` is given. Nor does it load anything from a server whose certificate does not verify, unless `--allow-invalid-certificates` is given. `--header` and `--cookie` go with the requests to the input's host only: never to another site, nor with a request that another site sends to that host by a redirect, which that site chose; the input itself keeps them through its own redirects. An input that does not load, refused or in HTTP error, fails the conversion: exit 1, no PDF; with `--fail-on-resource-error`, so does a resource of the page. The conversion stops after 120 s (`--timeout`), and Chromium's sandbox is on (`--no-sandbox`, not recommended).
