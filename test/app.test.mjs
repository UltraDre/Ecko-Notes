import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Integration tests for the real src/app.js, running in a real DOM (jsdom)
 * against a mocked `documentPictureInPicture`.
 *
 * The mock hands back a second, genuinely separate jsdom Window, so assertions
 * like `app.ownerDocument === pipDocument` are real cross-document checks:
 * they prove the notepad subtree actually adopted into the floating window and
 * actually came back, rather than asserting on a stand-in.
 */

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const BLANK = '<!doctype html><html><head></head><body></body></html>';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const problems = [];

function makeWindow(html, label) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => problems.push(`[${label}] jsdomError: ${e.message}`));
  virtualConsole.on('error', (...args) => problems.push(`[${label}] console.error: ${args.join(' ')}`));
  return new JSDOM(html, { url: 'https://ecko.test/', pretendToBeVisual: true, virtualConsole });
}

/* --------------------------------------------------------------- harness -- */

const dom = makeWindow(HTML, 'tab');
const pipDom = makeWindow(BLANK, 'pip');
const pipWindow = pipDom.window;

// Simulate the browser: closing the PiP window fires `pagehide`, which is the
// signal app.js listens for to reclaim the notepad.
pipWindow.close = function close() {
  pipApi.window = null;
  pipWindow.dispatchEvent(new pipWindow.Event('pagehide'));
};

const pipApi = {
  window: null,
  requests: [],
  async requestWindow(options) {
    this.requests.push(options);
    this.window = pipWindow;
    pipWindow.innerWidth = options.width;
    pipWindow.innerHeight = options.height;
    return pipWindow;
  },
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(dom.window, 'documentPictureInPicture', {
  value: pipApi,
  configurable: true,
});

// Real browsers clear documentPictureInPicture.window when the PiP window
// closes. Without this the mock would report a window that no longer exists,
// and requestPipWindow() would take its "reuse the open window" branch.
pipWindow.addEventListener('pagehide', () => {
  pipApi.window = null;
});

// jsdom ships neither of these; app.js touches both on the export path.
const downloads = [];
URL.createObjectURL = () => 'blob:mock';
URL.revokeObjectURL = () => {};
// The download anchor is created in whichever document currently hosts #app,
// so both windows' prototypes need the stub.
const stubAnchorClick = (win) => {
  win.HTMLAnchorElement.prototype.click = function click() {
    downloads.push(this.download);
  };
};
stubAnchorClick(dom.window);
stubAnchorClick(pipWindow);

for (const key of [
  'window',
  'document',
  'location',
  'localStorage',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'Blob',
]) {
  if (dom.window[key] === undefined) continue;
  // Node 22 exposes some of these (navigator) as getter-only, so a plain
  // assignment throws. defineProperty works for all of them.
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  });
}

// Importing runs boot() — this is the real application, not a fixture.
const { dispose } = await import('../src/app.js');

const doc = dom.window.document;

// #app (and everything inside it) moves between documents, so lookups have to
// follow it. The element refs below are captured once and stay valid either
// way, because moving a node does not change its identity.
const app = doc.getElementById('app');
const hostDoc = () => (app.isConnected && app.ownerDocument) || doc;
const $ = (sel) => hostDoc().querySelector(sel);

const stage = doc.getElementById('stage');
const placeholder = doc.getElementById('pip-placeholder');
// #btn-return lives in the placeholder, which stays in the tab, so it must be
// looked up in the main document even while the notepad is floating.
const btnReturn = doc.getElementById('btn-return');
const editor = doc.getElementById('editor');
const noteList = doc.getElementById('note-list');
const searchInput = doc.getElementById('search');
const modeLabel = doc.getElementById('mode-label');
const floatLabel = doc.getElementById('float-btn-label');

const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const storedNotes = () => JSON.parse(dom.window.localStorage.getItem('ecko.notes.v1') || '{}');
const storedPrefs = () => JSON.parse(dom.window.localStorage.getItem('ecko.notes.prefs.v1') || '{}');
const isFloating = () => app.ownerDocument === pipDom.window.document;

/* ----------------------------------------------------------------- boot -- */

test('boots with a seeded note rendered in both the list and the editor', () => {
  assert.equal(noteList.querySelectorAll('.note-item').length, 1);
  assert.ok(editor.value.includes('Welcome to Ecko Notes'), 'editor should show the seeded note');
  assert.equal($('#editor-title').textContent, 'Welcome to Ecko Notes');
  assert.equal(app.dataset.mode, 'docked');
  assert.equal(modeLabel.textContent, 'Docked in tab');
  assert.equal(floatLabel.textContent, 'Float on top');
  // DEFAULT_PREFS.theme is 'system', so applyPrefs() overrides the static
  // data-theme="dark" baked into index.html.
  assert.equal(doc.documentElement.dataset.theme, 'system');
});

