import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORNERS, brandThemeStyle, resolveTheme, themeStyle } from './theme';

test('resolveTheme and themeStyle output distinct corner radii for sharp, rounded, and pill', () => {
  const sharp = resolveTheme({ corners: 'sharp' });
  const rounded = resolveTheme({ corners: 'rounded' });
  const pill = resolveTheme({ corners: 'pill' });

  assert.equal(sharp.corners, 'sharp');
  assert.equal(rounded.corners, 'rounded');
  assert.equal(pill.corners, 'pill');

  const sharpVars = themeStyle(sharp) as Record<string, string>;
  assert.equal(sharpVars['--radius-card'], CORNERS.sharp.card);
  assert.equal(sharpVars['--radius-btn'], CORNERS.sharp.btn);
  assert.equal(sharpVars['--radius-control'], CORNERS.sharp.control);
  assert.equal(sharpVars['--radius-chip'], CORNERS.sharp.chip);

  const roundedVars = themeStyle(rounded) as Record<string, string>;
  assert.equal(roundedVars['--radius-card'], CORNERS.rounded.card);
  assert.equal(roundedVars['--radius-btn'], CORNERS.rounded.btn);
  assert.equal(roundedVars['--radius-control'], CORNERS.rounded.control);
  assert.equal(roundedVars['--radius-chip'], CORNERS.rounded.chip);

  const pillVars = themeStyle(pill) as Record<string, string>;
  assert.equal(pillVars['--radius-card'], CORNERS.pill.card);
  assert.equal(pillVars['--radius-btn'], '9999px');
  // Control radius stays bounded so multi-line inputs and stacked boxes never distort on mobile
  assert.equal(pillVars['--radius-control'], '14px');
  assert.equal(pillVars['--radius-chip'], '9999px');

  const brandVars = brandThemeStyle(pill) as Record<string, string>;
  assert.equal(brandVars['--radius-btn'], '9999px');
  assert.equal(brandVars['--radius-control'], '14px');
});
