import { detectWatermarkMask } from "./detect.js";
import {
  cloneRawImage,
  countMaskedPixels,
  downscaleMask,
  downscaleRawImage,
  upscaleInpaintToTarget,
} from "./image-utils.js";
import { inpaint } from "./inpaint.js";
import type {
  AutoDetectOptions,
  MaskBuffer,
  RawImage,
  RemoveWatermarkOptions,
  RemoveWatermarkResult,
  WatermarkRemover,
} from "./types.js";

export * from "./types.js";
export * from "./image-utils.js";
export * from "./adapters/web.js";
export { detectWatermarkMask } from "./detect.js";
export { inpaint } from "./inpaint.js";

const MULTI_SCALE_THRESHOLD = 800;
const LOW_RES_MAX = 512;

function inpaintWithScale(
  image: RawImage,
  mask: MaskBuffer,
  options: RemoveWatermarkOptions
): RawImage {
  const maxSide = Math.max(image.width, image.height);
  const useMultiScale = options.multiScale !== false && maxSide > MULTI_SCALE_THRESHOLD;

  if (!useMultiScale) {
    return inpaint(image, mask, {
      method: options.method,
      maxIterations: options.maxIterations,
    });
  }

  const small = downscaleRawImage(image, LOW_RES_MAX);
  const smallMask = downscaleMask(mask, image, small);
  const smallResult = inpaint(small, smallMask, {
    method: options.method,
    maxIterations: options.maxIterations ?? 48,
  });

  const upscaled = upscaleInpaintToTarget(smallResult, smallMask, image, mask);
  return inpaint(upscaled, mask, {
    method: options.method,
    maxIterations: Math.min(24, options.maxIterations ?? 24),
  });
}

/** Factory — use this as the single integration entry point. */
export function createWatermarkRemover(): WatermarkRemover {
  return {
    detectMask(image: RawImage, options?: AutoDetectOptions) {
      return detectWatermarkMask(image, options);
    },

    inpaint(image: RawImage, mask: MaskBuffer, options?: Omit<RemoveWatermarkOptions, "mask">) {
      return inpaintWithScale(image, mask, options ?? {});
    },

    remove(image: RawImage, options: RemoveWatermarkOptions = {}): RemoveWatermarkResult {
      const start = typeof performance !== "undefined" ? performance.now() : Date.now();
      const mask =
        options.mask ?? detectWatermarkMask(image, { sensitivity: 0.5, edgeOnly: true });

      if (countMaskedPixels(mask) === 0) {
        return {
          image: cloneRawImage(image),
          mask,
          elapsedMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - start,
        };
      }

      const result = inpaintWithScale(image, mask, options);
      return {
        image: result,
        mask,
        elapsedMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - start,
      };
    },
  };
}

/** One-shot helper for quick integration. */
export function removeWatermark(
  image: RawImage,
  options?: RemoveWatermarkOptions
): RemoveWatermarkResult {
  return createWatermarkRemover().remove(image, options);
}

/** Default singleton instance. */
export const watermarkRemover = createWatermarkRemover();
