import type { ExportOptions, RawImage } from "../types.js";
import { rawImageFromImageData, toImageData } from "../image-utils.js";

/** Load RawImage from a browser File (no upload). */
export async function loadRawImageFromFile(file: File): Promise<RawImage> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return rawImageFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

/** Load RawImage from an HTMLImageElement or ImageBitmap. */
export function loadRawImageFromCanvasSource(
  source: CanvasImageSource,
  width: number,
  height: number
): RawImage {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, width, height);
  return rawImageFromImageData(ctx.getImageData(0, 0, width, height));
}

/** Export RawImage to Blob for download or sharing. */
export async function exportRawImageToBlob(
  image: RawImage,
  options: ExportOptions = {}
): Promise<Blob> {
  const mime = options.mimeType ?? "image/png";
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext("2d")!.putImageData(toImageData(image), 0, 0);
  return canvas.convertToBlob({ type: mime, quality: options.quality });
}

/** Draw result onto a 2D canvas context. */
export function drawRawImage(ctx: CanvasRenderingContext2D, image: RawImage): void {
  ctx.putImageData(toImageData(image), 0, 0);
}
