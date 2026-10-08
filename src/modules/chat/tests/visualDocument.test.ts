import assert from 'node:assert/strict';

import { test } from 'vitest';

import { buildVisualDocument, parseVisualMeta, usesD3, VISUAL_CSP } from '@/modules/chat/visuals/visualDocument';
import { buildVisualTheme, CHART_PALETTES } from '@/modules/chat/visuals/visualTheme';

const BASE = { frameId: 'vtest', themeCss: ':root { --color-text: hsl(0 0% 0%); }', fontCss: '' };

test('parseVisualMeta reads kind and title, quoted or not', () => {
  assert.deepEqual(parseVisualMeta('kind=chart title="Spend by month"'), { kind: 'chart', title: 'Spend by month' });
  assert.deepEqual(parseVisualMeta("title='Año fiscal' kind=kpi"), { kind: 'kpi', title: 'Año fiscal' });
  assert.deepEqual(parseVisualMeta(''), { kind: null, title: null });
  assert.deepEqual(parseVisualMeta(null), { kind: null, title: null });
  assert.deepEqual(parseVisualMeta('just words'), { kind: null, title: null });
});

test('usesD3 only matches calls into d3', () => {
  assert.equal(usesD3('const svg = d3.select("#c")'), true);
  assert.equal(usesD3('<svg><text>d3 is a library</text></svg>'), false);
});

test('a fragment goes into <body>, after a head that starts with the CSP', () => {
  const doc = buildVisualDocument({ ...BASE, code: '<div id="chart">hi</div>', d3Source: null });
  const head = doc.slice(doc.indexOf('<head>'), doc.indexOf('</head>'));
  assert.ok(head.indexOf('Content-Security-Policy') < head.indexOf('<script>'), 'CSP before any script');
  assert.ok(head.includes(VISUAL_CSP));
  assert.ok(VISUAL_CSP.includes("connect-src 'none'"));
  assert.ok(VISUAL_CSP.includes("default-src 'none'"));
  assert.ok(doc.includes('<body><div id="chart">hi</div></body>'));
  assert.ok(doc.includes('window.sendPrompt'));
  assert.ok(!doc.includes('d3-inline-marker'));
});

test('D3 is inlined only when given, and a </script> inside it cannot close the tag', () => {
  const doc = buildVisualDocument({ ...BASE, code: 'x', d3Source: 'var d3 = {}; /* d3-inline-marker </script> */' });
  assert.ok(doc.includes('d3-inline-marker <\\/script>'));
  assert.equal((doc.match(/<\/script>/g) ?? []).length, 2);
});

test('a full document keeps its own markup and gets the head inserted right after <head>', () => {
  const page = '<!doctype html><html lang="es"><head><title>Page</title><script>var a = 1;</script></head><body>ok</body></html>';
  const doc = buildVisualDocument({ ...BASE, code: page, d3Source: null });
  assert.ok(doc.startsWith('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'));
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('var a = 1;'));
  assert.ok(doc.endsWith('<body>ok</body></html>'));
});

test('a document with <html> but no <head> gets one', () => {
  const doc = buildVisualDocument({ ...BASE, code: '<html><body>ok</body></html>', d3Source: null });
  assert.ok(doc.startsWith('<html><head><meta charset="utf-8">'));
});

test('the theme resolves aliases to colours and picks the palette for the theme and mode', () => {
  const tokens: Record<string, string> = { foreground: '36 9% 11%', card: '0 0% 100%', border: '37.5 23% 86%', 'hemi-copper': '22 51% 47%', 'font-sans': '"IBM Plex Sans", sans-serif' };
  const light = buildVisualTheme('hemilake', false, (name) => tokens[name] ?? '');
  assert.ok(light.css.includes('--color-text: hsl(36 9% 11%);'));
  assert.ok(light.css.includes('--color-accent: hsl(22 51% 47%);'));
  assert.ok(light.css.includes('--color-grid: hsl(37.5 23% 86% / 0.55);'));
  assert.ok(light.css.includes('--foreground: 36 9% 11%;'));
  assert.ok(light.css.includes(`--chart-2: ${CHART_PALETTES.hemilake.light[1]};`));
  assert.ok(light.css.includes('color-scheme: light;'));
  const dark = buildVisualTheme('orange', true, (name) => tokens[name] ?? '');
  assert.ok(dark.css.includes(`--chart-1: ${CHART_PALETTES.orange.dark[0]};`));
  assert.ok(dark.css.includes('color-scheme: dark;'));
  assert.ok(!dark.css.includes('--color-ok:'), 'a token the theme lacks is left out');
});
