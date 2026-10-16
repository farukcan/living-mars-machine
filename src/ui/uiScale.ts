import { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';

/**
 * HUD scaling, the way a game engine's canvas scaler works.
 *
 * The HUD is laid out at one reference resolution and scaled as a single piece, so every
 * window shows the same composition. Without it a 907×510 portal iframe crammed the
 * full-size panels into a third of the space and they ran into each other, while a 1080p
 * fullscreen left them small in the corners.
 */

/** The size the HUD is designed at: everything fits here with room to spare. */
export const UI_REFERENCE_WIDTH = 1366;
export const UI_REFERENCE_HEIGHT = 768;

/**
 * Floor for small windows. Below it the 10px labels drop under 8px and stop being legible
 * at devicePixelRatio 1; past this point the layout's own wrapping takes over instead.
 */
export const UI_SCALE_MIN = 0.8;

/** Ceiling for large windows, past which the panels crowd the scene instead of framing it. */
export const UI_SCALE_MAX = 1.4;

/** The HUD scale for a viewport: the tighter axis against the reference, then clamped. */
export function uiScaleFor(width: number, height: number): number {
  const fit = Math.min(width / UI_REFERENCE_WIDTH, height / UI_REFERENCE_HEIGHT);
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, fit));
}

/**
 * Style for the layer that holds the HUD.
 *
 * The layer is laid out at viewport ÷ scale and then scaled back down (or up) to fill the
 * viewport exactly. A transform rather than CSS `zoom` because it behaves the same in every
 * browser and keeps pointer hit-testing exact.
 */
export function hudLayerStyle(scale: number): CSSProperties {
  return {
    width: `${100 / scale}%`,
    height: `${100 / scale}%`,
    transform: `scale(${scale})`,
  };
}

function subscribeToResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

function currentUiScale(): number {
  return uiScaleFor(window.innerWidth, window.innerHeight);
}

/** The HUD scale for the current window, updated on resize. */
export function useUiScale(): number {
  return useSyncExternalStore(subscribeToResize, currentUiScale);
}
