/**
 * Ecko Notes — application shell.
 *
 * The whole notepad is a single DOM subtree (#app). "Float on top" moves that
 * exact subtree into an always-on-top Document Picture-in-Picture window and
 * moves it back on `pagehide`. Nothing is cloned, so there is exactly one
 * instance of the app and no cross-window state to reconcile.
 *
 * The one real gotcha: moving a node does NOT move the JavaScript realm it was
 * created in. All of this app's closures and listeners still belong to the
 * opener tab's realm (which is why localStorage writes stay consistent), but
 * anything bound to the opener's `window`/`document` stops receiving events
 * once focus moves to the PiP window. `bindGlobals()` re-points those at
 * whichever window currently hosts #app.
 */

import {
  STORAGE_KEY,
  PREFS_KEY,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_FAMILIES,
  THEMES,
  createNote,  deriveTitle,
  derivePreview,
  computeStats,
  totalStats,
  sortNotes,
  filterNotes,
  serialize,
  deserialize,
  mergeNotes,
  exportBundle,
  noteToMarkdown,
  slugify,
  formatRelativeTime,
  formatDuration,
  formatCount,
  normalizePrefs,
  parsePrefs,
} from './notes.js';

import {
  supportsDocumentPip,
  isPipOpen,
  isBlockedByContext,
  supportsPopupFallback,
  requestPipWindow,
  copyStyles,
  copyDocumentMeta,
  explainFailure,
  watchPipSize,
} from './pip.js';

import {
  CLIP_STORAGE_KEY,
  MAX_CLIP_ITEMS,
  addClip,
  removeClip,
  toggleClipPin,
  updateClipText,
  clearClips,
  filterClips,
  sortClips,
  clipSummary,
  clipStats,
  sourceLabel,
  serializeClips,
  deserializeClips,
} from './clipboard.js';

/* -------------------------------------------------------------------------- */
/* DOM                                                                         */
/* -------------------------------------------------------------------------- */

const $ = (sel) => document.querySelector(sel);

const stage = $('#stage');
const app = $('#app');
const placeholder = $('#pip-placeholder');
const sidebar = $('#sidebar');
const noteList = $('#note-list');
const emptyList = $('#empty-list');
const emptySub = $('#empty-sub');
const searchInput = $('#search');
const clearSearchBtn = $('#btn-clear-search');
const totalsEl = $('#totals');

const editor = $('#editor');
const editorPane = $('.editor-pane');
const editorTitle = $('#editor-title');
const editorMeta = $('#editor-meta');
const statWords = $('#stat-words');
const statChars = $('#stat-chars');
const statRead = $('#stat-read');
const saveState = $('#save-state');
const modeLabel = $('#mode-label');

const btnNew = $('#btn-new');
const btnImport = $('#btn-import');
const btnExport = $('#btn-export');
const importFile = $('#import-file');
const btnToggleSidebar = $('#btn-toggle-sidebar');
const btnPin = $('#btn-pin');
const btnFontDown = $('#btn-font-down');
const btnFontUp = $('#btn-font-up');
const btnFontFamily = $('#btn-font-family');
const btnWrap = $('#btn-wrap');
const btnTheme = $('#btn-theme');
const btnCopy = $('#btn-copy');
const btnDownload = $('#btn-download');
const btnDuplicate = $('#btn-duplicate');
const btnDelete = $('#btn-delete');
const btnFloat = $('#btn-float');
const floatBtnLabel = $('#float-btn-label');
const btnReturn = $('#btn-return');
const toastRoot = $('#toast-root');

// Tabs
const tabNotes = $('#tab-notes');
const tabClipboard = $('#tab-clipboard');
const panelNotes = $('#panel-notes');
const panelClipboard = $('#panel-clipboard');
const clipCount = $('#clip-count');

// Clipboard panel
const clipList = $('#clip-list');
const clipEmpty = $('#clip-empty');
const clipEmptyTitle = $('#clip-empty-title');
const clipEmptySub = $('#clip-empty-sub');
const clipSearch = $('#clip-search');
const clipSub = $('#clip-sub');
const btnClipGrab = $('#btn-clip-grab');
const btnClipAdd = $('#btn-clip-add');
const btnClipCapture = $('#btn-clip-capture');
const btnClipClear = $('#btn-clip-clear');

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/** @type {import('./notes.js').Note[]} */
let notes = [];
let activeId = null;
let query = '';
let prefs = parsePrefs(safeRead(PREFS_KEY));

let pipWindow = null;
let unwatchPipSize = () => {};
let standbyStandalone = false;
let lastDeleted = null;
let renderedNoteId = null;

/** Clipboard history, and the filter applied to it. */
let clips = [];
let clipQuery = '';

/**
 * True while *we* are writing to the system clipboard. Without this, our own
 * copy actions would fire a `copy` event and re-capture the snippet we just
 * put there — an instant duplicate.
 */
let suppressCapture = false;

let saveTimer = null;
let persistTimer = null;

/** The document/window currently hosting #app. */
const hostDocument = () => (app.isConnected && app.ownerDocument) || document;
const hostWindow = () => hostDocument().defaultView || window;

