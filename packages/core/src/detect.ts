import type { AutoDetectOptions, MaskBuffer, RawImage } from "./types.js";
import { createEmptyMask, dilateMask } from "./image-utils.js";

/**
 * Heuristic detection for semi-transparent text/logo watermarks.
 * Works best on light gray/white overlays in corners or edges.
 */
export function detectWatermarkMask(image: RawImage, options: AutoDetectOptions = {}): MaskBuffer {
  const sensitivity = options.sensitivity ?? 0.5;
  const edgeOnly = options.edgeOnly ?? true;
  const edgeRatio = options.edgeRatio ?? 0.25;

  const { width, height, data } = image;
  const mask = createEmptyMask(width, height);
  const edgeW = Math.floor(Math.min(width, height) * edgeRatio);

  const lumThreshold = 180 + (1 - sensitivity) * 40;
  const satThreshold = 0.08 + (1 - sensitivity) * 0.12;
  const diffThreshold = 12 + (1 - sensitivity) * 20;

  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const inEdge = (x: number, y: number): boolean => {
    if (!edgeOnly) return true;
    return x < edgeW || y < edgeW || x >= width - edgeW || y >= height - edgeW;
  };

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!inEdge(x, y)) continue;

      const idx = y * width + x;
      const o = idx * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const l = lum[idx];

      const localContrast = localLuminanceVariance(lum, width, height, x, y, 2);
      const isLightOverlay = l > lumThreshold / 255 && sat < satThreshold;
      const isFlatWatermark =
        localContrast < diffThreshold / 255 && l > (150 + (1 - sensitivity) * 40) / 255;

      if (isLightOverlay || isFlatWatermark) {
        mask[idx] = 255;
      }
    }
  }

  const dilateRadius = sensitivity > 0.6 ? 2 : 1;
  return dilateMask(mask, width, height, dilateRadius);
}

function localLuminanceVariance(
  lum: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number
): number {
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const v = lum[y * width + x];
      sum += v;
      sumSq += v * v;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}
