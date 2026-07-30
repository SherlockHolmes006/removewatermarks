import type { AutoDetectOptions, MaskBuffer, RawImage } from "./types.js";
import { closeMask, createEmptyMask, dilateMask, fillMaskHoles } from "./image-utils.js";

/**
 * Detect tiled / semi-transparent watermarks.
 *
 * Important: use per-tile thresholds (not global top-K), otherwise some regions
 * steal the budget and other identical watermarks are missed.
 * Then morphologically thicken strokes so letter interiors are filled.
 */
export function detectWatermarkMask(image: RawImage, options: AutoDetectOptions = {}): MaskBuffer {
  const sensitivity = clamp01(options.sensitivity ?? 0.55);
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

  // Two blur scales: catch both thin strokes and softer washes.
  const r1 = Math.max(5, Math.round(Math.min(width, height) * 0.008));
  const r2 = Math.max(r1 + 4, Math.round(Math.min(width, height) * 0.02));

  const blurLum1 = boxBlur(lum, width, height, r1);
  const blurLum2 = boxBlur(lum, width, height, r2);
  const blurR1 = boxBlur(rCh, width, height, r1);
  const blurG1 = boxBlur(gCh, width, height, r1);
  const blurB1 = boxBlur(bCh, width, height, r1);

  const residual = new Float32Array(n);
  const scores = new Float32Array(n);
  const zone = buildScanZone(width, height, edgeOnly, edgeRatio);

  const resLo = 0.008 - sensitivity * 0.004;
  const resHi = 0.13 + sensitivity * 0.05;
  const opaqueCut = 0.2 + sensitivity * 0.05;

  for (let i = 0; i < n; i++) {
    if (!zone[i]) continue;

    const dR = rCh[i] - blurR1[i];
    const dG = gCh[i] - blurG1[i];
    const dB = bCh[i] - blurB1[i];
    const res = Math.sqrt(dR * dR + dG * dG + dB * dB);
    residual[i] = res;

    const dL1 = lum[i] - blurLum1[i];
    const dL2 = lum[i] - blurLum2[i];
    // Mild lift vs either scale (tiled white/pink watermarks).
    const lift = Math.max(dL1, dL2);

    if (res < resLo || res > resHi) continue;
    // Opaque title interiors / hard graphics — skip.
    if (res >= opaqueCut) continue;
    // Only reject if tightly hugging a strong opaque blob.
    if (touchesOpaqueInterior(residual, width, height, i, opaqueCut, 1)) continue;

    const paleLift = lift > 0.004 && lift < 0.18;
    const nearNeutral = Math.abs(dR - dG) < 0.08 && Math.abs(dG - dB) < 0.08;
    const pinkish = dR > dG + 0.002 && dR > dB + 0.002 && lift > 0.002;
    const coolTint = dB > dR + 0.002 && lift > 0.002;

    if (!(paleLift || (nearNeutral && lift > 0.003) || pinkish || coolTint)) continue;

    // Soft body scores higher than sharp residual spikes.
    let score = 0.04 + (resHi - res) * 0.8 + Math.min(0.08, lift) * 1.5;
    if (paleLift) score += 0.03;
    if (pinkish) score += 0.02;
    if (nearNeutral) score += 0.01;
    scores[i] = score;
  }

  // Per-tile selection → every region of a repeating watermark can win.
  const tile = Math.max(64, Math.round(Math.min(width, height) / 6));
  let mask = thresholdByTiles(scores, width, height, tile, sensitivity);

  // Also keep a global soft floor so weak-but-valid strokes aren't lost between tiles.
  const floor = scorePercentile(scores, 0.35 - sensitivity * 0.15);
  if (floor > 0) {
    for (let i = 0; i < n; i++) {
      if (scores[i] >= floor) mask[i] = 255;
    }
  }

  mask = pruneSpeckles(mask, width, height, Math.max(4, Math.floor(10 - sensitivity * 6)));

  // Thicken & fill so characters are solid blocks, not hollow rings.
  const closeR = sensitivity > 0.7 ? 4 : sensitivity > 0.4 ? 3 : 2;
  mask = closeMask(mask, width, height, closeR);
  mask = dilateMask(mask, width, height, 2); // expand into stroke interiors
  mask = fillMaskHoles(mask, width, height);
  mask = pruneOpaqueFilled(mask, width, height, residual, opaqueCut);
  // Slight tighten after expand, then one more dilate for coverage.
  mask = closeMask(mask, width, height, 1);
  mask = dilateMask(mask, width, height, 1);

  // Tiled watermarks can legitimately cover more area; still guard against whole-image blur.
  return clampCoverage(mask, width, height, 0.08 + sensitivity * 0.12);
}

/**
 * In each tile, keep pixels above a local score cutoff so detection is spatially even.
 */
function thresholdByTiles(
  scores: Float32Array,
  width: number,
  height: number,
  tileSize: number,
  sensitivity: number
): MaskBuffer {
  const mask = createEmptyMask(width, height);
  // Lower percentile cutoff → keep more pixels in each tile.
  const keepFrom = clamp01(0.4 - sensitivity * 0.25); // 0.4 … 0.15

  for (let ty = 0; ty < height; ty += tileSize) {
    for (let tx = 0; tx < width; tx += tileSize) {
      const x1 = Math.min(width, tx + tileSize);
      const y1 = Math.min(height, ty + tileSize);
      const local: number[] = [];

      for (let y = ty; y < y1; y++) {
        for (let x = tx; x < x1; x++) {
          const s = scores[y * width + x];
          if (s > 0) local.push(s);
        }
      }
      if (local.length < 8) continue;

      local.sort((a, b) => a - b);
      const idx = Math.min(local.length - 1, Math.floor(local.length * keepFrom));
      const cutoff = local[idx];

      for (let y = ty; y < y1; y++) {
        for (let x = tx; x < x1; x++) {
          const i = y * width + x;
          if (scores[i] >= cutoff) mask[i] = 255;
        }
      }
    }
  }

  return mask;
}

function scorePercentile(scores: Float32Array, p: number): number {
  const vals: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] > 0) vals.push(scores[i]);
  if (vals.length < 16) return 0;
  vals.sort((a, b) => a - b);
  const idx = Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * clamp01(p))));
  return vals[idx];
}

function touchesOpaqueInterior(
  residual: Float32Array,
  width: number,
  height: number,
  idx: number,
  opaqueCut: number,
  radius: number
): boolean {
  const x = idx % width;
  const y = (idx / width) | 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (residual[ny * width + nx] >= opaqueCut) return true;
    }
  }
  return false;
}

function pruneSpeckles(mask: MaskBuffer, width: number, height: number, minArea: number): MaskBuffer {
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
  const softCut = opaqueCut * 0.85;

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

    // Drop blobs that mostly sit on opaque content (solid titles / icons).
    if (strong / component.length > 0.32) continue;
    for (const idx of component) out[idx] = 255;
  }

  return out;
}

function clampCoverage(mask: MaskBuffer, width: number, height: number, maxCoverage: number): MaskBuffer {
  const n = width * height;
  let count = 0;
  for (let i = 0; i < n; i++) if (mask[i]) count++;
  if (count <= n * maxCoverage) return mask;

  let cur = mask;
  for (let round = 0; round < 5; round++) {
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
      if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - width] && mask[i + width]) {
        out[i] = 255;
      }
    }
  }
  return out;
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
