import type { AutoDetectOptions, MaskBuffer, RawImage } from "./types.js";
import { closeMask, createEmptyMask, dilateMask, fillMaskHoles } from "./image-utils.js";

/**
 * Detect semi-transparent watermarks via residual vs. local blur.
 * Then close + fill holes so letter interiors are solid (not hollow outlines).
 * Opaque content text edges are rejected so titles don't get falsely outlined.
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

  const blurRadius = Math.max(6, Math.round(Math.min(width, height) * 0.01));
  const blurLum = boxBlur(lum, width, height, blurRadius);
  const blurR = boxBlur(rCh, width, height, blurRadius);
  const blurG = boxBlur(gCh, width, height, blurRadius);
  const blurB = boxBlur(bCh, width, height, blurRadius);

  const residual = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dR = rCh[i] - blurR[i];
    const dG = gCh[i] - blurG[i];
    const dB = bCh[i] - blurB[i];
    residual[i] = Math.sqrt(dR * dR + dG * dG + dB * dB);
  }

  const zone = buildScanZone(width, height, edgeOnly, edgeRatio);
  const scores = new Float32Array(n);

  // Soft overlays sit in a mild residual band; opaque glyph interiors are much stronger.
  const resLo = 0.012 - sensitivity * 0.005;
  const resHi = 0.11 + sensitivity * 0.04;
  const opaqueCut = resHi + 0.04;
  const maxCoverage = 0.03 + sensitivity * 0.07; // ~3% … 10% before morphological fill

  for (let i = 0; i < n; i++) {
    if (!zone[i]) continue;

    const res = residual[i];
    if (res < resLo || res > resHi) continue;

    const dL = lum[i] - blurLum[i];
    const dR = rCh[i] - blurR[i];
    const dG = gCh[i] - blurG[i];
    const dB = bCh[i] - blurB[i];

    // Skip anti-aliased edges of opaque content (hollow rings around real titles).
    if (touchesOpaqueInterior(residual, width, height, i, opaqueCut)) continue;

    const paleLift = dL > 0.006 && dL < 0.16;
    const tinted = Math.abs(dR - dG) < 0.07 && Math.abs(dG - dB) < 0.07;
    const pinkish = dR > dG + 0.003 && dR > dB + 0.003 && dL > 0;
    const blueish = dB > dR + 0.003 && dB > dG + 0.001;

    if (!(paleLift || tinted || pinkish || blueish)) continue;

    const localBlurVar = sampleVar(blurLum, width, height, i % width, (i / width) | 0, 3);
    if (localBlurVar > 0.014 + sensitivity * 0.01) continue;

    // Prefer softer residual (stroke body) over sharper mid-edge rings.
    let score = (resHi - res) + 0.02;
    if (paleLift) score += 0.03;
    if (pinkish || blueish) score += 0.025;
    if (tinted) score += 0.01;
    scores[i] = score;
  }

  let mask = thresholdByCoverage(scores, width, height, maxCoverage);
  mask = pruneNoise(mask, width, height, sensitivity, residual, opaqueCut);

  // Fill stroke interiors: close gaps, then fill enclosed holes, slight dilate for coverage.
  const closeRadius = sensitivity > 0.65 ? 3 : 2;
  mask = closeMask(mask, width, height, closeRadius);
  mask = fillMaskHoles(mask, width, height);
  // After fill, drop components that landed on opaque content (solid titles).
  mask = pruneOpaqueFilled(mask, width, height, residual, opaqueCut);
  mask = pruneHollowOutlines(mask, width, height, residual, opaqueCut);
  mask = dilateMask(mask, width, height, 1);

  // Safety: don't let filled mask explode past ~12%.
  return clampCoverage(mask, width, height, 0.04 + sensitivity * 0.08);
}

/** True if a neighbor looks like opaque content interior (strong residual). */
function touchesOpaqueInterior(
  residual: Float32Array,
  width: number,
  height: number,
  idx: number,
  opaqueCut: number
): boolean {
  const x = idx % width;
  const y = (idx / width) | 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (residual[ny * width + nx] >= opaqueCut) return true;
    }
  }
  return false;
}

/**
 * Drop components that are mostly hollow rings around opaque glyphs
 * (area fills little of bbox, and bbox interior has strong residual).
 */