function safeRead(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

const getActive = () => notes.find((n) => n.id === activeId) || null;

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

function toast(message, { kind = 'info', action = null, duration = 4200 } = {}) {
  const el = hostDocument().createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;

  const msg = hostDocument().createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  el.append(msg);

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    el.dataset.leaving = 'true';
    setTimeout(() => el.remove(), 180);
  };

  if (action) {
    const btn = hostDocument().createElement('button');
    btn.className = 'toast-action';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    el.append(btn);
  }

  toastRoot.append(el);
  // Keep at most 3 toasts; PiP windows are small.
  while (toastRoot.children.length > 3) toastRoot.firstElementChild.remove();

  timer = setTimeout(dismiss, duration);
  return dismiss;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

function loadNotes() {
  notes = sortNotes(deserialize(safeRead(STORAGE_KEY)));
  if (notes.length === 0) notes = [seedNote()];
  activeId = notes[0]?.id ?? null;
}

function seedNote() {
  return createNote({
    body: [
      'Welcome to Ecko Notes',
      '',
      'Click "Float on top" (or press Ctrl+Shift+P) to detach this notepad into an',
      'always-on-top window that stays above every other app on your desktop.',
      '',
      '- Everything autosaves to this browser as you type',
      '- The first line of a note becomes its title',
      '- Ctrl+Alt+N new note   /   Ctrl+S save   /   Ctrl+\\ toggle sidebar',
      '- Your floating window remembers its size between sessions',
      '',
      'Delete this note whenever you are ready.',
    ].join('\n'),
  });
}

function persistNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  setSaveState('saving');
  const ok = safeWrite(STORAGE_KEY, serialize(notes));
  setSaveState(ok ? 'saved' : 'error');
  if (!ok) toast('Could not save — browser storage is full or blocked.', { kind: 'danger', duration: 6000 });
  return ok;
}

/** Debounced write; typing should never block on localStorage. */
function schedulePersist(delay = 350) {
  setSaveState('saving');
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, delay);
}

function setSaveState(state) {
  saveState.dataset.state = state;
  saveState.textContent =
    state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Saved';
}

function persistPrefs() {
  safeWrite(PREFS_KEY, JSON.stringify(normalizePrefs(prefs)));
}

/* -------------------------------------------------------------------------- */
/* Note mutations                                                              */
/* -------------------------------------------------------------------------- */

function touch(note) {
  note.updatedAt = Date.now();
  return note;
}

function newNote({ focus = true, body = '' } = {}) {
  const note = touch(createNote({ body }));
  notes.unshift(note);
  activeId = note.id;
  query = '';
  searchInput.value = '';
  clearSearchBtn.hidden = true;
  persistNow();
  renderAll();
  if (focus) focusEditor(0);
  return note;
}

function deleteActive() {
  const note = getActive();
  if (!note) return;
  const index = notes.findIndex((n) => n.id === note.id);
  notes.splice(index, 1);
  lastDeleted = { note, index };

  const remaining = visibleNotes();
  activeId = remaining[0]?.id ?? notes[0]?.id ?? null;
  if (!activeId && notes.length === 0) {
    const fresh = createNote({});
    notes.push(fresh);
    activeId = fresh.id;
  }
  renderedNoteId = null;
  persistNow();
  renderAll();
  focusEditor(0);

  toast(`Deleted “${deriveTitle(note.body)}”`, {
    kind: 'danger',
    action: {
      label: 'Undo',
      onClick: () => {
        notes.splice(Math.min(lastDeleted.index, notes.length), 0, lastDeleted.note);
        activeId = lastDeleted.note.id;
        renderedNoteId = null;
        lastDeleted = null;
        persistNow();
        renderAll();
      },
    },
  });
}

function duplicateActive() {
  const note = getActive();
  if (!note) return;
  const copy = touch(createNote({ body: note.body, pinned: note.pinned }));
  const at = notes.findIndex((n) => n.id === note.id);
  notes.splice(at + 1, 0, copy);
  activeId = copy.id;
  persistNow();
  renderAll();
  toast('Note duplicated', { kind: 'success', duration: 2200 });
}

function togglePin() {
  const note = getActive();
  if (!note) return;
  note.pinned = !note.pinned;
  persistNow();
  renderAll();
}

function updateActiveBody(value) {
  const note = getActive();
  if (!note) return;
  if (note.body === value) return;
  note.body = value;
  touch(note);
  schedulePersist();
  renderHeader();
  renderStats();
  renderList();
}

function selectNote(id) {
  if (id === activeId) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistNow();
  }
  activeId = id;
  renderAll();
  focusEditor(0);
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

const visibleNotes = () => sortNotes(filterNotes(notes, query));

function renderAll() {
  renderList();
  renderEditor();
  renderHeader();
  renderStats();
  renderTotals();
}

function renderList() {
  const list = visibleNotes();
  noteList.replaceChildren();

  emptyList.hidden = list.length !== 0;
  emptySub.textContent = query
    ? `Nothing matches “${query}”.`
    : 'Create one to get started.';

  const frag = hostDocument().createDocumentFragment();
  for (const note of list) {
    const li = hostDocument().createElement('li');
    const btn = hostDocument().createElement('button');
    btn.type = 'button';
    btn.className = 'note-item';
    btn.dataset.id = note.id;
    btn.dataset.pinned = String(Boolean(note.pinned));
    btn.setAttribute('aria-current', note.id === activeId ? 'true' : 'false');

    const top = hostDocument().createElement('div');
    top.className = 'note-item-top';

    const title = hostDocument().createElement('span');
    title.className = 'note-item-title';
    title.textContent = deriveTitle(note.body);

    const pin = hostDocument().createElement('span');
    pin.className = 'note-item-pin';
    pin.setAttribute('aria-hidden', 'true');
    pin.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 3h6l-1 6 3.5 3v2h-11v-2L10 9z"/></svg>';

    top.append(title, pin);

    const preview = hostDocument().createElement('p');
    preview.className = 'note-item-preview';
    preview.textContent = derivePreview(note.body) || 'No additional text';

    const time = hostDocument().createElement('p');
    time.className = 'note-item-time';
    time.dataset.time = String(note.updatedAt);
    time.textContent = note.pinned ? 'Pinned · ' : '';
    time.append(formatRelativeTime(note.updatedAt));

    btn.append(top, preview, time);
    li.append(btn);
    frag.append(li);
  }
  noteList.append(frag);
}