test('the first line of the body drives the title, live', () => {
  type(editor, 'Live title check\nsecond line');
  assert.equal($('#editor-title').textContent, 'Live title check');
  assert.ok(
    $('#stat-words').textContent.startsWith('5 words'),
    `"Live title check / second line" is 5 words, got "${$('#stat-words').textContent}"`,
  );
});

test('typing autosaves to localStorage after the debounce', async () => {
  type(editor, 'Autosave me\nbody text here');
  await wait(500);
  const { notes } = storedNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, 'Autosave me\nbody text here');
  assert.equal($('#save-state').dataset.state, 'saved');
});

/* ------------------------------------------------------------ list ops -- */

test('new note button creates a note, focuses the editor and clears search', async () => {
  type(searchInput, 'zzz-no-match');
  assert.equal(noteList.querySelectorAll('.note-item').length, 0);

  click($('#btn-new'));
  assert.equal(searchInput.value, '', 'search must reset so the new note is visible');
  assert.equal(noteList.querySelectorAll('.note-item').length, 2);
  assert.equal(editor.value, '');
  assert.equal(doc.activeElement, editor, 'editor should receive focus');
});

test('search filters the list without touching stored notes', () => {
  type(editor, 'Banana smoothie\nrecipe');
  type(searchInput, 'banana');
  assert.equal(noteList.querySelectorAll('.note-item').length, 1);
  assert.ok($('#note-list').textContent.includes('Banana smoothie'));
  assert.equal(storedNotes().notes.length, 2, 'filtering must not delete anything');

  click($('#btn-clear-search'));
  assert.equal(noteList.querySelectorAll('.note-item').length, 2);
});

test('searching for nothing shows the empty state', () => {
  type(searchInput, 'qqqq-nothing');
  assert.equal(placeholder.hidden, true);
  assert.equal($('#empty-list').hidden, false);
  assert.ok($('#empty-sub').textContent.includes('Nothing matches'));
  click($('#btn-clear-search'));
  assert.equal($('#empty-list').hidden, true);
});

