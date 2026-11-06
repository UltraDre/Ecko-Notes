import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  supportsDocumentPip,
  isPipOpen,
  isBlockedByContext,
  supportsPopupFallback,
  requestPipWindow,
  classifyError,
  explainFailure,
  copyStyles,
  copyDocumentMeta,
  watchPipSize,
} from '../src/pip.js';
import { PIP_MIN_WIDTH, PIP_MIN_HEIGHT } from '../src/notes.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const domException = (name, message = name) => new DOMException(message, name);

/* ------------------------------------------------------ feature detection -- */

test('supportsDocumentPip is false for every shape that is not the real API', () => {
  assert.equal(supportsDocumentPip(undefined), false);
  assert.equal(supportsDocumentPip(null), false);
  assert.equal(supportsDocumentPip({}), false);
  assert.equal(supportsDocumentPip({ documentPictureInPicture: null }), false);
  assert.equal(supportsDocumentPip({ documentPictureInPicture: {} }), false);
  assert.equal(supportsDocumentPip({ documentPictureInPicture: { requestWindow: 'nope' } }), false);
});

test('supportsDocumentPip is true only when requestWindow is callable', () => {
  const win = { documentPictureInPicture: { requestWindow: async () => ({}) } };
  assert.equal(supportsDocumentPip(win), true);
});

test('supportsDocumentPip survives a throwing getter', () => {
  const win = {};
  Object.defineProperty(win, 'documentPictureInPicture', {
    get() {
      throw new Error('blocked by policy');
    },
  });
  assert.equal(supportsDocumentPip(win), false);
});

test('isPipOpen reflects documentPictureInPicture.window', () => {
  const pip = { requestWindow: async () => ({}), window: null };
  const win = { documentPictureInPicture: pip };
  assert.equal(isPipOpen(win), false);
  pip.window = {};
  assert.equal(isPipOpen(win), true);
  assert.equal(isPipOpen({}), false, 'no API means no window');
});

test('isBlockedByContext detects an insecure origin', () => {
  assert.equal(isBlockedByContext({ isSecureContext: false }), true);
  assert.equal(isBlockedByContext({ isSecureContext: true }), false);
  assert.equal(isBlockedByContext({}), false);
});

test('supportsPopupFallback checks for window.open', () => {
  assert.equal(supportsPopupFallback({ open() {} }), true);
  assert.equal(supportsPopupFallback({}), false);
  assert.equal(supportsPopupFallback(null), false);
});

/* --------------------------------------------------------- error mapping -- */

test('classifyError maps each DOMException to a reason code', () => {
  assert.equal(classifyError(domException('NotAllowedError')), 'no-user-activation');
  assert.equal(classifyError(domException('NotSupportedError')), 'disabled');
  assert.equal(classifyError(domException('RangeError')), 'bad-size');
  assert.equal(classifyError(domException('SecurityError')), 'blocked');
  assert.equal(classifyError(domException('WeirdError')), 'unknown');
  assert.equal(classifyError(null), 'unknown');
  assert.equal(classifyError(undefined), 'unknown');
  assert.equal(classifyError('a string'), 'unknown');
});

test('explainFailure returns distinct, non-empty copy for every reason', () => {
  const reasons = [
    'unsupported',
    'no-user-activation',
    'disabled',
    'blocked',
    'bad-size',
    'unknown',
  ];
  const seen = new Set();
  for (const reason of reasons) {
    const copy = explainFailure(reason);
    assert.ok(typeof copy === 'string' && copy.length > 10, `weak copy for ${reason}`);
    assert.ok(!seen.has(copy), `duplicate copy for ${reason}`);
    seen.add(copy);
  }
});

/* --------------------------------------------------------- requestWindow -- */

test('requestPipWindow reports unsupported without touching the API', async () => {
  const result = await requestPipWindow({});
  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'unsupported' });
});

test('requestPipWindow always sends BOTH width and height (RangeError guard)', async () => {
  let received;
  const pipWindow = { focus() {} };
  const win = {
    documentPictureInPicture: {
      window: null,
      async requestWindow(options) {
        received = options;
        return pipWindow;
      },
    },
  };

  // Only a width was supplied by the caller — the classic RangeError setup.
  const result = await requestPipWindow(win, { width: 500 });

  assert.equal(result.ok, true);
  assert.equal(result.window, pipWindow);
  assert.ok(Number.isFinite(received.width), 'width missing');
  assert.ok(Number.isFinite(received.height), 'height missing — would throw RangeError');
  assert.ok(received.width >= PIP_MIN_WIDTH);
  assert.ok(received.height >= PIP_MIN_HEIGHT);
  assert.equal(received.disallowReturnToOpener, false);
  assert.equal(received.preferInitialWindowPlacement, false);
});

test('requestPipWindow clamps absurd sizes instead of sending them', async () => {
  let received;
  const win = {
    documentPictureInPicture: {
      window: null,
      async requestWindow(options) {
        received = options;
        return {};
      },
    },
  };

  await requestPipWindow(win, { width: -50, height: 999999 });
  assert.ok(received.width >= PIP_MIN_WIDTH);
  assert.ok(received.height <= 2400);
});

test('requestPipWindow reuses an existing window instead of opening a second', async () => {
  // The spec allows only one PiP window per tab.
  const existing = { focus() {} };
  let opened = 0;
  const win = {
    documentPictureInPicture: {
      window: existing,
      async requestWindow() {
        opened += 1;
        return {};
      },
    },
  };

  const result = await requestPipWindow(win, { width: 300, height: 400 });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.window, existing);
  assert.equal(opened, 0, 'must not call requestWindow when one is already open');
});

