// The layout quirks of wkhtmltopdf 0.12.6's WebKit that the compatible
// mode reproduces (measured on the corpus, bench/). Style sheets
// served to Chromium are rewritten by rewriteCss; what is inline in the
// page is rewritten in the page by emulateInPage, just before printing.
import { cleanCss } from './webkit534-loads.js';

export interface Emulation {
  // Media queries evaluated against this viewport: [0, 0] without
  // --viewport-size, as wkhtmltopdf does.
  mediaViewport?: [number, number];
  // Screen media, printed: the media types of the style sheets are
  // rewritten (screen always true, print never), so that the page can be
  // printed with Chromium's print media, the only one under which it
  // repeats table headers on each page, as WebKit does.
  screenTypes?: boolean;
  // WebKit printed with the printer's margins: @page rules have no effect.
  dropPageRules?: boolean;
  // Qt rounds font sizes to whole pixels.
  roundFontSizes?: boolean;
  minimumFontSize?: number; // px, 0: none
  // WebKit drops the top margin collapsed at the top of the printed page.
  truncateTopMargin?: boolean;
  // It drops any margin that starts at the top of the page, in floats,
  // positioned boxes and table cells too (not in inline blocks): measured
  // on wkhtmltopdf 0.12.6, as WebKit 534's collapseMargins pulls a margin
  // back to the next page top, which is the position itself there.
  pageTopMargins?: boolean;
  // WebKit 534 lays out in whole pixels: a line height given as a number
  // or a percentage is taken of the rounded font size and truncated
  // (Length::calcMinValue), a length is truncated after adding 0.01
  // (CSSPrimitiveValue::roundForImpreciseConversion).
  wholePixelLineHeights?: boolean;
  // line-height: normal as Qt reads it from FreeType on Linux: ascent and
  // descent each rounded up to a whole pixel, no line gap.
  normalLineHeight?: boolean;
  // Margins, paddings and text indents truncated as lengths are.
  wholePixelBoxes?: boolean;
  // WebKit 534 moves a table row that does not fit to the next page;
  // Chromium splits it. A layered default that any rule of the page
  // overrides.
  unsplitRows?: boolean;
  // It moves a block that scrolls its overflow (auto or scroll, on either
  // axis) whole to the next page too, as it does an image, when it fits in
  // one (RenderBlock::adjustForUnsplittableChild); Chromium splits it.
  unsplitScrollBoxes?: boolean;
  // WebKit 534 lays the page out once and cuts it into pages: a float that
  // a page break splits goes on at its place on the next page. Chromium
  // places what follows of a float there against the floats that go on
  // too: a column whose neighbour ended above the break moves to the edge
  // (a Bootstrap 3 row of an empty col-xs-6 and one of totals: ERPNext's
  // invoices). The floats of a line get the height of the tallest, so that
  // they all go on; only those that paint nothing below their content, in
  // a box that holds them, so that nothing else moves.
  floatColumns?: boolean;
  // CSS that WebKit 534 does not parse is dropped from the text of the
  // style sheets, so that the page's fallbacks apply as they did there:
  // Odoo writes display: -webkit-box; display: -webkit-flex; display: flex,
  // and wkhtmltopdf kept the first. Done on the text: a browser keeps only
  // the last declaration of a property.
  webkit534Css?: boolean;
  // Nothing loaded that WebKit 534 never read (webkit534-loads.ts): the
  // page, its frames and its style sheets cleaned before Chromium reads
  // them.
  webkit534Loads?: boolean;
  // WebKit 534 controls widows and orphans only when the page sets them
  // (hasAutoWidows); Chromium's initial value is 2. A layered default of 1
  // that any rule of the page overrides.
  noDefaultWidows?: boolean;
  // Without smart shrinking, WebKit prints content wider than the paper
  // at its size, past the edge; Chromium shrinks the whole page to fit it
  // (up to 1.5 times). Clipping the horizontal overflow of html and body
  // keeps the scale: overflow: clip makes no formatting context, margins
  // still collapse. Not done when either already hides its overflow.
  noShrinkToFit?: boolean;
}

const TRUE = '(min-width: 0px)';
const FALSE = '(min-width: 1000000px)';

