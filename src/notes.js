/**
 * Ecko Notes — pure data layer.
 *
 * This module deliberately touches no DOM APIs so it can be imported both by the
 * browser app (src/app.js) and by the Node test suite (test/*.test.mjs).
 * Keeping the note/prefs logic here means the tests exercise the exact code
 * that ships, not a re-implementation of it.
 */

export const STORAGE_KEY = 'ecko.notes.v1';
export const PREFS_KEY = 'ecko.notes.prefs.v1';

export const TITLE_MAX = 80;
export const PREVIEW_MAX = 90;
export const WORDS_PER_MINUTE = 200;

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

/** Collision-resistant id, preferring the native crypto implementation. */
export function createId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `n${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

export function createNote(overrides = {}) {
  const createdAt = Number.isFinite(overrides.createdAt) ? overrides.createdAt : Date.now();
  return {
    id: typeof overrides.id === 'string' && overrides.id.trim() ? overrides.id.trim() : createId(),
    body: typeof overrides.body === 'string' ? overrides.body : '',
    pinned: Boolean(overrides.pinned),
    createdAt,
    updatedAt: Number.isFinite(overrides.updatedAt) ? overrides.updatedAt : createdAt,
  };
}

export function truncate(text, max) {
  const out = String(text ?? '').trim();
  if (out.length <= max) return out;
  return `${out.slice(0, max - 1).trimEnd()}\u2026`;
}

/**
 * A note has no separate title field: the first non-empty line of the body is
 * the title. That keeps the editor a plain textarea with nothing to keep in
 * sync, which matters a lot once the DOM is being moved into a PiP window.
 */
export function deriveTitle(body, fallback = 'Untitled note') {
  if (typeof body !== 'string') return fallback;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/^#{1,6}\s+/, '');
    if (line) return truncate(line, TITLE_MAX);
  }
  return fallback;
}

/** Text shown under the title in the sidebar list. */
export function derivePreview(body, max = PREVIEW_MAX) {
  const lines = String(body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return '';
  return truncate(lines.slice(1).join(' '), max);
}

export function computeStats(body = '') {
  const text = typeof body === 'string' ? body : '';
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  return {
    chars: text.length,
    charsNoSpaces: text.replace(/\s/g, '').length,
    words,
    lines: text ? text.split('\n').length : 0,
    readingSeconds: words ? Math.max(1, Math.round((words / WORDS_PER_MINUTE) * 60)) : 0,
  };
}

export function totalStats(notes = []) {
  return notes.reduce(
    (acc, note) => {
      const s = computeStats(note.body);
      acc.notes += 1;
      acc.words += s.words;
      acc.chars += s.chars;
      return acc;
    },
    { notes: 0, words: 0, chars: 0 },
  );
}

/* -------------------------------------------------------------------------- */
/* Normalisation & validation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Coerce arbitrary input (localStorage, an imported file, a corrupted value)
 * into a valid note, or `null` when nothing usable can be salvaged.
 */
export function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  // `text` is accepted as an alias so older/hand-written exports still import.
  const body =
    typeof raw.body === 'string' ? raw.body : typeof raw.text === 'string' ? raw.text : '';

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createId(),
    body,
    pinned: Boolean(raw.pinned),
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
  };
}

/** Normalise a list, dropping junk and de-duplicating by id (first wins). */
export function normalizeNotes(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const note = normalizeNote(item);
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    out.push(note);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Ordering & searching                                                        */
/* -------------------------------------------------------------------------- */

/** Pinned notes first, then most recently edited. Never mutates the input. */
export function sortNotes(notes = []) {
  return [...notes].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const delta = (b.updatedAt || 0) - (a.updatedAt || 0);
    if (delta !== 0) return delta;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Case-insensitive substring match across the derived title and full body. */
export function filterNotes(notes = [], query = '') {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return notes;
  const terms = q.split(/\s+/).filter(Boolean);
  return notes.filter((note) => {
    const haystack = `${deriveTitle(note.body)}\n${note.body}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

export function serialize(notes = [], savedAt = Date.now()) {
  return JSON.stringify({ version: 1, savedAt, notes: sortNotes(notes) });
}

/**
 * Parse stored/imported JSON. Accepts the current envelope, a bare array
 * (v0 shape), or garbage — garbage yields an empty list rather than a throw,
 * because this runs on startup and must never brick the app.
 */
export function deserialize(text) {
  if (text === null || text === undefined || text === '') return [];
  let parsed;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return normalizeNotes(parsed);
  if (parsed && typeof parsed === 'object') return normalizeNotes(parsed.notes);
  return [];
}