function renderEditor() {
  const note = getActive();
  editorPane.dataset.empty = note && note.body ? 'false' : 'true';
  if (!note) {
    if (editor.value !== '') editor.value = '';
    renderedNoteId = null;
    return;
  }
  // Only overwrite the textarea when switching notes. Re-rendering while the
  // user types would fight the caret and make the editor unusable.
  if (renderedNoteId !== note.id) {
    editor.value = note.body;
    renderedNoteId = note.id;
  }
}

function renderHeader() {
  const note = getActive();
  editorTitle.textContent = note ? deriveTitle(note.body) : 'No note selected';
  editorMeta.textContent = note
    ? `edited ${formatRelativeTime(note.updatedAt)} · created ${formatRelativeTime(note.createdAt)}`
    : '';
  btnPin.setAttribute('aria-pressed', String(Boolean(note?.pinned)));
  const disable = !note;
  for (const b of [btnPin, btnCopy, btnDownload, btnDuplicate, btnDelete]) b.disabled = disable;
}

function renderStats() {
  const note = getActive();
  const s = computeStats(note?.body ?? '');
  statWords.textContent = `${formatCount(s.words)} ${s.words === 1 ? 'word' : 'words'}`;
  statChars.textContent = `${formatCount(s.chars)} ${s.chars === 1 ? 'char' : 'chars'}`;
  statRead.textContent = `${formatDuration(s.readingSeconds)} read`;
}

function renderTotals() {
  const t = totalStats(notes);
  totalsEl.textContent = `${formatCount(t.notes)} ${t.notes === 1 ? 'note' : 'notes'} · ${formatCount(t.words)} words`;
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

function setTab(name, { focus = false } = {}) {
  const tab = name === 'clipboard' ? 'clipboard' : 'notes';
  app.dataset.tab = tab;

  panelNotes.hidden = tab !== 'notes';
  panelClipboard.hidden = tab !== 'clipboard';
  tabNotes.setAttribute('aria-selected', String(tab === 'notes'));
  tabClipboard.setAttribute('aria-selected', String(tab === 'clipboard'));

  if (tab !== prefs.tab) {
    prefs = normalizePrefs({ ...prefs, tab });
    persistPrefs();
  }
  if (focus) {
    if (tab === 'clipboard') clipSearch.focus();
    else focusEditor();
  }
}

function toggleTab() {
  setTab(prefs.tab === 'clipboard' ? 'notes' : 'clipboard', { focus: true });
}

/* -------------------------------------------------------------------------- */
/* Clipboard history                                                           */
/* -------------------------------------------------------------------------- */

function loadClips() {
  clips = sortClips(deserializeClips(safeRead(CLIP_STORAGE_KEY)));
}

function persistClips() {
  return safeWrite(CLIP_STORAGE_KEY, serializeClips(clips));
}

/**
 * Add a snippet to the history. Auto-capture stays silent (a toast on every
 * copy would be unbearable); explicit actions announce themselves.
 */
function recordClip(text, source, { notify = false } = {}) {
  const { clips: next, clip, bumped } = addClip(clips, text, source);
  if (!clip) return null;
  clips = next;
  persistClips();
  renderClips();
  renderClipCount();
  if (notify) {
    toast(bumped ? 'Moved that snippet to the top' : 'Added to clipboard history', {
      kind: 'success',
      duration: 2000,
    });
  }
  return clip;
}

function renderClips() {
  const list = sortClips(filterClips(clips, clipQuery));
  clipList.replaceChildren();

  clipEmpty.hidden = list.length !== 0;
  if (clips.length === 0) {
    clipEmptyTitle.textContent = 'Clipboard is empty';
    clipEmptySub.textContent =
      'Press Grab to pull in whatever is on your system clipboard, or copy something inside Ecko.';
  } else if (list.length === 0) {
    clipEmptyTitle.textContent = 'No matching snippets';
    clipEmptySub.textContent = `Nothing matches “${clipQuery}”.`;
  }

  const doc = hostDocument();
  const frag = doc.createDocumentFragment();

  for (const clip of list) {
    const li = doc.createElement('li');
    li.className = 'clip-item';
    li.dataset.id = clip.id;
    li.dataset.pinned = String(Boolean(clip.pinned));

    const textBtn = doc.createElement('button');
    textBtn.type = 'button';
    textBtn.className = 'clip-text';
    textBtn.dataset.act = 'copy';
    textBtn.title = 'Copy this snippet to the system clipboard';
    textBtn.textContent = clipSummary(clip.text) || '(whitespace only)';

    const row = doc.createElement('div');
    row.className = 'clip-row';

    const meta = doc.createElement('div');
    meta.className = 'clip-meta';
    const time = doc.createElement('span');
    time.dataset.time = String(clip.createdAt);
    time.textContent = formatRelativeTime(clip.createdAt);
    const src = doc.createElement('span');
    src.className = 'clip-source';
    src.textContent = sourceLabel(clip.source);
    const chars = doc.createElement('span');
    chars.textContent = `${formatCount(clip.text.length)} ch`;
    meta.append(time, src, chars);

    const actions = doc.createElement('div');
    actions.className = 'clip-actions';
    const specs = [
      ['copy', 'Copy', 'Copy to the system clipboard'],
      ['insert', 'Insert', 'Insert into the current note'],
      [
        'pin',
        clip.pinned ? 'Unpin' : 'Pin',
        clip.pinned ? 'Unpin this snippet' : 'Pin this snippet to the top',
      ],
      ['delete', 'Delete', 'Delete this snippet'],
    ];
    for (const [act, label, title] of specs) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'clip-action';
      b.dataset.act = act;
      b.textContent = label;
      b.title = title;
      if (act === 'pin') b.dataset.active = String(Boolean(clip.pinned));
      actions.append(b);
    }

    row.append(meta, actions);
    li.append(textBtn, row);
    frag.append(li);
  }

  clipList.append(frag);
}

