/** Pixel buffer in RGBA row-major order (4 bytes per pixel). */
export type PixelBuffer = Uint8ClampedArray;

/** Mask: 255 = watermark region to remove, 0 = keep original. */
export type MaskBuffer = Uint8Array;

export interface ImageSize {
  width: number;
  height: number;
}

export interface RawImage {
  data: PixelBuffer;
  width: number;
  height: number;
}

export type InpaintMethod = "telea" | "ns";

export interface RemoveWatermarkOptions {
  /** Mask aligned with image dimensions. If omitted, auto-detection is used. */
  mask?: MaskBuffer;
  /** Inpainting algorithm. Default: telea */
  method?: InpaintMethod;
  /** Max inpaint iterations per scale. Default: 64 */
  maxIterations?: number;
  /** Use multi-scale processing for large images. Default: true */
  multiScale?: boolean;
}

export interface AutoDetectOptions {
  /** Sensitivity 0–1. Higher = more aggressive mask. Default: 0.5 */
  sensitivity?: number;
  /** Only scan image edges (common watermark placement). Default: true */
  edgeOnly?: boolean;
  /** Edge band width as fraction of min(width,height). Default: 0.25 */
  edgeRatio?: number;
}

export interface RemoveWatermarkResult {
  image: RawImage;
  mask: MaskBuffer;
  /** Milliseconds spent processing */
  elapsedMs: number;
}

/** Unified entry point for all platforms (Web, Node, future RN / native wrappers). */
export interface WatermarkRemover {
  remove(image: RawImage, options?: RemoveWatermarkOptions): RemoveWatermarkResult;
  detectMask(image: RawImage, options?: AutoDetectOptions): MaskBuffer;
  inpaint(image: RawImage, mask: MaskBuffer, options?: Omit<RemoveWatermarkOptions, "mask">): RawImage;
}

export interface ExportOptions {
  mimeType?: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
}
