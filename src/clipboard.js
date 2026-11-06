/**
 * Ecko Notes — clipboard history data layer.
 *
 * Pure functions only (no DOM), so this is importable from Node and covered
 * directly by test/clipboard.test.mjs.
 *
 * IMPORTANT PLATFORM CONSTRAINT this module is designed around: a web page
 * cannot observe the system clipboard. There is no clipboard-history API and
 * `navigator.clipboard.readText()` only works on an explicit user gesture, with
 * permission, while the document is focused. So this history can only ever be
 * filled by (a) copy/cut/paste events that happen *inside* the app, or (b) the
 * user pressing "Grab". The UI says so rather than pretending otherwise.
 */

import { createId, truncate } from './notes.js';

export const CLIP_STORAGE_KEY = 'ecko.notes.clipboard.v1';

/** Hard ceiling on stored snippets — a clipboard history must not grow forever. */
export const MAX_CLIP_ITEMS = 100;

export const CLIP_SUMMARY_MAX = 140;

/** Where a snippet came from; drives the label shown in the list. */
export const CLIP_SOURCES = Object.freeze(['copy', 'cut', 'paste', 'grab', 'manual', 'note']);

export const SOURCE_LABELS = Object.freeze({
  copy: 'copied',
  cut: 'cut',
  paste: 'pasted',
  grab: 'grabbed',
  manual: 'added',
  note: 'from note',
});

/* -------------------------------------------------------------------------- */
/* Clips                                                                       */
/* -------------------------------------------------------------------------- */

export function createClip(overrides = {}) {
  const createdAt = Number.isFinite(overrides.createdAt) ? overrides.createdAt : Date.now();
  return {
    id: typeof overrides.id === 'string' && overrides.id.trim() ? overrides.id.trim() : createId(),
    text: typeof overrides.text === 'string' ? overrides.text : '',
    source: CLIP_SOURCES.includes(overrides.source) ? overrides.source : 'manual',
    pinned: Boolean(overrides.pinned),
    createdAt,
  };
}

/**
 * Dedupe key. Whitespace runs collapse to a single space so that copying the
 * same paragraph twice with a trailing newline does not create a second entry,
 * while the stored `text` keeps its original formatting.
 */
export function clipKey(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** One-line preview for the list row. */
export function clipSummary(text, max = CLIP_SUMMARY_MAX) {
  const raw = String(text ?? '');
  for (const line of raw.split('\n')) {
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (collapsed) return truncate(collapsed, max);
  }
  return '';
}

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || 'added';
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

export function normalizeClip(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  // Accept `body`/`value` aliases so hand-written imports still work.
  const text =
    typeof raw.text === 'string'
      ? raw.text
      : typeof raw.body === 'string'
        ? raw.body
        : typeof raw.value === 'string'
          ? raw.value
          : '';

  // An empty snippet is useless in a clipboard history — drop it.
  if (!text.trim()) return null;

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createId(),
    text,
    source: CLIP_SOURCES.includes(raw.source) ? raw.source : 'manual',
    pinned: Boolean(raw.pinned),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

export function normalizeClips(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const clip = normalizeClip(item);
    if (!clip || seen.has(clip.id)) continue;
    seen.add(clip.id);
    out.push(clip);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Ordering & searching                                                        */
/* -------------------------------------------------------------------------- */

/** Pinned first, then most recently captured. Never mutates the input. */
export function sortClips(clips = []) {
  return [...clips].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const delta = (b.createdAt || 0) - (a.createdAt || 0);
    if (delta !== 0) return delta;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function filterClips(clips = [], query = '') {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return clips;
  const terms = q.split(/\s+/).filter(Boolean);
  return clips.filter((clip) => {
    const haystack = clip.text.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Enforce the cap without ever discarding a pinned snippet. If pinned items
 * alone exceed the limit, they are all kept — the user pinned them on purpose.
 */
export function trimToLimit(clips = [], limit = MAX_CLIP_ITEMS) {
  if (clips.length <= limit) return sortClips(clips);
  // Sort FIRST, then slice: sortClips() orders newest-first, so slicing keeps
  // the most recent snippets. Slicing the raw input instead would silently
  // discard whatever the user copied most recently — the opposite of useful.
  const sorted = sortClips(clips);
  const pinned = sorted.filter((c) => c.pinned);
  const room = Math.max(0, limit - pinned.length);
  const rest = sorted.filter((c) => !c.pinned).slice(0, room);
  return sortClips([...pinned, ...rest]);
}

/**
 * Add a snippet. If an identical snippet (by whitespace-normalised text) is
 * already present it is bumped to the top and re-stamped instead of
 * duplicated — repeatedly copying the same thing should not fill the history.
 *
 * Returns `{ clips, clip, bumped }`; `clip` is null when the text was blank.
 */
export function addClip(clips = [], text, source = 'manual') {
  const current = normalizeClips(clips);
  const incoming = normalizeClip({ text, source, createdAt: Date.now() });
  if (!incoming) return { clips: current, clip: null, bumped: false };

  const key = clipKey(incoming.text);
  const existingIndex = current.findIndex((c) => clipKey(c.text) === key);

  if (existingIndex !== -1) {
    const existing = current[existingIndex];
    // Keep the user's pin, refresh everything else, and preserve the exact
    // formatting of the newest copy.
    const bumped = {
      ...existing,
      text: incoming.text,
      source: incoming.source,
      createdAt: incoming.createdAt,
    };
    const next = [...current];
    next[existingIndex] = bumped;
    return { clips: trimToLimit(next), clip: bumped, bumped: true };
  }

  return { clips: trimToLimit([...current, incoming]), clip: incoming, bumped: false };
}

export function removeClip(clips = [], id) {
  return normalizeClips(clips).filter((c) => c.id !== id);
}

export function toggleClipPin(clips = [], id) {
  const next = normalizeClips(clips).map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c));
  return sortClips(next);
}

export function updateClipText(clips = [], id, text) {
  const clip = normalizeClip({ text, source: 'manual' });
  if (!clip) return normalizeClips(clips);
  const next = normalizeClips(clips).map((c) =>
    c.id === id ? { ...c, text: clip.text, createdAt: Date.now() } : c,
  );
  return sortClips(next);
}

/** Clear the history. Pinned snippets survive unless `keepPinned` is false. */
export function clearClips(clips = [], { keepPinned = true } = {}) {
  const current = normalizeClips(clips);
  return keepPinned ? current.filter((c) => c.pinned) : [];
}

export function clipStats(clips = []) {
  return clips.reduce(
    (acc, clip) => {
      acc.clips += 1;
      acc.chars += String(clip.text ?? '').length;
      if (clip.pinned) acc.pinned += 1;
      return acc;
    },
    { clips: 0, chars: 0, pinned: 0 },
  );
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

export function serializeClips(clips = [], savedAt = Date.now()) {
  return JSON.stringify({ version: 1, savedAt, clips: sortClips(clips) });
}

/** Corrupt or legacy input yields an empty history rather than a throw. */
export function deserializeClips(text) {
  if (text === null || text === undefined || text === '') return [];
  let parsed;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return trimToLimit(normalizeClips(parsed));
  if (parsed && typeof parsed === 'object') return trimToLimit(normalizeClips(parsed.clips));
  return [];
}
