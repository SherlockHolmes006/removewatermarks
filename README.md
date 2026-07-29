# 去水印工具 (Watermark Remover)

轻量级、**纯本地**图片去水印方案。核心算法为 TypeScript 实现，无后端依赖，便于集成到 Web / Android / iOS。

## 结构

```
RemoveWatermarks/
├── packages/core/     # @watermark-remover/core — 可复用 SDK
├── apps/web/          # 浏览器演示工具 (Vite)
└── apps/cli/          # 命令行工具 (Node + sharp)
```

## 快速开始

```bash
npm install
npm run build
npm run dev          # 打开 Web 工具 http://localhost:5173
```

CLI：

```bash
npm run cli -- path/to/image.jpg
npm run cli -- input.jpg output.png --sensitivity 0.7
```

## 核心 API（集成入口）

```typescript
import {
  createWatermarkRemover,
  rawImageFromImageData,
  toImageData,
  type RawImage,
  type MaskBuffer,
} from "@watermark-remover/core";

const remover = createWatermarkRemover();

// 1. 准备 RawImage（RGBA 像素缓冲）
const image: RawImage = rawImageFromImageData(imageData);

// 2a. 自动检测水印区域
const mask: MaskBuffer = remover.detectMask(image, { sensitivity: 0.5 });

// 2b. 或传入手动绘制的 mask（255 = 水印区域）

// 3. 去水印
const { image: result, elapsedMs } = remover.remove(image, { mask });

// Web: 显示结果
ctx.putImageData(toImageData(result), 0, 0);
```

### 工厂方法

| 方法 | 说明 |
|------|------|
| `createWatermarkRemover()` | 创建实例（推荐，便于测试与 DI） |
| `removeWatermark(image, opts)` | 一次性调用 |
| `watermarkRemover` | 默认单例 |

### 选项

```typescript
interface RemoveWatermarkOptions {
  mask?: Uint8Array;           // 手动 mask，省略则自动检测
  method?: "telea" | "ns";     // 修复算法
  maxIterations?: number;      // 迭代次数，默认 64
  multiScale?: boolean;        // 大图多尺度加速，默认 true
}
```

## 未来集成指南

### Web 网站

直接 npm 依赖 `@watermark-remover/core`，配合 Canvas / OffscreenCanvas 即可，本仓库 `apps/web` 即为参考实现。

### React Native / Expo

将 core 包打入 bundle，使用 `react-native-canvas` 或 Skia 读取像素为 `RawImage`，处理后再写回。

### Android (Kotlin)

**方案 A（推荐）**：WebView 加载打包后的 web SDK，通过 JS Bridge 传 base64。  
**方案 B**：用 [quickjs](https://github.com/bellard/quickjs) / Hermes 运行编译后的 core JS。  
**方案 C**：后续将 core 算法移植为 Kotlin Native 或使用 JNI 调用 Rust/WASM。

### iOS (Swift)

与 Android 类似：WKWebView + JS Bridge，或将 core 作为 JavaScriptCore 模块运行。

### 统一封装建议

```
your-app/
  └── modules/watermark-remover/   # 拷贝或 npm link packages/core
        ├── index.ts               # 对外稳定 API
        └── adapters/
              web.ts
              node.ts
              react-native.ts      # 未来
```

保持 **`RawImage` + `MaskBuffer` → `remove()`** 作为跨平台契约；各端只负责图像 I/O 适配。

## 算法说明

- **检测**：边缘区域浅色低饱和度启发式（适合常见文字/logo 水印）
- **修复**：轻量扩散 inpainting（Telea / NS 风格），大图自动多尺度处理
- **局限**：复杂水印、大面积覆盖效果有限；手动画笔标记可显著提升效果

## 版本维护与部署

推荐流程：`本地改代码 → commit → push GitHub → 服务器自动/手动更新`。

### 1. 本地首次关联 GitHub

```bash
git init
git add .
git commit -m "chore: initial commit"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

日常更新：

```bash
git add .
git commit -m "feat: 说明本次改动"
git push
```

发版本（可选）：

```bash
git tag v0.1.0
git push origin v0.1.0
```

### 2. 服务器手动部署

在云服务器克隆仓库后：

```bash
cd /opt/RemoveWatermarks          # 或你的源码目录
chmod +x scripts/deploy.sh
WEB_ROOT=/var/www/remove-watermark ./scripts/deploy.sh
```

Nginx 示例配置见 `scripts/nginx.remove-watermark.conf.example`。

### 3. GitHub Actions 自动部署

仓库已包含 `.github/workflows/deploy.yml`。在 GitHub → Settings → Secrets 添加：

| Secret | 含义 |
|--------|------|
| `SSH_HOST` | 服务器 IP / 域名 |
| `SSH_USER` | SSH 用户名 |
| `SSH_PRIVATE_KEY` | 部署用私钥 |
| `SSH_PORT` | 可选，默认 22 |
| `WEB_ROOT` | 可选，默认 `/var/www/remove-watermark` |

之后每次 `push` 到 `main`，会自动构建并把 `apps/web/dist` 同步到服务器。

## 许可

MIT