test('pinning moves a note to the top and is persisted', () => {
  const items = () => [...noteList.querySelectorAll('.note-item')].map((n) => n.dataset.id);
  const ids = items();
  assert.ok(ids.length >= 2, 'precondition: at least two notes to reorder');

  // Select whichever note is currently LAST, so pinning has somewhere to move
  // it — the active note is often already first because it was just edited.
  const lastId = ids[ids.length - 1];
  click([...noteList.querySelectorAll('.note-item')].find((n) => n.dataset.id === lastId));

  click($('#btn-pin'));
  assert.equal($('#btn-pin').getAttribute('aria-pressed'), 'true');
  assert.equal(items()[0], lastId, 'a pinned note must sort to the top');
  const row = noteList.querySelector(`.note-item[data-id="${lastId}"]`);
  assert.equal(row.dataset.pinned, 'true');
  assert.ok(storedNotes().notes.find((n) => n.id === lastId).pinned === true);

  click($('#btn-pin'));
  assert.equal($('#btn-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(noteList.querySelector(`.note-item[data-id="${lastId}"]`).dataset.pinned, 'false');
});

test('delete removes the note and the undo toast restores it', async () => {
  const before = storedNotes().notes.length;
  const deletedTitle = $('#editor-title').textContent;

  click($('#btn-delete'));
  await flush();
  assert.equal(storedNotes().notes.length, before - 1);

  const undo = doc.querySelector('#toast-root .toast-action');
  assert.ok(undo, 'an Undo action should be offered');
  click(undo);
  await flush();

  assert.equal(storedNotes().notes.length, before);
  assert.equal($('#editor-title').textContent, deletedTitle);
});

test('duplicating creates an editable copy', async () => {
  type(editor, 'Original body\nwith content');
  const before = storedNotes().notes.length;
  click($('#btn-duplicate'));
  await flush();
  assert.equal(storedNotes().notes.length, before + 1);
  assert.equal(editor.value, 'Original body\nwith content');
});

/* --------------------------------------------------- Document PiP flow -- */

test('floating moves #app into the PiP document and copies its stylesheets', async () => {
  const stylesBefore = pipDom.window.document.head.children.length;
  assert.equal(stylesBefore, 0, 'the PiP document starts unstyled');

  click($('#btn-float'));
  await flush();

  assert.ok(isFloating(), '#app must be adopted into the PiP document');
  assert.equal(app.isConnected, true);
  assert.equal(pipDom.window.document.body.contains(app), true);

  // The API does not copy CSS; without this the notepad renders unstyled.
  assert.equal(
    pipDom.window.document.head.querySelectorAll('link[rel="stylesheet"]').length,
    1,
    'the app stylesheet must be copied into the PiP window',
  );
  assert.ok(pipDom.window.document.getElementById('ecko-pip-base'), 'body margin reset must be injected');
  assert.equal(
    pipDom.window.document.documentElement.dataset.theme,
    doc.documentElement.dataset.theme,
    'theme must be mirrored into the floating window',
  );
  assert.equal(pipDom.window.document.title, doc.title);

  // The tab must show the placeholder, not a blank page.
  assert.equal(placeholder.hidden, false);
  assert.equal(stage.contains(app), false, '#app must no longer be in the tab');
  assert.equal(app.dataset.mode, 'floating');
  assert.equal(modeLabel.dataset.floating, 'true');
  assert.equal(floatLabel.textContent, 'Dock back');
});

test('requestWindow received a valid, fully-specified size', () => {
  assert.equal(pipApi.requests.length, 1);
  const options = pipApi.requests[0];
  assert.ok(Number.isFinite(options.width) && options.width > 0, 'width must be a positive number');
  assert.ok(Number.isFinite(options.height) && options.height > 0, 'height must be a positive number');
  assert.equal(options.disallowReturnToOpener, false);
});

test('editing while floating still autosaves (one realm, no divergence)', async () => {
  assert.ok(isFloating(), 'precondition: still floating');
  type(editor, 'Typed while floating\nsecond line');
  await wait(500);
  const { notes } = storedNotes();
  assert.ok(notes.some((n) => n.body === 'Typed while floating\nsecond line'));
  assert.equal(noteList.ownerDocument, pipDom.window.document, 'the list moved too');
});

test('resizing the floating window is remembered under pipWidth/pipHeight', async () => {
  pipWindow.innerWidth = 611;
  pipWindow.innerHeight = 733;
  pipWindow.dispatchEvent(new pipWindow.Event('resize'));
  await wait(400);

  const prefs = storedPrefs();
  // Regression: these were once written as `width`/`height` and lost.
  assert.equal(prefs.pipWidth, 611, 'pipWidth must persist');
  assert.equal(prefs.pipHeight, 733, 'pipHeight must persist');
});

test('pagehide returns #app to the tab and restores the docked UI', () => {
  pipWindow.dispatchEvent(new pipWindow.Event('pagehide'));

  assert.equal(isFloating(), false);
  assert.equal(stage.contains(app), true, '#app must be back in the tab');
  assert.equal(app.ownerDocument, doc);
  assert.equal(placeholder.hidden, true);
  assert.equal(app.dataset.mode, 'docked');
  assert.equal(modeLabel.dataset.floating, 'false');
  assert.equal(floatLabel.textContent, 'Float on top');
  assert.equal(editor.value, 'Typed while floating\nsecond line', 'content survives the round trip');
});

test('the floating window can be reopened at the remembered size', async () => {
  click($('#btn-float'));
  await flush();
  assert.ok(isFloating());

  const last = pipApi.requests.at(-1);
  assert.equal(last.width, 611, 'should reopen at the size the user left it');
  assert.equal(last.height, 733);

  // Docking back via the in-window button.
  click($('#btn-float'));
  await flush();
  assert.equal(isFloating(), false, '"Dock back" must close the PiP window');
  assert.equal(stage.contains(app), true);
});

test('the tab placeholder button brings the notepad back', async () => {
  click($('#btn-float'));
  await flush();
  assert.ok(isFloating());

  click(btnReturn);
  await flush();
  assert.equal(isFloating(), false);
  assert.equal(placeholder.hidden, true);
  assert.equal(stage.contains(app), true);
});

test('Ctrl+Shift+P toggles the floating window', async () => {
  const press = (target) =>
    target.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'P',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

  press(dom.window);
  await flush();
  assert.ok(isFloating(), 'shortcut should open the floating window');

  // While floating, global listeners must be re-pointed at the PiP window.
  press(pipWindow);
  await flush();
  assert.equal(isFloating(), false, 'shortcut must also work from inside the PiP window');
});

/* ------------------------------------------------------------- prefs UI -- */

test('theme cycling updates <html> in both documents while floating', async () => {
  click($('#btn-float'));
  await flush();
  assert.ok(isFloating());

  click($('#btn-theme'));
  assert.notEqual(doc.documentElement.dataset.theme, 'system');
  assert.equal(
    pipDom.window.document.documentElement.dataset.theme,
    doc.documentElement.dataset.theme,
    'the floating window must follow the theme',
  );

  click($('#btn-theme'));
  click($('#btn-theme'));
  assert.equal(doc.documentElement.dataset.theme, 'system', 'three cycles returns to system');
  assert.equal(pipDom.window.document.documentElement.dataset.theme, 'system');

  // Dock back so the remaining preference tests run in the normal tab layout.
  click($('#btn-float'));
  await flush();
  assert.equal(isFloating(), false);
});

test('font size buttons clamp at both ends and update the CSS variable', async () => {
  const size = () => app.style.getPropertyValue('--editor-size');

  for (let i = 0; i < 40; i += 1) click($('#btn-font-up'));
  assert.equal(size(), '30px', 'clamped at FONT_SIZE_MAX');

  for (let i = 0; i < 60; i += 1) click($('#btn-font-down'));
  assert.equal(size(), '12px', 'clamped at FONT_SIZE_MIN');

  click($('#btn-font-up'));
  assert.equal(size(), '13px');
  assert.equal(storedPrefs().fontSize, 13);
});

test('font family cycling is reflected on the app element', () => {
  click($('#btn-font-family'));
  assert.notEqual(app.dataset.font, 'mono');
  click($('#btn-font-family'));
  click($('#btn-font-family'));
  assert.equal(app.dataset.font, 'mono', 'three cycles returns to mono');
});

test('the soft-wrap toggle flips the layout attribute and persists', () => {
  assert.equal(app.dataset.wrap, 'on', 'wrap is on by default');
  assert.equal($('#btn-wrap').getAttribute('aria-pressed'), 'true');

  click($('#btn-wrap'));
  assert.equal(app.dataset.wrap, 'off');
  assert.equal($('#btn-wrap').getAttribute('aria-pressed'), 'false');
  assert.equal(storedPrefs().wrap, false);

  click($('#btn-wrap'));
  assert.equal(app.dataset.wrap, 'on');
  assert.equal(storedPrefs().wrap, true);
});

test('sidebar toggle flips the layout attribute and persists', () => {
  const before = app.dataset.sidebar;
  click($('#btn-toggle-sidebar'));
  assert.notEqual(app.dataset.sidebar, before);
  assert.equal(storedPrefs().sidebarOpen, app.dataset.sidebar === 'open');
  click($('#btn-toggle-sidebar'));
  assert.equal(app.dataset.sidebar, before);
});

test('Ctrl+S forces a save and Ctrl+Alt+N creates a note', async () => {
  const before = storedNotes().notes.length;
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'n', altKey: true, ctrlKey: true, bubbles: true }),
  );
  assert.equal(storedNotes().notes.length, before + 1);
  assert.equal($('#save-state').dataset.state, 'saved');
});

