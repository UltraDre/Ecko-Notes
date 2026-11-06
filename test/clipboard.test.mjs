import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIP_STORAGE_KEY,
  MAX_CLIP_ITEMS,
  CLIP_SOURCES,
  createClip,
  clipKey,
  clipSummary,
  sourceLabel,
  normalizeClip,
  normalizeClips,
  sortClips,
  filterClips,
  trimToLimit,
  addClip,
  removeClip,
  toggleClipPin,
  updateClipText,
  clearClips,
  clipStats,
  serializeClips,
  deserializeClips,
} from '../src/clipboard.js';
import { createId } from '../src/notes.js';

/* ------------------------------------------------------------- creation -- */

test('createClip applies defaults and honours overrides', () => {
  const clip = createClip({ text: 'hello' });
  assert.equal(clip.text, 'hello');
  assert.equal(clip.source, 'manual', 'unknown source falls back to manual');
  assert.equal(clip.pinned, false);
  assert.ok(clip.id.length > 4);
  assert.ok(Number.isFinite(clip.createdAt));

  const custom = createClip({ id: 'c1', text: 'x', source: 'grab', pinned: true, createdAt: 42 });
  assert.deepEqual(custom, {
    id: 'c1',
    text: 'x',
    source: 'grab',
    pinned: true,
    createdAt: 42,
  });
});

test('createClip coerces non-string text to an empty string', () => {
  assert.equal(createClip({ text: 42 }).text, '');
  assert.equal(createClip({ text: null }).text, '');
  assert.equal(createClip({}).text, '');
});

test('every declared source has a human label', () => {
  for (const source of CLIP_SOURCES) {
    const label = sourceLabel(source);
    assert.ok(typeof label === 'string' && label.length > 0, `no label for ${source}`);
  }
  assert.equal(sourceLabel('invented'), 'added', 'unknown source still gets a label');
});

/* -------------------------------------------------------------- keying -- */

test('clipKey collapses whitespace and case for dedupe', () => {
  const a = clipKey('Deploy checklist\n  step one');
  const b = clipKey('deploy checklist step one');
  assert.equal(a, b);
  assert.notEqual(clipKey('deploy checklist'), clipKey('deploy checklists'));
});

test('clipKey handles null and empty input', () => {
  assert.equal(clipKey(null), '');
  assert.equal(clipKey(undefined), '');
  assert.equal(clipKey('   \n  '), '');
});

test('clipSummary uses the first non-empty line', () => {
  assert.equal(clipSummary('first line\nsecond line'), 'first line');
  assert.equal(clipSummary('\n\n  indented  \nmore'), 'indented');
  assert.equal(clipSummary('a   b    c'), 'a b c', 'internal runs collapse');
  assert.equal(clipSummary(''), '');
  assert.equal(clipSummary(null), '');
});

test('clipSummary truncates long lines', () => {
  const out = clipSummary('x'.repeat(400));
  assert.ok(out.length <= 140, `expected <= 140, got ${out.length}`);
  assert.ok(out.endsWith('\u2026'));
});

/* -------------------------------------------------------- normalisation -- */

test('normalizeClip drops empty and whitespace-only snippets', () => {
  assert.equal(normalizeClip({ text: '' }), null);
  assert.equal(normalizeClip({ text: '   \n\t ' }), null);
  assert.equal(normalizeClip({ text: 42 }), null);
});

test('normalizeClip accepts body/value aliases', () => {
  assert.equal(normalizeClip({ id: 'a', body: 'from body' }).text, 'from body');
  assert.equal(normalizeClip({ id: 'b', value: 'from value' }).text, 'from value');
  assert.equal(normalizeClip({ id: 'c', text: 'wins', body: 'ignored' }).text, 'wins');
});

