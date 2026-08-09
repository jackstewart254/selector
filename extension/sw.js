// Service worker: crops the screenshot and saves it, then hands the finished
// text back to the content script, which is what actually writes the clipboard
// (a worker has no DOM, so no clipboard either).
//
// Image/document do not exist here — ImageBitmap + OffscreenCanvas only. No
// durable state: this worker is killed after ~30s idle and every pick is
// self-contained, so there is nothing worth persisting.

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Height of the URL strip burned onto the bottom of every screenshot. */
const BAR = 26;

/** Shrink a URL until it fits `max` px: drop the scheme, then ellipsize the
 *  middle, keeping the host and the tail — those carry the most meaning. */
function fitUrl(ctx, url, max) {
  let s = url.replace(/^https?:\/\//, '');
  if (ctx.measureText(s).width <= max) return s;
  let lo = 4;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const head = Math.ceil(mid / 2);
    const cand = `${s.slice(0, head)}…${s.slice(s.length - (mid - head))}`;
    if (ctx.measureText(cand).width <= max) lo = mid + 1; else hi = mid;
  }
  const n = Math.max(4, lo - 1);
  const head = Math.ceil(n / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (n - head))}`;
}

/**
 * Crop the visible-tab PNG to the element rect, 80px padding, longest side
 * <= 1200, then burn the page URL along the bottom. The strip matters: when the
 * image is the flavour that gets pasted, it is the ONLY thing carrying where it
 * came from — the text block goes nowhere.
 */
async function crop(dataUrl, rect, dpr, url = '') {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const pad = 80;
  const x = Math.max(0, Math.round(rect.x * dpr) - pad);
  const y = Math.max(0, Math.round(rect.y * dpr) - pad);
  const w = Math.max(1, Math.min(bmp.width, Math.round((rect.x + rect.width) * dpr) + pad) - x);
  const h = Math.max(1, Math.min(bmp.height, Math.round((rect.y + rect.height) * dpr) + pad) - y);
  const scale = Math.min(1, 1200 / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);

  const canvas = new OffscreenCanvas(cw, ch + BAR);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, x, y, w, h, 0, 0, cw, ch);
  bmp.close();

  ctx.fillStyle = '#1f2328';
  ctx.fillRect(0, ch, cw, BAR);
  ctx.fillStyle = '#ffffff';
  ctx.font = '13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(fitUrl(ctx, url, cw - 16), 8, ch + BAR / 2 + 1);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return 'data:image/png;base64,' + b64(await blob.arrayBuffer());
}

function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

async function handlePick({ payload, rect, dpr }, sender) {
  let dataUrl = '';
  try {
    const shot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    // sender.tab.url comes from Chrome, not from the page, so a hostile page
    // cannot forge what the strip says.
    dataUrl = await crop(shot, rect, dpr, sender.tab.url || '');
  } catch (e) {
    // Best-effort: a pick with no image still beats no pick at all.
    console.warn('screenshot failed', e);
  }

  // The block is assembled before capture is attempted, so has-screenshot starts
  // optimistic. Correct it rather than claim an image that does not exist. First
  // match is ours: the attribute sits in the <element> open tag, ahead of any
  // page-derived content.
  if (!dataUrl) payload = payload.replace('has-screenshot="true"', 'has-screenshot="false"');

  badge('OK', '#1a7f37');
  // The image travels as a data URL because structured clone cannot carry a
  // Blob from a worker to a content script; the page turns it back into one.
  return { text: payload, dataUrl };
}

// ------------------------------------------------------------------- start

// Pages Chrome refuses to inject into. Named explicitly so the badge can say
// why instead of just failing.
const BLOCKED = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|data):/i;
const WEBSTORE = /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;
const PDF = /\.pdf(\?|#|$)/i;

function blockedReason(url = '') {
  if (BLOCKED.test(url)) return 'Chrome cannot inject scripts into browser pages';
  if (WEBSTORE.test(url)) return 'The Chrome Web Store blocks extension scripts';
  if (PDF.test(url)) return 'PDF viewer pages have no DOM to pick from';
  return '';
}

/** Runs in the page's MAIN world: element-source needs the framework fiber
 *  expandos, which are invisible from a content script's isolated world. */
function probe() {
  if (window.__elementSelectorProbe) return;
  window.__elementSelectorProbe = true;
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__elementSelector !== 'req') return;
    let component = '';
    try {
      const el = document.querySelector('[data-element-selector-target]');
      const src = window.ElementSource;
      if (el && src) {
        const info = await src.resolveElementInfo(el);
        component = info.componentName || '';
        const stack = (info.stack || []).map((f) => f.componentName).filter(Boolean).slice(1, 4);
        if (component && stack.length) component += ` (in ${stack.join(' > ')})`;
      }
    } catch { /* best effort — production bundles often yield nothing */ }
    window.postMessage({ __elementSelector: 'res', component }, '*');
  });
}

async function startPicker(tab) {
  const reason = blockedReason(tab && tab.url);
  if (!tab || reason) return fail(reason || 'no active tab');
  try {
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['vendor/element-source.global.js'] });
    await chrome.scripting.executeScript({ target, world: 'MAIN', func: probe });
    await chrome.scripting.executeScript({
      target,
      // executeScript files are classic scripts; dynamic import() is the only
      // way to get real ESM (and its vendored deps) into the page.
      func: async (url) => { (await import(url)).start(); },
      args: [chrome.runtime.getURL('picker.js')],
    });
    chrome.action.setTitle({ tabId: tab.id, title: 'Selecting — click an element, Escape cancels' });
  } catch (e) {
    fail(String(e.message || e));
  }
}

/** No popup any more, so the badge and tooltip are the only channel left for a
 *  failure that happens before anything can be drawn on the page. */
function fail(reason) {
  badge('!', '#cf222e');
  chrome.action.setTitle({ title: `element-selector: ${reason}` });
  console.warn('[element-selector]', reason);
}

chrome.action.onClicked.addListener((tab) => startPicker(tab));

// The toolbar click cannot be synthesised by any automation, so test-chrome.mjs
// calls this directly. Exposing it keeps the test on the real entry point
// rather than a copy of it that can silently drift.
globalThis.startPicker = startPicker;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type !== 'picked') return false;
  handlePick(msg, sender).then(reply, (e) => {
    badge('!', '#cf222e');
    reply({ text: msg.payload, path: '', error: String(e.message || e) });
  });
  return true;
});
