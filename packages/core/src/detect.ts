import type { AutoDetectOptions, MaskBuffer, RawImage } from "./types.js";
import { createEmptyMask, dilateMask } from "./image-utils.js";

/**
 * Conservative watermark detection based on residual vs. local blur.
 * Avoids marking real image edges (which caused whole-image blur after inpaint).
 */
export function detectWatermarkMask(image: RawImage, options: AutoDetectOptions = {}): MaskBuffer {
  const sensitivity = clamp01(options.sensitivity ?? 0.5);
  const edgeOnly = options.edgeOnly ?? false;
  const edgeRatio = options.edgeRatio ?? 0.4;

  const { width, height, data } = image;
  const n = width * height;

  const rCh = new Float32Array(n);
  const gCh = new Float32Array(n);
  const bCh = new Float32Array(n);
  const lum = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    rCh[i] = data[o] / 255;
    gCh[i] = data[o + 1] / 255;
    bCh[i] = data[o + 2] / 255;
    lum[i] = 0.299 * rCh[i] + 0.587 * gCh[i] + 0.114 * bCh[i];
  }

  // Large blur ≈ background without thin watermark strokes.
  const blurRadius = Math.max(8, Math.round(Math.min(width, height) * 0.012));
  const blurLum = boxBlur(lum, width, height, blurRadius);
  const blurR = boxBlur(rCh, width, height, blurRadius);
  const blurG = boxBlur(gCh, width, height, blurRadius);
  const blurB = boxBlur(bCh, width, height, blurRadius);

  const zone = buildScanZone(width, height, edgeOnly, edgeRatio);
  const scores = new Float32Array(n);

  // Higher sensitivity → lower residual threshold, slightly higher coverage.
  const resLo = 0.018 - sensitivity * 0.008;
  const resHi = 0.14 + sensitivity * 0.06;
  const maxCoverage = 0.025 + sensitivity * 0.055; // ~2.5% … 8%

  for (let i = 0; i < n; i++) {
    if (!zone[i]) continue;

    const dL = lum[i] - blurLum[i];
    const dR = rCh[i] - blurR[i];
    const dG = gCh[i] - blurG[i];
    const dB = bCh[i] - blurB[i];
    const res = Math.sqrt(dR * dR + dG * dG + dB * dB);

    // Watermark strokes are usually a mild lift/tint over background, not hard object edges.
    if (res < resLo || res > resHi) continue;

    // Prefer pale / tinted overlays (white, gray, pink, light blue logos).
    const paleLift = dL > 0.008 && dL < 0.18;
    const tinted =
      Math.abs(dR - dG) < 0.08 &&
      Math.abs(dG - dB) < 0.08 &&
      res > resLo;

    // Soft pink/red brand watermarks (common tiled diagonal text).
    const pinkish = dR > dG + 0.004 && dR > dB + 0.004 && dL > 0 && res < resHi;

    // Soft blue brand watermarks.
    const blueish = dB > dR + 0.004 && dB > dG + 0.002 && res < resHi;

    if (!(paleLift || tinted || pinkish || blueish)) continue;

    // Suppress strong photographic edges: local contrast of blur should stay moderate.
    const localBlurVar = sampleVar(blurLum, width, height, i % width, (i / width) | 0, 3);
    if (localBlurVar > 0.012 + sensitivity * 0.01) continue;

    // Score: mid residual + pale/tint preference.
    let score = res;
    if (paleLift) score += 0.02;
    if (pinkish || blueish) score += 0.015;
    scores[i] = score;
  }

  const mask = thresholdByCoverage(scores, width, height, maxCoverage);
  const pruned = pruneNoise(mask, width, height, sensitivity);
  const dilateRadius = sensitivity > 0.75 ? 2 : 1;
  return dilateMask(pruned, width, height, dilateRadius);
}

/** Keep only the highest-scoring pixels up to maxCoverage of the image. */
function thresholdByCoverage(
  scores: Float32Array,
  width: number,
  height: number,
  maxCoverage: number
): MaskBuffer {
  const n = width * height;
  const indexed: { i: number; s: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (scores[i] > 0) indexed.push({ i, s: scores[i] });
  }

  const mask = createEmptyMask(width, height);
  if (indexed.length === 0) return mask;

  indexed.sort((a, b) => b.s - a.s);
  const budget = Math.max(32, Math.floor(n * maxCoverage));
  const keep = Math.min(budget, indexed.length);
  for (let k = 0; k < keep; k++) {
    mask[indexed[k].i] = 255;
  }
  return mask;
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const r = Math.max(1, radius);

  // Horizontal
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const row = y * width;
    for (let x = -r; x <= r; x++) {
      sum += src[row + clamp(x, 0, width - 1)];
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / (r * 2 + 1);
      const remove = src[row + clamp(x - r, 0, width - 1)];
      const add = src[row + clamp(x + r + 1, 0, width - 1)];
      sum += add - remove;
    }
  }

  // Vertical
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) {
      sum += tmp[clamp(y, 0, height - 1) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / (r * 2 + 1);
      const remove = tmp[clamp(y - r, 0, height - 1) * width + x];
      const add = tmp[clamp(y + r + 1, 0, height - 1) * width + x];
      sum += add - remove;
    }
  }

  return out;
}

function sampleVar(
  field: Float32Array,
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
      const v = field[y * width + x];
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

function buildScanZone(width: number, height: number, edgeOnly: boolean, edgeRatio: number): Uint8Array {
  const zone = new Uint8Array(width * height);
  if (!edgeOnly) {
    zone.fill(1);
    return zone;
  }

  const band = Math.max(24, Math.floor(Math.min(width, height) * edgeRatio));
  const bottomBand = Math.max(band, Math.floor(height * 0.3));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < band || y < band || x >= width - band || y >= height - band || y >= height - bottomBand) {
        zone[y * width + x] = 1;
      }
    }
  }
  return zone;
}

function pruneNoise(mask: MaskBuffer, width: number, height: number, sensitivity: number): MaskBuffer {
  const minArea = Math.max(8, Math.floor((1.1 - sensitivity) * 28));
  const maxArea = Math.floor(width * height * 0.12);
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

    // Drop speckles and giant blobs (usually false positives on UI panels).
    if (component.length >= minArea && component.length <= maxArea) {
      for (const idx of component) out[idx] = 255;
    }
  }

  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