test('requestPipWindow normalises rejections into a reason code', async () => {
  const makeWin = (error) => ({
    documentPictureInPicture: {
      window: null,
      async requestWindow() {
        throw error;
      },
    },
  });

  const noActivation = await requestPipWindow(makeWin(domException('NotAllowedError')), {
    width: 300,
    height: 400,
  });
  assert.equal(noActivation.ok, false);
  assert.equal(noActivation.reason, 'no-user-activation');
  assert.ok(noActivation.error instanceof DOMException);

  const disabled = await requestPipWindow(makeWin(domException('NotSupportedError')), {
    width: 300,
    height: 400,
  });
  assert.equal(disabled.reason, 'disabled');
});

/* ----------------------------------------------------------- copyStyles -- */

const blankDoc = () =>
  new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://ecko.test/',
  }).window.document;

test('copyStyles clones every style and stylesheet link into the PiP document', () => {
  const source = new JSDOM(
    '<!doctype html><html><head>' +
      '<link rel="stylesheet" href="/styles/app.css">' +
      '<link rel="icon" href="/favicon.ico">' +
      '<style>:root{--a:1}</style>' +
      '</head><body></body></html>',
    { url: 'https://ecko.test/' },
  ).window.document;

  const target = blankDoc();
  assert.equal(target.head.children.length, 0);

  const copied = copyStyles(source, target);

  assert.equal(copied, 2, 'link[rel=stylesheet] + style, but not link[rel=icon]');
  assert.equal(target.head.querySelectorAll('link[rel="stylesheet"]').length, 1);
  assert.equal(target.head.querySelectorAll('style').length, 1);
  assert.equal(target.head.querySelector('link').getAttribute('href'), '/styles/app.css');
  assert.equal(target.head.querySelector('style').textContent, ':root{--a:1}');
});

test('copyStyles clones rather than moves, so the host stays styled', () => {
  const source = new JSDOM(
    '<!doctype html><html><head><style>body{color:red}</style></head><body></body></html>',
    { url: 'https://ecko.test/' },
  ).window.document;
  const target = blankDoc();

  copyStyles(source, target);

  assert.equal(source.head.querySelectorAll('style').length, 1, 'host must keep its stylesheet');
  assert.equal(target.head.querySelectorAll('style').length, 1);
  assert.notEqual(
    source.head.querySelector('style'),
    target.head.querySelector('style'),
    'must be a clone, not the same node',
  );
});

test('copyStyles tolerates missing documents', () => {
  assert.equal(copyStyles(null, blankDoc()), 0);
  assert.equal(copyStyles(blankDoc(), null), 0);
});

test('copyDocumentMeta mirrors lang/theme attributes and resets body margins', () => {
  const source = new JSDOM(
    '<!doctype html><html lang="en" data-theme="dark"><head></head><body></body></html>',
    { url: 'https://ecko.test/' },
  ).window.document;
  const target = blankDoc();

  copyDocumentMeta(source, target, 'Ecko Notes');

  assert.equal(target.documentElement.getAttribute('lang'), 'en');
  assert.equal(target.documentElement.dataset.theme, 'dark');
  assert.equal(target.title, 'Ecko Notes');
  assert.ok(target.getElementById('ecko-pip-base'), 'base style reset must be injected');
});

test('copyDocumentMeta does not inject the base reset twice', () => {
  const source = blankDoc();
  const target = blankDoc();
  copyDocumentMeta(source, target, 'a');
  copyDocumentMeta(source, target, 'b');
  assert.equal(target.querySelectorAll('#ecko-pip-base').length, 1);
});

test('copyDocumentMeta tolerates missing documents and empty title', () => {
  const target = blankDoc();
  assert.doesNotThrow(() => copyDocumentMeta(null, target, 'x'));
  assert.doesNotThrow(() => copyDocumentMeta(blankDoc(), null, 'x'));
  copyDocumentMeta(blankDoc(), target, '');
  assert.equal(target.querySelectorAll('#ecko-pip-base').length, 1);
});

/* ---------------------------------------------------------- watchPipSize -- */

test('watchPipSize debounces resize and reports the new size', async () => {
  const handlers = [];
  const fakeWin = {
    innerWidth: 100,
    innerHeight: 100,
    addEventListener: (type, fn) => handlers.push([type, fn]),
    removeEventListener: () => {},
  };

  const seen = [];
  const unwatch = watchPipSize(fakeWin, (size) => seen.push(size), { wait: 20 });

  assert.equal(handlers.length, 1);
  assert.equal(handlers[0][0], 'resize');

  fakeWin.innerWidth = 320;
  fakeWin.innerHeight = 480;
  handlers[0][1]();
  handlers[0][1]();
  handlers[0][1]();

  await wait(60);
  assert.deepEqual(seen, [{ width: 320, height: 480 }], 'rapid resizes collapse to one callback');

  unwatch();
});

test('watchPipSize ignores non-finite dimensions and cleans up', async () => {
  let removed = 0;
  const handlers = [];
  const fakeWin = {
    innerWidth: NaN,
    innerHeight: NaN,
    addEventListener: (type, fn) => handlers.push(fn),
    removeEventListener: () => {
      removed += 1;
    },
  };

  const seen = [];
  const unwatch = watchPipSize(fakeWin, (size) => seen.push(size), { wait: 10 });
  handlers[0]();
  await wait(40);
  assert.deepEqual(seen, [], 'NaN sizes must be dropped');

  unwatch();
  assert.equal(removed, 1);
});

test('watchPipSize is a no-op without a window or callback', () => {
  assert.equal(typeof watchPipSize(null, () => {}), 'function');
  assert.equal(typeof watchPipSize({ addEventListener() {} }, null), 'function');
});