test('normalizeClip rejects junk', () => {
  for (const junk of [null, undefined, 0, 'text', [], () => {}]) {
    assert.equal(normalizeClip(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('normalizeClip mints an id and defaults the timestamp', () => {
  const clip = normalizeClip({ text: 'no id here' });
  assert.ok(clip.id.length > 4);
  assert.ok(Number.isFinite(clip.createdAt));
  assert.equal(clip.source, 'manual');
});

test('normalizeClips de-duplicates by id and drops junk', () => {
  const out = normalizeClips([
    { id: 'a', text: 'first' },
    { id: 'a', text: 'dupe' },
    { id: 'b', text: '   ' },
    null,
    { id: 'c', text: 'third' },
  ]);
  assert.deepEqual(out.map((c) => c.id), ['a', 'c']);
  assert.equal(out[0].text, 'first');
});

test('normalizeClips returns [] for non-arrays', () => {
  assert.deepEqual(normalizeClips(undefined), []);
  assert.deepEqual(normalizeClips({ clips: [] }), []);
  assert.deepEqual(normalizeClips('nope'), []);
});

/* ------------------------------------------------------------- ordering -- */

test('sortClips puts pinned first then most recent, without mutating', () => {
  const a = createClip({ id: 'a', text: 'a', createdAt: 100 });
  const b = createClip({ id: 'b', text: 'b', createdAt: 300 });
  const c = createClip({ id: 'c', text: 'c', createdAt: 200, pinned: true });
  const input = [a, b, c];

  assert.deepEqual(sortClips(input).map((x) => x.id), ['c', 'b', 'a']);
  assert.deepEqual(input.map((x) => x.id), ['a', 'b', 'c'], 'input must not be reordered');
});

test('sortClips breaks ties deterministically', () => {
  const x = createClip({ id: 'x', text: 'x', createdAt: 5 });
  const y = createClip({ id: 'y', text: 'y', createdAt: 5 });
  assert.deepEqual(sortClips([y, x]).map((c) => c.id), ['x', 'y']);
});

/* ------------------------------------------------------------ filtering -- */

test('filterClips matches every space-separated term', () => {
  const clips = [
    createClip({ id: '1', text: 'npm run deploy' }),
    createClip({ id: '2', text: 'npm install jsdom' }),
  ];
  assert.deepEqual(filterClips(clips, 'npm deploy').map((c) => c.id), ['1']);
  assert.deepEqual(filterClips(clips, 'npm').length, 2);
  assert.deepEqual(filterClips(clips, 'npm missing'), []);
  assert.equal(filterClips(clips, '  ').length, 2, 'blank query returns everything');
});

test('filterClips is case-insensitive and does not mutate', () => {
  const clips = [createClip({ id: '1', text: 'Secret Token' })];
  assert.equal(filterClips(clips, 'SECRET TOKEN').length, 1);
  filterClips(clips, 'secret');
  assert.equal(clips.length, 1);
});

/* --------------------------------------------------------- cap / limit -- */

test('trimToLimit caps the history at MAX_CLIP_ITEMS', () => {
  const many = Array.from({ length: MAX_CLIP_ITEMS + 40 }, (_, i) =>
    createClip({ id: `c${i}`, text: `snippet ${i}`, createdAt: i }),
  );
  const trimmed = trimToLimit(many);
  assert.equal(trimmed.length, MAX_CLIP_ITEMS);
});

test('trimToLimit keeps the most recent entries, not the oldest', () => {
  const many = Array.from({ length: MAX_CLIP_ITEMS + 10 }, (_, i) =>
    createClip({ id: `c${i}`, text: `s${i}`, createdAt: i }),
  );
  const ids = new Set(trimToLimit(many).map((c) => c.id));
  assert.ok(ids.has(`c${MAX_CLIP_ITEMS + 9}`), 'newest must survive');
  assert.ok(!ids.has('c0'), 'oldest must be dropped');
});

test('trimToLimit never discards a pinned snippet, even past the cap', () => {
  const pinned = Array.from({ length: 5 }, (_, i) =>
    createClip({ id: `p${i}`, text: `pinned ${i}`, pinned: true, createdAt: 1000 + i }),
  );
  const rest = Array.from({ length: MAX_CLIP_ITEMS + 20 }, (_, i) =>
    createClip({ id: `r${i}`, text: `r${i}`, createdAt: i }),
  );

  const trimmed = trimToLimit([...pinned, ...rest]);
  assert.equal(trimmed.filter((c) => c.pinned).length, 5, 'all pinned survive');
  assert.equal(trimmed.length, MAX_CLIP_ITEMS);
});

test('trimToLimit keeps everything when under the cap', () => {
  const few = [createClip({ id: 'a', text: 'a' }), createClip({ id: 'b', text: 'b' })];
  assert.equal(trimToLimit(few).length, 2);
});

/* --------------------------------------------------------------- addClip -- */

test('addClip appends a new snippet', () => {
  const { clips, clip, bumped } = addClip([], 'first snippet', 'grab');
  assert.equal(clips.length, 1);
  assert.equal(clip.text, 'first snippet');
  assert.equal(clip.source, 'grab');
  assert.equal(bumped, false);
});

test('addClip bumps a duplicate instead of creating a second entry', () => {
  const old = createClip({ id: 'old', text: 'npm test', createdAt: 1000 });
  const other = createClip({ id: 'other', text: 'unrelated', createdAt: 2000 });

  const { clips, clip, bumped } = addClip([other, old], 'npm   test\n', 'copy');

  assert.equal(clips.length, 2, 'must not duplicate');
  assert.equal(bumped, true);
  assert.equal(clip.id, 'old', 'reuses the existing entry');
  assert.equal(clips[0].id, 'old', 'bumped snippet moves to the top');
  assert.equal(clips[0].source, 'copy', 'source is refreshed');
  assert.ok(clips[0].createdAt > 1000, 'timestamp is refreshed');
});

test('addClip preserves a pin when bumping', () => {
  const pinned = createClip({ id: 'p', text: 'keep me', pinned: true, createdAt: 1 });
  const { clips } = addClip([pinned], 'keep me', 'paste');
  assert.equal(clips[0].pinned, true, 'bumping must not silently unpin');
});

test('addClip rejects blank input and leaves the list untouched', () => {
  const existing = [createClip({ id: 'a', text: 'a' })];
  for (const blank of ['', '   ', '\n\t', null, undefined]) {
    const { clips, clip } = addClip(existing, blank, 'manual');
    assert.equal(clip, null, `expected null clip for ${JSON.stringify(blank)}`);
    assert.equal(clips.length, 1);
  }
});

test('addClip enforces the cap', () => {
  let clips = [];
  for (let i = 0; i < MAX_CLIP_ITEMS + 25; i += 1) {
    clips = addClip(clips, `snippet ${i}`, 'manual').clips;
  }
  assert.equal(clips.length, MAX_CLIP_ITEMS);
});

test('addClip ignores junk already in the list', () => {
  const { clips } = addClip([null, 'junk', { text: '' }], 'real', 'manual');
  assert.equal(clips.length, 1);
  assert.equal(clips[0].text, 'real');
});

/* -------------------------------------------------------------- mutators -- */

test('removeClip removes only the target', () => {
  const clips = [createClip({ id: 'a', text: 'a' }), createClip({ id: 'b', text: 'b' })];
  const out = removeClip(clips, 'a');
  assert.deepEqual(out.map((c) => c.id), ['b']);
  assert.equal(clips.length, 2, 'input untouched');
});

test('removeClip tolerates an unknown id', () => {
  const clips = [createClip({ id: 'a', text: 'a' })];
  assert.equal(removeClip(clips, 'nope').length, 1);
});

test('toggleClipPin flips the flag and re-sorts', () => {
  const a = createClip({ id: 'a', text: 'a', createdAt: 100 });
  const b = createClip({ id: 'b', text: 'b', createdAt: 200 });
  const pinned = toggleClipPin([b, a], 'a');
  assert.equal(pinned[0].id, 'a', 'newly pinned sorts first');
  assert.equal(pinned[0].pinned, true);

  const unpinned = toggleClipPin(pinned, 'a');
  assert.equal(unpinned.find((c) => c.id === 'a').pinned, false);
});

test('toggleClipPin leaves the list unchanged for an unknown id', () => {
  const clips = [createClip({ id: 'a', text: 'a' })];
  assert.equal(toggleClipPin(clips, 'zzz').length, 1);
});

test('updateClipText edits in place and re-stamps', () => {
  const clip = createClip({ id: 'a', text: 'old', createdAt: 1 });
  const out = updateClipText([clip], 'a', 'new text');
  assert.equal(out[0].text, 'new text');
  assert.equal(out[0].id, 'a');
  assert.ok(out[0].createdAt > 1);
});

test('updateClipText refuses to blank a snippet', () => {
  const clip = createClip({ id: 'a', text: 'keep' });
  assert.equal(updateClipText([clip], 'a', '   ')[0].text, 'keep');
});

test('clearClips keeps pinned by default and can wipe everything', () => {
  const clips = [
    createClip({ id: 'a', text: 'a', pinned: true }),
    createClip({ id: 'b', text: 'b' }),
  ];
  assert.deepEqual(clearClips(clips).map((c) => c.id), ['a']);
  assert.deepEqual(clearClips(clips, { keepPinned: false }), []);
  assert.equal(clips.length, 2, 'input untouched');
});

test('clipStats counts clips, characters and pins', () => {
  const clips = [
    createClip({ text: 'abcd', pinned: true }),
    createClip({ text: 'ef' }),
  ];
  assert.deepEqual(clipStats(clips), { clips: 2, chars: 6, pinned: 1 });
  assert.deepEqual(clipStats([]), { clips: 0, chars: 0, pinned: 0 });
});

/* ---------------------------------------------------------- persistence -- */

test('serialize/deserialize round-trips the history', () => {
  const clips = [
    createClip({ id: 'a', text: 'alpha', source: 'grab' }),
    createClip({ id: 'b', text: 'beta', pinned: true }),
  ];
  assert.deepEqual(deserializeClips(serializeClips(clips)), sortClips(clips));
});

test('deserializeClips accepts the legacy bare-array shape', () => {
  const out = deserializeClips(JSON.stringify([{ id: 'a', text: 'x' }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'x');
});

test('deserializeClips returns [] rather than throwing on corrupt data', () => {
  for (const bad of ['{not json', 'null', '', null, undefined, '"str"', '7']) {
    assert.deepEqual(deserializeClips(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

test('deserializeClips enforces the cap on imported data', () => {
  const many = Array.from({ length: MAX_CLIP_ITEMS + 30 }, (_, i) => ({
    id: `c${i}`,
    text: `s${i}`,
    createdAt: i,
  }));
  assert.equal(deserializeClips(JSON.stringify(many)).length, MAX_CLIP_ITEMS);
});

test('deserializeClips drops empty snippets from imported data', () => {
  const out = deserializeClips(
    JSON.stringify([
      { id: 'a', text: 'real' },
      { id: 'b', text: '   ' },
    ]),
  );
  assert.deepEqual(out.map((c) => c.id), ['a']);
});

test('the storage key is namespaced and separate from notes', () => {
  assert.equal(CLIP_STORAGE_KEY, 'ecko.notes.clipboard.v1');
  assert.notEqual(CLIP_STORAGE_KEY, 'ecko.notes.v1');
});

test('createId still yields unique ids at volume', () => {
  const ids = new Set(Array.from({ length: 300 }, () => createId()));
  assert.equal(ids.size, 300);
});
