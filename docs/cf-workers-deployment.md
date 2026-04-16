# 拼豆底稿生成器 — Cloudflare Workers 部署方案

## 目录

1. [项目现状分析](#1-项目现状分析)
2. [技术选型：opennextjs-cloudflare](#2-技术选型opennextjs-cloudflare)
3. [需要改造的点](#3-需要改造的点)
4. [详细部署步骤](#4-详细部署步骤)
5. [注意事项与已知限制](#5-注意事项与已知限制)
6. [成本评估](#6-成本评估)
7. [回退方案](#7-回退方案)

---

## 1. 项目现状分析

### 1.1 当前技术栈

| 项目 | 版本/技术 |
|------|-----------|
| 框架 | Next.js 15.3.6 (App Router) |
| 运行时 | React 19 |
| 样式 | Tailwind CSS 4 |
| PWA | next-pwa 5.6.0 |
| 图片裁剪 | cropperjs + react-cropper |
| 图片处理 | sharp 0.34.2（devDependencies） |
| 本地开发服务器 | 自定义 HTTPS server.js |

### 1.2 服务端功能

本项目**几乎全是客户端渲染**（所有页面和组件都标记了 `'use client'`），服务端只有：

1. **一个 API 路由**：`/src/app/api/ai-optimize/route.ts`
   - 调用火山引擎即梦 AI 接口
   - 使用 Node.js `crypto` 模块做 HMAC-SHA256 签名
   - 使用 `Buffer.byteLength()`
   - 需要环境变量 `VOLC_ACCESS_KEY_ID` 和 `VOLC_SECRET_ACCESS_KEY`

2. **自定义 HTTPS 开发服务器**：`server.js`（仅用于本地开发，部署不需要）

### 1.3 部署可行性结论

**可以部署，但需要少量改造。** 核心应用全部是客户端渲染，非常适合 Edge 部署。唯一的挑战是那个 API 路由使用了 Node.js 的 `crypto` 模块。

---

## 2. 技术选型：opennextjs-cloudflare

### 2.1 为什么选择 opennextjs-cloudflare

目前有两个主流方案：

| 方案 | 状态 | 推荐度 |
|------|------|--------|
| `@cloudflare/next-on-pages` | 成熟，但 Cloudflare 官方已转向 opennextjs | 次选 |
| **`@opennextjs/cloudflare`** | **Cloudflare 官方当前推荐方案** | **首选** |

**选择 `@opennextjs/cloudflare` 的理由：**

- Cloudflare 官方推荐，是未来的主推方向
- 基于 OpenNext 开源项目，社区活跃
- 对 Next.js 15 有良好支持
- 提供 `nodejs_compat` 兼容标志，支持 Node.js API（包括 `crypto`）
- 与 Cloudflare 生态（R2、KV、D1、Durable Objects）深度集成

### 2.2 opennextjs-cloudflare 是什么

它是一个构建适配器，将 Next.js 应用转换为 Cloudflare Worker 格式。核心原理：

```
Next.js 构建输出 (.next) → opennextjs-cloudflare 打包 → Worker 代码 (.open-next/worker.js) + 静态资源 (.open-next/assets/)
                                    ↓
                          部署到 Cloudflare Workers
```

---

## 3. 需要改造的点

### 3.1 必须改造

#### (1) 移除 `sharp` 依赖

`sharp` 是原生 Node.js 模块，无法在 Workers 环境运行。

**但好消息是：** `sharp` 在 `devDependencies` 中，且项目中**实际没有 import 使用它**。只需从 `package.json` 中移除即可。

```bash
npm uninstall sharp
```

#### (2) API 路由的 `crypto` 模块兼容

`/src/app/api/ai-optimize/route.ts` 使用了：
- `crypto.createHmac('sha256', secret)` — HMAC 签名
- `crypto.createHash('sha256')` — SHA256 哈希
- `Buffer.byteLength()` — 计算 body 长度

**解决方案：** 使用 `nodejs_compat` 兼容标志 + `export const runtime = 'edge'`。

Cloudflare Workers 的 `nodejs_compat` 标志提供了 `crypto` 模块和 `Buffer` 的 polyfill，**无需改代码**。只需在 API 路由中添加：

```typescript
export const runtime = 'edge';
```

#### (3) 移除 `server.js`

`server.js` 是本地 HTTPS 开发服务器，部署到 CF 不需要。**无需删除，但不参与部署流程。**

#### (4) PWA 兼容处理

当前使用 `next-pwa` 插件，它会在构建时在 `public/` 目录生成 Service Worker 文件。在 CF Workers 部署时，静态资源从 `.open-next/assets/` 提供。

**方案：** 保留 `next-pwa`，生成的 `sw.js` 和 `workbox-*.js` 会被作为静态资源一起部署。但需要在构建时确认这些文件正确输出到 assets 目录。

### 3.2 建议改造（非必须）

#### (1) 移除 `@vercel/analytics`

当前依赖了 Vercel 的分析组件，部署到 CF 后无法使用。建议：

```bash
npm uninstall @vercel/analytics
```

并在代码中移除相关引用（搜索 `<Analytics />` 组件的使用）。

#### (2) 环境变量管理

`VOLC_ACCESS_KEY_ID` 和 `VOLC_SECRET_ACCESS_KEY` 需要通过 `wrangler.toml` 或 Cloudflare Dashboard 设置为 Worker 的环境变量（secrets）。

---

## 4. 详细部署步骤

### 第一步：安装依赖

```bash
# 安装 opennextjs-cloudflare 和 wrangler
npm install -D @opennextjs/cloudflare wrangler
```

### 第二步：移除不兼容的依赖

```bash
npm uninstall sharp @vercel/analytics
```

如果代码中引用了 `@vercel/analytics` 的 `<Analytics />` 组件，需要一并移除：

```bash
# 搜索并移除 Analytics 引用
grep -r "Analytics" src/ --include="*.tsx" --include="*.ts"
```

### 第三步：创建 `wrangler.jsonc` 配置文件

在项目根目录创建 `wrangler.jsonc`：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": ".open-next/worker.js",
  "name": "perler-beads",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },
  "services": [
    {
      "binding": "WORKER_SELF_REFERENCE",
      "service": "perler-beads"
    }
  ],
  // R2 缓存桶（用于 Next.js 增量缓存/ISR，本项目主要是静态页面，可选）
  // 如果不需要 ISR 功能，可以不配置 R2 和 D1
  "r2_buckets": [
    {
      "binding": "NEXT_INC_CACHE_R2_BUCKET",
      "bucket_name": "perler-beads-cache"
    }
  ],
  // 环境变量（敏感信息用 secrets，不直接写在这里）
  "vars": {
    "NODE_ENV": "production"
  }
}
```

### 第四步：修改 `next.config.ts`

需要将 `next-pwa` 的 `require` 改为动态 import，并添加 Cloudflare 开发初始化：

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
```

> **PWA 说明：** `next-pwa` 使用 CommonJS `require()` 语法，与 ES Module 配置不兼容。有两个选择：
>
> **选择 A（推荐）：** 将 `next.config.ts` 重命名为 `next.config.mjs`，用动态 import 方式：
> ```javascript
> import withPWAInit from "next-pwa";
>
> const withPWA = withPWAInit({
>   dest: "public",
>   register: true,
>   skipWaiting: true,
>   disable: process.env.NODE_ENV === "development",
>   buildExcludes: [/middleware-manifest\.json$/],
> });
>
> /** @type {import('next').NextConfig} */
> const nextConfig = {};
>
> export default withPWA(nextConfig);
> ```
>
> **选择 B：** 暂时移除 PWA 支持，部署成功后再逐步恢复。

### 第五步：为 API 路由添加 Edge Runtime 声明

编辑 `src/app/api/ai-optimize/route.ts`，在文件顶部添加：

```typescript
export const runtime = 'edge';
```

完整文件开头变为：

```typescript
export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
// ... 其余代码不变
```

### 第六步：修改 `package.json` scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "build:cf": "npx opennextjs-cloudflare build",
    "preview:cf": "npx opennextjs-cloudflare preview",
    "deploy:cf": "npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy",
    "lint": "next lint"
  }
}
```

### 第七步：本地预览测试

```bash
# 1. 先执行普通构建
npm run build

# 2. 再执行 CF 构建
npm run build:cf

# 3. 本地预览
npm run preview:cf
```

预览成功后，终端会显示本地访问地址（默认 `http://localhost:8787`），在浏览器中打开测试所有功能。

### 第八步：设置环境变量（Secrets）

火山引擎 API 密钥不应写在配置文件中，使用 wrangler secrets 设置：

```bash
# 登录 Cloudflare（首次需要）
npx wrangler login

# 设置密钥（会提示输入值）
npx wrangler secret put VOLC_ACCESS_KEY_ID
npx wrangler secret put VOLC_SECRET_ACCESS_KEY
```

### 第九步：创建 R2 缓存桶（如需要）

```bash
npx wrangler r2 bucket create perler-beads-cache
```

> 如果不需要 ISR/SSG 缓存功能（本项目主要是纯客户端应用），可以跳过此步，并在 `wrangler.jsonc` 中移除 `r2_buckets` 配置。

### 第十步：部署

```bash
npm run deploy:cf
```

部署成功后，终端会输出访问 URL，格式类似：
```
https://perler-beads.<your-subdomain>.workers.dev
```

### 第十一步（可选）：绑定自定义域名

1. 进入 Cloudflare Dashboard → Workers & Pages → 选择 `perler-beads`
2. Settings → Triggers → Custom Domains
3. 添加自定义域名（需要域名已托管在 Cloudflare DNS 上）

---

## 5. 注意事项与已知限制

### 5.1 Workers 运行时限制

| 限制项 | Workers Free 计划 | Workers Paid 计划 |
|--------|-------------------|-------------------|
| CPU 时间 | 10ms（免费）/ 30s（付费） | 30s |
| 内存 | 128MB | 128MB |
| 请求体大小 | 100MB | 100MB |
| 单次请求超时 | 无硬性限制 | 无硬性限制 |
| 每天请求数 | 100,000 | 无限 |

### 5.2 `nodejs_compat` 提供的 Node.js API

启用了 `nodejs_compat` 后，Workers 支持以下 Node.js API（本项目的 API 路由用到的都有）：

- `crypto` 模块（`createHmac`, `createHash` 等）
- `Buffer` 类
- `process.env`
- `setTimeout`, `setInterval`

### 5.3 PWA 相关注意

- Service Worker 文件需要从 `.open-next/assets/` 目录正确提供
- 如果 PWA 功能异常，可能需要手动将 `public/sw.js` 和 `public/workbox-*.js` 复制到 `.open-next/assets/` 目录
- PWA 的离线缓存策略在 Edge 环境下行为可能略有不同

### 5.4 `next/image` 优化

如果项目使用了 `<Image>` 组件（`next/image`），需要配置 `unoptimized: true`，因为 Cloudflare 不支持 Vercel 的图片优化 API。搜索项目中的使用：

```bash
grep -r "next/image" src/
```

如果发现使用，在 `next.config.ts` 中添加：

```typescript
const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
};
```

### 5.5 `next/font` 和 `next/link`

这些是纯客户端/构建时功能，在 CF Workers 上正常工作，无需特殊处理。

---

## 6. 成本评估

### 6.1 Cloudflare Workers Free Plan

对于拼豆底稿生成器这种**纯客户端计算 + 一个轻量 API 路由**的应用：

| 资源 | 免费额度 | 本项目预估用量 |
|------|----------|----------------|
| 请求数 | 100,000 次/天 | 远低于此（用户量小时） |
| CPU 时间 | 10ms/请求 | 像素化在客户端完成，服务端只有 AI 优化 API 转发 |
| 带宽 | 无限制 | 主要是静态资源，CF CDN 免费 |

**结论：免费计划完全够用。** 所有重计算（图像像素化、颜色映射）都在浏览器 Canvas 中完成，服务端几乎没有计算压力。

### 6.2 如果 AI 优化功能频繁调用

火山引擎 API 的轮询等待（最长 3 分钟）会占用 Worker 的 CPU 时间。在 Free Plan 下 10ms CPU 时间可能不够。

**解决方案：**
1. 付费升级 Workers Plan（$5/月），CPU 时间提升到 30s
2. 或者将 AI 优化功能改为客户端直接调用火山引擎 API（需要考虑 CORS 和密钥安全）
3. 或者使用 Durable Objects 处理长时间任务（成本更高）

---

## 7. 回退方案

### 7.1 如果 opennextjs-cloudflare 遇到问题

可以回退到 `@cloudflare/next-on-pages`：

```bash
npm install -D @cloudflare/next-on-pages
```

构建命令改为：

```bash
npx @cloudflare/next-on-pages
```

预览命令改为：

```bash
npx wrangler pages dev .vercel/output/static --compatibility-flag=nodejs_compat
```

### 7.2 如果 CF Workers 完全不合适

本项目是纯客户端渲染应用，几乎不需要服务端，以下方案都可以作为备选：

1. **Vercel**（零配置，Next.js 原生支持）
2. **Cloudflare Pages（静态部署）**：`next export` 生成纯静态文件，完全不需要 Worker
3. **GitHub Pages**：导出为静态 HTML
4. **Netlify**：对 Next.js 支持也很好

其中 **Cloudflare Pages 纯静态部署** 最简单——因为本项目的核心功能全部在浏览器端完成，API 路由（AI 优化）可以单独部署为一个 Worker 或迁移到客户端。

---

## 附录 A：完整的 `wrangler.jsonc` 最小配置

不需要 R2/D1 的最小配置（适合本项目）：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": ".open-next/worker.js",
  "name": "perler-beads",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },
  "services": [
    {
      "binding": "WORKER_SELF_REFERENCE",
      "service": "perler-beads"
    }
  ]
}
```

## 附录 B：快速部署检查清单

- [ ] 1. `npm install -D @opennextjs/cloudflare wrangler`
- [ ] 2. `npm uninstall sharp @vercel/analytics`
- [ ] 3. 创建 `wrangler.jsonc`
- [ ] 4. 修改 `next.config.ts`（处理 PWA 兼容）
- [ ] 5. API 路由添加 `export const runtime = 'edge'`
- [ ] 6. `package.json` 添加 CF 相关 scripts
- [ ] 7. `npm run build:cf` 构建成功
- [ ] 8. `npm run preview:cf` 本地预览正常
- [ ] 9. `npx wrangler secret put VOLC_ACCESS_KEY_ID`
- [ ] 10. `npx wrangler secret put VOLC_SECRET_ACCESS_KEY`
- [ ] 11. `npm run deploy:cf` 部署成功
- [ ] 12. 在线验证所有功能正常
- [ ] 13. 绑定自定义域名（可选）








CF部署：

● 构建成功，所有页面都静态导出了。out/ 目录已生成。

● 所有改造完成。总结一下做了什么：

  改造完成

  ┌───────────────────────────────────────────────────────────────────────────────┬──────┐
  │                                     步骤                                      │ 状态 │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ 移除 sharp、@vercel/analytics、next-pwa                                       │ Done │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ 安装 wrangler                                                                 │ Done │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ layout.tsx 移除 <Analytics />                                                 │ Done │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ next.config.ts 重写：output: 'export' + images: { unoptimized: true }         │ Done │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ API 路由迁移：src/app/api/ai-optimize/route.ts → functions/api/ai-optimize.ts │ Done │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ tsconfig.json 排除 functions/ 目录                                            │ Done │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ package.json 添加 pages:dev / pages:deploy scripts                            │ Done │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ .gitignore 添加 .dev.vars 和 .open-next/                                      │ Done │
  ├───────────────────────────────────────────────────────────────────────────────┼──────┤
  │ npm run build 静态导出验证通过                                                │ Done │
  └───────────────────────────────────────────────────────────────────────────────┴──────┘

  后续使用

  本地开发预览（含 Pages Function）：
  # 创建 .dev.vars 文件填入密钥
  echo "VOLC_ACCESS_KEY_ID=xxx" > .dev.vars
  echo "VOLC_SECRET_ACCESS_KEY=xxx" >> .dev.vars

  npm run pages:dev

  部署到 Cloudflare Pages：
  npm run build && npm run pages:deploy
  或直接将 GitHub 仓库连接到 Cloudflare Pages Dashboard，设置构建命令为 npm run build，输出目录为 out。环境变量在
  Dashboard 的 Settings → Environment Variables 中设置。


  ❯ 请问 api 的 cf function功能也应该部署了吗？

● 是的，wrangler pages deploy out 会同时部署：

  - 静态文件：out/ 目录中的 HTML/CSS/JS
  - Pages Functions：functions/ 目录中的 serverless 函数（即你的 api/ai-optimize）

  不需要额外操作，Pages 会自动识别 functions/ 目录并部署为 Functions。out/ 里没有的路径（如
  /api/ai-optimize）会自动路由到对应的 Pages Function 处理。

  部署前记得在 Cloudflare Dashboard（Pages 项目 → Settings → Environment Variables）中添加 VOLC_ACCESS_KEY_ID 和
  VOLC_SECRET_ACCESS_KEY 两个环境变量，因为 .dev.vars 只用于本地开发。


  ● 已修复。现在改为读取 NEXT_PUBLIC_OFFICIAL_DOMAIN 环境变量，未设置则完全跳过重定向。

  使用方式：在 .env.local 或构建环境中设置：
  NEXT_PUBLIC_OFFICIAL_DOMAIN=https://liang.348349.xyz/

  不设置则不会重定向，CF Pages 临时域名可以正常访问。
  