function renderClipCount() {
  const s = clipStats(clips);
  clipCount.textContent = formatCount(s.clips);
  clipCount.hidden = s.clips === 0;
  clipSub.textContent =
    s.clips === 0
      ? '0 snippets'
      : `${formatCount(s.clips)} ${s.clips === 1 ? 'snippet' : 'snippets'}${
          s.pinned ? ` · ${s.pinned} pinned` : ''
        }`;
  if (clips.length >= MAX_CLIP_ITEMS) {
    clipSub.textContent += ` · capped at ${MAX_CLIP_ITEMS}`;
  }
}

/* ------------------------------------------------------- system clipboard -- */

/**
 * Write to the system clipboard, suppressing our own auto-capture so the
 * snippet we just stored does not immediately get re-captured.
 */
async function writeToSystemClipboard(text) {
  suppressCapture = true;
  try {
    const api = hostWindow().navigator?.clipboard;
    if (api && typeof api.writeText === 'function') {
      await api.writeText(text);
      return true;
    }
    return legacyCopy(text);
  } catch {
    return legacyCopy(text);
  } finally {
    // Defer so any copy event fired by the legacy path is already swallowed.
    setTimeout(() => {
      suppressCapture = false;
    }, 0);
  }
}

/** Fallback for browsers/contexts without the async Clipboard API. */
function legacyCopy(text) {
  const doc = hostDocument();
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  doc.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/**
 * Read the system clipboard. This is the only way a web page can see it, and
 * it needs a user gesture, permission, and a focused document — so it is wired
 * to an explicit button, never to a timer or page load.
 */
async function grabSystemClipboard() {
  const api = hostWindow().navigator?.clipboard;
  if (!api || typeof api.readText !== 'function') {
    toast(
      'This browser will not let a web page read the system clipboard. Copy the text, then use the + button to store it.',
      { kind: 'danger', duration: 8000 },
    );
    return;
  }

  let text;
  try {
    text = await api.readText();
  } catch (error) {
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    toast(
      denied
        ? 'Clipboard access was denied. Allow it for this site, or copy the text and press Ctrl+V here to capture it.'
        : 'Could not read the system clipboard.',
      { kind: 'danger', duration: 8000 },
    );
    return;
  }

  if (!text || !text.trim()) {
    toast('The system clipboard is empty.', { duration: 2600 });
    return;
  }
  recordClip(text, 'grab', { notify: true });
}

/** Text the user currently has selected, for copy/cut capture. */
function currentSelectionText() {
  const el = hostDocument().activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
    const { selectionStart: start, selectionEnd: end } = el;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return String(el.value).slice(start, end);
    }
    return '';
  }
  try {
    return hostWindow().getSelection?.()?.toString() || '';
  } catch {
    return '';
  }
}

function onCaptureEvent(event) {
  if (suppressCapture || !prefs.captureClipboard) return;

  const text =
    event.type === 'paste'
      ? event.clipboardData?.getData('text/plain') || ''
      : currentSelectionText();
  if (!text.trim()) return;

  const source = event.type === 'paste' ? 'paste' : event.type === 'cut' ? 'cut' : 'copy';
  recordClip(text, source);
}

/* ----------------------------------------------------------- clip actions -- */

function clipById(id) {
  return clips.find((c) => c.id === id) || null;
}

async function onClipAction(event) {
  const btn = event.target.closest('.clip-action, .clip-text');
  if (!btn) return;
  const item = btn.closest('.clip-item');
  if (!item) return;
  const clip = clipById(item.dataset.id);
  if (!clip) return;

  switch (btn.dataset.act) {
    case 'copy': {
      const ok = await writeToSystemClipboard(clip.text);
      toast(ok ? 'Copied to system clipboard' : 'Copy failed.', {
        kind: ok ? 'success' : 'danger',
        duration: 2000,
      });
      break;
    }
    case 'insert':
      insertClipIntoNote(clip.text);
      break;
    case 'pin':
      clips = toggleClipPin(clips, clip.id);
      persistClips();
      renderClips();
      renderClipCount();
      break;
    case 'delete': {
      const removed = clip;
      clips = removeClip(clips, clip.id);
      persistClips();
      renderClips();
      renderClipCount();
      toast('Snippet deleted', {
        kind: 'danger',
        action: {
          label: 'Undo',
          onClick: () => {
            recordClip(removed.text, removed.source);
            clips = sortClips(
              clips.map((c) => (c.text === removed.text ? { ...c, pinned: removed.pinned } : c)),
            );
            persistClips();
            renderClips();
          },
        },
      });
      break;
    }
    default:
      break;
  }
}

