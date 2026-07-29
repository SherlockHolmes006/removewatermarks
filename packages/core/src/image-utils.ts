import type { ImageSize, MaskBuffer, PixelBuffer, RawImage } from "./types.js";

export function cloneRawImage(image: RawImage): RawImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

export function createEmptyMask(width: number, height: number): MaskBuffer {
  return new Uint8Array(width * height);
}

export function dilateMask(mask: MaskBuffer, width: number, height: number, radius = 1): MaskBuffer {
  if (radius <= 0) return mask;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 255) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              out[ny * width + nx] = 255;
            }
          }
        }
      }
    }
  }
  return out;
}

export function countMaskedPixels(mask: MaskBuffer): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) count++;
  }
  return count;
}

export function downscaleRawImage(image: RawImage, maxSide: number): RawImage {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  if (scale >= 1) return cloneRawImage(image);

  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x / width) * image.width));
      const sy = Math.min(image.height - 1, Math.floor((y / height) * image.height));
      const si = (sy * image.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = image.data[si];
      data[di + 1] = image.data[si + 1];
      data[di + 2] = image.data[si + 2];
      data[di + 3] = image.data[si + 3];
    }
  }

  return { width, height, data };
}

export function downscaleMask(mask: MaskBuffer, from: ImageSize, to: ImageSize): MaskBuffer {
  const out = createEmptyMask(to.width, to.height);
  for (let y = 0; y < to.height; y++) {
    for (let x = 0; x < to.width; x++) {
      const sx = Math.min(from.width - 1, Math.floor((x / to.width) * from.width));
      const sy = Math.min(from.height - 1, Math.floor((y / to.height) * from.height));
      if (mask[sy * from.width + sx] > 0) out[y * to.width + x] = 255;
    }
  }
  return out;
}

export function upscaleInpaintToTarget(
  lowRes: RawImage,
  _lowMask: MaskBuffer,
  target: RawImage,
  targetMask: MaskBuffer
): RawImage {
  const result = cloneRawImage(target);

  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      const idx = y * target.width + x;
      if (targetMask[idx] === 0) continue;

      const lx = Math.min(lowRes.width - 1, Math.floor((x / target.width) * lowRes.width));
      const ly = Math.min(lowRes.height - 1, Math.floor((y / target.height) * lowRes.height));
      const li = (ly * lowRes.width + lx) * 4;
      const di = idx * 4;

      result.data[di] = lowRes.data[li];
      result.data[di + 1] = lowRes.data[li + 1];
      result.data[di + 2] = lowRes.data[li + 2];
      result.data[di + 3] = target.data[di + 3];
    }
  }

  return result;
}

export function rawImageFromImageData(imageData: ImageData): RawImage {
  return {
    width: imageData.width,
    height: imageData.height,
    data: new Uint8ClampedArray(imageData.data),
  };
}

export function toImageData(image: RawImage): ImageData {
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
}
