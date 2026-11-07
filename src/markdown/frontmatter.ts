// The YAML front matter of a Markdown document: a first line of three
// dashes, then lines of "key: value", up to a line of three dashes or dots.
// pdfkiln reads what goes into the PDF (title, author, subject, keywords,
// lang) as plain scalars, keywords also as a list; other keys are left out.
// A block with a line that is not "key: value", a list item or a comment
// is not front matter: a thematic break and a setext heading stay what
// CommonMark makes of them.

export interface FrontMatter {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  lang?: string;
}

const KEY = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const ITEM = /^[ \t]+-(?:[ \t]+(.*?))?[ \t]*$/;
// A BCP 47 tag, as html's lang takes it.
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

// A scalar: quoted ("…" with its escapes, '…' with '' for a quote), or
// plain, up to a comment.
function scalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\/nt])/g, (_, c: string) => ({ n: '\n', t: '\t' })[c] ?? c);
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw.replace(/[ \t]+#.*$/, '');
}

// [a, "b, c", d]: the items of a flow list, commas inside quotes kept.
function flowList(raw: string): string[] {
  const items: string[] = [];
  for (const m of raw.slice(1, -1).matchAll(/\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+)\s*(?:,|$)/g)) {
    const v = scalar(m[1]!.trim());
    if (v) items.push(v);
  }
  return items;
}

export function splitFrontMatter(src: string): { meta: FrontMatter; body: string } {
  const text = src.replace(/^﻿/, '');
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return { meta: {}, body: text };
  const lines = text.slice(open[0].length).split(/\r?\n/);
  const end = lines.findIndex((l) => /^(---|\.\.\.)[ \t]*$/.test(l));
  if (end === -1) return { meta: {}, body: text };
  const values = new Map<string, string | string[]>();
  let last = '';
  for (const line of lines.slice(0, end)) {
    if (!line.trim() || /^[ \t]*#/.test(line)) continue;
    const item = ITEM.exec(line);
    if (item && last && values.get(last) === '') {
      values.set(last, [scalar(item[1] ?? '')]);
      continue;
    }
    const list = values.get(last);
    if (item && Array.isArray(list)) {
      list.push(scalar(item[1] ?? ''));
      continue;
    }
    const kv = KEY.exec(line);
    if (!kv) return { meta: {}, body: text };
    last = kv[1]!.toLowerCase();
    const raw = kv[2] ?? '';
    values.set(last, /^\[.*\]$/.test(raw) ? flowList(raw) : scalar(raw));
  }
  const one = (k: string): string | undefined => {
    const v = values.get(k);
    const s = Array.isArray(v) ? v.join(', ') : v;
    return s?.trim() || undefined;
  };
  const meta: FrontMatter = {};
  const title = one('title');
  if (title) meta.title = title;
  const author = values.get('author') ?? values.get('authors');
  const authors = (Array.isArray(author) ? author : author ? [author] : []).map((a) => a.trim()).filter(Boolean);
  if (authors.length) meta.author = authors.join(', ');
  const subject = one('subject') ?? one('description');
  if (subject) meta.subject = subject;
  const kw = values.get('keywords') ?? values.get('tags');
  const keywords = (Array.isArray(kw) ? kw : kw ? kw.split(',') : []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length) meta.keywords = keywords;
  const lang = one('lang') ?? one('language');
  if (lang && LANG.test(lang)) meta.lang = lang;
  return { meta, body: lines.slice(end + 1).join('\n') };
}
