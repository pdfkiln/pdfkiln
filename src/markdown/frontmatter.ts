// The YAML front matter of a Markdown document: a first line of three
// dashes, up to a line of three dashes or dots. A key starts a line at the
// margin ("key:"); what it holds may go on over the lines below, more
// indented (a nested map, a block scalar, a list), or as a list at the
// margin. pdfkiln reads what goes into the PDF: title, author (a string, a
// list, pandoc's "- name:" entries), subject (or description), keywords (or
// tags) and lang; the rest is left out, and the block never prints. A block
// with a line at the margin that is none of these is not front matter:
// "---", "Title", "---" stay a rule and a heading, as CommonMark makes them.

export interface FrontMatter {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  lang?: string;
}

interface Entry {
  key: string;
  // What follows the colon on the key's line.
  inline: string;
  // The lines below it, blank ones included, as they are.
  lines: string[];
}

// A key at the margin, quoted or not, which may hold colons (og:image): the
// colon that ends it is followed by a space or ends the line.
const KEY = /^([^\s#"'-][^\n]*?|"[^"\n]*"|'[^'\n]*')[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const DASH = /^[ \t]*-(?:[ \t]|$)/;
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

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;

// What a key holds, as YAML reads it: a block scalar (| keeps the lines, >
// folds them), a flow list, a plain or quoted scalar that may go on over
// the lines below, a list (its items; for a map in an item, its name), or a
// nested map (its name, as pandoc writes an author).
function read(e: Entry): string | string[] | undefined {
  const inline = e.inline.trim();
  const filled = e.lines.filter((l) => l.trim());
  if (/^[|>][-+]?[1-9]?[-+]?$/.test(inline)) {
    const indent = Math.min(...filled.map(indentOf));
    const body = e.lines.map((l) => l.slice(Math.min(indent, indentOf(l)))).join('\n').trim();
    return inline.startsWith('|') ? body : body.replace(/([^\n])\n(?!\n)/g, '$1 ');
  }
  if (/^\[.*\]$/.test(inline) && !filled.length) return flowList(inline);
  if (inline) return scalar([inline, ...filled.map((l) => l.trim())].join(' '));
  if (!filled.length) return undefined;
  if (DASH.test(filled[0]!)) {
    const at = indentOf(filled[0]!);
    const items: string[][] = [];
    for (const l of filled) {
      if (indentOf(l) === at && DASH.test(l)) items.push([l.slice(at).replace(/^-[ \t]*/, '')]);
      else items.at(-1)?.push(l.trim());
    }
    return items.map((item) => {
      const name = item.map((s) => /^name[ \t]*:[ \t]*(.*)$/.exec(s)?.[1]).find((v) => v !== undefined);
      if (name !== undefined) return scalar(name.trim());
      // A map without a name, or a nested list: nothing to show.
      return item.length === 1 && !KEY.test(item[0]!) ? scalar(item[0]!) : '';
    }).filter(Boolean);
  }
  const name = filled.map((l) => /^[ \t]+name[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(l)?.[1]).find((v) => v !== undefined);
  return name ? scalar(name) : undefined;
}

export function splitFrontMatter(src: string): { meta: FrontMatter; body: string } {
  const text = src.replace(/^﻿/, '');
  const none = { meta: {}, body: text };
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return none;
  const lines = text.slice(open[0].length).split(/\r?\n/);
  const end = lines.findIndex((l) => /^(---|\.\.\.)[ \t]*$/.test(l));
  if (end === -1) return none;
  const entries: Entry[] = [];
  for (const line of lines.slice(0, end)) {
    if (!line.trim()) {
      entries.at(-1)?.lines.push('');
      continue;
    }
    // A comment at the margin; indented, it may be a block scalar's text.
    if (line.startsWith('#')) continue;
    const kv = KEY.exec(line);
    if (kv) {
      entries.push({ key: kv[1]!.replace(/^(["'])(.*)\1$/, '$2').toLowerCase(), inline: kv[2] ?? '', lines: [] });
      continue;
    }
    if (entries.length && (/^[ \t]/.test(line) || DASH.test(line))) {
      entries.at(-1)!.lines.push(line);
      continue;
    }
    return none;
  }
  if (!entries.length) return none;
  // The last of a key wins, as in YAML.
  const value = (...keys: string[]) => {
    for (const k of keys) {
      const e = entries.findLast((x) => x.key === k);
      if (e) return read(e);
    }
    return undefined;
  };
  const one = (...keys: string[]) => {
    const v = value(...keys);
    return (Array.isArray(v) ? v.join(', ') : v)?.replace(/\s+/g, ' ').trim() || undefined;
  };
  const meta: FrontMatter = {};
  const title = one('title');
  if (title) meta.title = title;
  const author = one('author', 'authors');
  if (author) meta.author = author;
  const subject = one('subject', 'description');
  if (subject) meta.subject = subject;
  const kw = value('keywords', 'tags');
  const keywords = (Array.isArray(kw) ? kw : kw ? kw.split(',') : []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length) meta.keywords = keywords;
  const lang = one('lang', 'language');
  if (lang && LANG.test(lang)) meta.lang = lang;
  return { meta, body: lines.slice(end + 1).join('\n') };
}
