// Fork: regenerates the Hemisphere logo, favicon and PWA icons in public/ from
// one SVG template, so the glyph matches src/shared/ui/BrandMark.tsx.
//   node scripts/fork/generate-brand-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const BACKGROUND = 'hsl(221.2 83.2% 53.3%)'; // the app's primary colour

/** Full mark: rounded background plus the glyph, scaled to `size`. */
function markSvg(size, { rounded = true, background = BACKGROUND } = {}) {
  const radius = rounded ? Math.round(size * 0.25) : 0;
  const glyph = size * 0.62; // glyph box relative to the canvas
  const offset = (size - glyph) / 2;
  const scale = glyph / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${background}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"/>
    <path d="M3 12a9 9 0 0 1 18 0Z" fill="white" stroke="none"/>
    <path d="M3 12h18"/>
  </g>
</svg>
`;
}

async function writePng(svg, path, size) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path);
  console.log('wrote', path);
}

mkdirSync(join(root, 'icons'), { recursive: true });

// PWA icons: square canvas, the OS rounds the corners.
for (const size of [72, 96, 128, 144, 152, 192, 384, 512]) {
  const svg = markSvg(size, { rounded: false });
  writeFileSync(join(root, 'icons', `icon-${size}x${size}.svg`), svg);
  await writePng(svg, join(root, 'icons', `icon-${size}x${size}.png`), size);
}

// Logo (rounded) and favicon.
writeFileSync(join(root, 'logo.svg'), markSvg(32));
for (const size of [32, 64, 128, 256, 512]) {
  await writePng(markSvg(size), join(root, `logo-${size}.png`), size);
}
writeFileSync(join(root, 'favicon.svg'), markSvg(64));
await writePng(markSvg(64), join(root, 'favicon.png'), 64);