function insertClipIntoNote(text) {
  if (!getActive()) newNote({ focus: false });

  setTab('notes');
  // Insert at the caret only if the editor actually has focus; otherwise
  // appending is what the user expects.
  const focused = hostDocument().activeElement === editor;
  const start = focused ? editor.selectionStart : editor.value.length;
  const end = focused ? editor.selectionEnd : editor.value.length;

  editor.setRangeText(text, start, end, 'end');
  updateActiveBody(editor.value);
  focusEditor(editor.selectionStart);
  toast('Inserted into note', { kind: 'success', duration: 1800 });
}

/** Inline composer, so "Add" never depends on window.prompt(). */
function beginAddSnippet() {
  if (clipList.querySelector('.clip-composer')) {
    clipList.querySelector('.clip-composer-input').focus();
    return;
  }

  const doc = hostDocument();
  const li = doc.createElement('li');
  li.className = 'clip-item clip-composer';

  const ta = doc.createElement('textarea');
  ta.className = 'clip-composer-input';
  ta.rows = 3;
  ta.placeholder = 'Paste or type the snippet…';
  ta.setAttribute('aria-label', 'New snippet');

  const row = doc.createElement('div');
  row.className = 'clip-row';
  const hint = doc.createElement('div');
  hint.className = 'clip-meta';
  hint.textContent = 'Ctrl+Enter to save';

  const actions = doc.createElement('div');
  actions.className = 'clip-actions';
  const save = doc.createElement('button');
  save.type = 'button';
  save.className = 'clip-action';
  save.dataset.active = 'true';
  save.textContent = 'Save';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'clip-action';
  cancel.textContent = 'Cancel';
  actions.append(save, cancel);

  row.append(hint, actions);
  li.append(ta, row);
  clipList.prepend(li);
  ta.focus();

  const close = () => li.remove();
  const commit = () => {
    const value = ta.value;
    close();
    if (!value.trim()) return;
    recordClip(value, 'manual', { notify: true });
  };

  save.addEventListener('click', commit);
  cancel.addEventListener('click', close);
  ta.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
  });
}

function clearHistory() {
  if (clips.length === 0) {
    toast('Clipboard history is already empty.', { duration: 2000 });
    return;
  }
  const before = clips;
  clips = clearClips(clips);
  persistClips();
  renderClips();
  renderClipCount();
  toast(`Cleared ${before.length - clips.length} snippets (pinned kept)`, {
    kind: 'danger',
    action: {
      label: 'Undo',
      onClick: () => {
        clips = before;
        persistClips();
        renderClips();
        renderClipCount();
      },
    },
  });
}

function applyPrefs() {
  app.dataset.font = prefs.fontFamily;
  app.dataset.wrap = prefs.wrap ? 'on' : 'off';
  app.dataset.sidebar = prefs.sidebarOpen ? 'open' : 'closed';
  app.style.setProperty('--editor-size', `${prefs.fontSize}px`);
  btnToggleSidebar.setAttribute('aria-pressed', String(prefs.sidebarOpen));
  btnWrap.setAttribute('aria-pressed', String(prefs.wrap));
  btnWrap.title = `Soft wrap: ${prefs.wrap ? 'on' : 'off'} (click to toggle)`;
  btnClipCapture.setAttribute('aria-pressed', String(prefs.captureClipboard));
  btnClipCapture.title = `Auto-capture copies and pastes inside Ecko: ${
    prefs.captureClipboard ? 'on' : 'off'
  }`;

  // Theme lives on <html>, so it has to be applied to every document that can
  // currently be showing the app: the tab, and the PiP window if one is open.
  for (const doc of hostDocuments()) {
    doc.documentElement.dataset.theme = prefs.theme;
  }
  btnTheme.title = `Theme: ${prefs.theme} (click to cycle)`;
  btnFontFamily.title = `Font: ${prefs.fontFamily} (click to cycle)`;
}

const hostDocuments = () => {
  const docs = [document];
  if (pipWindow && pipWindow.document && pipWindow.document !== document) docs.push(pipWindow.document);
  return docs;
};

/* -------------------------------------------------------------------------- */
/* Global (window-level) listeners                                             */
/* -------------------------------------------------------------------------- */

const GLOBAL_BINDINGS = [
  ['keydown', onKeyDown],
  ['beforeunload', onBeforeUnload],
  // Capture in-app clipboard activity. These bubble to the window, so binding
  // here (and re-binding on PiP enter/exit) keeps capture working in both.
  ['copy', onCaptureEvent],
  ['cut', onCaptureEvent],
  ['paste', onCaptureEvent],
];

let boundWindow = null;

function bindGlobals(win) {
  unbindGlobals();
  boundWindow = win;
  for (const [type, handler] of GLOBAL_BINDINGS) win.addEventListener(type, handler);
}

function unbindGlobals() {
  if (!boundWindow) return;
  for (const [type, handler] of GLOBAL_BINDINGS) boundWindow.removeEventListener(type, handler);
  boundWindow = null;
}

