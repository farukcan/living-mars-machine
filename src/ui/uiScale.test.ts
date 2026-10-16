import { describe, expect, it } from 'vitest';
import { UI_SCALE_MAX, UI_SCALE_MIN, hudLayerStyle, uiScaleFor } from './uiScale.ts';

describe('uiScaleFor', () => {
  it('is 1 at the reference resolution', () => {
    expect(uiScaleFor(1366, 768)).toBe(1);
  });

  it('follows the tighter axis', () => {
    // 1216×684 is a 16:9 portal iframe: both axes give the same ratio.
    expect(uiScaleFor(1216, 684)).toBeCloseTo(1216 / 1366, 5);
    // An ultrawide window is height-bound.
    expect(uiScaleFor(2560, 768)).toBe(1);
    // A tall, narrow window is width-bound.
    expect(uiScaleFor(1200, 1000)).toBeCloseTo(1200 / 1366, 5);
  });

  it('never drops below the legibility floor in the small portal iframes', () => {
    expect(uiScaleFor(907, 510)).toBe(UI_SCALE_MIN);
    expect(uiScaleFor(821, 462)).toBe(UI_SCALE_MIN);
  });

  it('grows with a fullscreen window up to the ceiling', () => {
    expect(uiScaleFor(1920, 1080)).toBe(UI_SCALE_MAX);
    expect(uiScaleFor(3840, 2160)).toBe(UI_SCALE_MAX);
  });
});

describe('hudLayerStyle', () => {
  it('lays the layer out at viewport ÷ scale so the transform fills it exactly', () => {
    expect(hudLayerStyle(0.8)).toEqual({
      width: '125%',
      height: '125%',
      transform: 'scale(0.8)',
    });
  });
});
