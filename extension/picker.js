// Injected content script (isolated world), loaded by sw.js via dynamic
// import() so it can use real ESM. Draws the hover overlay, swallows the whole
// mouse family so the page never sees the selecting click, and hands the picked
// element to the service worker.
import { buildPayload } from './payload.js';

const MARKER = 'data-selector-target';
// Every mouse event a page might act on. Capture phase at document, all
// cancelled — a link must not navigate just because you selected it.
const MOUSE = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu'];

// Chromium's own inspector-overlay palette, so the overlay reads exactly like
// DevTools' inspect mode rather than as a lookalike with different meanings.
const COLORS = {
  content: 'rgba(111,168,220,.66)',
  padding: 'rgba(147,196,125,.55)',
  border: 'rgba(255,229,153,.66)',
  margin: 'rgba(246,178,107,.55)',
};

// The running picker's teardown, or null when idle. Doubles as the "are we
// picking?" flag, so the toolbar can stop a picker it did not start — the module
// is imported once per page and this survives every later import().
let stop = null;

// The toolbar icon toggles: sw.js asks here first, and only injects if nothing
// was already running. Replying true is what tells it not to start a second one.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== 'stop') return false;
  const running = !!stop;
  if (running) stop();
  reply(running);
  return false;
});

/** Position a ring: outer box at (x,y,w,h), thickness per side. */
function place(el, x, y, w, h, side) {
  Object.assign(el.style, {
    display: 'block',
    left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, h)}px`,
    borderTopWidth: `${side.t}px`, borderRightWidth: `${side.r}px`,
    borderBottomWidth: `${side.b}px`, borderLeftWidth: `${side.l}px`,
  });
}

/** DevTools prints 561 × 20.8 — integers bare, fractions to one place. */
const dim = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''));

const IMPLICIT_ROLE = {
  A: (el) => (el.hasAttribute('href') ? 'link' : 'generic'),
  AREA: (el) => (el.hasAttribute('href') ? 'link' : 'generic'),
  BUTTON: 'button', SUMMARY: 'button', H1: 'heading', H2: 'heading', H3: 'heading',
  H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'image', NAV: 'navigation',
  MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
  SECTION: 'region', FORM: 'form', UL: 'list', OL: 'list', LI: 'listitem',
  TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', SELECT: 'combobox',
  TEXTAREA: 'textbox', P: 'paragraph', ARTICLE: 'article', DIALOG: 'dialog',
  PROGRESS: 'progressbar', HR: 'separator', OPTION: 'option', LABEL: 'label',
};
const INPUT_ROLE = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  submit: 'button', button: 'button', reset: 'button', image: 'button',
  email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox', search: 'searchbox',
};

/**
 * Role and name are approximations of the real accessibility tree. DevTools
 * gets the computed values from Blink; a content script has no such API, so
 * this covers the common cases and says nothing when unsure rather than
 * inventing a value.
 */
function roleOf(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/)[0];
  if (el.tagName === 'INPUT') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox';
  const implicit = IMPLICIT_ROLE[el.tagName];
  return typeof implicit === 'function' ? implicit(el) : implicit || 'generic';
}

function nameOf(el) {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
    if (t) return t;
  }
  if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    const lab = el.labels && el.labels[0];
    if (lab && lab.textContent.trim()) return lab.textContent.trim();
    return el.getAttribute('placeholder') || el.getAttribute('title') || '';
  }
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return text || el.getAttribute('title') || '';
}

function focusableOf(el) {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
  const ti = el.getAttribute('tabindex');
  if (ti !== null) return parseInt(ti, 10) >= 0;
  if (el.isContentEditable) return true;
  if (el.tagName === 'A' || el.tagName === 'AREA') return el.hasAttribute('href');
  return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'IFRAME'].includes(el.tagName);
}

/** Rebuild the info card for `el`. Plain DOM + inline styles: a strict page
 *  style-src would drop an injected <style>, and innerHTML would be a needless
 *  injection surface for page-derived strings. */
function fillCard(card, el, rect, capture) {
  card.textContent = '';
  card.style.display = 'block';

  const row = (gap) => {
    const d = document.createElement('div');
    d.style.cssText = `display:flex;align-items:baseline;justify-content:space-between;gap:16px${gap ? ';margin-top:2px' : ''}`;
    return d;
  };
  const span = (text, css) => {
    const s = document.createElement('span');
    s.textContent = text;
    if (css) s.style.cssText = css;
    return s;
  };

  const head = row();
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList.length ? `.${el.classList[0]}` : '';
  head.append(
    span(`${el.tagName.toLowerCase()}${id}${cls}`,
      'font-weight:700;color:#a626a4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'),
    span(`${dim(rect.width)} × ${dim(rect.height)}`, 'color:#5f6368;white-space:nowrap'),
  );
  card.append(head);

  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;align-items:center;gap:6px;margin:6px 0 4px;'
    + 'font-size:10px;letter-spacing:.06em;color:#5f6368;text-transform:uppercase';
  legend.append(span('Accessibility'));
  const rule = document.createElement('div');
  rule.style.cssText = 'flex:1;height:1px;background:#dadce0';
  legend.append(rule);
  card.append(legend);

  const name = nameOf(el);
  const kv = (k, v, muted) => {
    const d = row(true);
    d.append(span(k, 'color:#5f6368'),
      span(v, `text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px${muted ? ';color:#9aa0a6' : ''}`));
    card.append(d);
  };
  kv('Name', name ? (name.length > 40 ? name.slice(0, 39) + '…' : name) : '—', !name);
  kv('Role', roleOf(el));
  kv('Keyboard-focusable', focusableOf(el) ? '✓' : '⃠');

  const shotRow = row(true);
  shotRow.style.marginTop = '6px';
  shotRow.style.paddingTop = '6px';
  shotRow.style.borderTop = '1px solid #dadce0';
  shotRow.append(span('Screenshot', 'color:#5f6368'),
    span(`${Math.round(capture.w)} × ${Math.round(capture.h)}`, 'color:#5f6368'));
  card.append(shotRow);
}

export function start() {
  if (stop) return;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  // Closed: the page cannot reach in, and our nodes stay out of its queries.
  const root = host.attachShadow({ mode: 'closed' });

  // Inline cssText only — an injected <style> tag trips a strict style-src CSP.
  // Dashed outline of what the screenshot will contain. First, so the box-model
  // layers paint over it.
  const shot = document.createElement('div');
  shot.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;display:none;'
    + 'border:1px dashed rgba(32,33,36,.5)';

  // Box model, drawn as DevTools does it: each layer is a ring made of borders
  // rather than a filled rect, so the colours never stack and muddy each other.
  const layer = () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;display:none;border-style:solid';
    return d;
  };
  const marginL = layer(); marginL.style.borderColor = COLORS.margin;
  const borderL = layer(); borderL.style.borderColor = COLORS.border;
  const paddingL = layer(); paddingL.style.borderColor = COLORS.padding;
  const contentL = document.createElement('div');
  contentL.style.cssText = `position:fixed;pointer-events:none;display:none;background:${COLORS.content}`;

  const card = document.createElement('div');
  card.style.cssText = 'position:fixed;pointer-events:none;display:none;box-sizing:border-box;'
    + 'font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#202124;background:#fff;'
    + 'border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,.35);padding:8px 10px;'
    + 'min-width:200px;max-width:360px;z-index:1';
  // The buffer's only readout: how many picks are held and which key commits
  // them. Inside the overlay host, so hide() takes it out of the screenshot
  // along with everything else.
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);'
    + 'font:12px/1.5 ui-sans-serif,system-ui,sans-serif;color:#fff;background:rgba(32,33,36,.92);'
    + 'padding:6px 12px;border-radius:999px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3);z-index:2';
  root.append(shot, marginL, borderL, paddingL, contentL, card, hud);

  const prevCursor = document.documentElement.style.cursor;

  let hovered = null;
  let picked = false;
  let inflight = null; // the running pick(), so Enter can commit behind it
  // Picks accumulate here and reach the clipboard together on Enter. Kept in the
  // page, not the worker: the worker is killed after ~30s idle and hunting for
  // the next element easily takes longer than that.
  const items = [];

  function hide() {
    host.remove();
    document.documentElement.style.cursor = prevCursor;
  }

  /** (Re)arm the overlay — once at the start, then after every pick, since the
   *  screenshot needs the whole host out of the page. */
  function show() {
    // Clear the last element's boxes rather than flashing them over whatever
    // happens to be under the cursor now.
    for (const el of [shot, marginL, borderL, paddingL, contentL, card]) el.style.display = 'none';
    hovered = null;
    hud.textContent = items.length
      ? `${items.length} selected — right-click or Enter to copy, Esc to clear`
      : 'Click elements to select — Esc to cancel';
    document.documentElement.append(host);
    document.documentElement.style.cursor = 'crosshair';

    // Clicking the toolbar icon leaves focus in the browser chrome, so the page
    // document receives no keydown and Escape does nothing until you click into
    // the page. Take focus onto the overlay host to route the keys here.
    //
    // hasFocus(), not activeElement: Blink KEEPS activeElement when the web
    // contents loses focus — measured on Chrome 151, a focused <input> is still
    // activeElement after focus moves away — so gating on it means never firing
    // for anyone who had a field focused, which is most of the reason to reach for
    // the picker. And this is the exact condition: onKey listens at document
    // capture, so any focused page element already delivers Escape. The steal is
    // only ever needed when the document has no focus at all.
    if (!document.hasFocus()) {
      host.tabIndex = -1;
      host.focus({ preventScroll: true });
    }
  }

  function teardown() {
    // Identity, not truthiness. Stop the picker and start a fresh one and this
    // closure is still reachable from the old one's in-flight work; without the
    // guard it would tear the NEW picker's state down, orphaning its swallow
    // handlers on document with no way left to remove them — a page dead to the
    // mouse until reload.
    if (stop !== teardown) return;
    stop = null;
    for (const t of MOUSE) document.removeEventListener(t, swallow, true);
    document.removeEventListener('pointermove', hover, true);
    document.removeEventListener('keydown', onKey, true);
    hide();
    // The worker owns the toolbar tooltip and cannot see this happen. Without
    // it the icon keeps offering Enter and Escape at a picker that already quit.
    chrome.runtime.sendMessage({ type: 'idle' }).catch(() => {});
  }

  function hover(e) {
    const el = e.composedPath()[0];
    if (picked || !el || el.nodeType !== 1 || el === hovered) return;
    hovered = el;

    const cs = getComputedStyle(el);
    const px = (v) => parseFloat(v) || 0;
    const r = el.getBoundingClientRect(); // the border box
    // Negative margins would draw a ring inside out; clamp for display only.
    const m = { t: Math.max(0, px(cs.marginTop)), r: Math.max(0, px(cs.marginRight)),
                b: Math.max(0, px(cs.marginBottom)), l: Math.max(0, px(cs.marginLeft)) };
    const bd = { t: px(cs.borderTopWidth), r: px(cs.borderRightWidth),
                 b: px(cs.borderBottomWidth), l: px(cs.borderLeftWidth) };
    const p = { t: px(cs.paddingTop), r: px(cs.paddingRight),
                b: px(cs.paddingBottom), l: px(cs.paddingLeft) };

    // Each ring sits at its own outer box, with border widths equal to that
    // layer's thickness — so the painted area is exactly the ring.
    place(marginL, r.left - m.l, r.top - m.t, r.width + m.l + m.r, r.height + m.t + m.b, m);
    place(borderL, r.left, r.top, r.width, r.height, bd);
    const pl = r.left + bd.l, pt = r.top + bd.t;
    const pw = Math.max(0, r.width - bd.l - bd.r), ph = Math.max(0, r.height - bd.t - bd.b);
    place(paddingL, pl, pt, pw, ph, p);
    const cw = Math.max(0, pw - p.l - p.r), ch = Math.max(0, ph - p.t - p.b);
    Object.assign(contentL.style, {
      display: 'block', left: `${pl + p.l}px`, top: `${pt + p.t}px`, width: `${cw}px`, height: `${ch}px`,
    });

    // Mirror crop() in sw.js: 80 DEVICE px of padding, clamped to the viewport
    // (the capture is of the visible tab, so nothing outside it can be cropped).
    // Read dpr per-hover — it changes when the window moves between displays.
    const pad = 80 / devicePixelRatio;
    const sl = Math.max(0, r.left - pad);
    const st = Math.max(0, r.top - pad);
    const sw = Math.min(innerWidth, r.right + pad) - sl;
    const sh = Math.min(innerHeight, r.bottom + pad) - st;
    Object.assign(shot.style, { display: 'block', left: `${sl}px`, top: `${st}px`, width: `${sw}px`, height: `${sh}px` });

    fillCard(card, el, r, { w: sw, h: sh });

    // Below the margin box by default; flip above when it would run off, and
    // clamp horizontally. Measured after filling, since the height varies.
    const cr = card.getBoundingClientRect();
    const below = r.bottom + m.b + 8;
    const top = below + cr.height > innerHeight ? Math.max(4, r.top - m.t - cr.height - 8) : below;
    Object.assign(card.style, {
      left: `${Math.min(Math.max(4, r.left - m.l), Math.max(4, innerWidth - cr.width - 4))}px`,
      top: `${top}px`,
    });
  }

  /** Copy the buffer and quit. Tear down first — finish() awaits the worker, and
   *  the overlay must not sit on the page for that whole trip. A pick still in
   *  flight has not pushed into `items` yet, so commit behind it: picking and
   *  finishing straight after is the ordinary case, and losing that last element
   *  would be silent. */
  function commit() {
    const pending = picked ? inflight : null;
    teardown();
    Promise.resolve(pending).then(() => { if (items.length) finish(items); });
  }

  // The picker stays up after a pick, so the trailing mouseup/click/contextmenu
  // are swallowed by these same still-attached handlers — and only pointerdown
  // ever starts a pick, so re-arming before they arrive cannot pick twice.
  async function swallow(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'pointerdown') return;
    if (e.button === 2) {
      // Right-click finishes, so the whole thing works without the keyboard.
      // teardown() pulls the swallow handlers off document on the way out, and
      // the native menu fires AFTER this pointerdown — so leave something behind
      // to eat it, or committing pops a context menu every time.
      const eat = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); };
      for (const t of ['contextmenu', 'auxclick']) document.addEventListener(t, eat, true);
      setTimeout(() => {
        for (const t of ['contextmenu', 'auxclick']) document.removeEventListener(t, eat, true);
      }, 500);
      return commit();
    }
    if (picked || e.button !== 0) return;
    picked = true;
    hide(); // out of the screenshot and out of the serialised DOM before we read it
    inflight = pick(e.composedPath()[0], items);
    await inflight;
    // The picker can be stopped and restarted while that is in flight. Showing
    // here would re-append a host this picker no longer owns, and nothing left
    // running could ever take it back off the page.
    if (stop !== teardown) return;
    picked = false;
    show();
  }

  function onKey(e) {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Enter') return commit();
    teardown(); // Escape throws the buffer away
  }

  for (const t of MOUSE) document.addEventListener(t, swallow, true);
  document.addEventListener('pointermove', hover, true);
  document.addEventListener('keydown', onKey, true);
  stop = teardown;
  show();
}

/** Capture one element into `items`. Nothing reaches the clipboard until Enter. */
async function pick(el, items) {
  if (!el || el.nodeType !== 1) return;
  const r = el.getBoundingClientRect();
  const payload = buildPayload(el, { react: await reactComponent(el) });
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'picked',
      payload,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      dpr: devicePixelRatio,
    });
  } catch (e) {
    res = { text: payload, error: String(e.message || e) };
  }
  items.push({ text: (res && res.text) || payload, dataUrl: (res && res.dataUrl) || '' });
}

/**
 * Commit the buffer as ONE paste. A clipboard item carries a single bitmap, so
 * several shots have to become one — the worker stacks them in pick order, and
 * the text blocks follow in that same order so the two can be read side by side.
 * (text/html still gets them as separate <img>s, which is strictly better where
 * the target understands it.)
 */
async function finish(items) {
  const shots = items.map((i) => i.dataUrl).filter(Boolean);
  const text = items.length === 1
    ? items[0].text
    : `${items.length} elements were selected, in the order they appear top-to-bottom in the image.\n\n`
      + items.map((i) => i.text).join('\n\n');

  let composite = shots[0] || '';
  if (shots.length > 1) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'compose', dataUrls: shots });
      if (res && res.dataUrl) composite = res.dataUrl;
    } catch (e) {
      console.warn('[selector] compose failed, falling back to the first shot', e);
    }
  }

  const how = await copy(text, composite, shots);
  const n = items.length > 1 ? `${items.length} ` : '';
  toast({
    both: `Copied ${n}— image + text`,
    text: `Copied ${n}— text only`,
    fail: 'Copy failed — see console',
  }[how], how !== 'fail');
  if (how === 'fail') console.warn('[selector] clipboard write failed; payload follows\n' + text);
}

/**
 * A clipboard holds ONE item with several flavours, and the target picks the
 * one it understands — you cannot force a terminal to take an image, or a
 * paste to yield two things. So write all three:
 *   text/plain  the block, for terminals and editors (carries <url>)
 *   text/html   the block AND the image inline, so a rich target gets both
 *   image/png   the raw bitmap, for anything that wants a picture
 *
 * navigator.clipboard.write needs a secure context; on plain http it throws and
 * we fall back to text. writeText needs transient user activation, which the
 * picking pointerdown grants and which outlives the worker round trip, with a
 * hidden-textarea execCommand behind that for when a page policy eats it.
 *
 * Returns 'both' | 'text' | 'fail'.
 */
async function copy(text, dataUrl, shots = dataUrl ? [dataUrl] : []) {
  if (dataUrl && typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
    try {
      const png = await (await fetch(dataUrl)).blob();
      // The stack for image/png, but the individual shots for text/html — one
      // <img> each keeps them at full size for anything that takes rich paste.
      const imgs = shots.map((u) => `<img src="${u}" alt="selected element">`).join('');
      const html = `<div>${imgs}<pre>${escapeHtml(text)}</pre></div>`;
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
        'image/png': png,
      })]);
      return 'both';
    } catch (e) {
      // Insecure context, or the page denied it. Text is the important half.
      console.warn('[selector] image copy failed, falling back to text', e);
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'text';
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok ? 'text' : 'fail';
  } catch {
    return 'fail';
  }
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Brief confirmation — without it there is no signal the pick did anything. */
function toast(msg, ok) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:auto 16px 16px auto;z-index:2147483647;pointer-events:none';
  const box = document.createElement('div');
  box.textContent = msg;
  box.style.cssText =
    `font:13px/1.4 ui-sans-serif,system-ui,sans-serif;color:#fff;padding:8px 12px;border-radius:6px;` +
    `background:${ok ? '#1a7f37' : '#cf222e'};box-shadow:0 2px 8px rgba(0,0,0,.3)`;
  host.attachShadow({ mode: 'closed' }).append(box);
  document.documentElement.append(host);
  setTimeout(() => host.remove(), 2000);
}

/**
 * Component name from element-source. The framework fiber expandos live on the
 * page's own wrapper objects, invisible from this isolated world, so
 * element-source runs in a MAIN-world probe (installed by sw.js). We hand it
 * the element via a temporary attribute — attributes are real DOM state, shared
 * across worlds, unlike expando properties.
 */
function reactComponent(el) {
  el.setAttribute(MARKER, '');
  return new Promise((resolve) => {
    const done = (v) => {
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      el.removeAttribute(MARKER);
      resolve(v);
    };
    const onMsg = (e) => {
      if (e.source === window && e.data && e.data.__elementSelector === 'res') done(e.data.component || '');
    };
    const timer = setTimeout(() => done(''), 400);
    window.addEventListener('message', onMsg);
    window.postMessage({ __elementSelector: 'req' }, '*');
  });
}
