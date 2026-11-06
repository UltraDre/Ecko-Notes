# Ecko Notes

A floating notepad web app that stays on top of every other window on your
desktop, built on the **Document Picture-in-Picture API**.

Click **Float on top** (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>)
and the notepad detaches into a small always-on-top window that hovers above
your editor, your browser, your terminal — anything — while you keep typing.
Notes autosave as you go.

---

## Quick start

```bash
npm install     # only needed for the test suite (jsdom); the app has zero runtime deps
npm start       # http://localhost:5173
npm test        # 96 tests
```

The app itself is plain HTML, CSS and ES modules — no build step, no bundler,
no framework. `server.mjs` is a ~90-line static file server.

## Browser support

The Document Picture-in-Picture API has **limited availability**, so the app
feature-detects it and degrades honestly rather than silently breaking.

| Browser | Document PiP | What you get |
| --- | --- | --- |
| Chrome / Edge / Opera 116+ | Yes | Always-on-top floating window |
| Firefox 151+ (desktop) | Yes | Always-on-top floating window |
| Safari (any version) | No | Separate pop-up window, **not** always-on-top |
| Chrome / Firefox for Android | No | Separate pop-up window, **not** always-on-top |

Two other constraints from the spec:

- **Secure context required.** Serve over HTTPS, or use `localhost`. Opening
  `index.html` straight off the filesystem will not expose the API.
- **Transient activation required.** `requestWindow()` only works inside a
  user-gesture handler, so the floating window always opens from a click or
  keypress — never on page load or a timer.

On unsupported browsers the button relabels itself to *Open in new window* and
the app tells you plainly that the window cannot be forced on top.

## Features

- **Always-on-top window** that remembers the size you leave it at
- Multiple notes with live search, pinning and duplicate
- Autosave to `localStorage` on a 350 ms debounce, with a save indicator
- First line of a note is its title — the editor stays a plain textarea
- Word / character counts and reading time
- Dark, light and system themes; three editor fonts; soft-wrap toggle
- Adjustable font size (12–30 px)
- Export one note as Markdown, or everything as JSON; import JSON back
- Delete with an Undo toast
- Keyboard shortcuts, listed below

### Shortcuts

| Keys | Action |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> | Toggle the floating window |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Alt</kbd> + <kbd>N</kbd> | New note |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Alt</kbd> + <kbd>D</kbd> | Duplicate note |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>S</kbd> | Save now |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>\</kbd> | Toggle sidebar |
| <kbd>/</kbd> | Focus search |
| <kbd>Esc</kbd> | Clear search |

## How the floating window works

The whole notepad is a single DOM subtree, `#app`. Floating it **moves that
subtree** into the PiP window and moves it back on `pagehide`:

```js
const pipWindow = await documentPictureInPicture.requestWindow({ width, height });
copyStyles(document, pipWindow.document);      // CSS is NOT copied for you
pipWindow.document.body.append(app);           // adopt the notepad
pipWindow.addEventListener('pagehide', () => {
  stage.prepend(app);                          // reclaim it before teardown
});
```

Nothing is cloned or mirrored, so there is exactly one instance of the app and
no cross-window state to reconcile. Three details worth knowing, each of which
has a test:

1. **Stylesheets are not inherited.** Moved nodes arrive completely unstyled, so
   `copyStyles()` clones every `<style>` and `<link rel="stylesheet">` into the
   PiP document. They are cloned, not moved — the host tab must keep its CSS for
   when the notepad comes back.

2. **Moving a node does not move its JavaScript realm.** All of the app's
   closures and listeners keep belonging to the opener tab, which is why
   `localStorage` writes stay consistent. But anything bound to the opener's
   `window` stops receiving events once focus moves, so `bindGlobals()`
   re-points keyboard shortcuts at whichever window currently hosts `#app`.

3. **`width` and `height` must both be supplied**, or `requestWindow()` throws a
   `RangeError`. `clampPipSize()` guarantees a finite, sane pair, and the
   size the user resizes to is read back off the PiP window and persisted.

`@media (display-mode: picture-in-picture)` handles the compact layout — it
matches only inside the floating window, so it cannot affect the docked view.

## Project layout

```
index.html          Markup: #app (the notepad) + #pip-placeholder (shown in the tab)
styles/app.css      One stylesheet, shared by the tab and the PiP window
src/notes.js        Pure data layer — no DOM, importable from Node
src/pip.js          Document PiP layer — detection, requestWindow, style copying
src/app.js          Application shell and DOM wiring
server.mjs          Zero-dependency static dev server
test/               96 tests: notes.test.mjs, pip.test.mjs, app.test.mjs
```

## Tests

```bash
npm test
```

`notes.test.mjs` and `pip.test.mjs` cover the pure logic. `app.test.mjs` runs
the real `src/app.js` inside jsdom against a mocked `documentPictureInPicture`
that hands back a genuinely separate jsdom `Window`, so assertions like
`app.ownerDocument === pipDocument` are real cross-document checks: they prove
the notepad actually adopted into the floating window and actually came back.

**What this does not cover:** there is no browser binary in this environment, so
the real Document PiP window — actual always-on-top behaviour, browser window
chrome, and the *back to tab* control — has not been exercised. That needs a
manual check in Chrome, Edge or Firefox 151+. The API surface it would touch is
mocked and tested.

## License

MIT
