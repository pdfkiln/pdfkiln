// The native interface's bookmarks, without Chromium: titles that Chromium
// doubles put right, the others left as they are.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { undoubleTitles, type OutlineItem } from '../src/pdf/assemble.js';

const item = (title: string, children: OutlineItem[] = []): OutlineItem => ({ title, page: 0, dest: null, children });
const titles = (items: OutlineItem[]): unknown[] => items.map((it) => (it.children.length ? [it.title, titles(it.children)] : it.title));

test('a heading pushed to the next page: its bookmark titled once, at any depth', () => {
  const headings = ['Titre principal', 'Installation', 'Installation', 'Usage'];
  assert.deepEqual(titles(undoubleTitles([item('Titre principal', [item('Installation'), item('InstallationInstallation'), item('Usage', [item('UsageUsage')])])], headings)),
    [['Titre principal', ['Installation', 'Installation', ['Usage', ['Usage']]]]]);
  // innerText and textContent may differ in spaces and case.
  assert.deepEqual(titles(undoubleTitles([item('MISE EN ROUTEMISE EN ROUTE')], ['Mise en  route', 'MISE EN ROUTE'])), ['MISE EN ROUTE']);
});

test('the other titles as Chromium wrote them', () => {
  // A heading named as two of itself; a title no heading explains; an
  // empty one; one page without headings.
  const kept = ['TomTom', 'Tom', 'AbcAbc', '', 'Fin'];
  assert.deepEqual(titles(undoubleTitles(kept.map((t) => item(t)), ['TomTom', 'Tom', 'Fin'])), kept);
  assert.deepEqual(titles(undoubleTitles([item('NoteNote')], [])), ['NoteNote']);
  // The item is a copy: readOutline's stays.
  const original = [item('AA')];
  assert.notEqual(undoubleTitles(original, ['A'])[0], original[0]);
  assert.equal(original[0]!.title, 'AA');
});