function onBeforeUnload() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  safeWrite(STORAGE_KEY, serialize(notes));
  safeWrite(CLIP_STORAGE_KEY, serializeClips(clips));
}

function isTypingTarget(target) {
  const tag = target?.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || target?.isContentEditable === true;
}

function onKeyDown(event) {
  const mod = event.metaKey || event.ctrlKey;
  const onClipboardTab = prefs.tab === 'clipboard';

  if (!mod) {
    // `/` focuses whichever search belongs to the visible tab.
    if (event.key === '/' && !isTypingTarget(event.target)) {
      event.preventDefault();
      const field = onClipboardTab ? clipSearch : searchInput;
      field.focus();
      field.select();
    }
    if (event.key === 'Escape' && event.target === searchInput && query) {
      query = '';
      searchInput.value = '';
      clearSearchBtn.hidden = true;
      renderList();
    }
    if (event.key === 'Escape' && event.target === clipSearch && clipQuery) {
      clipQuery = '';
      clipSearch.value = '';
      renderClips();
    }
    return;
  }

  const key = event.key.toLowerCase();

  // Ctrl/Cmd+Shift+P — toggle the always-on-top window.
  if (event.shiftKey && key === 'p') {
    event.preventDefault();
    toggleFloat();
    return;
  }

  // Ctrl/Cmd+Alt+N — new note. (Plain Ctrl+N is reserved by the browser.)
  if (event.altKey && key === 'n') {
    event.preventDefault();
    newNote();
    return;
  }

  // Ctrl/Cmd+Alt+C — switch between the Notes and Clipboard tabs.
  if (event.altKey && key === 'c') {
    event.preventDefault();
    toggleTab();
    return;
  }

  // Ctrl/Cmd+Alt+G — grab the system clipboard into the history.
  if (event.altKey && key === 'g') {
    event.preventDefault();
    setTab('clipboard');
    grabSystemClipboard();
    return;
  }

  if (key === 's' && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    persistNow();
    toast('All changes saved', { kind: 'success', duration: 1800 });
    return;
  }

  if (key === '\\') {
    event.preventDefault();
    toggleSidebar();
    return;
  }

  if (event.altKey && key === 'd') {
    event.preventDefault();
    duplicateActive();
  }
}

/* -------------------------------------------------------------------------- */
/* Document Picture-in-Picture                                                 */
/* -------------------------------------------------------------------------- */

async function toggleFloat() {
  if (pipWindow || isPipOpen(window)) {
    closePip();
    return;
  }
  await openFloat();
}

async function openFloat() {
  if (!supportsDocumentPip(window)) return openFallbackWindow();

  const result = await requestPipWindow(window, {
    width: prefs.pipWidth,
    height: prefs.pipHeight,
  });

  if (!result.ok) {
    const reason = result.reason;
    if (reason === 'unsupported' && supportsPopupFallback(window)) return openFallbackWindow();
    toast(explainFailure(reason), { kind: 'danger', duration: 6500 });
    return;
  }

  enterPip(result.window);
}

function enterPip(win) {
  pipWindow = win;
  const doc = win.document;

  // Stylesheets are not inherited by the PiP document — copy them, or the
  // moved notepad arrives completely unstyled.
  copyStyles(document, doc);
  copyDocumentMeta(document, doc, document.title);
  applyPrefs();

  // Move the single #app subtree across; the placeholder takes its place.
  doc.body.append(app);
  app.dataset.mode = 'floating';
  placeholder.hidden = false;

  unwatchPipSize = watchPipSize(win, (size) => {
    // watchPipSize reports { width, height }; prefs are keyed pipWidth/pipHeight.
    prefs = normalizePrefs({ ...prefs, pipWidth: size.width, pipHeight: size.height });
    persistPrefs();
  });

  win.addEventListener('pagehide', onPipHide, { once: true });
  bindGlobals(win);

  renderAll();
  try {
    win.focus();
  } catch {
    /* best-effort */
  }
  focusEditor();

  modeLabel.dataset.floating = 'true';
  modeLabel.textContent = 'Floating on top';
  floatBtnLabel.textContent = 'Dock back';
  btnFloat.title = 'Return to the browser tab (Ctrl+Shift+P)';
}

function onPipHide() {
  const win = pipWindow;
  pipWindow = null;
  if (typeof unwatchPipSize === 'function') {
    unwatchPipSize();
    unwatchPipSize = () => {};
  }

  // The PiP document is being torn down; reclaim #app before it goes with it.
  app.dataset.mode = standbyStandalone ? 'standalone' : 'docked';
  stage.prepend(app);
  placeholder.hidden = true;

  unbindGlobals();
  bindGlobals(window);

  modeLabel.dataset.floating = 'false';
  modeLabel.textContent = standbyStandalone ? 'Separate window' : 'Docked in tab';
  floatBtnLabel.textContent = 'Float on top';
  btnFloat.title = 'Float on top of all windows (Ctrl+Shift+P)';

  applyPrefs();
  renderAll();
  persistNow();

  if (win) {
    try {
      window.focus();
    } catch {
      /* best-effort */
    }
  }
}

function closePip() {
  const win = pipWindow || (isPipOpen(window) ? window.documentPictureInPicture.window : null);
  if (!win) return;
  try {
    win.close();
  } catch {
    // If close() is refused, fall back to moving the DOM back ourselves.
    onPipHide();
  }
}

