// Fork: regenerates the Hemilake Studio logo, favicon and PWA icons in public/ from
// one SVG template, so the glyph matches src/shared/ui/BrandMark.tsx.
//   node scripts/fork/generate-brand-icons.mjs
// Logo and favicon sit on a light (paper) tile; PWA and home-screen icons on an ink tile.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const PAPER = '#F6F3EE';
const INK = '#1F1D1A';
const HAIRLINE = '#E4DED4';
const COPPER = '#B5673B';
const COPPER_ON_INK = '#D8895C';

/** The Hemilake symbol on its 64-unit grid: copper right half, open left arc. */
function symbol({ fill, stroke }) {
  return `<path d="M32 4 A28 28 0 0 1 32 60 Z" fill="${fill}"/><path d="M32 4 A28 28 0 0 0 32 60" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>`;
}

/** Light tile: logo.svg and logo-*.png. */
function lightTileSvg(size) {
  const scale = (size * 0.625) / 64;
  const offset = (size - 64 * scale) / 2;
  const radius = (size * 7) / 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Hemilake Studio"><rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${radius}" fill="${PAPER}" stroke="${HAIRLINE}" stroke-width="1"/><g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale.toFixed(4)})">${symbol({ fill: COPPER, stroke: INK })}</g></svg>
`;
}

/** Ink tile: PWA and home-screen icons, Electron app icon. */
function inkTileSvg(size) {
  const scale = (size * 0.625) / 64;
  const offset = (size - 64 * scale) / 2;
  const radius = size * 0.225;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Hemilake Studio"><rect width="${size}" height="${size}" rx="${radius.toFixed(2)}" fill="${INK}"/><g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale.toFixed(4)})">${symbol({ fill: COPPER_ON_INK, stroke: PAPER })}</g></svg>
`;
}

/** favicon.svg: the bare symbol, no tile (favicon.png keeps the light tile). */
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 64 64" role="img" aria-label="Hemilake Studio">${symbol({ fill: COPPER, stroke: INK })}</svg>
`;

async function writePng(svg, path, size) {
  await sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png().toFile(path);
  console.log('wrote', path);
}

mkdirSync(join(root, 'icons'), { recursive: true });

for (const size of [72, 96, 128, 144, 152, 192, 384, 512]) {
  const svg = inkTileSvg(size);
  writeFileSync(join(root, 'icons', `icon-${size}x${size}.svg`), svg);
  await writePng(svg, join(root, 'icons', `icon-${size}x${size}.png`), size);
}
writeFileSync(join(root, 'icons', 'icon-template.svg'), inkTileSvg(512));

writeFileSync(join(root, 'logo.svg'), lightTileSvg(32));
for (const size of [32, 64, 128, 256, 512]) {
  await writePng(lightTileSvg(size), join(root, `logo-${size}.png`), size);
}
writeFileSync(join(root, 'favicon.svg'), faviconSvg);
await writePng(lightTileSvg(64), join(root, 'favicon.png'), 64);

// Electron app icon (macOS uses the PNG; electron/scripts/generate-macos-icon.js builds the .icns).
await writePng(inkTileSvg(1024), join(root, '..', 'electron', 'assets', 'logo-macos.png'), 1024);

// Other themes (src/shared/theme/registry.tsx): favicon PNG and PWA icons from the
// theme's own logo file in public/themes/<id>/, rendered as delivered, never redrawn.
// Orange uses its small logo (square and bar), as its brand rules ask below 50 px.
// Classic blue reuses Hemilake's icons.
const THEME_ICON_SOURCES = {
  orange: 'logo-small.svg',
};
for (const [themeId, source] of Object.entries(THEME_ICON_SOURCES)) {
  const dir = join(root, 'themes', themeId);
  const svg = readFileSync(join(dir, source));
  await writePng(svg, join(dir, 'favicon.png'), 64);
  for (const size of [72, 96, 128, 144, 152, 192, 384, 512]) {
    await writePng(svg, join(dir, `icon-${size}x${size}.png`), size);
  }
}
