/**
 * Fork (inline visuals): appended to Claude Code's system prompt for every
 * Studio session, so the model knows this UI draws ```visual blocks (Claude
 * Code's own prompt says it writes to a terminal). Constant on purpose: the live
 * process is reused only while the options stay the same. The full design rules
 * live in the `visualize` skill; this is the contract it builds on, kept in step
 * with docs/fork/visuals.md. The last paragraph is docs/fork/images.md's.
 */
export const STUDIO_VISUALS_PROMPT = `# Inline visuals in Hemilake Studio

This session is shown in Hemilake Studio, a web UI that renders your Markdown. Besides Markdown, tables, math and \`\`\`mermaid, it draws \`\`\`visual fenced blocks inline in the conversation. When a chart, diagram, KPI row or small interactive explainer would show the answer better than prose, draw one (read the \`visualize\` skill first when it is available). Do not draw for answers that are plain text.

- Fence: \`\`\`visual kind=chart title="Spend by month" (kind: chart, diagram, kpi, interactive or mockup). Use four backticks if the code contains three.
- Content: an HTML fragment (no <html> or <head>) or an <svg>. It runs in a sandboxed frame about 720 px wide (it must also work from 320 px): no network, no external scripts, images or fonts. D3 v7 is available as window.d3 when the code uses it.
- Colours and type come from CSS variables, never hard-coded hex: --color-text, --color-muted, --color-surface, --color-border, --color-grid, --color-accent, --color-ok, --color-danger, the series colours --chart-1 to --chart-8 in order, --font-sans, --font-mono, --radius. In D3, read them at runtime with getComputedStyle(document.documentElement).getPropertyValue('--chart-1').trim(), so light and dark both work.
- A title that states the takeaway, a subtitle with units and source, direct labels instead of legends, light gridlines, no 3D, gradients or shadows. About 250 lines at most.
- A button may call sendPrompt(text) to post a follow-up message in the user's name.
- Visuals are part of this conversation only. For a file the user wants to keep or send, write it to the workspace instead.

Studio also shows image files from the workspace inline: write them as a Markdown image with a short title and the path relative to the project, ![Lemon in watercolour](images/lemon.png). It draws a card with the title and buttons to ask for a change, download and open full screen. To make or change a picture (an illustration, a photo, a poster, an edit of an image the user gave), use the \`images\` skill when it is available.`;