/**
 * Merge an incoming export into the current list, keyed by note id.
 * Existing notes are only replaced when the incoming copy is strictly newer,
 * so importing into a stale tab can never destroy newer local edits.
 */
export function mergeNotes(existing = [], incoming = []) {
  const byId = new Map(existing.map((note) => [note.id, note]));
  let added = 0;
  let updated = 0;

  for (const note of normalizeNotes(incoming)) {
    const current = byId.get(note.id);
    if (!current) {
      byId.set(note.id, note);
      added += 1;
    } else if (note.updatedAt > current.updatedAt) {
      byId.set(note.id, { ...current, ...note });
      updated += 1;
    }
  }

  return { notes: sortNotes([...byId.values()]), added, updated };
}

export function exportBundle(notes = []) {
  return JSON.stringify(
    { app: 'ecko-notes', version: 1, exportedAt: new Date().toISOString(), notes: sortNotes(notes) },
    null,
    2,
  );
}

/* -------------------------------------------------------------------------- */
/* Export helpers                                                              */
/* -------------------------------------------------------------------------- */

export function slugify(text, fallback = 'note') {
  const slug = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

/**
 * The body already starts with its own title line, so a Markdown export is
 * simply the body — no duplicated heading, no lossy round-trip.
 */
export function noteToMarkdown(note) {
  const body = typeof note?.body === 'string' ? note.body.trim() : '';
  return body ? `${body}\n` : '';
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export function formatRelativeTime(ts, nowTs = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const delta = Math.max(0, nowTs - ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function formatCount(n) {
  return new Intl.NumberFormat(undefined).format(Number(n) || 0);
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                 */
/* -------------------------------------------------------------------------- */

export const DEFAULT_PREFS = Object.freeze({
  theme: 'system', // 'light' | 'dark' | 'system'
  fontFamily: 'mono', // 'mono' | 'serif' | 'sans'
  fontSize: 15,
  wrap: true,
  sidebarOpen: true,
  tab: 'notes', // 'notes' | 'clipboard'
  captureClipboard: true, // auto-add in-app copy/cut/paste to the history
  pipWidth: 400,
  pipHeight: 560,
  useFallbackWindow: false, // user asked for a plain popup instead of PiP
});

export const TABS = ['notes', 'clipboard'];

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 30;
export const FONT_FAMILIES = ['mono', 'serif', 'sans'];
export const THEMES = ['light', 'dark', 'system'];

export const PIP_MIN_WIDTH = 240;
export const PIP_MIN_HEIGHT = 260;
export const PIP_MAX_DIMENSION = 2400;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * requestWindow() rejects when only one of width/height is supplied, so both
 * are always returned together and always finite/positive.
 */
export function clampPipSize(width, height) {
  const w = Math.round(clamp(Number(width) || DEFAULT_PREFS.pipWidth, PIP_MIN_WIDTH, PIP_MAX_DIMENSION));
  const h = Math.round(clamp(Number(height) || DEFAULT_PREFS.pipHeight, PIP_MIN_HEIGHT, PIP_MAX_DIMENSION));
  return { width: w, height: h };
}

export function clampFontSize(size) {
  return Math.round(clamp(Number(size) || DEFAULT_PREFS.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX));
}

export function normalizePrefs(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const theme = THEMES.includes(src.theme) ? src.theme : DEFAULT_PREFS.theme;
  const fontFamily = FONT_FAMILIES.includes(src.fontFamily)
    ? src.fontFamily
    : DEFAULT_PREFS.fontFamily;
  // clampPipSize() returns { width, height } — the shape requestWindow() wants.
  // Rename here so prefs keep the `pipWidth`/`pipHeight` keys they document.
  const size = clampPipSize(src.pipWidth, src.pipHeight);
  return {
    theme,
    fontFamily,
    fontSize: clampFontSize(src.fontSize),
    wrap: src.wrap === undefined ? DEFAULT_PREFS.wrap : Boolean(src.wrap),
    sidebarOpen: src.sidebarOpen === undefined ? DEFAULT_PREFS.sidebarOpen : Boolean(src.sidebarOpen),
    tab: TABS.includes(src.tab) ? src.tab : DEFAULT_PREFS.tab,
    captureClipboard:
      src.captureClipboard === undefined
        ? DEFAULT_PREFS.captureClipboard
        : Boolean(src.captureClipboard),
    pipWidth: size.width,
    pipHeight: size.height,
    useFallbackWindow: Boolean(src.useFallbackWindow),
  };
}

export function parsePrefs(text) {
  if (text === null || text === undefined || text === '') return { ...DEFAULT_PREFS };
  let parsed;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { ...DEFAULT_PREFS };
  }
  return normalizePrefs(parsed);
}
