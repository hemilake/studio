/**
 * Fork (inline visuals): D3 and the IBM Plex faces, inlined into each frame.
 * D3 7.9.0 is vendored in vendor/ (ISC, vendor/D3-LICENSE.txt): the package's
 * exports map does not expose its UMD build, and pinning it keeps every frame
 * on the version the `visualize` skill is written for.
 *
 * Loaded on demand as their own chunk the first time a visual renders, so the
 * main bundle does not grow. The fonts are the Latin subsets (Spanish accents
 * included), licensed under the SIL OFL (fonts/OFL.txt).
 */

export type VisualAssets = {
  d3Source: string;
  /** @font-face rules with data: URLs. */
  fontCss: string;
};

let assetsPromise: Promise<VisualAssets> | null = null;

export function loadVisualAssets(): Promise<VisualAssets> {
  assetsPromise ??= Promise.all([
    import('@/modules/chat/visuals/vendor/d3-7.9.0.min.js?raw'),
    import('@/modules/chat/visuals/fonts/ibm-plex-sans-latin-400-normal.woff2?inline'),
    import('@/modules/chat/visuals/fonts/ibm-plex-sans-latin-600-normal.woff2?inline'),
    import('@/modules/chat/visuals/fonts/ibm-plex-mono-latin-400-normal.woff2?inline'),
  ]).then(([d3, sans400, sans600, mono400]) => ({
    d3Source: d3.default,
    fontCss: [
      `@font-face{font-family:"IBM Plex Sans";font-weight:400;font-display:block;src:url(${sans400.default}) format("woff2")}`,
      `@font-face{font-family:"IBM Plex Sans";font-weight:500 700;font-display:block;src:url(${sans600.default}) format("woff2")}`,
      `@font-face{font-family:"IBM Plex Mono";font-weight:400 500;font-display:block;src:url(${mono400.default}) format("woff2")}`,
    ].join('\n'),
  })).catch((error) => {
    assetsPromise = null;
    throw error;
  });
  return assetsPromise;
}
