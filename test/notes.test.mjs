import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  PREFS_KEY,
  DEFAULT_PREFS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  PIP_MIN_WIDTH,
  PIP_MIN_HEIGHT,
  createNote,
  createId,
  deriveTitle,
  derivePreview,
  truncate,
  computeStats,
  totalStats,
  normalizeNote,
  normalizeNotes,
  sortNotes,
  filterNotes,
  serialize,
  deserialize,
  mergeNotes,
  exportBundle,
  slugify,
  noteToMarkdown,
  formatRelativeTime,
  formatDuration,
  formatCount,
  clampPipSize,
  clampFontSize,
  normalizePrefs,
  parsePrefs,
} from '../src/notes.js';

/* --------------------------------------------------------------- titles -- */

test('deriveTitle uses the first non-empty line and strips markdown hashes', () => {
  assert.equal(deriveTitle('Shopping list\nmilk\neggs'), 'Shopping list');
  assert.equal(deriveTitle('\n\n  Standup notes  \nmore'), 'Standup notes');
  assert.equal(deriveTitle('### Roadmap Q1\nstuff'), 'Roadmap Q1');
});

test('deriveTitle falls back when the body is blank or not a string', () => {
  assert.equal(deriveTitle(''), 'Untitled note');
  assert.equal(deriveTitle('   \n  \n '), 'Untitled note');
  assert.equal(deriveTitle(undefined), 'Untitled note');
  assert.equal(deriveTitle(null, 'Empty'), 'Empty');
});

test('deriveTitle truncates long first lines', () => {
  const long = 'a'.repeat(200);
  const title = deriveTitle(long);
  assert.ok(title.length <= 80, `expected <= 80 chars, got ${title.length}`);
  assert.ok(title.endsWith('\u2026'));
});

test('derivePreview skips the title line and returns "" for one-liners', () => {
  assert.equal(derivePreview('Title\nsecond line here'), 'second line here');
  assert.equal(derivePreview('only a title'), '');
  assert.equal(derivePreview(''), '');
  assert.equal(derivePreview('Title\n\n\nbody'), 'body');
});

test('truncate leaves short text untouched and shortens long text', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('abcdefg', 4), 'abc\u2026');
  assert.equal(truncate('abcdefg', 4).length, 4);
});

/* ---------------------------------------------------------------- stats -- */

test('computeStats counts words, chars, lines and reading time', () => {
  const body = 'one two three\nfour';
  const s = computeStats(body);
  assert.equal(s.words, 4);
  assert.equal(s.lines, 2);
  assert.equal(s.chars, body.length);
  assert.equal(s.charsNoSpaces, 15); // "onetwothreefour"
  assert.equal(s.readingSeconds, 1); // (4/200)*60 = 1.2s, clamped up to 1
});

test('computeStats treats empty and whitespace-only bodies as zero', () => {
  for (const body of ['', '   ', '\n\n\n', undefined]) {
    const s = computeStats(body);
    assert.equal(s.words, 0, `words for ${JSON.stringify(body)}`);
    assert.equal(s.readingSeconds, 0, `readingSeconds for ${JSON.stringify(body)}`);
  }
  assert.equal(computeStats('').lines, 0);
});

test('computeStats collapses runs of whitespace into single words', () => {
  assert.equal(computeStats('a    b\n\n\tc').words, 3);
});

test('computeStats never throws on non-string input', () => {
  assert.equal(computeStats(42).words, 0);
  assert.equal(computeStats(null).chars, 0);
  assert.equal(computeStats({}).lines, 0);
});

test('totalStats aggregates across notes', () => {
  const notes = [createNote({ body: 'a b' }), createNote({ body: 'c' })];
  const t = totalStats(notes);
  assert.equal(t.notes, 2);
  assert.equal(t.words, 3);
});

/* -------------------------------------------------------------- ids ------- */

