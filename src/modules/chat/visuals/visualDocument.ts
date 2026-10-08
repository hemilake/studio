/**
 * Fork (inline visuals): the document a visual runs in. See docs/fork/visuals.md.
 *
 * The frame is `sandbox="allow-scripts"` with no `allow-same-origin`, so its
 * origin is opaque: it cannot read Studio's token or storage, call its API or
 * reach its WebSockets. On top of that its CSP allows no network at all. D3 and
 * the fonts are inlined by the host, which is why the frame needs no requests:
 * an opaque origin carries no cookies, so a request back to a Studio behind an
 * access proxy would fail anyway.
 */

/** No network, no forms, no base; inline scripts and styles, data: images and fonts. */
export const VISUAL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** Upper bound for text a widget can hand to the composer. */
export const SEND_PROMPT_MAX_CHARS = 2000;

export type VisualMeta = { kind: string | null; title: string | null };

/** Reads `kind=chart title="Spend by month"` from a fence's info string (after the language). */
export function parseVisualMeta(meta: string | null | undefined): VisualMeta {
  const result: VisualMeta = { kind: null, title: null };
  if (!meta) {
    return result;
  }
  const pattern = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  for (const match of meta.matchAll(pattern)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (match[1] === 'kind' && value) result.kind = value;
    if (match[1] === 'title' && value) result.title = value;
  }
  return result;
}

/** True when the code draws with D3, so the host inlines the library. */
export const usesD3 = (code: string): boolean => /\bd3\s*\./.test(code);

/** Keeps inlined source from closing the <script> element it sits in. */
const escapeScript = (source: string): string => source.replace(/<\/(script)/gi, '<\\/$1');

/**
 * Runs in the frame before the model's code. Messages to the host carry
 * `__hemiVisual: 1` and the frame id; the host also checks `event.source`.
 */
function bootstrapSource(frameId: string): string {
  return `(function () {
  var FRAME = ${JSON.stringify(frameId)};
  var MAX = ${SEND_PROMPT_MAX_CHARS};
  function post(message) { message.__hemiVisual = 1; message.frame = FRAME; parent.postMessage(message, '*'); }
  var last = -1;
  function measure() {
    var body = document.body;
    var height = Math.ceil(Math.max(document.documentElement.scrollHeight, body ? body.scrollHeight : 0));
    if (height !== last) { last = height; post({ type: 'size', height: height }); }
  }
  var observer = new ResizeObserver(measure);
  observer.observe(document.documentElement);
  document.addEventListener('DOMContentLoaded', function () { if (document.body) observer.observe(document.body); measure(); });
  addEventListener('load', measure);
  function sendPrompt(text) {
    if (!(navigator.userActivation && navigator.userActivation.isActive)) {
      console.warn('sendPrompt only works from a click or a key press');
      return false;
    }
    post({ type: 'prompt', text: String(text == null ? '' : text).slice(0, MAX) });
    return true;
  }
  window.sendPrompt = sendPrompt;
  window.hemi = { sendPrompt: sendPrompt };
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    event.preventDefault();
    post({ type: 'link', href: link.href });
  }, true);
  addEventListener('error', function (event) { post({ type: 'error', message: String(event.message || 'Script error') }); });
  var STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap',
    'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
    'letter-spacing', 'visibility', 'display'];
  function biggestSvg() {
    var best = null, area = 0;
    document.querySelectorAll('svg').forEach(function (svg) {
      if (svg.parentElement && svg.parentElement.closest('svg')) return;
      var box = svg.getBoundingClientRect();
      if (box.width * box.height > area) { area = box.width * box.height; best = svg; }
    });
    return best;
  }
  function serializeSvg(svg) {
    var box = svg.getBoundingClientRect();
    var copy = svg.cloneNode(true);
    var source = [svg].concat(Array.prototype.slice.call(svg.querySelectorAll('*')));
    var target = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll('*')));
    source.forEach(function (element, index) {
      var style = getComputedStyle(element);
      var css = STYLE_PROPS.map(function (prop) { return prop + ':' + style.getPropertyValue(prop); }).join(';');
      target[index].setAttribute('style', css);
    });
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', String(Math.round(box.width)));
    copy.setAttribute('height', String(Math.round(box.height)));
    if (!copy.getAttribute('viewBox')) copy.setAttribute('viewBox', '0 0 ' + Math.round(box.width) + ' ' + Math.round(box.height));
    return { svg: new XMLSerializer().serializeToString(copy), width: box.width, height: box.height };
  }
  function toPng(serialized, done) {
    var scale = 2;
    var image = new Image();
    image.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(serialized.width * scale);
      canvas.height = Math.round(serialized.height * scale);
      var context = canvas.getContext('2d');
      context.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      done(canvas.toDataURL('image/png'));
    };
    image.onerror = function () { done(null); };
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialized.svg);
  }
  addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data || {};
    if (data.__hemiVisualHost !== 1 || data.type !== 'export') return;
    var reply = function (payload) { post({ type: 'export', request: data.request, format: data.format, data: payload }); };
    var svg = biggestSvg();
    if (data.format === 'svg') { reply(svg ? serializeSvg(svg).svg : null); return; }
    if (data.format === 'png') {
      if (svg) { toPng(serializeSvg(svg), reply); return; }
      var canvas = document.querySelector('canvas');
      reply(canvas ? canvas.toDataURL('image/png') : null);
    }
  });
})();`;
}

const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body {
  padding: 12px 16px 16px;
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
  overflow-x: auto;
}`;

export type VisualDocumentInput = {
  code: string;
  frameId: string;
  /** `:root { … }` from buildVisualTheme. */
  themeCss: string;
  /** @font-face rules with data: URLs, or ''. */
  fontCss: string;
  /** D3's minified source when the code uses it, else null. */
  d3Source: string | null;
};

/** The frame's `srcdoc`. A fragment goes in <body>; a full document gets the head inserted after its own <head>. */
export function buildVisualDocument({ code, frameId, themeCss, fontCss, d3Source }: VisualDocumentInput): string {
  const head = [
    `<meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<style id="hemi-visual-theme">${fontCss}\n${themeCss}\n${BASE_CSS}</style>`,
    `<script>${escapeScript(bootstrapSource(frameId))}</script>`,
    d3Source ? `<script>${escapeScript(d3Source)}</script>` : '',
  ].join('');

  if (/<html[\s>]/i.test(code) || /<head[\s>]/i.test(code)) {
    const headOpen = code.match(/<head(\s[^>]*)?>/i);
    if (headOpen && headOpen.index !== undefined) {
      const at = headOpen.index + headOpen[0].length;
      return code.slice(0, at) + head + code.slice(at);
    }
    const htmlOpen = code.match(/<html(\s[^>]*)?>/i);
    if (htmlOpen && htmlOpen.index !== undefined) {
      const at = htmlOpen.index + htmlOpen[0].length;
      return `${code.slice(0, at)}<head>${head}</head>${code.slice(at)}`;
    }
  }
  return `<!doctype html><html><head>${head}</head><body>${code}</body></html>`;
}
