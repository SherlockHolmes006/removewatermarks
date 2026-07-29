import type { AutoDetectOptions, MaskBuffer, RawImage } from "./types.js";
import { createEmptyMask, dilateMask } from "./image-utils.js";

/**
 * Multi-strategy watermark detection:
 * 1) light / gray translucent overlays
 * 2) soft text-like edges (logos, colored captions)
 * 3) mild color-cast overlays
 *
 * Prefer typical watermark zones (edges + bottom band), then fall back to full image.
 */
export function detectWatermarkMask(image: RawImage, options: AutoDetectOptions = {}): MaskBuffer {
  const sensitivity = clamp01(options.sensitivity ?? 0.55);
  const edgeOnly = options.edgeOnly ?? true;
  const edgeRatio = options.edgeRatio ?? 0.35;

  const { width, height } = image;
  const zoneMask = buildScanZone(width, height, edgeOnly, edgeRatio);

  let mask = detectInZone(image, zoneMask, sensitivity);

  // If nothing found on edges, scan the whole image once (common for center logos).
  if (edgeOnly && countMask(mask) < Math.max(64, (width * height) * 0.00005)) {
    const fullZone = new Uint8Array(width * height).fill(1);
    mask = detectInZone(image, fullZone, Math.min(1, sensitivity + 0.12));
  }

  const dilateRadius = sensitivity > 0.7 ? 3 : sensitivity > 0.45 ? 2 : 1;
  return dilateMask(mask, width, height, dilateRadius);
}

function detectInZone(image: RawImage, zone: Uint8Array, sensitivity: number): MaskBuffer {
  const { width, height, data } = image;
  const mask = createEmptyMask(width, height);

  const lum = new Float32Array(width * height);
  const sat = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    sat[i] = max === 0 ? 0 : (max - min) / max;
  }

  // Soft edge map (Sobel magnitude) — logos/text leave moderate edges.
  const edges = sobelMagnitude(lum, width, height);

  const lightLumMin = 0.55 - sensitivity * 0.2;
  const lightSatMax = 0.22 + (1 - sensitivity) * 0.1;
  const edgeLo = 0.02 + (1 - sensitivity) * 0.02;
  const edgeHi = 0.35 + sensitivity * 0.25;
  const castSatMin = 0.08;
  const castSatMax = 0.55;
  const flatVarMax = 0.004 + (1 - sensitivity) * 0.006;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (!zone[idx]) continue;

      const l = lum[idx];
      const s = sat[idx];
      const e = edges[idx];
      const localVar = localVariance(lum, width, height, x, y, 2);

      // 1) Pale / white translucent stamp
      const isLightOverlay = l > lightLumMin && s < lightSatMax && localVar < flatVarMax * 2;

      // 2) Text-like soft edges (works for colored logos like blue captions)
      const isTextStroke =
        e > edgeLo &&
        e < edgeHi &&
        localVar < 0.02 + sensitivity * 0.02 &&
        l > 0.12 &&
        l < 0.95;

      // 3) Mild color cast (semi-transparent brand color)
      const isColorCast =
        s > castSatMin &&
        s < castSatMax &&
        e > edgeLo * 0.6 &&
        e < edgeHi &&
        localVar < 0.015 + sensitivity * 0.01;

      // 4) Flat pale plate often used behind logos
      const isFlatPlate = localVar < flatVarMax && l > 0.45 + (1 - sensitivity) * 0.15 && s < 0.25;

      if (isLightOverlay || isTextStroke || isColorCast || isFlatPlate) {
        mask[idx] = 255;
      }
    }
  }

  return pruneNoise(mask, width, height, sensitivity);
}

function buildScanZone(width: number, height: number, edgeOnly: boolean, edgeRatio: number): Uint8Array {
  const zone = new Uint8Array(width * height);
  if (!edgeOnly) {
    zone.fill(1);
    return zone;
  }

  const band = Math.max(24, Math.floor(Math.min(width, height) * edgeRatio));
  const bottomBand = Math.max(band, Math.floor(height * 0.28));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onEdge = x < band || y < band || x >= width - band || y >= height - band;
      const onBottom = y >= height - bottomBand;
      if (onEdge || onBottom) zone[y * width + x] = 1;
    }
  }
  return zone;
}

function sobelMagnitude(lum: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -lum[i - width - 1] -
        2 * lum[i - 1] -
        lum[i + width - 1] +
        lum[i - width + 1] +
        2 * lum[i + 1] +
        lum[i + width + 1];
      const gy =
        -lum[i - width - 1] -
        2 * lum[i - width] -
        lum[i - width + 1] +
        lum[i + width - 1] +
        2 * lum[i + width] +
        lum[i + width + 1];
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

function localVariance(
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

/** Drop tiny speckles; keep stroke-like / blob regions. */
function pruneNoise(mask: MaskBuffer, width: number, height: number, sensitivity: number): MaskBuffer {
  const minArea = Math.max(12, Math.floor((1.2 - sensitivity) * 40));
  const visited = new Uint8Array(mask.length);
  const out = createEmptyMask(width, height);
  const stack: number[] = [];

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 || visited[i]) continue;

    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    const component: number[] = [];

    while (stack.length) {
      const cur = stack.pop()!;
      component.push(cur);
      const x = cur % width;
      const y = (cur / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (visited[ni] || mask[ni] === 0) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }

    if (component.length >= minArea) {
      for (const idx of component) out[idx] = 255;
    }
  }

  return out;
}

function countMask(mask: MaskBuffer): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
