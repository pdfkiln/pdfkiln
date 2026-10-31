// One conversion of the compatible mode, in wkhtmltopdf 0.12.6's phases
// (src/lib/pdfconverter.cc): load the pages, print each with Chromium,
// render the headers and footers, put everything together.
import { accessSync, constants, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { removeQuietly } from '../engine/browser.js';
import type { Emulation } from '../engine/emulation.js';
import { emulate, openPage, type LoadedPage, type LoadSpec } from '../engine/loader.js';
import { relayGet } from '../engine/relay.js';
import {
  fixDests, merge, moveDest, prune, readOutline, repeatPages, retargetLinks, setPageSize, writeOutline, type FinalItem, type LinkFate, type OutlineItem,
} from '../pdf/assemble.js';
import { version } from '../version.js';
import { Chromium, loadJar, saveJar } from './chromium.js';
import type { Feedback } from './feedback.js';
import { hasText, measure, printDocument, renderHtml, stamp, textDocument, withParms, type Geometry, type Layer, type Parms } from './headers.js';
import { anchorsOf, fragmentOf, linkHeadings, markTargets, pageKey, tocAnchorNames, type Anchor } from './links.js';
import { Anchors, buildOutline, outlineXml, sameTree, type WkDoc, type WkItem } from './outline.js';
import type { Parsed } from './parse.js';
import type { HeaderFooter, PdfObject, UnitReal } from './settings.js';
import { defaultTocHtml, xsltTocHtml } from './toc.js';
import { PAGE_SIZES, toMm } from './units.js';
import { guessUrlFromString, looksLikeHtmlAndNotAUrl } from './urls.js';

const PX_PER_MM = 96 / 25.4;
const PT_PER_MM = 72 / 25.4;

export interface Result {
  success: boolean;
  errorCode: number;
}

export interface Io {
  stdin: () => Buffer;
  stdout: (data: Uint8Array) => void;
  onTimeout: (line: string) => void;
}

const unset = (u: UnitReal) => u.value === -1;

// Smart shrinking lays the page out on 1.25 times its width, then shrinks
// it: 0.8, measured. --zoom multiplies it.
function scaleOf(o: PdfObject, shrinking = o.web.enableIntelligentShrinking): number {
  return Math.min(2, Math.max(0.1, (shrinking ? 0.8 : 1) * o.load.zoomFactor));
}

function viewportOf(s: string): [number, number] {
  if (!s) return [0, 0];
  const parts = s.split('x');
  const w = parseInt(parts[0] ?? '', 10);
  const h = parseInt(parts[parts.length - 1] ?? '', 10);
  return w > 0 && h > 0 ? [w, h] : [0, 0];
}

// src/lib/outline.cc buildHFCache: for each of three levels, the first
// heading of each page, carried over to the pages that have none.
export function sectionCache(roots: OutlineItem[][], prefix: number[], pageCount: number): (string | null)[][] {
  const hf: (OutlineItem | null)[][] = [[null], [null], [null]];
  const build = (items: OutlineItem[], doc: number, level: number) => {
    if (level >= 3) return;
    for (const j of items) {
      const page = j.page + 1 + prefix[doc]!;
      const l = hf[level]!;
      while (l.length < page) l.push(l[l.length - 1]!);
      if (l.length === page) l.push(j);
      build(j.children, doc, level + 1);
    }
  };
  roots.forEach((items, doc) => build(items, doc, 0));
  return hf.map((l) => {
    while (l.length <= pageCount) l.push(l[l.length - 1]!);
    return l.map((i) => i?.title ?? null);
  });
}

// PDFKILN_EMULATION turns emulations on or off for the bench, by name:
// "+wholePixelLineHeights,-truncateTopMargin".
function emulationSwitches(): Partial<Emulation> {
  const out: Record<string, boolean> = {};
  for (const s of (process.env.PDFKILN_EMULATION ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    out[s.replace(/^[+-]/, '')] = !s.startsWith('-');
  }
  return out as Partial<Emulation>;
}

// PDFKILN_TIMINGS=1 writes the time of each step, in ms, on stderr.
const timings: Record<string, number> = {};
let mark = 0;
const step = (name: string) => {
  const now = performance.now();
  timings[name] = Math.round(now - mark);
  mark = now;
};

export async function convert(p: Parsed, fb: Feedback, io: Io): Promise<Result> {
  const { g } = p;
  mark = performance.now();
  timings.boot = Math.round(mark);
  const fail = (errorCode = 0): Result => ({ success: false, errorCode });

  for (const spec of new Set(p.used)) {
    if (spec.support === 'noop') fb.warning(`--${spec.name} has no effect with pdfkiln`);
  }
  const objects = p.objects;
  const isToc = (o: PdfObject) => o.kind === 'toc';
  for (const o of objects) {
    for (const [which, h] of [['header', o.header], ['footer', o.footer]] as const) {
      if (h.htmlUrl && looksLikeHtmlAndNotAUrl(h.htmlUrl)) {
        fb.error(`--${which}-html should be a URL and not a string containing HTML code.`);
        return fail();
      }
    }
  }
  if (g.kiln.noSandbox) fb.warning("Chromium's sandbox is off (--kiln-no-sandbox)");

  // Paper and margins, in millimetres.
  let [width, height] = !unset(g.pageWidth) && !unset(g.pageHeight)
    ? [toMm(g.pageWidth, g.dpi), toMm(g.pageHeight, g.dpi)]
    : PAGE_SIZES[g.pageSize]!;
  if (g.orientation === 'Landscape') [width, height] = [height, width];
  const left = toMm(g.margin.left, g.dpi);
  const right = toMm(g.margin.right, g.dpi);
  const contentWidth = width - left - right;
  const sameUnits = new Set([g.margin.left.unit, g.margin.right.unit, g.margin.top.unit, g.margin.bottom.unit]).size === 1;

  const work = mkdtempSync(join(tmpdir(), 'pdfkiln-'));
  const chromium = new Chromium();
  try {
    fb.phaseChanged(0);
    fb.progressChanged(0, '0%');

    const block = g.kiln.blockPrivateNetwork;
    const proxy = objects.find((o) => o.load.proxy)?.load.proxy ?? null;
    const context = await chromium.start(g, proxy, objects[0]!.load.bypassProxyForHosts, work, fb, io.onTimeout);
    const fontFamily = chromium.fontFamily;
    step('launch');
    if (chromium.served) timings.served = 1;
    if (g.cookieJar) await loadJar(context, g.cookieJar);

    // The page itself: a URL, a file, or the standard input.
    let stdin: Buffer | undefined;
    const urls = objects.map((o, i) => {
      if (isToc(o)) return '';
      if (o.page !== '-') return guessUrlFromString(o.page);
      stdin ??= io.stdin();
      const file = join(work, `stdin-${i}.html`);
      writeFileSync(file, stdin);
      stdin = Buffer.alloc(0); // A second "-" finds it empty, as in wkhtmltopdf.
      return pathToFileURL(file).href;
    });
    // --post-file: a file that cannot be read fails the conversion.
    for (const o of objects) {
      for (const i of o.load.post) {
        if (!i.file) continue;
        try {
          accessSync(i.value, constants.R_OK);
        } catch {
          fb.error(`Unable to open file ${i.value}`);
          return fail();
        }
      }
    }
    const userCss = new Map<string, string>();
    for (const o of objects) {
      const s = o.web.userStyleSheet;
      if (!s || userCss.has(s)) continue;
      userCss.set(s, await readStyleSheet(s, block));
    }

    const emulationOf = (o: PdfObject): Emulation => ({
      mediaViewport: viewportOf(g.viewportSize),
      screenTypes: !o.web.printMediaType,
      dropPageRules: true,
      roundFontSizes: true,
      truncateTopMargin: true,
      minimumFontSize: o.web.minimumFontSize > 0 ? o.web.minimumFontSize : 0,
      grayscale: g.grayscale,
      noDefaultWidows: true,
      unsplitRows: true,
      webkit534Css: true,
      noShrinkToFit: !o.web.enableIntelligentShrinking,
      ...emulationSwitches(),
    });
    // wkhtmltopdf loads headers and footers with Qt's default settings and
    // applies the object's only when it prints them: their scripts run and
    // their images load whatever --disable-javascript and --no-images say.
    const specOf = (o: PdfObject, isMain: boolean): Omit<LoadSpec, 'url' | 'viewport'> => ({
      web: isMain ? o.web : { ...o.web, enableJavascript: true, loadImages: true },
      load: o.load,
      isMain,
      media: o.web.printMediaType ? 'print' : 'screen',
      emulation: emulationOf(o),
      fontFamily,
      blockPrivateNetwork: block,
      userStyleSheet: o.web.userStyleSheet ? userCss.get(o.web.userStyleSheet) : undefined,
    });

    // Headers and footers are measured first: their size places them, and
    // gives the margins when --margin-top or --margin-bottom is not given.
    const needCalc = objects.some((o) => (o.header.htmlUrl && unset(g.margin.top)) || (o.footer.htmlUrl && unset(g.margin.bottom)));
    const measureAt = (o: PdfObject, h: HeaderFooter, scale: number) =>
      measure(context, guessUrlFromString(h.htmlUrl), { width: contentWidth, scale, spec: specOf(o, false) }, fb);
    const measures = objects.map((o) => {
      const one = (h: HeaderFooter) => (h.htmlUrl ? measureAt(o, h, scaleOf(o)) : undefined);
      return { header: one(o.header), footer: one(o.footer) };
    });
    // wkhtmltopdf's margin (calculateHeaderHeight): the height of the
    // body, printed with Qt's default settings, so with smart shrinking,
    // in printer pixels at --dpi, taken for points and turned into
    // millimetres; plus the spacing.
    const reserve = async (which: 'header' | 'footer') => {
      let max = 0;
      for (const [i, o] of objects.entries()) {
        const h = o[which];
        if (!h.htmlUrl) continue;
        const m = scaleOf(o, true) === scaleOf(o) ? await measures[i]![which]! : await measureAt(o, h, scaleOf(o, true));
        max = Math.max(max, (m.m.box * g.dpi) / 72 + h.spacing);
      }
      return max;
    };
    const top = !unset(g.margin.top) ? toMm(g.margin.top, g.dpi) : needCalc ? await reserve('header') : 10;
    const bottom = !unset(g.margin.bottom) ? toMm(g.margin.bottom, g.dpi) : needCalc ? await reserve('footer') : 10;
    const contentHeight = height - top - bottom;

    const pageViewport = (o: PdfObject) => ({ width: (contentWidth * PX_PER_MM) / scaleOf(o), height: (Math.max(contentHeight, 1) * PX_PER_MM) / scaleOf(o) });
    // Tables of contents are made once the pages are printed.
    const loaded: (LoadedPage | undefined)[] = await Promise.all(objects.map((o, i) => (isToc(o)
      ? undefined
      : openPage(context, { ...specOf(o, true), url: urls[i]!, viewport: pageViewport(o) }, fb))));
    fb.progressChanged(100, '100%');
    step('load');
    const pages = loaded.filter((l): l is LoadedPage => Boolean(l));
    if (g.cookieJar && pages[0]) await saveJar(pages[0], g.cookieJar);
    let errorCode = Math.max(0, ...pages.map((l) => l.errorCode));
    if (loaded.some((l, i) => l && !l.ok && objects[i]!.load.loadErrorHandling === 'abort')) return fail(errorCode);
    if (!sameUnits) {
      fb.error('Currently all margin units must be the same!');
      return fail(errorCode);
    }

    // Counting pages: each page printed on its own, with the outline when
    // it is wanted or when headers may show a section.
    fb.phaseChanged(1);
    const sectionsUsed = objects.some((o) => o.header.htmlUrl || o.footer.htmlUrl ||
      [o.header, o.footer].some((h) => /\[(sub)*section\]/i.test(h.left + h.center + h.right)));
    const hasToc = objects.some(isToc);
    const needOutline = g.outline || sectionsUsed || hasToc || Boolean(g.dumpOutline);
    const live: { l: LoadedPage; o: PdfObject }[] = [];
    loaded.forEach((l, i) => {
      if (isToc(objects[i]!) || !l!.skipped) live.push({ l: l!, o: objects[i]! });
    });
    // Links between objects (findLinks): the objects by URL, the last one
    // winning, and the elements that links of other objects point at.
    const anchorLists: Anchor[][] = await Promise.all(live.map(({ l, o }) => (isToc(o) ? [] : anchorsOf(l.page))));
    const byKey = new Map<string, number>();
    live.forEach(({ l, o }, k) => !isToc(o) && byKey.set(pageKey(l.page.url()), k));
    const wanted = live.map(() => new Set<string>());
    live.forEach(({ o }, k) => {
      if (!o.useLocalLinks) return;
      for (const a of anchorLists[k]!) {
        const t = byKey.get(pageKey(a.href));
        const f = fragmentOf(a.href);
        if (t !== undefined && f) wanted[t]!.add(f);
      }
    });
    const destNames = live.map(() => new Map<string, string>());
    // --enable-toc-back-links, from the object of the heading.
    const backLinks = live.some(({ o }) => o.toc.backLinks);
    const headingCount = live.map(() => 0);
    const printOne = async (l: LoadedPage, o: PdfObject, withOutline: boolean, k: number) => {
      await emulate(l);
      if (wanted[k]!.size) destNames[k] = await markTargets(l.page, [...wanted[k]!]);
      if (isToc(o) && backLinks) destNames[k] = await markTargets(l.page, await tocAnchorNames(l.page));
      if (o.toc.backLinks) headingCount[k] = await linkHeadings(l.page);
      // The style sheets no longer depend on the media type: print media
      // makes Chromium repeat table headers.
      if (!o.web.printMediaType) await l.cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      const pdf = await l.page.pdf({
        width: `${width}mm`,
        height: `${height}mm`,
        margin: { top: `${top}mm`, bottom: `${bottom}mm`, left: `${left}mm`, right: `${right}mm` },
        printBackground: o.web.background,
        scale: scaleOf(o),
        preferCSSPageSize: false,
        tagged: withOutline,
        outline: withOutline,
      });
      const doc = await PDFDocument.load(pdf, { updateMetadata: false });
      fixDests(doc, left * PT_PER_MM, top * PT_PER_MM, scaleOf(o));
      return { doc, outline: withOutline ? readOutline(doc) : [], pages: doc.getPageCount() };
    };
    let done = 0;
    const toPrint = live.filter(({ o }) => !isToc(o));
    const printed: ({ doc: PDFDocument; outline: OutlineItem[]; pages: number } | undefined)[] = await Promise.all(live.map(async ({ l, o }, k) => {
      if (isToc(o)) return undefined;
      const r = await printOne(l, o, needOutline, k);
      fb.progressChanged((++done * 100) / toPrint.length, `Object ${done} of ${toPrint.length}`);
      return r;
    }));

    // The outline as wkhtmltopdf keeps it, and the tables of contents made
    // from it, printed again until their page count and headings settle
    // (loadTocs, tocLoaded).
    const anchors = new Anchors();
    const replaced = new Map<number, number>();
    const docOf = (k: number): WkDoc => {
      const { l, o } = live[k]!;
      const pr = printed[k];
      if (!pr || (!isToc(o) && !o.includeInOutline)) return { empty: true, title: '', pages: 1, items: [] };
      return { empty: false, title: isToc(o) ? o.toc.captionText : l.title, pages: pr.pages, items: pr.outline };
    };
    const outlineNow = () => buildOutline(live.map((_, k) => docOf(k)), g.pageOffset, (k, n) => anchors.forDoc(k, n, (replaced.get(k) ?? 0) >= 2));
    let wk: WkItem[] = needOutline ? outlineNow() : [];
    if (hasToc) {
      fb.phaseChanged(2);
      for (let pass = 0; pass < 6; pass++) {
        const xml = outlineXml(wk);
        let changed = false;
        for (const [k, { o }] of live.entries()) {
          if (!isToc(o)) continue;
          let html = defaultTocHtml(wk, o.toc);
          if (o.tocXsl) {
            let xsl: string;
            try {
              xsl = readFileSync(o.tocXsl, 'utf8');
            } catch {
              fb.error('Could not read the TOC XSL');
              return fail(errorCode);
            }
            const made = await xsltTocHtml(live.find((x) => !isToc(x.o))?.l.page ?? (await context.newPage()), xml, xsl);
            if (made === null) {
              fb.error('Could not apply the TOC XSL');
              return fail(errorCode);
            }
            html = made;
          }
          const file = join(work, `toc-${k}-${pass}.html`);
          writeFileSync(file, html);
          const l = await openPage(context, { ...specOf(o, true), url: pathToFileURL(file).href, viewport: pageViewport(o) }, fb);
          const r = await printOne(l, o, true, k);
          const old = printed[k];
          changed ||= !old || old.pages !== r.pages || !sameTree(old.outline, r.outline);
          if (old) await live[k]!.l.page.close().catch(() => {});
          live[k] = { l, o };
          printed[k] = r;
          replaced.set(k, (replaced.get(k) ?? 0) + 1);
        }
        wk = outlineNow();
        if (!changed) break;
      }
    }
    const done_ = printed as { doc: PDFDocument; outline: OutlineItem[]; pages: number }[];
    const total = done_.reduce((a, x) => a + x.pages, 0);
    step('print');
    fb.phaseChanged(3);
    live.forEach((_, i) => fb.progressChanged(((i + 1) * 100) / live.length, `Object ${i + 1} of ${live.length}`));

    // Page parameters: global numbering, sections, titles.
    const prefix = [0];
    for (const x of done_) prefix.push(prefix[prefix.length - 1]! + x.pages);
    const roots = done_.map((x, i) => (live[i]!.o.includeInOutline || isToc(live[i]!.o) ? x.outline : []));
    const sections = sectionCache(roots, prefix, total);
    // The first title found, a cover's included (pdfconverter.cc pagesLoaded).
    const title = g.documentTitle || live.filter(({ o }) => !isToc(o)).map(({ l }) => l.title).find((t) => t) || '';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const isodate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const parmsOf = (k: number, objectPage: number): Parms => {
      const { o, l } = live[k]!;
      const page = prefix[k]! + objectPage + 1;
      const parms: Parms = Object.fromEntries(o.replacements);
      Object.assign(parms, {
        frompage: String(g.pageOffset + 1),
        topage: String(g.pageOffset + total),
        page: String(page + g.pageOffset),
        webpage: o.page,
        section: sections[0]![page] ?? '',
        subsection: sections[1]![page] ?? '',
        subsubsection: sections[2]![page] ?? '',
        doctitle: title,
        title: l.title,
        time: now.toLocaleTimeString(undefined, { timeStyle: 'short' }),
        date: now.toLocaleDateString(undefined, { dateStyle: 'short' }),
        isodate,
        sitepage: String(objectPage + 1),
        sitepages: String(done_[k]!.pages),
      });
      return parms;
    };

    // Headers and footers.
    fb.phaseChanged(4);
    const geometry: Geometry = { width, height, top, bottom, left, right };
    const layerJobs: Promise<Layer | null>[] = [];
    const textPages: { header: HeaderFooter; footer: HeaderFooter; parms: Parms }[] = [];
    const textTargets: number[] = [];
    live.forEach(({ o }, k) => {
      if (!hasText(o.header) && !hasText(o.footer)) return;
      for (let i = 0; i < done_[k]!.pages; i++) {
        textPages.push({ header: o.header, footer: o.footer, parms: parmsOf(k, i) });
        textTargets.push(prefix[k]! + i);
      }
    });
    if (textPages.length) {
      layerJobs.push(printDocument(context, textDocument(geometry, textPages), work, geometry, specOf(objects[0]!, false), fb)
        .then((pdf) => ({ pdf, targets: textTargets, place: { left: 0, top: 0, width, height } })));
    }
    const hfErrors: number[] = [];
    live.forEach(({ o }, k) => {
      const index = objects.indexOf(o);
      for (const which of ['header', 'footer'] as const) {
        const h = o[which];
        const m = measures[index]![which];
        if (!h.htmlUrl || !m) continue;
        layerJobs.push((async () => {
          const { m: size, errorCode: e1 } = await m;
          hfErrors.push(e1);
          const targets = Array.from({ length: done_[k]!.pages }, (_, i) => prefix[k]! + i);
          const pageUrls = targets.map((_, i) => withParms(guessUrlFromString(h.htmlUrl), parmsOf(k, i)));
          const box = { width: contentWidth, scale: scaleOf(o), spec: specOf(o, false) };
          const { pdf, errorCode } = await renderHtml(context, pageUrls, box, size.extent, work, fb);
          hfErrors.push(errorCode);
          const place = which === 'header'
            ? { left, top: top - h.spacing - size.box, width: contentWidth, height: size.extent }
            : { left, top: height - bottom + h.spacing, width: contentWidth, height: size.extent };
          return { pdf, targets, place } satisfies Layer;
        })());
      }
    });
    const layers = (await Promise.all(layerJobs)).filter((x): x is Layer => x !== null);
    if (errorCode === 0) errorCode = Math.max(0, ...hfErrors);
    step('headers');

    // Printing: one document, wkhtmltopdf's sizes, outline and title.
    fb.phaseChanged(5);
    fb.progressChanged(0, 'Preparing');
    const outDoc = done_.length
      ? await merge(done_.map((x) => ({ doc: x.doc, outline: x.outline })), false)
      : { doc: await emptyDocument(width, height), pages: [], offsets: [] };
    setPageSize(outDoc.pages, width * PT_PER_MM, height * PT_PER_MM);
    // Before stamping: pdf-lib keeps the stamped pages unreferenced until save.
    prune(outDoc.doc);
    await stamp(outDoc.doc, outDoc.pages, layers);
    // Links. Those of the tables of contents, href="__WKANCHOR_...", go to
    // their headings; a link to the page of an object, to that object.
    const byLink = new Map<string, WkItem>();
    const index = (items: WkItem[]) => items.forEach((it) => (byLink.set(it.link, it), index(it.children)));
    index(wk);
    const dests = outDoc.doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
    const named = (t: number, name: string) => {
      const n = PDFName.of(t === 0 ? name : `p${t}.${name}`);
      return dests?.has(n) ? n : null;
    };
    live.forEach(({ o }, k) => {
      const raw = new Map(anchorLists[k]!.map((a) => [a.href, a.raw]));
      const first = outDoc.offsets[k]!;
      const headings: WkItem[] = [];
      const flat = (items: WkItem[]) => items.forEach((it) => (headings.push(it), flat(it.children)));
      flat(wk[k]?.children ?? []);
      retargetLinks(outDoc.pages.slice(first, first + done_[k]!.pages), (uri): LinkFate => {
        const back = uri?.match(/\/__WKBACK_(\d+)$/);
        if (back) {
          // To the entry in the last table of contents that has it, or to
          // the heading that has its name (a table printed again names its
          // back links after its headings).
          const it = headingCount[k] === headings.length ? headings[Number(back[1])] : undefined;
          if (!it) return null;
          for (let t = live.length - 1; t >= 0; t--) {
            const name = destNames[t]!.get(it.backLink);
            if (name !== undefined && isToc(live[t]!.o)) return named(t, name);
          }
          const to = byLink.get(it.backLink);
          return to?.source?.dest ? moveDest(outDoc.doc, to.source.dest, outDoc.pages[outDoc.offsets[to.doc]! + to.source.page]!) : null;
        }
        if (!o.useLocalLinks && !o.useExternalLinks) return null;
        if (uri === undefined) return o.useLocalLinks ? undefined : null;
        if (isToc(o)) {
          const it = byLink.get(uri.slice(uri.lastIndexOf('/') + 1));
          if (!it?.source?.dest) return undefined;
          return moveDest(outDoc.doc, it.source.dest, outDoc.pages[outDoc.offsets[it.doc]! + it.source.page]!);
        }
        const t = byKey.get(pageKey(uri));
        if (t !== undefined) {
          if (!o.useLocalLinks) return null;
          const f = fragmentOf(uri);
          if (f) {
            const name = destNames[t]!.get(f);
            return name === undefined ? null : named(t, name);
          }
          const page = outDoc.pages[outDoc.offsets[t]!]!;
          return outDoc.doc.context.obj([page.ref, PDFName.of('XYZ'), left * PT_PER_MM, page.getHeight() - top * PT_PER_MM, 0]);
        }
        if (!o.useExternalLinks) return null;
        return g.resolveRelativeLinks ? undefined : raw.get(uri);
      });
    });
    if (g.outline && g.outlineDepth > 0) {
      const toFinal = (items: OutlineItem[], k: number, depth: number): FinalItem[] => items
        .filter((it) => it.dest && it.page >= 0)
        .map((it) => ({
          title: it.title,
          dest: moveDest(outDoc.doc, it.dest!, outDoc.pages[outDoc.offsets[k]! + it.page]!),
          children: depth < g.outlineDepth ? toFinal(it.children, k, depth + 1) : [],
        }));
      writeOutline(outDoc.doc, roots.flatMap((items, k) => toFinal(items, k, 1)));
    }
    if (g.dumpOutline) {
      try {
        if (g.dumpOutline === '-') process.stdout.write(outlineXml(wk));
        else writeFileSync(g.dumpOutline, outlineXml(wk));
      } catch {
        fb.error(`Unable to write the outline to ${g.dumpOutline}`);
      }
    }
    repeatPages(outDoc.doc, g.copies, g.collate);
    outDoc.doc.setTitle(title);
    outDoc.doc.setCreator(`PDFKiln ${version}`);
    outDoc.doc.setProducer('pdfkiln.org');
    const bytes = await outDoc.doc.save();
    outDoc.pages.forEach((_, i) => fb.progressChanged(((i + 1) * 100) / outDoc.pages.length, `Page ${i + 1} of ${outDoc.pages.length}`));
    try {
      if (g.out === '-') io.stdout(bytes);
      else writeFileSync(g.out, bytes);
    } catch {
      fb.error('Unable to write to destination');
      return fail(errorCode);
    }
    step('assemble');
    fb.phaseChanged(6);
    return { success: true, errorCode };
  } finally {
    await chromium.close();
    removeQuietly(work);
    step('close');
    if (process.env.PDFKILN_TIMINGS) process.stderr.write(`${JSON.stringify(timings)}\n`);
  }
}

async function emptyDocument(width: number, height: number): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([width * PT_PER_MM, height * PT_PER_MM]);
  return doc;
}

// --user-style-sheet is a URL or a file, given by the caller: read as is.
export async function readStyleSheet(s: string, block: boolean): Promise<string> {
  const url = guessUrlFromString(s);
  try {
    if (url.startsWith('file:')) return readFileSync(new URL(url), 'utf8');
    if (/^https?:/.test(url)) return (await relayGet(url, { block })).body.toString('utf8');
  } catch {
    // As WebKit: a style sheet that cannot be read is no style sheet.
  }
  return '';
}