// "screen" becomes "all", "print" "all and <false>": "not print" stays true
// and "print and (...)" false, as they are on a screen.
export function rewriteMediaTypes(prelude: string): string {
  return prelude
    .replace(/(^|[\s,(])screen(?=$|[\s,)])/gi, '$1all')
    .replace(/(^|[\s,(])print(?=$|[\s,)])/gi, `$1all and ${FALSE}`);
}

// Rewrites width and height media features into a feature that is always
// true or always false in Chromium. Applying it twice changes nothing.
export function rewriteMediaPrelude(prelude: string, width: number, height: number): string {
  return prelude.replace(
    /\(\s*(min-|max-)?(width|height)\s*:\s*(-?[0-9.]+)\s*(px|em|rem)?\s*\)/gi,
    (_m, prefix: string | undefined, feature: string, value: string, unit: string | undefined) => {
      const v = Number(value) * (unit && unit.toLowerCase() !== 'px' ? 16 : 1);
      const actual = feature.toLowerCase() === 'width' ? width : height;
      const p = (prefix ?? '').toLowerCase();
      const ok = p === 'min-' ? actual >= v : p === 'max-' ? actual <= v : actual === v;
      return ok ? TRUE : FALSE;
    },
  );
}

// @page { ... } blocks, including nested margin boxes, removed.
function dropPageBlocks(css: string): string {
  let out = '';
  let i = 0;
  const re = /@page\b[^{;]*\{/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    out += css.slice(i, m.index);
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    i = j;
    re.lastIndex = j;
  }
  return out + css.slice(i);
}

// Declarations WebKit 534 rejects: flexible boxes and grids (it has the
// 2009 box model, display: -webkit-box, only). Kept in step with
// emulateInPage.
const UNKNOWN_DISPLAY = /(?<=^|[;{\s])display\s*:\s*(?:-webkit-)?(?:inline-)?(?:flex|grid)\s*(?:!\s*important\s*)?(?:;\s*|(?=\}|$))/gi;

// Values with calc() or var(), which came after WebKit 534; custom
// properties themselves are left, they do nothing there.
const UNKNOWN_VALUE = /(?<=^|[;{\s])(?!--)[a-z-]+\s*:[^;{}]*\b(?:-webkit-)?(?:calc|var)\([^;{}]*(?:;\s*|(?=\}|$))/gi;

// The breaks of CSS Fragmentation (break-before, -after and -inside) and
// named pages (page) came after it too: it knows page-break-before, -after
// and -inside, which Chromium takes as the same breaks. At the start of a
// declaration only, not in a string.
const UNKNOWN_BREAK = /(?<=(?:^|[;{])\s*)(?:break-(?:before|after|inside)|page)\s*:[^;{}]*(?:;\s*|(?=\}|$))/gi;

// system-ui, the font of the system's interface, came after WebKit 534 too:
// there it is the name of a family, which no font has, and the next family
// of the list applies, quoted or not. Chromium takes even the quoted name
// for that font: another name, which no font has either.
const SYSTEM_UI = /(?<=[\s,:])(["']?)system-ui\1(?=\s*(?:[,;}!]|$))/gi;
const FONT_PROPERTY = /^\s*font(?:-family)?\s*:/i;

export function dropUnknownCss(css: string): string {
  return css.replace(UNKNOWN_DISPLAY, '').replace(UNKNOWN_VALUE, '').replace(UNKNOWN_BREAK, '').replace(SYSTEM_UI, (m: string, _q: string, at: number, all: string) => {
    const start = Math.max(all.lastIndexOf(';', at), all.lastIndexOf('{', at), all.lastIndexOf('}', at)) + 1;
    return FONT_PROPERTY.test(all.slice(start, at)) ? '"WebKit 534 system-ui"' : m;
  });
}

// --user-style-sheet's rules in a cascade layer of their own, the first of
// the page when the style sheet comes first: the page's rules outrank them
// whatever their specificity, and their !important declarations outrank
// the page's, as WebKit ranks a user style sheet (CSS 2.1's cascade,
// measured on wkhtmltopdf 0.12.6). Its @import rules take the layer too,
// its @namespace rules stay before the block, @charset goes.
export const USER_LAYER = 'pdfkiln-user';
const CSS_STRING = String.raw`"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'`;
const CSS_URL = String.raw`url\(\s*(?:${CSS_STRING}|[^)]*)\s*\)`;
const CSS_BLANK = /^(?:\s+|\/\*[\s\S]*?(?:\*\/|$))/;
const CSS_STATEMENT = new RegExp(String.raw`^@(charset|import|namespace)\b(?:${CSS_STRING}|${CSS_URL}|[^;{"'])*;?`, 'i');
const IMPORT_SOURCE = new RegExp(String.raw`^(@import\s*)(${CSS_URL}|${CSS_STRING})`, 'i');

export function userLayer(css: string): string {
  const head: string[] = [];
  let rest = css;
  for (;;) {
    const blank = CSS_BLANK.exec(rest);
    if (blank?.[0]) {
      rest = rest.slice(blank[0].length);
      continue;
    }
    const m = CSS_STATEMENT.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
    const kind = m[1]!.toLowerCase();
    if (kind === 'import') head.push(/\blayer\b/i.test(m[0].replace(IMPORT_SOURCE, '')) ? m[0] : m[0].replace(IMPORT_SOURCE, `$1$2 layer(${USER_LAYER})`));
    else if (kind === 'namespace') head.push(m[0]);
  }
  return `${head.map((s) => `${s}\n`).join('')}@layer ${USER_LAYER} {\n${rest}\n}\n`;
}

// A conversion serves the same style sheets to its page, its header and
// its footer: each text is rewritten once.
const rewritten = new Map<string, string>();

export function rewriteCss(css: string, e: Emulation): string {
  const key = `${JSON.stringify(e)}
${css}`;
  const done = rewritten.get(key);
  if (done !== undefined) return done;
  if (rewritten.size >= 64) rewritten.clear();
  const out = rewriteOnce(css, e);
  rewritten.set(key, out);
  return out;
}

function rewriteOnce(css: string, e: Emulation): string {
  let out = e.webkit534Loads ? cleanCss(css) : css;
  if (e.webkit534Css) out = dropUnknownCss(out);
  if (e.mediaViewport || e.screenTypes) {
    const [w, h] = e.mediaViewport ?? [0, 0];
    out = out.replace(/@media([^{;]+)\{/g, (_m, prelude: string) => {
      let p = e.mediaViewport ? rewriteMediaPrelude(prelude, w, h) : prelude;
      if (e.screenTypes) p = rewriteMediaTypes(p);
      return `@media${p}{`;
    });
  }
  if (e.dropPageRules) out = dropPageBlocks(out);
  return out;
}

// Runs in each frame, serialized by Puppeteer: it must stay
// self-contained.
export function emulateInPage(e: Emulation): void {
  const rewrite = (text: string, w: number, h: number) => text.replace(
    /\(\s*(min-|max-)?(width|height)\s*:\s*(-?[0-9.]+)\s*(px|em|rem)?\s*\)/gi,
    (_m: string, prefix: string | undefined, feature: string, value: string, unit: string | undefined) => {
      const v = Number(value) * (unit && unit.toLowerCase() !== 'px' ? 16 : 1);
      const actual = feature.toLowerCase() === 'width' ? w : h;
      const p = (prefix ?? '').toLowerCase();
      const ok = p === 'min-' ? actual >= v : p === 'max-' ? actual <= v : actual === v;
      return ok ? '(min-width: 0px)' : '(min-width: 1000000px)';
    },
  );
  const types = (text: string) => text
    .replace(/(^|[\s,(])screen(?=$|[\s,)])/gi, '$1all')
    .replace(/(^|[\s,(])print(?=$|[\s,)])/gi, '$1all and (min-width: 1000000px)');
  const media = (text: string, w: number, h: number) => {
    let t = e.mediaViewport ? rewrite(text, w, h) : text;
    if (e.screenTypes) t = types(t);
    return t;
  };
  const doc = document;
  if (e.webkit534Css) {
    const drop = (css: string) => css
      .replace(/(?<=^|[;{\s])display\s*:\s*(?:-webkit-)?(?:inline-)?(?:flex|grid)\s*(?:!\s*important\s*)?(?:;\s*|(?=\}|$))/gi, '')
      .replace(/(?<=^|[;{\s])(?!--)[a-z-]+\s*:[^;{}]*\b(?:-webkit-)?(?:calc|var)\([^;{}]*(?:;\s*|(?=\}|$))/gi, '')
      .replace(/(?<=(?:^|[;{])\s*)(?:break-(?:before|after|inside)|page)\s*:[^;{}]*(?:;\s*|(?=\}|$))/gi, '')
      .replace(/(?<=[\s,:])(["']?)system-ui\1(?=\s*(?:[,;}!]|$))/gi, (m: string, _q: string, at: number, all: string) => {
        const start = Math.max(all.lastIndexOf(';', at), all.lastIndexOf('{', at), all.lastIndexOf('}', at)) + 1;
        return /^\s*font(?:-family)?\s*:/i.test(all.slice(start, at)) ? '"WebKit 534 system-ui"' : m;
      });
    for (const el of Array.from(doc.querySelectorAll('style'))) {
      const next = drop(el.textContent ?? '');
      if (next !== el.textContent) el.textContent = next;
    }
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) {
      const css = el.getAttribute('style') ?? '';
      const next = drop(css);
      if (next !== css) el.setAttribute('style', next);
    }
  }
  if (e.mediaViewport || e.dropPageRules || e.screenTypes) {
    const [w, h] = e.mediaViewport ?? [0, 0];
    const walk = (rules: CSSRuleList) => {
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i]!;
        if (e.dropPageRules && r instanceof CSSPageRule) {
          const parent = r.parentRule as CSSGroupingRule | null;
          if (parent) parent.deleteRule(i);
          else r.parentStyleSheet?.deleteRule(i);
          continue;
        }
        if ((e.mediaViewport || e.screenTypes) && (r instanceof CSSMediaRule || r instanceof CSSImportRule)) {
          const next = media(r.media.mediaText, w, h);
          if (next !== r.media.mediaText) r.media.mediaText = next;
        }
        if (r instanceof CSSImportRule && r.styleSheet) {
          try {
            walk(r.styleSheet.cssRules);
          } catch {
            // Another origin: rewritten when it was served.
          }
        }
        if ('cssRules' in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(doc.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        // Another origin: rewritten when it was served.
      }
    }
    if (e.mediaViewport || e.screenTypes) {
      for (const el of Array.from(doc.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[media], style[media]'))) {
        const next = media(el.media, w, h);
        if (next !== el.media) el.media = next;
      }
    }
  }
  if (e.roundFontSizes || e.minimumFontSize) {
    const elements = Array.from(doc.querySelectorAll<HTMLElement>('body, body *'));
    const sizes = elements.map((el) => parseFloat(getComputedStyle(el).fontSize));
    elements.forEach((el, i) => {
      let s = sizes[i]!;
      if (e.minimumFontSize && s < e.minimumFontSize) s = e.minimumFontSize;
      if (e.roundFontSizes) s = Math.round(s);
      if (Math.abs(s - sizes[i]!) > 0.001) el.style.setProperty('font-size', `${s}px`, 'important');
    });
  }
  // roundForImpreciseConversion: towards zero, after 0.01 away from it.
  const whole = (v: number) => Math.trunc(v + (v < 0 ? -0.01 : 0.01));
  if (e.wholePixelLineHeights || e.normalLineHeight) {
    // Every element gets its own value, read before any is set: an
    // inherited number would otherwise become an inherited length.
    const elements = Array.from(doc.querySelectorAll<HTMLElement>('body, body *'));
    const ratios = new Map<string, [number, number]>();
    const ctx = e.normalLineHeight ? doc.createElement('canvas').getContext('2d') : null;
    // Ascent and descent per pixel of font size, measured large enough
    // that Chromium's own rounding does not show.
    const ratio = (cs: CSSStyleDeclaration): [number, number] => {
      const key = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontFamily}`;
      let r = ratios.get(key);
      if (!r) {
        ctx!.font = `${cs.fontStyle} ${cs.fontWeight} 1000px ${cs.fontFamily}`;
        const m = ctx!.measureText('x');
        r = [m.fontBoundingBoxAscent / 1000, m.fontBoundingBoxDescent / 1000];
        ratios.set(key, r);
      }
      return r;
    };
    const values = elements.map((el) => {
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      if (cs.lineHeight === 'normal') {
        if (!e.normalLineHeight || !ctx) return null;
        const [a, d] = ratio(cs);
        return Math.ceil(a * size - 0.001) + Math.ceil(d * size - 0.001);
      }
      if (!e.wholePixelLineHeights) return null;
      const specified = el.computedStyleMap?.().get('line-height') as CSSUnitValue | undefined;
      if (specified?.unit === 'number') return Math.trunc(Math.round(size) * specified.value + 1e-6);
      if (specified?.unit === 'percent') return Math.trunc((Math.round(size) * specified.value) / 100 + 1e-6);
      return whole(parseFloat(cs.lineHeight));
    });
    elements.forEach((el, i) => {
      const v = values[i];
      if (v !== null && v !== undefined) el.style.setProperty('line-height', `${v}px`, 'important');
    });
  }
  if (e.wholePixelBoxes) {
    const props = ['margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'text-indent'];
    const elements = Array.from(doc.querySelectorAll<HTMLElement>('body, body *'));
    const values = elements.map((el) => {
      const cs = getComputedStyle(el);
      return props.map((p) => parseFloat(cs.getPropertyValue(p)));
    });
    elements.forEach((el, i) => {
      props.forEach((p, j) => {
        const v = values[i]![j]!;
        if (Number.isFinite(v) && Math.abs(v - whole(v)) > 0.001) el.style.setProperty(p, `${whole(v)}px`, 'important');
      });
    });
  }
  if (e.truncateTopMargin && doc.body) {
    // When the body's top margin collapses with those of its first
    // descendants, the body starts that far below the root: pull it up.
    const root = doc.documentElement;
    const style = getComputedStyle(root);
    const rootTop = root.getBoundingClientRect().top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const gap = doc.body.getBoundingClientRect().top - rootTop;
    if (gap > 0) root.style.setProperty('margin-top', `${-gap}px`, 'important');
  }
  if (e.pageTopMargins && doc.body) {
    // Down from the body, now at the top of the page: the first in-flow
    // block of a box whose content starts there loses its top margin, and
    // so on inside it; so do the first blocks of the floats, positioned
    // boxes and table cells placed there, which keep their own margins.
    // Inline blocks keep their content's.
    const at = (el: Element) => Math.abs(el.getBoundingClientRect().top + window.scrollY) < 0.01;
    const flush = (cs: CSSStyleDeclaration) => !parseFloat(cs.paddingTop) && !parseFloat(cs.borderTopWidth)
      && (cs.display !== 'table' || cs.borderCollapse === 'collapse' || !parseFloat(cs.borderSpacing.split(' ').pop()!));
    const visit = (box: HTMLElement): void => {
      const aside: HTMLElement[] = [];
      let first: HTMLElement | undefined;
      for (const node of Array.from(box.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.textContent?.trim()) break;
          continue;
        }
        if (!(node instanceof HTMLElement)) continue;
        const cs = getComputedStyle(node);
        if (cs.display === 'none') continue;
        if (cs.cssFloat !== 'none' || cs.position === 'absolute' || cs.position === 'fixed') {
          aside.push(node);
          continue;
        }
        if (cs.display.startsWith('inline')) break;
        if (cs.display === 'table-row-group' || cs.display === 'table-header-group' || cs.display === 'table-row') {
          visit(node);
          break;
        }
        if (cs.display === 'table-cell') {
          // Every cell of the first row starts at the top.
          for (const cell of Array.from(box.children) as HTMLElement[]) if (flush(getComputedStyle(cell))) visit(cell);
          break;
        }
        first = node;
        break;
      }
      if (first) {
        if (parseFloat(getComputedStyle(first).marginTop) > 0) first.style.setProperty('margin-top', '0px', 'important');
        if (flush(getComputedStyle(first))) visit(first);
      }
      for (const el of aside) if (at(el) && flush(getComputedStyle(el))) visit(el);
    };
    visit(doc.body);
  }
  if (e.unsplitScrollBoxes && doc.body && window === window.top) {
    // In-flow and floating blocks that fit in a page, the height of the
    // window: a taller one is split from where it stands, as in WebKit,
    // where Chromium would push it to the next page first. html and body
    // give their overflow to the window; frames are printed apart. All
    // read before any is set.
    const scrolls = (v: string) => v === 'auto' || v === 'scroll';
    const boxes = Array.from(doc.body.querySelectorAll<HTMLElement>('*')).filter((el) => {
      const cs = getComputedStyle(el);
      return (scrolls(cs.overflowX) || scrolls(cs.overflowY)) && cs.position !== 'absolute' && cs.position !== 'fixed'
        && !/^(inline|table|contents|none)/.test(cs.display) && el.getBoundingClientRect().height <= innerHeight;
    });
    for (const el of boxes) el.style.setProperty('break-inside', 'avoid');
  }
  if (e.noDefaultWidows || e.unsplitRows) {
    const css = `@layer pdfkiln-defaults { ${e.noDefaultWidows ? 'html { orphans: 1; widows: 1 }' : ''} ${e.unsplitRows ? 'tr { break-inside: avoid }' : ''} }`;
    const style = doc.createElement('style');
    style.textContent = css;
    (doc.head ?? doc.documentElement).prepend(style);
    // A page whose Content-Security-Policy refuses inline styles, which
    // WebKit 534 does not know, leaves the element without its style sheet
    // (measured, Chromium 158): it is then adopted, which the policy does
    // not govern, as --user-style-sheet is (loader.ts). Its layer then
    // comes after the page's own, whose rules wkhtmltopdf 0.12.6 ignores
    // anyway (measured).
    if (!style.sheet) {
      style.remove();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    }
  }
  if (e.noShrinkToFit && doc.body) {
    // Only on visible boxes: a body that hides its overflow would become a
    // scroll container, which Chromium does not split across pages.
    const visible = (el: Element) => {
      const cs = getComputedStyle(el);
      return cs.overflowX === 'visible' && cs.overflowY === 'visible';
    };
    if (visible(doc.documentElement) && visible(doc.body)) {
      for (const el of [doc.documentElement, doc.body]) el.style.setProperty('overflow-x', 'clip', 'important');
    }
  }
  if (e.floatColumns && doc.body && window === window.top) {
    // A line of floats: the floats of one parent whose margin boxes start
    // at the same height, in a parent that holds them (a clearfix, its own
    // formatting context), so that stretching one to the bottom of the
    // line moves nothing. Images and other replaced elements, and floats
    // with a background, a border, a shadow or an outline, are left as
    // they are. All read before any is set.
    type Float = { el: HTMLElement; top: number; bottom: number; under: number; extra: number; paints: boolean };
    const lines = new Map<HTMLElement, Map<number, Float[]>>();
    const sides = ['top', 'right', 'bottom', 'left'];
    for (const el of Array.from(doc.body.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement) || !el.parentElement) continue;
      const cs = getComputedStyle(el);
      if (cs.cssFloat === 'none' || !/^(block|flow-root)$/.test(cs.display)) continue;
      if (/^(IMG|VIDEO|CANVAS|IFRAME|OBJECT|EMBED|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) continue;
      const px = (p: string) => parseFloat(cs.getPropertyValue(p)) || 0;
      const paints = !/^(transparent|rgba\(.*,\s*0\))$/.test(cs.backgroundColor) || cs.backgroundImage !== 'none'
        || sides.some((s) => cs.getPropertyValue(`border-${s}-style`) !== 'none' && px(`border-${s}-width`) > 0)
        || cs.boxShadow !== 'none' || (cs.outlineStyle !== 'none' && px('outline-width') > 0);
      const r = el.getBoundingClientRect();
      const top = r.top + scrollY;
      const extra = cs.boxSizing === 'border-box' ? 0 : px('padding-top') + px('padding-bottom') + px('border-top-width') + px('border-bottom-width');
      const float: Float = { el, top, bottom: r.bottom + scrollY, under: px('margin-bottom'), extra, paints };
      const line = lines.get(el.parentElement) ?? new Map<number, Float[]>();
      lines.set(el.parentElement, line);
      const key = Math.round(top - px('margin-top'));
      line.set(key, [...(line.get(key) ?? []), float]);
    }
    const stretch: [HTMLElement, number][] = [];
    for (const [parent, line] of lines) {
      const ps = getComputedStyle(parent);
      const holds = parent.getBoundingClientRect().bottom + scrollY - parseFloat(ps.borderBottomWidth) - parseFloat(ps.paddingBottom);
      for (const floats of line.values()) {
        if (floats.length < 2) continue;
        const end = Math.max(...floats.map((f) => f.bottom + f.under));
        if (holds < end - 0.5) continue;
        for (const f of floats) {
          if (f.paints || f.bottom + f.under > end - 0.5) continue;
          stretch.push([f.el, end - f.under - f.top - f.extra]);
        }
      }
    }
    for (const [el, h] of stretch) el.style.setProperty('min-height', `${h}px`, 'important');
  }
}