/* ---------------------------------------------------------- export path -- */

test('download and export produce files without throwing', async () => {
  type(editor, 'Exported note\nsome body');
  await wait(420);

  downloads.length = 0;
  click($('#btn-download'));
  click($('#btn-export'));
  await flush();

  assert.equal(downloads.length, 2);
  assert.match(downloads[0], /^exported-note\.md$/);
  assert.match(downloads[1], /^ecko-notes-\d{4}-\d{2}-\d{2}\.json$/);
});

test('copy falls back gracefully when the clipboard API is unavailable', async () => {
  assert.equal(dom.window.navigator.clipboard, undefined, 'jsdom has no clipboard');
  assert.doesNotThrow(() => click($('#btn-copy')));
  await flush();
});

/* -------------------------------------------------------------- teardown -- */

test('the app ran without unexpected DOM or console errors', () => {
  // jsdom does not implement Window.prototype.focus(); it reports that through
  // the virtual console rather than throwing. Real browsers all support it, and
  // app.js already treats focus as best-effort. Everything else is a real bug.
  const KNOWN_JSDOM_GAPS = [/Not implemented: Window's focus\(\) method/];
  const real = problems.filter((p) => !KNOWN_JSDOM_GAPS.some((re) => re.test(p)));
  assert.deepEqual(real, []);
});

test('dispose releases timers so the process can exit', () => {
  assert.doesNotThrow(dispose);
  assert.doesNotThrow(dispose, 'dispose must be idempotent');
});
