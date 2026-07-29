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
const canvasStage = canvasSource.parentElement as HTMLDivElement;
const canvasWrap = canvasStage.parentElement as HTMLDivElement;

let sourceImage: RawImage | null = null;
let userMask: MaskBuffer | null = null;
let resultImage: RawImage | null = null;
let drawing = false;
let tool: "brush" | "eraser" | null = null;
let isPainting = false;
let lastPoint: { x: number; y: number } | null = null;

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
    lastPoint = null;

    enableControls(true);
    hint.textContent = "可「自动检测」或切换到「画笔标记」手动涂选水印区域";
    setStatus("");
    URL.revokeObjectURL(img.src);
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
  const scaleX = canvasMask.width / Math.max(1, rect.width);
  const scaleY = canvasMask.height / Math.max(1, rect.height);
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
  };
}

/** Stamp a circular brush dab into the mask buffer (no redraw). */
function stampAt(x: number, y: number) {
  if (!userMask || !sourceImage) return;
  const r = Number(brushSize.value);
  const r2 = r * r;
  const { width, height } = sourceImage;
  const value = tool === "eraser" ? 0 : 255;

  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(width - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(height - 1, Math.ceil(y + r));

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy > r2) continue;
      userMask[py * width + px] = value;
    }
  }
}

/**
 * Interpolate between last and current point so fast pointer moves stay continuous.
 * Spacing is a fraction of brush radius to avoid gaps.
 */
function paintStrokeTo(x: number, y: number) {
  if (!userMask || !sourceImage) return;

  if (!lastPoint) {
    stampAt(x, y);
    lastPoint = { x, y };
    renderMaskOverlay(userMask);
    return;
  }

  const dx = x - lastPoint.x;
  const dy = y - lastPoint.y;
  const dist = Math.hypot(dx, dy);
  const spacing = Math.max(1, Number(brushSize.value) * 0.35);
  const steps = Math.max(1, Math.ceil(dist / spacing));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stampAt(
      Math.round(lastPoint.x + dx * t),
      Math.round(lastPoint.y + dy * t)
    );
  }

  lastPoint = { x, y };
  renderMaskOverlay(userMask);
}

function setTool(next: "brush" | "eraser" | null) {
  tool = next;
  drawing = next !== null;
  lastPoint = null;
  btnBrush.classList.toggle("active", next === "brush");
  btnEraser.classList.toggle("active", next === "eraser");
  canvasWrap.classList.toggle("drawing", drawing);
  canvasMask.style.pointerEvents = drawing ? "auto" : "none";
  canvasMask.style.cursor = drawing ? "crosshair" : "default";
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadImageToCanvas(file);
});

btnAuto.addEventListener("click", () => {
  if (!sourceImage) return;

  setTool(null);
  btnAuto.disabled = true;
  setStatus("正在自动检测水印…");
  hint.textContent = "检测中，请稍候";

  // Yield to UI so status text paints before heavy CPU work.
  requestAnimationFrame(() => {
    try {
      const sens = Number(sensitivity.value) / 100;
      let mask = remover.detectMask(sourceImage!, {
        sensitivity: sens,
        edgeOnly: true,
        edgeRatio: 0.35,
      });
      let count = mask.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);

      // Stronger full-image pass if edge scan found almost nothing.
      if (count < 80) {
        mask = remover.detectMask(sourceImage!, {
          sensitivity: Math.min(1, sens + 0.2),
          edgeOnly: false,
        });
        count = mask.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
      }

      userMask = mask;
      renderMaskOverlay(mask);

      if (count > 0) {
        hint.textContent = `已检测到约 ${count.toLocaleString()} 个像素的水印区域（红色半透明）。可再用画笔/橡皮微调`;
        setStatus(`自动检测完成：标记了 ${count.toLocaleString()} 像素`, "ok");
      } else {
        hint.textContent =
          "未检测到明显水印。请调高「检测灵敏度」后重试，或用手动画笔涂选水印";
        setStatus("自动检测未找到水印，请手动画笔标记", "err");
      }
    } catch (err) {
      setStatus(`检测失败: ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      btnAuto.disabled = false;
    }
  });
});

btnBrush.addEventListener("click", () => setTool(tool === "brush" ? null : "brush"));
btnEraser.addEventListener("click", () => setTool(tool === "eraser" ? null : "eraser"));

canvasMask.addEventListener("pointerdown", (e) => {
  if (!drawing) return;
  e.preventDefault();
  isPainting = true;
  canvasMask.setPointerCapture(e.pointerId);
  lastPoint = null;
  const { x, y } = getCanvasPoint(e);
  paintStrokeTo(x, y);
});

canvasMask.addEventListener("pointermove", (e) => {
  if (!isPainting || !drawing) return;
  e.preventDefault();
  const { x, y } = getCanvasPoint(e);
  paintStrokeTo(x, y);
});

function endStroke(e: PointerEvent) {
  if (!isPainting) return;
  isPainting = false;
  lastPoint = null;
  try {
    canvasMask.releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
}

canvasMask.addEventListener("pointerup", endStroke);
canvasMask.addEventListener("pointercancel", endStroke);
canvasMask.addEventListener("lostpointercapture", () => {
  isPainting = false;
  lastPoint = null;
});

btnProcess.addEventListener("click", () => {
  if (!sourceImage) return;

  btnProcess.disabled = true;
  setStatus("处理中…");
  hint.textContent = "正在本地修复图像，请稍候";

  requestAnimationFrame(() => {
    try {
      const hasUserMask = !!(userMask && userMask.some((v) => v > 0));
      const mask = hasUserMask
        ? userMask!
        : remover.detectMask(sourceImage!, {
            sensitivity: Number(sensitivity.value) / 100,
            edgeOnly: false,
          });

      if (!hasUserMask) {
        userMask = mask;
        renderMaskOverlay(mask);
      }

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
  lastPoint = null;
  fileInput.value = "";
  setTool(null);
  enableControls(false);
  btnDownload.disabled = true;
  clearMaskOverlay();
  clearResult();
  hint.textContent = "上传图片后，可自动检测或手动画笔标记水印区域";
  setStatus("");
});
