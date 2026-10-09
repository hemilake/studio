# Inline visuals

Studio draws charts, diagrams, KPI rows and small interactive widgets inside the conversation, like Visualize in Claude Desktop. The model writes HTML or SVG in a ```` ```visual ```` fenced block; Studio renders it in a sandboxed frame with the active theme. This file is the contract between Studio and the `visualize` skill in the Hemilake plugin.

## The fence

````markdown
```visual kind=chart title="Spend by month"
<div id="chart"></div>
<script>
  const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const svg = d3.select('#chart').append('svg')…
</script>
```
````

- Language `visual`. The info string carries `kind` (`chart`, `diagram`, `kpi`, `interactive`, `mockup`) and `title`; the title labels the block and names its downloads.
- The body is an HTML fragment or an `<svg>`. A full document (`<html>`, `<head>`) also works: Studio inserts its head right after the document's own `<head>`.
- When the code contains three backticks, the fence uses four.
- ```` ```html ```` blocks stay code, with a Preview button that opens them full screen in the same kind of frame.

## What the frame provides

- **D3 7.9.0** as `window.d3`, inlined only when the code calls `d3.`.
- **CSS variables** on `:root`, already colours (no `hsl()` wrapper):
  - `--color-bg`, `--color-surface` (the frame's background), `--color-text`, `--color-muted`, `--color-subtle`, `--color-border`, `--color-grid`
  - `--color-accent`, `--color-accent-text`, `--color-accent-tint` (copper in Hemilake, orange in Orange), `--color-ok`, `--color-ok-tint`, `--color-danger`
  - `--chart-1` … `--chart-8`: series colours in order, per theme and mode. Each row is the bundled `dataviz` skill's validated palette with slot 2 swapped for the theme's accent, and passes that skill's `validate_palette.py`.
  - `--font-sans`, `--font-mono`, `--radius`, and Studio's raw tokens (`--foreground`, `--hemi-copper`…) as bare HSL channels.
- **IBM Plex Sans and Mono** (Latin subset) as data: fonts. Orange uses Helvetica Neue from the system.
- `body` with `padding: 12px 16px 16px`, 14 px type, tabular numbers, `background: var(--color-surface)`.
- `sendPrompt(text)` (also `hemi.sendPrompt`): posts a follow-up message in the owner's name. It only works from a click or key press (`navigator.userActivation`), up to 2,000 characters. Outside bypass mode it sends; in bypass it fills the composer and the owner presses Enter.
- Links open in a new tab through Studio, `http(s)` only.

The frame is about 720 px wide in the chat, 320–430 px on a phone, and full width in full screen. It grows (and shrinks) to its content's height, up to 1,600 px inline; heights are remembered per visual and window width in `localStorage` (`hemi-visual-heights`), so a frame mounts at its size instead of growing after it draws. A theme or dark-mode change rebuilds the frame, so a chart that reads colours at runtime redraws with the new ones (widget state resets).

## Security

Studio keeps its JWT in `localStorage`, and that token reaches a shell (`/shell`), agent turns (`/ws`, bypass included) and file writes. Any script in Studio's origin can therefore run commands on the owner's machine. A visual never runs there:

- `sandbox="allow-scripts"` with no `allow-same-origin`, `allow-popups`, `allow-top-navigation`, `allow-forms` or `allow-modals`. The frame's origin is opaque: no `localStorage`, cookies, `parent.document` or same-origin requests.
- A CSP meta at the top of the frame's head: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'`. No request leaves the frame, which is also why D3 and the fonts are inlined: an opaque origin sends no cookies, so a request back to a Studio behind an access proxy would fail.
- Studio's pages send `frame-src 'self' blob:` (with `frame-ancestors`, in `server/modules/embed/embed.routes.ts`). Without it the frame could navigate itself to another site and carry data in the URL.
- The host accepts a message only when `event.source` is that frame's window and the message carries the frame's id. The embed bridge only listens to the console (`window.parent` and its origin), so a widget cannot impersonate the console.
- `sendPrompt` strips tags that mean something to Studio or Claude Code (`<adversarial_review>`, `<system-reminder>`…).

Checked in Chrome on 8 Oct 2026 with a hostile widget in a frame built this way on Studio's origin: `localStorage`, `document.cookie`, `parent.document` and `top.location` threw `SecurityError`; `fetch` to Studio and to another site failed; an `<img>` to another site was blocked by the CSP before any request; `window.open` returned null; `location.href = 'https://…'` ended on Chrome's error page with no request sent.

What stays open: WebRTC is outside `connect-src` and no CSP directive covers it, so a widget could still send what it displays through a STUN request. A widget only holds what the model put in it, and a model under prompt injection already has Bash and the network, so this adds no new reach. A widget can also draw a fake form; the frame's border and the toolbar mark it as content of the conversation.

## How the model knows

`server/shared/studio-visuals-prompt.ts` is appended to Claude Code's system prompt (`systemPrompt.append`) in every Studio session: it says this UI draws ```` ```visual ```` blocks and gives the contract above in short. It is constant, because the live Claude process is reused only while the options stay the same. The design rules live in the `visualize` skill in the Hemilake plugin. The Hemilake Agent, Telegram, WhatsApp and a terminal do not get the prompt, so the model does not draw there.

## Toolbar

On hover (always visible on touch screens): Ask to change (fills the composer with `Update the "<title>" visual: `), Show code, Copy code, Download (HTML: the frame's document, self-contained; SVG: the biggest `<svg>` with computed styles inlined; PNG: that SVG rasterised at 2×, or the first `<canvas>`), Save to workspace (`visuals/<slug>.html`), Full screen.

## Streaming

A visual in the half of a reply still being written shows a "Drawing <title> · N lines" card. The frame mounts when the block settles or the reply ends, so the browser never runs half a script.

## Files

`src/modules/chat/visuals/` (`VisualBlock.tsx`, `visualDocument.ts`, `visualTheme.ts`, `visualAssets.ts`, `VisualContext.ts`, `fonts/` with `OFL.txt`, `vendor/` with D3 and its licence), `src/modules/chat/transcript/{Markdown,StreamingMarkdown}.tsx`, `src/modules/chat/ChatInterface.tsx`, `src/modules/chat/hooks/useChatComposerState.ts` (`fillComposer`), `src/shared/context/ThemeContext.tsx` (`useIsDarkMode`), `server/shared/studio-visuals-prompt.ts`, `server/modules/providers/list/claude/claude-runtime.provider.js`, `server/modules/embed/embed.routes.ts`.