test('createId produces unique, non-empty ids', () => {
  const ids = new Set(Array.from({ length: 500 }, () => createId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.ok(id.length > 4);
});

/* -------------------------------------------------------- normalisation -- */

test('normalizeNote repairs partial and legacy records', () => {
  const n = normalizeNote({ id: 'x', text: 'legacy body', pinned: 1 });
  assert.equal(n.id, 'x');
  assert.equal(n.body, 'legacy body'); // `text` alias accepted
  assert.equal(n.pinned, true);
  assert.equal(n.updatedAt, n.createdAt);
});

test('normalizeNote rejects junk', () => {
  for (const junk of [null, undefined, 0, 'string', [], () => {}]) {
    assert.equal(normalizeNote(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('normalizeNote never lets updatedAt precede createdAt', () => {
  const n = normalizeNote({ id: 'a', createdAt: 1000, updatedAt: 5 });
  assert.equal(n.updatedAt, 1000);
});

test('normalizeNotes drops junk and de-duplicates by id', () => {
  const out = normalizeNotes([
    { id: 'a', body: 'first' },
    { id: 'a', body: 'duplicate' },
    null,
    'junk',
    { id: 'b', body: 'second' },
  ]);
  assert.deepEqual(out.map((n) => n.id), ['a', 'b']);
  assert.equal(out[0].body, 'first', 'first occurrence wins');
});

test('normalizeNotes returns [] for non-arrays', () => {
  assert.deepEqual(normalizeNotes(undefined), []);
  assert.deepEqual(normalizeNotes({ notes: [] }), []);
  assert.deepEqual(normalizeNotes('nope'), []);
});

/* -------------------------------------------------------------- sorting -- */

test('sortNotes puts pinned first, then most recent, without mutating input', () => {
  const a = createNote({ id: 'a', body: 'a', updatedAt: 100 });
  const b = createNote({ id: 'b', body: 'b', updatedAt: 300 });
  const c = createNote({ id: 'c', body: 'c', updatedAt: 200, pinned: true });
  const input = [a, b, c];

  assert.deepEqual(sortNotes(input).map((n) => n.id), ['c', 'b', 'a']);
  assert.deepEqual(input.map((n) => n.id), ['a', 'b', 'c'], 'input must not be reordered');
});

test('sortNotes breaks updatedAt ties deterministically', () => {
  const x = createNote({ id: 'x', body: 'x', updatedAt: 5 });
  const y = createNote({ id: 'y', body: 'y', updatedAt: 5 });
  assert.deepEqual(sortNotes([y, x]).map((n) => n.id), ['x', 'y']);
});

/* ------------------------------------------------------------- filter -- */

test('filterNotes matches title and body case-insensitively', () => {
  const notes = [
    createNote({ id: '1', body: 'Groceries\nmilk and eggs' }),
    createNote({ id: '2', body: 'Retro\nship it' }),
  ];
  assert.deepEqual(filterNotes(notes, 'MILK').map((n) => n.id), ['1']);
  assert.deepEqual(filterNotes(notes, 'ship').map((n) => n.id), ['2']);
  assert.equal(filterNotes(notes, '   ').length, 2, 'blank query returns everything');
});

test('filterNotes requires every space-separated term to match', () => {
  const notes = [
    createNote({ id: '1', body: 'deploy checklist' }),
    createNote({ id: '2', body: 'deploy notes' }),
  ];
  assert.deepEqual(filterNotes(notes, 'deploy checklist').map((n) => n.id), ['1']);
  assert.deepEqual(filterNotes(notes, 'deploy missing'), []);
});

test('filterNotes never mutates its input array', () => {
  const notes = [createNote({ id: '1', body: 'a' })];
  filterNotes(notes, 'a');
  assert.equal(notes.length, 1);
});

/* -------------------------------------------------------- persistence -- */

test('serialize/deserialize round-trips notes', () => {
  const notes = [createNote({ id: 'a', body: 'alpha' }), createNote({ id: 'b', body: 'beta', pinned: true })];
  const restored = deserialize(serialize(notes));
  assert.deepEqual(restored, sortNotes(notes));
});

test('deserialize accepts the legacy bare-array shape', () => {
  const out = deserialize(JSON.stringify([{ id: 'a', body: 'x' }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].body, 'x');
});

test('deserialize returns [] instead of throwing on corrupt data', () => {
  for (const bad of ['{not json', 'null', '', null, undefined, '"a string"', '123']) {
    assert.deepEqual(deserialize(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

test('mergeNotes adds new notes and only replaces strictly newer ones', () => {
  // createdAt is pinned explicitly: normalizeNote() clamps updatedAt up to
  // createdAt, so leaving createdAt at Date.now() would mask every timestamp.
  const existing = [
    createNote({ id: 'a', body: 'local newer', createdAt: 100, updatedAt: 500 }),
    createNote({ id: 'b', body: 'local older', createdAt: 100, updatedAt: 100 }),
  ];
  const incoming = [
    createNote({ id: 'a', body: 'remote older', createdAt: 100, updatedAt: 200 }),
    createNote({ id: 'b', body: 'remote newer', createdAt: 100, updatedAt: 900 }),
    createNote({ id: 'c', body: 'brand new', createdAt: 100, updatedAt: 300 }),
  ];

  const { notes, added, updated } = mergeNotes(existing, incoming);
  const byId = Object.fromEntries(notes.map((n) => [n.id, n]));

  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.equal(byId.a.body, 'local newer', 'older incoming copy must not clobber local');
  assert.equal(byId.b.body, 'remote newer');
  assert.equal(byId.c.body, 'brand new');
});

test('mergeNotes does not mutate the existing list', () => {
  const existing = [createNote({ id: 'a', body: 'x', createdAt: 1, updatedAt: 1 })];
  mergeNotes(existing, [createNote({ id: 'b', body: 'y', createdAt: 2, updatedAt: 2 })]);
  assert.equal(existing.length, 1);
  assert.deepEqual(existing.map((n) => n.id), ['a']);
});

test('mergeNotes ignores junk payloads', () => {
  const { notes, added } = mergeNotes([], [null, 'junk', 7]);
  assert.equal(added, 0);
  assert.deepEqual(notes, []);
});

test('exportBundle is re-importable and carries metadata', () => {
  const notes = [createNote({ id: 'a', body: 'hello' })];
  const bundle = JSON.parse(exportBundle(notes));
  assert.equal(bundle.app, 'ecko-notes');
  assert.equal(bundle.version, 1);
  assert.ok(bundle.exportedAt);
  assert.deepEqual(deserialize(exportBundle(notes)).map((n) => n.id), ['a']);
});

test('storage keys are namespaced and versioned', () => {
  assert.equal(STORAGE_KEY, 'ecko.notes.v1');
  assert.equal(PREFS_KEY, 'ecko.notes.prefs.v1');
});

/* --------------------------------------------------------------- export -- */

test('slugify produces safe filenames', () => {
  assert.equal(slugify('Groceries & Errands!'), 'groceries-errands');
  assert.equal(slugify('  spaced   out  '), 'spaced-out');
  assert.equal(slugify('Café Notes'), 'cafe-notes', 'accents are folded, not dropped');
  assert.equal(slugify('***'), 'note');
  assert.equal(slugify(''), 'note');
});

test('noteToMarkdown does not duplicate the title heading', () => {
  const md = noteToMarkdown(createNote({ body: 'My Title\n\nbody line' }));
  assert.equal(md, 'My Title\n\nbody line\n');
  assert.equal(md.match(/My Title/g).length, 1);
});

test('noteToMarkdown handles empty and malformed notes', () => {
  assert.equal(noteToMarkdown(createNote({ body: '   ' })), '');
  assert.equal(noteToMarkdown(null), '');
  assert.equal(noteToMarkdown({}), '');
});

/* ----------------------------------------------------------- formatting -- */

test('formatRelativeTime covers each bucket', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now - 1_000, now), 'just now');
  assert.equal(formatRelativeTime(now - 12_000, now), '12s ago');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), '2d ago');
});

test('formatRelativeTime clamps clock skew and bad input', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now + 99_000, now), 'just now', 'future timestamps clamp');
  assert.equal(formatRelativeTime(undefined), '');
  assert.equal(formatRelativeTime('nope'), '');
});

test('formatRelativeTime switches to a date past a week', () => {
  const now = 1_700_000_000_000;
  const out = formatRelativeTime(now - 30 * 86_400_000, now);
  assert.ok(!out.includes('ago'), `expected a date, got "${out}"`);
  assert.ok(out.length > 0);
});

test('formatDuration formats seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(90), '1m 30s');
  assert.equal(formatDuration(120), '2m');
  assert.equal(formatDuration(3720), '1h 2m');
  assert.equal(formatDuration(undefined), '0s');
  assert.equal(formatDuration(-5), '0s');
});

test('formatCount renders grouped integers', () => {
  assert.equal(formatCount(1234).replace(/\D/g, ''), '1234');
  assert.equal(formatCount(undefined), '0');
});

/* ---------------------------------------------------------------- prefs -- */

test('DEFAULT_PREFS are already normalised (idempotent)', () => {
  assert.deepEqual(normalizePrefs(DEFAULT_PREFS), { ...DEFAULT_PREFS });
});

test('normalizePrefs rejects invalid enums and clamps numbers', () => {
  const p = normalizePrefs({ theme: 'neon', fontFamily: 'comic-sans', fontSize: 999 });
  assert.equal(p.theme, DEFAULT_PREFS.theme);
  assert.equal(p.fontFamily, DEFAULT_PREFS.fontFamily);
  assert.equal(p.fontSize, FONT_SIZE_MAX);

  assert.equal(normalizePrefs({ fontSize: -20 }).fontSize, FONT_SIZE_MIN);
  assert.equal(normalizePrefs({ fontSize: 'nonsense' }).fontSize, DEFAULT_PREFS.fontSize);
});

test('normalizePrefs fills in every key so nothing is undefined', () => {
  const p = normalizePrefs({});
  for (const key of Object.keys(DEFAULT_PREFS)) {
    assert.notEqual(p[key], undefined, `missing pref: ${key}`);
  }
});

test('normalizePrefs survives non-object input', () => {
  assert.deepEqual(normalizePrefs(null), normalizePrefs({}));
  assert.deepEqual(normalizePrefs('junk'), normalizePrefs({}));
});

test('parsePrefs handles stored, empty and corrupt values', () => {
  assert.equal(parsePrefs(JSON.stringify({ theme: 'light' })).theme, 'light');
  assert.equal(parsePrefs('').theme, DEFAULT_PREFS.theme);
  assert.equal(parsePrefs(null).theme, DEFAULT_PREFS.theme);
  assert.equal(parsePrefs('{corrupt').theme, DEFAULT_PREFS.theme);
});

test('clampPipSize always returns BOTH finite positive dimensions', () => {
  // requestWindow() throws RangeError unless width and height are both given,
  // so this invariant is what keeps the API call from failing.
  const cases = [
    [undefined, undefined],
    [400, undefined],
    [undefined, 500],
    [0, 0],
    [-100, -100],
    [10, 10],
    [999999, 999999],
    ['abc', 'def'],
    [NaN, NaN],
  ];
  for (const [w, h] of cases) {
    const size = clampPipSize(w, h);
    assert.ok(Number.isFinite(size.width), `width not finite for ${w},${h}`);
    assert.ok(Number.isFinite(size.height), `height not finite for ${w},${h}`);
    assert.ok(size.width >= PIP_MIN_WIDTH, `width too small for ${w},${h}`);
    assert.ok(size.height >= PIP_MIN_HEIGHT, `height too small for ${w},${h}`);
    assert.ok(size.width <= 2400 && size.height <= 2400, `unclamped for ${w},${h}`);
  }
});

test('clampPipSize preserves sane values', () => {
  assert.deepEqual(clampPipSize(500, 700), { width: 500, height: 700 });
});

test('clampFontSize bounds the editor size', () => {
  assert.equal(clampFontSize(1), FONT_SIZE_MIN);
  assert.equal(clampFontSize(1000), FONT_SIZE_MAX);
  assert.equal(clampFontSize(16), 16);
});

test('normalizePrefs accepts a stored PiP size round-trip', () => {
  const stored = JSON.stringify({ ...normalizePrefs({}), pipWidth: 640, pipHeight: 820 });
  const p = parsePrefs(stored);
  assert.equal(p.pipWidth, 640);
  assert.equal(p.pipHeight, 820);
});

// Regression: normalizePrefs() used to spread clampPipSize()'s `{ width, height }`
// straight into the prefs object, so pipWidth/pipHeight were always undefined
// and the floating window's remembered size was silently thrown away.
test('REGRESSION: pip size keys survive normalize -> save -> parse', () => {
  const once = normalizePrefs({ pipWidth: 640, pipHeight: 820 });
  assert.equal(once.pipWidth, 640);
  assert.equal(once.pipHeight, 820);
  assert.equal(once.width, undefined, 'must not leak requestWindow() key names');
  assert.equal(once.height, undefined);

  const twice = parsePrefs(JSON.stringify(once));
  assert.equal(twice.pipWidth, 640);
  assert.equal(twice.pipHeight, 820);
});
