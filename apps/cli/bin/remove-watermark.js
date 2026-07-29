#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { createWatermarkRemover } from "@watermark-remover/core";

const usage = `
用法: remove-watermark <输入图片> [输出图片] [选项]

选项:
  --sensitivity <0-1>   自动检测灵敏度 (默认 0.5)
  --full-image          检测全图而非仅边缘
  --method telea|ns       修复算法 (默认 telea)

示例:
  remove-watermark photo.jpg
  remove-watermark photo.jpg output.png --sensitivity 0.7
`.trim();

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (positional.length < 1) {
    console.log(usage);
    process.exit(positional.length === 0 ? 1 : 0);
  }

  const inputPath = positional[0];
  const defaultOut = join(
    dirname(inputPath),
    basename(inputPath).replace(/(\.[^.]+)?$/, "-no-watermark$1")
  );
  const outputPath = positional[1] ?? defaultOut;

  const sensitivity = flags.sensitivity !== undefined ? Number(flags.sensitivity) : 0.5;
  const edgeOnly = !flags["full-image"];
  const method = flags.method === "ns" ? "ns" : "telea";

  const remover = createWatermarkRemover();

  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const image = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };

  const mask = remover.detectMask(image, { sensitivity, edgeOnly });
  const maskedCount = mask.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);

  if (maskedCount === 0) {
    console.warn("未检测到水印区域，已复制原图。可尝试 --sensitivity 0.7 或 --full-image");
    await writeFile(outputPath, await readFile(inputPath));
    return;
  }

  const { image: result, elapsedMs } = remover.remove(image, { mask, method });
  console.log(`已处理 ${maskedCount} 像素，耗时 ${elapsedMs.toFixed(0)} ms`);

  await sharp(Buffer.from(result.data), {
    raw: { width: result.width, height: result.height, channels: 4 },
  })
    .png()
    .toFile(outputPath);

  console.log(`输出: ${outputPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
