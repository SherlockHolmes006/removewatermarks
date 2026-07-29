import {
  createWatermarkRemover,
  rawImageFromImageData,
  toImageData,
  type MaskBuffer,
  type RawImage,
} from "@watermark-remover/core";

const remover = createWatermarkRemover();

const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const btnAuto = document.getElementById("btnAuto") as HTMLButtonElement;
const btnBrush = document.getElementById("btnBrush") as HTMLButtonElement;
const btnEraser = document.getElementById("btnEraser") as HTMLButtonElement;
const btnProcess = document.getElementById("btnProcess") as HTMLButtonElement;
const btnDownload = document.getElementById("btnDownload") as HTMLButtonElement;
const btnReset = document.getElementById("btnReset") as HTMLButtonElement;
const brushSize = document.getElementById("brushSize") as HTMLInputElement;
const sensitivity = document.getElementById("sensitivity") as HTMLInputElement;
const canvasSource = document.getElementById("canvasSource") as HTMLCanvasElement;
const canvasMask = document.getElementById("canvasMask") as HTMLCanvasElement;
const canvasResult = document.getElementById("canvasResult") as HTMLCanvasElement;
const hint = document.getElementById("hint") as HTMLParagraphElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const canvasWrap = canvasSource.parentElement as HTMLDivElement;

let sourceImage: RawImage | null = null;
let userMask: MaskBuffer | null = null;
let resultImage: RawImage | null = null;
let drawing = false;
let tool: "brush" | "eraser" | null = null;
let isPainting = false;

function setStatus(text: string, type: "ok" | "err" | "" = "") {
  status.textContent = text;
  status.className = "status" + (type ? ` ${type}` : "");
}

function enableControls(enabled: boolean) {
  btnAuto.disabled = !enabled;
  btnBrush.disabled = !enabled;
  btnEraser.disabled = !enabled;
  btnProcess.disabled = !enabled;
  btnReset.disabled = !enabled;
}

function loadImageToCanvas(file: File) {
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    canvasSource.width = w;
    canvasSource.height = h;
    canvasMask.width = w;
    canvasMask.height = h;
    canvasResult.width = w;
    canvasResult.height = h;

    const ctx = canvasSource.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    sourceImage = rawImageFromImageData(imageData);

    userMask = new Uint8Array(w * h);
    clearMaskOverlay();
    clearResult();

    enableControls(true);
    hint.textContent = "可「自动检测」或切换到「画笔标记」手动涂选水印区域";
    setStatus("");
  };
  img.src = URL.createObjectURL(file);
}

function clearMaskOverlay() {
  const ctx = canvasMask.getContext("2d")!;
  ctx.clearRect(0, 0, canvasMask.width, canvasMask.height);
}

function clearResult() {
  resultImage = null;
  btnDownload.disabled = true;
  const ctx = canvasResult.getContext("2d")!;
  ctx.clearRect(0, 0, canvasResult.width, canvasResult.height);
}

function renderMaskOverlay(mask: MaskBuffer) {
  const { width, height } = canvasMask;
  const overlay = new ImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) {
      const o = i * 4;
      overlay.data[o] = 239;
      overlay.data[o + 1] = 107;
      overlay.data[o + 2] = 107;
      overlay.data[o + 3] = 180;
    }
  }
  canvasMask.getContext("2d")!.putImageData(overlay, 0, 0);
}

function getCanvasPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvasMask.getBoundingClientRect();
  const scaleX = canvasMask.width / rect.width;
  const scaleY = canvasMask.height / rect.height;
  return {
    x: Math.floor((e.clientX - rect.left) * scaleX),
    y: Math.floor((e.clientY - rect.top) * scaleY),
  };
}

function paintAt(x: number, y: number) {
  if (!userMask || !sourceImage) return;
  const r = Number(brushSize.value);
  const { width, height } = sourceImage;
  const value = tool === "eraser" ? 0 : 255;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      userMask[py * width + px] = value;
    }
  }
  renderMaskOverlay(userMask);
}

function setTool(next: "brush" | "eraser" | null) {
  tool = next;
  drawing = next !== null;
  btnBrush.classList.toggle("active", next === "brush");
  btnEraser.classList.toggle("active", next === "eraser");
  canvasWrap.classList.toggle("drawing", drawing);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadImageToCanvas(file);
});

btnAuto.addEventListener("click", () => {
  if (!sourceImage) return;
  const sens = Number(sensitivity.value) / 100;
  userMask = remover.detectMask(sourceImage, { sensitivity: sens, edgeOnly: true });
  renderMaskOverlay(userMask);
  const count = userMask.filter((v) => v > 0).length;
  hint.textContent = count > 0 ? `已检测到约 ${count} 个像素的水印区域` : "未检测到明显水印，请尝试手动画笔标记";
});

btnBrush.addEventListener("click", () => setTool(tool === "brush" ? null : "brush"));
btnEraser.addEventListener("click", () => setTool(tool === "eraser" ? null : "eraser"));

canvasMask.addEventListener("pointerdown", (e) => {
  if (!drawing) return;
  isPainting = true;
  canvasMask.setPointerCapture(e.pointerId);
  const { x, y } = getCanvasPoint(e);
  paintAt(x, y);
});

canvasMask.addEventListener("pointermove", (e) => {
  if (!isPainting || !drawing) return;
  const { x, y } = getCanvasPoint(e);
  paintAt(x, y);
});

canvasMask.addEventListener("pointerup", () => {
  isPainting = false;
});

btnProcess.addEventListener("click", () => {
  if (!sourceImage) return;

  btnProcess.disabled = true;
  setStatus("处理中…");
  hint.textContent = "正在本地修复图像，请稍候";

  requestAnimationFrame(() => {
    try {
      const mask =
        userMask && userMask.some((v) => v > 0)
          ? userMask
          : remover.detectMask(sourceImage!, {
              sensitivity: Number(sensitivity.value) / 100,
            });

      const { image, elapsedMs } = remover.remove(sourceImage!, { mask });
      resultImage = image;

      canvasResult.getContext("2d")!.putImageData(toImageData(image), 0, 0);
      btnDownload.disabled = false;
      setStatus(`完成，耗时 ${elapsedMs.toFixed(0)} ms（本地处理）`, "ok");
      hint.textContent = "可下载结果，或调整标记后再次处理";
    } catch (err) {
      setStatus(`处理失败: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      btnProcess.disabled = false;
    }
  });
});

btnDownload.addEventListener("click", () => {
  if (!resultImage) return;
  canvasResult.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "removed-watermark.png";
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
});

btnReset.addEventListener("click", () => {
  sourceImage = null;
  userMask = null;
  resultImage = null;
  fileInput.value = "";
  setTool(null);
  enableControls(false);
  btnDownload.disabled = true;
  clearMaskOverlay();
  clearResult();
  hint.textContent = "上传图片后，可自动检测或手动画笔标记水印区域";
  setStatus("");
});
