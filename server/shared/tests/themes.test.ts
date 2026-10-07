import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getInstanceThemeId, themedManifest } from '@/shared/themes.js';

test('instance theme comes from CLOUDCLI_THEME and falls back to Hemilake', () => {
  assert.equal(getInstanceThemeId({}), 'hemilake');
  assert.equal(getInstanceThemeId({ CLOUDCLI_THEME: ' Orange ' }), 'orange');
  assert.equal(getInstanceThemeId({ CLOUDCLI_THEME: 'nope' }), 'hemilake');
});

test('the manifest takes the theme name, colour and icons', () => {
  const base = {
    name: 'Hemilake Studio',
    start_url: '/',
    icons: [{ src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' }],
  };
  const manifest = themedManifest(base, 'orange');
  assert.equal(manifest.name, 'Orange Studio');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.background_color, '#FFFFFF');
  assert.deepEqual(manifest.icons, [{ src: '/themes/orange/icon-192x192.png', sizes: '192x192', type: 'image/png' }]);
});
