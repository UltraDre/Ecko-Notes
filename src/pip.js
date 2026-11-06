/**
 * Ecko Notes — Document Picture-in-Picture layer.
 *
 * Everything browser-API-specific about the always-on-top window lives here so
 * that src/app.js can stay focused on the notepad itself.
 *
 * API notes this module encodes (per MDN, Document Picture-in-Picture API):
 *   - Entry point is `window.documentPictureInPicture`.
 *   - `requestWindow()` requires *transient activation* — it must run inside a
 *     user-gesture handler, never on a timer or during page load.
 *   - Both `width` and `height` must be given together or it throws RangeError.
 *   - Stylesheets are NOT copied automatically; moved nodes arrive unstyled.
 *   - `pagehide` on the PiP window is the reliable "it closed" signal.
 *   - The PiP window is same-origin, shares localStorage, and never outlives
 *     the tab that opened it.
 *   - Supported: Chrome/Edge 116+, Firefox 151+. Not Safari, not mobile.
 */

import { clampPipSize } from './notes.js';

/** True when the Document PiP API exists on this window. */
export function supportsDocumentPip(win = globalThis) {
  try {
    return Boolean(
      win &&
        win.documentPictureInPicture &&
        typeof win.documentPictureInPicture.requestWindow === 'function',
    );
  } catch {
    return false;
  }
}

/** True when a PiP window is already open for this tab (only one is allowed). */
export function isPipOpen(win = globalThis) {
  if (!supportsDocumentPip(win)) return false;
  try {
    return Boolean(win.documentPictureInPicture.window);
  } catch {
    return false;
  }
}

/** True when the API should exist but is unavailable — insecure context. */
export function isBlockedByContext(win = globalThis) {
  return Boolean(win && win.isSecureContext === false);
}

/**
 * Detect whether a plain `window.open()` popup is viable as a fallback.
 * It is never always-on-top; it just keeps the app usable on Safari/mobile.
 */
export function supportsPopupFallback(win = globalThis) {
  return Boolean(win && typeof win.open === 'function');
}

/**
 * Copy the host document's styling into the PiP document.
 *
 * Nodes are cloned rather than moved: `<link>`/`<style>` must remain in the
 * host document so the notepad still looks right after it is moved back on
 * `pagehide`. Cloning a same-origin `<link>` is served from cache, so the
 * duplicate stylesheet costs no extra network round-trip.
 */
export function copyStyles(sourceDoc, targetDoc) {
  if (!sourceDoc || !targetDoc) return 0;
  const nodes = sourceDoc.querySelectorAll('style, link[rel="stylesheet"]');
  let copied = 0;
  for (const node of nodes) {
    const clone = targetDoc.importNode
      ? targetDoc.importNode(node, true)
      : node.cloneNode(true);
    targetDoc.head.append(clone);
    copied += 1;
  }
  return copied;
}

/** Mirror `<html>` attributes (theme, lang) and the title into the PiP doc. */
export function copyDocumentMeta(sourceDoc, targetDoc, title) {
  if (!sourceDoc || !targetDoc) return;
  const srcHtml = sourceDoc.documentElement;
  const dstHtml = targetDoc.documentElement;

  if (srcHtml && dstHtml) {
    for (const attr of Array.from(srcHtml.attributes)) {
      dstHtml.setAttribute(attr.name, attr.value);
    }
  }
  if (typeof title === 'string' && title) targetDoc.title = title;

  // Without this the PiP window keeps the UA default 8px body margin.
  if (!targetDoc.getElementById('ecko-pip-base')) {
    const style = targetDoc.createElement('style');
    style.id = 'ecko-pip-base';
    style.textContent =
      'html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden;}' +
      'body{-webkit-font-smoothing:antialiased;}';
    targetDoc.head.append(style);
  }
}

/**
 * Ask the browser for an always-on-top window.
 *
 * Callers MUST invoke this from a user-gesture handler. Rejections are
 * normalised into `{ ok:false, reason }` so the UI can degrade gracefully
 * instead of surfacing an unhandled promise rejection.
 */
export async function requestPipWindow(win, { width, height } = {}) {
  if (!supportsDocumentPip(win)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (isPipOpen(win)) {
    try {
      win.documentPictureInPicture.window.focus();
    } catch {
      /* focus is best-effort */
    }
    return { ok: true, window: win.documentPictureInPicture.window, reused: true };
  }

  const size = clampPipSize(width, height);
  try {
    const pipWindow = await win.documentPictureInPicture.requestWindow({
      width: size.width,
      height: size.height,
      // Keep the browser's "back to tab" affordance — useful for a notepad the
      // user may want to dock back into the page.
      disallowReturnToOpener: false,
      // false = the browser remembers the user's own size/position between
      // close and reopen, which is what you want for a persistent widget.
      preferInitialWindowPlacement: false,
    });
    return { ok: true, window: pipWindow, reused: false, requested: size };
  } catch (error) {
    return { ok: false, reason: classifyError(error), error };
  }
}

/** Turn a DOMException into a short, user-explainable reason code. */
export function classifyError(error) {
  const name = error?.name;
  if (name === 'NotAllowedError') return 'no-user-activation';
  if (name === 'NotSupportedError') return 'disabled';
  if (name === 'RangeError') return 'bad-size';
  if (name === 'SecurityError') return 'blocked';
  return 'unknown';
}

/** Human-readable copy for each failure mode, shown as a toast. */
export function explainFailure(reason) {
  switch (reason) {
    case 'unsupported':
      return 'This browser has no Document PiP API. Chrome/Edge 116+ or Firefox 151+ required.';
    case 'no-user-activation':
      return 'The browser needs a direct click to open a floating window. Click the button again.';
    case 'disabled':
      return 'Floating windows are disabled by a browser setting or policy.';
    case 'blocked':
      return 'Floating windows are blocked here. The page must be served over HTTPS or localhost.';
    case 'bad-size':
      return 'The requested window size was rejected. Try a smaller size.';
    default:
      return 'Could not open a floating window.';
  }
}

/**
 * Track the user's own resizing of the PiP window so the next open can reuse
 * it. Reading innerWidth/innerHeight off the PiP window is same-origin and
 * always allowed.
 */
export function watchPipSize(pipWindow, onChange, { wait = 250 } = {}) {
  if (!pipWindow || typeof onChange !== 'function') return () => {};
  let timer = null;
  const handler = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const width = pipWindow.innerWidth;
      const height = pipWindow.innerHeight;
      if (Number.isFinite(width) && Number.isFinite(height)) onChange({ width, height });
    }, wait);
  };
  pipWindow.addEventListener('resize', handler);
  return () => {
    if (timer) clearTimeout(timer);
    pipWindow.removeEventListener('resize', handler);
  };
}