/**
 * Fallback for browsers without the Document PiP API (Safari, mobile).
 * A plain popup is NOT always-on-top — we say so plainly rather than
 * pretending otherwise.
 */
function openFallbackWindow() {
  if (!supportsPopupFallback(window)) {
    toast(explainFailure('unsupported'), { kind: 'danger', duration: 7000 });
    return;
  }

  const size = { width: prefs.pipWidth, height: prefs.pipHeight };
  const features = `popup=yes,width=${size.width},height=${size.height}`;
  const url = `${location.origin}${location.pathname}#standalone`;
  const win = window.open(url, 'ecko-notes-standalone', features);

  if (!win) {
    toast('The browser blocked the pop-up window. Allow pop-ups for this site and try again.', {
      kind: 'danger',
      duration: 7000,
    });
    return;
  }

  try {
    win.focus();
  } catch {
    /* best-effort */
  }

  toast(
    'This browser has no Document PiP API, so a normal window was opened instead — it cannot be forced on top.',
    { kind: 'danger', duration: 8000 },
  );
}

/** Reflect capability in the UI before the user ever clicks. */
function reflectCapability() {
  if (supportsDocumentPip(window)) {
    btnFloat.hidden = false;
    floatBtnLabel.textContent = 'Float on top';
    btnFloat.title = 'Float on top of all windows (Ctrl+Shift+P)';
    return;
  }

  // No Document PiP. Inside an already-detached pop-up there is nothing left to
  // detach into — the button would only re-open the very same window — so hide
  // it rather than offer a control that does nothing useful.
  if (standbyStandalone) {
    btnFloat.hidden = true;
    return;
  }

  floatBtnLabel.textContent = 'Open in new window';
  btnFloat.title = isBlockedByContext(window)
    ? 'Always-on-top needs HTTPS or localhost; this page is not a secure context'
    : 'Document PiP is unavailable in this browser — opens a normal (not always-on-top) window';
}

/* -------------------------------------------------------------------------- */
/* Import / export / clipboard                                                 */
/* -------------------------------------------------------------------------- */

function download(filename, text, mime) {
  const doc = hostDocument();
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadActive() {
  const note = getActive();
  if (!note) return;
  const name = `${slugify(deriveTitle(note.body))}.md`;
  download(name, noteToMarkdown(note), 'text/markdown;charset=utf-8');
  toast(`Downloaded ${name}`, { kind: 'success', duration: 2600 });
}

function exportAll() {
  const name = `ecko-notes-${new Date().toISOString().slice(0, 10)}.json`;
  download(name, exportBundle(notes), 'application/json');
  toast(`Exported ${formatCount(notes.length)} notes`, { kind: 'success', duration: 2600 });
}

async function importFromText(text) {
  const incoming = deserialize(text);
  if (incoming.length === 0) {
    toast('That file has no readable notes.', { kind: 'danger' });
    return;
  }
  const before = notes.length;
  const merged = mergeNotes(notes, incoming);
  notes = merged.notes;
  if (!getActive()) activeId = notes[0]?.id ?? null;
  renderedNoteId = null;
  persistNow();
  renderAll();
  toast(
    `Imported ${merged.added} new · ${merged.updated} updated (had ${before})`,
    { kind: 'success', duration: 4200 },
  );
}

async function copyActive() {
  const note = getActive();
  if (!note) return;
  const ok = await writeToSystemClipboard(note.body);
  toast(ok ? 'Copied to clipboard' : 'Copy failed — select the text manually.', {
    kind: ok ? 'success' : 'danger',
    duration: ok ? 2000 : 2600,
  });
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                 */
/* -------------------------------------------------------------------------- */

function setPrefs(patch) {
  prefs = normalizePrefs({ ...prefs, ...patch });
  persistPrefs();
  applyPrefs();
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length];
  setPrefs({ theme: next });
  toast(`Theme: ${next}`, { duration: 1600 });
}

function cycleFontFamily() {
  const next = FONT_FAMILIES[(FONT_FAMILIES.indexOf(prefs.fontFamily) + 1) % FONT_FAMILIES.length];
  setPrefs({ fontFamily: next });
  toast(`Font: ${next}`, { duration: 1600 });
}

function toggleSidebar() {
  setPrefs({ sidebarOpen: !prefs.sidebarOpen });
}

function focusEditor(pos) {
  editor.focus();
  if (typeof pos === 'number') {
    try {
      editor.setSelectionRange(pos, pos);
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Event wiring                                                                */
/* -------------------------------------------------------------------------- */

editor.addEventListener('input', () => updateActiveBody(editor.value));

// Tab inserts a tab character instead of moving focus out of the editor.
editor.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.setRangeText('  ', start, end, 'end');
  updateActiveBody(editor.value);
});

noteList.addEventListener('click', (event) => {
  const btn = event.target.closest('.note-item');
  if (btn) selectNote(btn.dataset.id);
});

searchInput.addEventListener('input', () => {
  query = searchInput.value;
  clearSearchBtn.hidden = !query;
  renderList();
});

clearSearchBtn.addEventListener('click', () => {
  query = '';
  searchInput.value = '';
  clearSearchBtn.hidden = true;
  renderList();
  searchInput.focus();
});

btnNew.addEventListener('click', () => newNote());
btnDelete.addEventListener('click', deleteActive);
btnDuplicate.addEventListener('click', duplicateActive);
btnPin.addEventListener('click', togglePin);
btnCopy.addEventListener('click', copyActive);
btnDownload.addEventListener('click', downloadActive);
btnExport.addEventListener('click', exportAll);
btnTheme.addEventListener('click', cycleTheme);
btnFontFamily.addEventListener('click', cycleFontFamily);
btnWrap.addEventListener('click', () => {
  setPrefs({ wrap: !prefs.wrap });
  toast(`Soft wrap ${prefs.wrap ? 'on' : 'off'}`, { duration: 1600 });
});
btnToggleSidebar.addEventListener('click', toggleSidebar);
btnFloat.addEventListener('click', toggleFloat);

btnFontUp.addEventListener('click', () =>
  setPrefs({ fontSize: Math.min(FONT_SIZE_MAX, prefs.fontSize + 1) }),
);
btnFontDown.addEventListener('click', () =>
  setPrefs({ fontSize: Math.max(FONT_SIZE_MIN, prefs.fontSize - 1) }),
);

btnImport.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  importFile.value = '';
  if (!file) return;
  try {
    await importFromText(await file.text());
  } catch {
    toast('Could not read that file.', { kind: 'danger' });
  }
});

