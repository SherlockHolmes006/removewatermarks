import type { InpaintMethod, MaskBuffer, RawImage } from "./types.js";
import { cloneRawImage } from "./image-utils.js";

export interface InpaintOptions {
  method?: InpaintMethod;
  maxIterations?: number;
}

/**
 * Lightweight diffusion inpainting (Telea / Navier-Stokes inspired).
 * Pure CPU, no WASM — suitable for bundling into Web / RN / native wrappers.
 */
export function inpaint(image: RawImage, mask: MaskBuffer, options: InpaintOptions = {}): RawImage {
  const method = options.method ?? "telea";
  const maxIterations = options.maxIterations ?? 64;
  const { width, height } = image;
  const result = cloneRawImage(image);
  const workMask = new Uint8Array(mask);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    const nextMask = new Uint8Array(workMask);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (workMask[idx] === 0) continue;

        const filled = fillPixel(result, workMask, width, height, x, y, method);
        if (filled) {
          nextMask[idx] = 0;
          changed = true;
        }
      }
    }

    workMask.set(nextMask);
    if (!changed) break;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (workMask[idx] === 0) continue;
      fillPixel(result, workMask, width, height, x, y, "telea", true);
    }
  }

  return result;
}

function fillPixel(
  image: RawImage,
  mask: MaskBuffer,
  width: number,
  height: number,
  x: number,
  y: number,
  method: InpaintMethod,
  force = false
): boolean {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let weightSum = 0;

  const radius = 3;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      const nIdx = ny * width + nx;
      if (mask[nIdx] > 0 && !force) continue;

      const dist = Math.sqrt(dx * dx + dy * dy);
      const w = method === "ns" ? 1 / (1 + dist * dist) : 1 / (dist + 0.1);
      const o = nIdx * 4;

      sumR += image.data[o] * w;
      sumG += image.data[o + 1] * w;
      sumB += image.data[o + 2] * w;
      weightSum += w;
    }
  }

  if (weightSum === 0) return false;

  const idx = (y * width + x) * 4;
  image.data[idx] = clamp(sumR / weightSum);
  image.data[idx + 1] = clamp(sumG / weightSum);
  image.data[idx + 2] = clamp(sumB / weightSum);
  return true;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