function pruneHollowOutlines(
  mask: MaskBuffer,
  width: number,
  height: number,
  residual: Float32Array,
  opaqueCut: number
): MaskBuffer {
  const visited = new Uint8Array(mask.length);
  const out = createEmptyMask(width, height);
  const stack: number[] = [];

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 || visited[i]) continue;

    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    const component: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (stack.length) {
      const cur = stack.pop()!;
      component.push(cur);
      const x = cur % width;
      const y = (cur / width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

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

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const bboxArea = bw * bh;
    const fillRatio = component.length / Math.max(1, bboxArea);

    let opaqueHits = 0;
    let samples = 0;
    const step = Math.max(1, Math.floor(Math.min(bw, bh) / 8));
    for (let y = minY; y <= maxY; y += step) {
      for (let x = minX; x <= maxX; x += step) {
        samples++;
        if (residual[y * width + x] >= opaqueCut) opaqueHits++;
      }
    }
    const opaqueRatio = samples === 0 ? 0 : opaqueHits / samples;

    if (fillRatio < 0.35 && opaqueRatio > 0.2 && bw > 12 && bh > 12) {
      continue;
    }

    for (const idx of component) out[idx] = 255;
  }

  return out;
}

/** After hole-fill, drop blobs that sit on opaque title/content pixels. */
function pruneOpaqueFilled(
  mask: MaskBuffer,
  width: number,
  height: number,
  residual: Float32Array,
  opaqueCut: number
): MaskBuffer {
  const visited = new Uint8Array(mask.length);
  const out = createEmptyMask(width, height);
  const stack: number[] = [];
  const softCut = opaqueCut * 0.75;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 || visited[i]) continue;

    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    const component: number[] = [];
    let strong = 0;

    while (stack.length) {
      const cur = stack.pop()!;
      component.push(cur);
      if (residual[cur] >= softCut) strong++;

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

    // Watermark fills stay mild; opaque glyph fills light up residual.
    if (strong / component.length > 0.28) continue;

    for (const idx of component) out[idx] = 255;
  }

  return out;
}

function clampCoverage(
  mask: MaskBuffer,
  width: number,
  height: number,
  maxCoverage: number
): MaskBuffer {
  const n = width * height;
  let count = 0;
  for (let i = 0; i < n; i++) if (mask[i]) count++;
  if (count <= n * maxCoverage) return mask;

  // Thin from the outside via erosion rounds until under budget.
  let cur = mask;
  for (let round = 0; round < 4; round++) {
    cur = erodeOnce(cur, width, height);
    count = 0;
    for (let i = 0; i < n; i++) if (cur[i]) count++;
    if (count <= n * maxCoverage) break;
  }
  return cur;
}

function erodeOnce(mask: MaskBuffer, width: number, height: number): MaskBuffer {
  const out = createEmptyMask(width, height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (
        mask[i] &&
        mask[i - 1] &&
        mask[i + 1] &&
        mask[i - width] &&
        mask[i + width]
      ) {
        out[i] = 255;
      }
    }
  }
  return out;
}

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
  for (let k = 0; k < keep; k++) mask[indexed[k].i] = 255;
  return mask;
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const r = Math.max(1, radius);

  for (let y = 0; y < height; y++) {
    let sum = 0;
    const row = y * width;
    for (let x = -r; x <= r; x++) sum += src[row + clamp(x, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / (r * 2 + 1);
      sum += src[row + clamp(x + r + 1, 0, width - 1)] - src[row + clamp(x - r, 0, width - 1)];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / (r * 2 + 1);
      sum +=
        tmp[clamp(y + r + 1, 0, height - 1) * width + x] -
        tmp[clamp(y - r, 0, height - 1) * width + x];
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

function pruneNoise(
  mask: MaskBuffer,
  width: number,
  height: number,
  sensitivity: number,
  residual: Float32Array,
  opaqueCut: number
): MaskBuffer {
  const minArea = Math.max(6, Math.floor((1.05 - sensitivity) * 22));
  const maxArea = Math.floor(width * height * 0.15);
  const visited = new Uint8Array(mask.length);
  const out = createEmptyMask(width, height);
  const stack: number[] = [];

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 || visited[i]) continue;

    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    const component: number[] = [];
    let opaqueTouch = 0;

    while (stack.length) {
      const cur = stack.pop()!;
      component.push(cur);
      if (touchesOpaqueInterior(residual, width, height, cur, opaqueCut)) opaqueTouch++;

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

    // Components that mostly hug opaque glyphs are title outlines — drop them.
    if (opaqueTouch / component.length > 0.45) continue;

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