btnReturn.addEventListener('click', closePip);

/* --- tabs & clipboard ---------------------------------------------------- */

tabNotes.addEventListener('click', () => setTab('notes', { focus: true }));
tabClipboard.addEventListener('click', () => setTab('clipboard', { focus: true }));

clipList.addEventListener('click', onClipAction);

clipSearch.addEventListener('input', () => {
  clipQuery = clipSearch.value;
  renderClips();
});

btnClipGrab.addEventListener('click', grabSystemClipboard);
btnClipAdd.addEventListener('click', beginAddSnippet);
btnClipClear.addEventListener('click', clearHistory);
btnClipCapture.addEventListener('click', () => {
  setPrefs({ captureClipboard: !prefs.captureClipboard });
  toast(`Auto-capture ${prefs.captureClipboard ? 'on' : 'off'}`, { duration: 2000 });
});

// If the browser opens a PiP window on its own, keep the UI honest.
if (supportsDocumentPip(window)) {
  window.documentPictureInPicture.addEventListener?.('enter', (event) => {
    if (pipWindow) return;
    if (event?.window) enterPip(event.window);
  });
}

// Another tab (or the fallback pop-up) changed storage: adopt its notes.
// Guarded so the detached-during-PiP case cannot stomp on live edits.
window.addEventListener('storage', (event) => {
  if (event.key === PREFS_KEY) {
    prefs = parsePrefs(event.newValue);
    applyPrefs();
    setTab(prefs.tab);
    return;
  }
  if (event.key === CLIP_STORAGE_KEY) {
    if (pipWindow) return;
    const incoming = deserializeClips(event.newValue);
    if (incoming.length === clips.length) return;
    clips = incoming;
    renderClips();
    renderClipCount();
    return;
  }
  if (event.key !== STORAGE_KEY || pipWindow) return;
  if (persistTimer) return; // we are mid-write; our value is the fresh one
  const incoming = deserialize(event.newValue);
  if (incoming.length === 0) return;
  const merged = mergeNotes(notes, incoming);
  if (merged.added === 0 && merged.updated === 0) return;
  notes = merged.notes;
  if (!getActive()) activeId = notes[0]?.id ?? null;
  renderedNoteId = null;
  renderAll();
  toast('Synced notes from another window', { duration: 2600 });
});

// Keep relative timestamps fresh without a full re-render on every tick.
const refreshTimer = setInterval(() => {
  for (const el of noteList.querySelectorAll('[data-time]')) {
    const ts = Number(el.dataset.time);
    if (Number.isFinite(ts)) {
      const note = notes.find((n) => n.id === el.closest('.note-item')?.dataset.id);
      el.textContent = `${note?.pinned ? 'Pinned · ' : ''}${formatRelativeTime(ts)}`;
    }
  }
  for (const el of clipList.querySelectorAll('[data-time]')) {
    const ts = Number(el.dataset.time);
    if (Number.isFinite(ts)) el.textContent = formatRelativeTime(ts);
  }
}, 30000);

/**
 * Release timers and window-level listeners. The browser never needs this, but
 * it lets the test suite import and shut down the real app module cleanly
 * instead of leaving a 30s interval holding the event loop open.
 */
export function dispose() {
  clearInterval(refreshTimer);
  unbindGlobals();
  if (saveTimer) clearTimeout(saveTimer);
  if (persistTimer) clearTimeout(persistTimer);
  saveTimer = null;
  persistTimer = null;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

function boot() {
  loadNotes();
  loadClips();

  if (location.hash === '#standalone') {
    standbyStandalone = true;
    app.dataset.mode = 'standalone';
    floatBtnLabel.textContent = 'Float on top';
  }

  applyPrefs();
  reflectCapability();
  renderAll();
  renderClips();
  renderClipCount();
  setTab(prefs.tab);
  bindGlobals(window);
  setSaveState('saved');

  modeLabel.textContent = standbyStandalone ? 'Separate window' : 'Docked in tab';

  if (standbyStandalone) {
    toast(
      supportsDocumentPip(window)
        ? 'Separate window opened. Click "Float on top" here for an always-on-top window.'
        : 'This browser cannot pin windows on top, so this is a normal separate window.',
      { kind: 'info', duration: 6000 },
    );
  }
}

boot();
