// The table of contents of wkhtmltopdf 0.12.6: its default style sheet
// (src/lib/tocstylesheet.cc, LGPL-3.0-or-later, reproduced for
// --dump-default-toc-xsl), and the page that style sheet makes of the
// outline, written here directly: Chromium's XSLT is on its way out, it
// only serves a style sheet given with --xsl-style-sheet.
import type { Page } from 'puppeteer-core';
import type { TableOfContent } from './settings.js';
import type { WkItem } from './outline.js';

// QTextStream writes a double with 6 significant digits, %g style; the
// scale is a C float.
function qtNumber(x: number): string {
  return String(Number(x.toPrecision(6)));
}

export function defaultTocXsl(s: TableOfContent): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xsl:stylesheet version="2.0"',
    '                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"',
    '                xmlns:outline="http://wkhtmltopdf.org/outline"',
    '                xmlns="http://www.w3.org/1999/xhtml">',
    '  <xsl:output doctype-public="-//W3C//DTD XHTML 1.0 Strict//EN"',
    '              doctype-system="http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"',
    '              indent="yes" />',
    '  <xsl:template match="outline:outline">',
    '    <html>',
    '      <head>',
    `        <title>${s.captionText}</title>`,
    '        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />',
    '        <style>',
    '          h1 {',
    '            text-align: center;',
    '            font-size: 20px;',
    '            font-family: arial;',
    '          }',
    ...(s.useDottedLines ? ['          div {border-bottom: 1px dashed rgb(200,200,200);}'] : []),
    '          span {float: right;}',
    '          li {list-style: none;}',
    '          ul {',
    '            font-size: 20px;',
    '            font-family: arial;',
    '          }',
    `          ul ul {font-size: ${qtNumber(Math.fround(s.fontScale) * 100)}%; }`,
    '          ul {padding-left: 0em;}',
    `          ul ul {padding-left: ${s.indentation};}`,
    '          a {text-decoration:none; color: black;}',
    '        </style>',
    '      </head>',
    '      <body>',
    `        <h1>${s.captionText}</h1>`,
    '        <ul><xsl:apply-templates select="outline:item/outline:item"/></ul>',
    '      </body>',
    '    </html>',
    '  </xsl:template>',
    '  <xsl:template match="outline:item">',
    '    <li>',
    '      <xsl:if test="@title!=\'\'">',
    '        <div>',
    '          <a>',
    ...(s.forwardLinks
      ? [
        '            <xsl:if test="@link">',
        '              <xsl:attribute name="href"><xsl:value-of select="@link"/></xsl:attribute>',
        '            </xsl:if>',
      ]
      : []),
    '            <xsl:if test="@backLink">',
    '              <xsl:attribute name="name"><xsl:value-of select="@backLink"/></xsl:attribute>',
    '            </xsl:if>',
    '            <xsl:value-of select="@title" /> ',
    '          </a>',
    '          <span> <xsl:value-of select="@page" /> </span>',
    '        </div>',
    '      </xsl:if>',
    '      <ul>',
    '        <xsl:comment>added to prevent self-closing tags in QtXmlPatterns</xsl:comment>',
    '        <xsl:apply-templates select="outline:item"/>',
    '      </ul>',
    '    </li>',
    '  </xsl:template>',
    '</xsl:stylesheet>',
  ];
  return `${lines.join('\n')}\n`;
}

const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => text(s).replace(/"/g, '&quot;');

// What the default style sheet makes of the outline: the headings of
// every object, the roots left out, as indented by the serializer.
export function defaultTocHtml(roots: WkItem[], s: TableOfContent): string {
  const xsl = defaultTocXsl(s);
  const style = xsl.slice(xsl.indexOf('<style>'), xsl.indexOf('</style>') + '</style>'.length);
  const out: string[] = [];
  const item = (it: WkItem, pad: string) => {
    out.push(`${pad}<li>`);
    if (it.title !== '') {
      const href = s.forwardLinks ? ` href="${attr(it.link)}"` : '';
      out.push(`${pad}  <div>`, `${pad}    <a${href} name="${attr(it.backLink)}">${text(it.title)}</a>`, `${pad}    <span>${it.page}</span>`, `${pad}  </div>`);
    }
    out.push(`${pad}  <ul>`, `${pad}    <!--added to prevent self-closing tags in QtXmlPatterns-->`);
    for (const c of it.children) item(c, `${pad}    `);
    out.push(`${pad}  </ul>`, `${pad}</li>`);
  };
  for (const root of roots) for (const it of root.children) item(it, '      ');
  return [
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:outline="http://wkhtmltopdf.org/outline">',
    '  <head>',
    `    <title>${s.captionText}</title>`,
    '    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>',
    `    ${style}`,
    '  </head>',
    '  <body>',
    `    <h1>${s.captionText}</h1>`,
    '    <ul>',
    ...out,
    '    </ul>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

// A style sheet of the caller, run by Chromium's XSLT 1.0 processor
// (wkhtmltopdf had QtXmlPatterns' XSLT 2.0: style sheets that need 2.0
// features fail). Without indentation: libxslt honours indent="yes" even
// between the elements of an entry, and under white-space: pre (EDB's
// style sheet) each entry took three lines, the table five pages where
// wkhtmltopdf's took one.
export async function xsltTocHtml(page: Page, xml: string, xsl: string): Promise<string | null> {
  return page.evaluate((xmlText: string, xslText: string) => {
    if (typeof XSLTProcessor !== 'function') return null;
    const parser = new DOMParser();
    const processor = new XSLTProcessor();
    const sheet = parser.parseFromString(xslText, 'application/xml');
    for (const out of Array.from(sheet.getElementsByTagNameNS('http://www.w3.org/1999/XSL/Transform', 'output'))) out.setAttribute('indent', 'no');
    processor.importStylesheet(sheet);
    const result = processor.transformToDocument(parser.parseFromString(xmlText, 'application/xml'));
    if (!result?.documentElement) return null;
    return new XMLSerializer().serializeToString(result);
  }, xml, xsl);
}
