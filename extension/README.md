# Selector — Chrome extension

Click a DOM element in Chrome, its context lands on your clipboard. Paste it
wherever it needs to go. See `../SPEC.md` for the payload format.

Nothing else runs: no daemon, no hooks, no configuration.

## Load unpacked

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` directory.
3. Click the toolbar icon — that is the whole trigger, there is no popup.
   Then click anything on the page; Escape cancels. Hovering
   shows a DevTools-style overlay: box-model rings (content/padding/border/
   margin) and a card with the tag, dimensions, accessibility name/role/
   focusability, and the size of the region the screenshot will capture —
   itself outlined with a dashed box. A toast confirms the copy; the screenshot is saved under
   `~/Downloads/element-selector/` and its path is appended to the copied text.

No build step. No bundler. `npm install` is not needed and there is no
`package.json` — the two dependencies are vendored (see below).

Manual test page: `test.html`. Serve it (`npx serve extension`) or open it as
`file://` — for `file://` you must also tick **Allow access to file URLs** on the
extension's details page.

## Pinned extension ID

`manifest.json` carries a `key` (an RSA public key, base64 DER). It pins the
extension ID to `clacecfeghkbdikfijkacbdlakfdkkag` no matter where the directory
lives, which keeps `chrome.runtime.getURL` URLs stable across machines and
moves. Comments are not written into `manifest.json`
because Chrome's manifest parser is not guaranteed to tolerate them.

To mint your own:

```sh
openssl genrsa 2048 > key.pem                       # keep this OUT of git
openssl rsa -in key.pem -pubout -outform DER | base64 | tr -d '\n'
```

Paste the output as `"key"`. Keep `key.pem` if you ever want to pack a `.crx`
with the same ID (`chrome://extensions` → Pack extension → use `key.pem` as the
private key). Unpacked loading never needs the private key.

## Vendored dependencies

Copied verbatim from npm into `vendor/`, byte-for-byte, no transform — MV3
service workers and injected scripts have no npm resolution at runtime, and the
project takes a zero-build-step constraint:

| file | source | why that build |
|---|---|---|
| `vendor/finder.js` | `@medv/finder@4.0.2` (`finder.js`) | already plain ESM with no bare imports; imported by `payload.js`, and it touches no DOM at module scope so `payload.test.mjs` can import it under node |
| `vendor/element-source.global.js` | `element-source@0.0.5` (`dist/index.global.js`) | the ESM build has bare `bippy` / `bippy/source` imports that no browser can resolve; the IIFE build has bippy bundled and exposes `window.ElementSource` |

To refresh: `npm pack @medv/finder element-source`, untar, copy those two files.
`element-source.global.js` ends with a `sourceMappingURL` comment for a map that
is not shipped — harmless, and stripping it with `sed` corrupts the file (the
same string appears inside a minified regex).

## How it fits together

```
sw.js     → chrome.action.onClicked → startPicker(tab)
          → executeScript(world:MAIN)     vendor/element-source.global.js + probe
          → executeScript(world:ISOLATED) import('picker.js').start()
picker.js → payload.js (+ vendor/finder.js)
          → window.postMessage ⇄ MAIN-world probe   (component name)
          → chrome.runtime.sendMessage {type:'picked', payload, rect, dpr}
sw.js     → captureVisibleTab → crop → PNG data URL → returns {text, dataUrl}
picker.js → clipboard.write(ClipboardItem{text/plain, text/html, image/png})
          → writeText / execCommand fallback → toast
```

Two details worth knowing before changing anything:

- **Why the MAIN-world probe.** React/Vue/Svelte fibers hang off DOM nodes as
  expando properties, and expandos live on each world's own wrapper object. A
  content script in the isolated world simply cannot see `__reactFiber$`. The
  probe runs `element-source` in the page's world; the picker hands it the
  element via a temporary `data-selector-target` attribute, because
  attributes are real DOM state and are shared across worlds.
- **Why `import()` instead of `files:[…]`.** `chrome.scripting.executeScript`
  evaluates `files` as classic scripts, so a content script cannot `import`.
  Dynamic `import()` of a `web_accessible_resources` URL is the only route to
  real ESM in the page, hence `picker.js`, `payload.js` and `vendor/finder.js`
  being web-accessible.

## Checks

```sh
node extension/payload.test.mjs     # pure logic, no browser
node test-chrome.mjs                # real Chrome, real click, asserts the clipboard
```

Covers the pure logic: the selector class filter (hashed CSS-in-JS, CSS-module
and Tailwind-JIT classes are dropped), the shadow-host chain, block assembly
(fixed child order, empty tags omitted, XML escaping) and the homoglyph
hardening. The DOM-walking parts — `<html>` pruning, computed-style diffing,
sibling listing — need a real browser; `test.html` exercises them by hand and
labels what each section should produce. `test-chrome.mjs` drives those paths
for real — see its header comment for the Chrome-automation traps it encodes.

## When it does nothing at all

The picker failing to start looks identical to the extension being idle: no
overlay, no crosshair, no error. Two causes, in order of likelihood:

1. **A stale build.** Changing `manifest.json` — especially permissions — needs
   an explicit reload at `chrome://extensions` (the circular arrow on the card).
   Check the version on the card at `chrome://extensions`; if it does not match
   `manifest.json`, the reload did not take.
2. **Site access is restricted.** `chrome://extensions` -> Selector ->
   **Details** -> **Site access** must be **On all sites**. Chrome remembers a
   per-extension choice of "On click" / "On specific sites", and that choice
   survives a manifest change — so an extension first loaded with only
   `activeTab` can keep failing after `<all_urls>` is added, with exactly the
   silent symptom above.

## Known limits

- **`<all_urls>` host permission.** Required: `activeTab` alone is not enough
  for the popup-driven `executeScript`, and without it the picker fails
  silently. It does mean the extension can read and modify any page. Narrow it
  to specific origins in `manifest.json` if you only ever pick on a few sites.
- **Top frame only.** No iframes. `allFrames: true` needs the parent frame to
  contribute the `<iframe>` rect before the screenshot can be cropped correctly.
- **No `chrome://`, Web Store, or PDF pages.** Chrome forbids injection there;
  the popup says so instead of failing silently.
- **The clipboard write happens in the page, not the worker.** A service worker
  has no DOM and therefore no clipboard. `navigator.clipboard.writeText` needs
  transient user activation, which the picking `pointerdown` grants and which
  outlives the worker round trip; a hidden-textarea `execCommand` fallback
  covers the case where a page policy or a slow capture has eaten it.
- **`<react>` is best effort.** Production bundles yield a component name at
  best, often nothing. Props are not emitted: `element-source` does not expose
  them and hand-rolling `__reactFiber$` is explicitly out of scope.
- **The screenshot has a URL strip** burned along its bottom edge (26px), so an
  image pasted on its own still says where it came from. The crop is therefore
  26px taller than the region the dashed overlay shows.
- **One paste gives you one thing.** The clipboard item carries text, html and
  png, but the target chooses: a terminal takes the text, an image-aware app
  takes the picture, a rich editor takes the html and so gets both. Nothing is
  written to disk. If capture fails the pick is still copied as text, with
  `has-screenshot="false"`.
- **The image needs a secure context.** `clipboard.write` refuses on plain
  `http://` pages; the text still copies and the toast says "text only".
- Dynamic `import()` from the isolated world is the one place a very strict page
  CSP has historically caused trouble. If a site ever breaks the picker, that is
  the first thing to check.
