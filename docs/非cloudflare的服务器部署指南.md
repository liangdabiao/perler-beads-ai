# 拼豆底稿生成器 — 普通服务器部署指南

## 目录

1. [项目技术架构分析](#1-项目技术架构分析)
2. [部署方案对比](#2-部署方案对比)
3. [方案一：静态部署（Nginx/Apache）](#3-方案一静态部署nginxapache)
4. [方案二：Node.js 生产服务器部署](#4-方案二nodejs-生产服务器部署)
5. [方案三：Docker 部署](#5-方案三docker-部署)
6. [AI 优化功能配置](#6-ai-优化功能配置)
7. [HTTPS 配置指南](#7-https-配置指南)
8. [生产环境清单](#8-生产环境清单)
9. [常见问题排查](#9-常见问题排查)

---

## 1. 项目技术架构分析

### 1.1 技术栈

| 项目 | 版本 | 说明 |
|------|------|------|
| 框架 | Next.js 15.3.6 | App Router 模式 |
| 运行时 | React 19 | 客户端渲染为主 |
| 样式 | Tailwind CSS 4 | PostCSS 构建 |
| 目标输出 | 静态导出 (output: "export") | 生成纯静态文件 |
| 图片处理 | 客户端 Canvas API | 无需服务端处理 |
| AI 功能 | 火山引擎 API | 客户端调用 |

### 1.2 部署特点

本项目**核心是纯客户端应用**：

- `next.config.ts` 配置了 `output: "export"`，构建输出为纯静态 HTML/CSS/JS
- 所有页面组件都使用 `'use client'` 指令
- 没有服务端渲染 (SSR) 依赖
- 唯一的外部依赖是 AI 优化 API（火山引擎），通过客户端直接调用

### 1.3 构建产物

执行 `npm run build` 后生成：

```
.next/
├── static/                    # 静态资源
│   └── chunks/               # JS/CSS 分块
├── media/                    # 图片资源
└── out/                      # 最终静态输出（用于部署）
    ├── _next/
    ├── page.html
    └── ...
```

---

## 2. 部署方案对比

| 方案 | 优点 | 缺点 | 推荐场景 |
|------|------|------|----------|
| **静态部署 (Nginx)** | 简单、高性能、低内存 | 无服务端能力 | 纯展示、无 API 需求 |
| **Node.js 服务** | 支持 API 路由、灵活 | 需要进程管理 | 需要扩展、AI 功能 |
| **Docker** | 环境隔离、可移植 | 学习成本 | 微服务、集群部署 |
| **PM2 + Nginx** | 进程管理、负载均衡 | 配置复杂 | 正式生产环境 |

**推荐**：对于本项目，**方案一（静态部署 Nginx）** 或 **方案二（PM2 + Nginx）** 最为合适。

---

## 3. 方案一：静态部署（Nginx/Apache）

这是最简单的部署方式，适合不需要服务端 API 的场景。

### 3.1 构建静态文件

```bash
# 安装依赖
npm install

# 构建静态文件
npm run build
```

构建完成后，静态文件在 `out/` 目录。

### 3.2 Nginx 配置

创建 Nginx 配置文件：

```nginx
# /etc/nginx/sites-available/perler-beads

server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名或 IP

    # 重定向 HTTP 到 HTTPS（可选）
    # return 301 https://$server_name$request_uri;
    
    root /var/www/perler-beads/out;
    index index.html;

    # Gzip 压缩
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    gzip_min_length 1000;

    # 静态资源缓存
    location /_next/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    # SPA fallback（重要：确保路由正确）
    location /page {
        try_files $uri $uri/ /page.html;
    }
}
```

### 3.3 部署步骤

```bash
# 1. 创建部署目录
sudo mkdir -p /var/www/perler-beads

# 2. 复制构建产物
sudo cp -r out/* /var/www/perler-beads/

# 3. 启用站点
sudo ln -s /etc/nginx/sites-available/perler-beads /etc/nginx/sites-enabled/

# 4. 测试配置
sudo nginx -t

# 5. 重载 Nginx
sudo systemctl reload nginx
```

### 3.4 Apache 配置

如果使用 Apache，创建 `.htaccess` 文件在 `out/` 目录：

```apache
# out/.htaccess
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteBase /
    RewriteRule ^index\.html$ - [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_FILENAME} !-l
    RewriteRule . /index.html [L]
</IfModule>

# Gzip 压缩
<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/plain text/css application/json application/javascript
</IfModule>

# 缓存设置
<IfModule mod_expires.c>
    ExpiresActive On
    ExpiresByType text/css "access plus 1 year"
    ExpiresByType application/javascript "access plus 1 year"
</IfModule>
```

---

## 4. 方案二：Node.js 生产服务器部署

如果需要后续扩展 API 功能或使用 PM2 进行进程管理，选择此方案。

### 4.1 环境要求

- Node.js 18.x 或 20.x
- npm 9.x
- 内存：最低 512MB

### 4.2 安装 Node.js

```bash
# 使用 nvm 安装（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# 验证安装
node --version  # 应显示 v20.x.x
npm --version
```

### 4.3 构建项目

```bash
# 进入项目目录
cd /path/to/perler-beads-master

# 安装依赖
npm install

# 构建（静态导出模式）
npm run build
```

### 4.4 使用 PM2 管理进程

PM2 是 Node.js 生产环境推荐的进程管理器：

```bash
# 安装 PM2
npm install -g pm2

# 创建 PM2 配置文件 ecosystem.config.js
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'perler-beads',
    script: 'node_modules/next/dist/bin/next',
    args: 'start -p 3000',
    cwd: '/path/to/perler-beads-master',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
EOF

# 创建日志目录
mkdir -p logs

# 启动服务
pm2 start ecosystem.config.js

# 保存进程列表
pm2 save

# 设置开机自启
pm2 startup
```

### 4.5 Nginx 反向代理配置

```nginx
# /etc/nginx/sites-available/perler-beads

server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名

    # HTTPS 配置（见第七章）
    # ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # 静态资源由 Nginx 直接服务
    location /_next/static {
        proxy_pass http://127.0.0.1:3000;
        proxy_cache_valid 200 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### 4.6 PM2 常用命令

```bash
pm2 status              # 查看进程状态
pm2 logs perler-beads   # 查看日志
pm2 restart perler-beads  # 重启
pm2 stop perler-beads   # 停止
pm2 delete perler-beads # 删除
pm2 monit               # 监控面板
```

---

## 5. 方案三：Docker 部署

适合需要环境隔离或已在使用 Docker 的场景。

### 5.1 创建 Dockerfile

```dockerfile
# Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# 复制依赖文件
COPY package*.json ./
RUN npm ci

# 复制源码
COPY . .

# 构建
RUN npm run build

# 生产镜像
FROM node:20-alpine

WORKDIR /app

# 安装 production 依赖
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# 复制构建产物
COPY --from=builder /app/out ./out
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

# 启动命令（静态服务）
CMD ["npx", "serve", "-s", "out", "-l", "3000"]
```

### 5.2 创建 docker-compose.yml

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    container_name: perler-beads
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
    networks:
      - perler-network

  nginx:
    image: nginx:alpine
    container_name: perler-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./certificates:/etc/nginx/certs:ro
    depends_on:
      - app
    networks:
      - perler-network

networks:
  perler-network:
    driver: bridge
```

### 5.3 创建 nginx.conf

```nginx
# nginx.conf
upstream perler_app {
    server app:3000;
}

server {
    listen 80;
    server_name localhost;

    location / {
        proxy_pass http://perler_app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 5.4 部署命令

```bash
# 构建并启动
docker-compose up -d --build

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

---

## 6. AI 优化功能配置

本项目的 AI 优化功能使用火山引擎（字节跳动）即梦 API。

### 6.1 获取 API 密钥

1. 访问 [火山引擎控制台](https://console.volcengine.com/)
2. 注册/登录账号
3. 创建访问密钥 (Access Key)
4. 获取 `VOLC_ACCESS_KEY_ID` 和 `VOLC_SECRET_ACCESS_KEY`

### 6.2 环境变量配置

#### 方案 A：客户端直接调用（当前实现）

AI 优化功能已通过 Web Crypto API 实现，密钥存储在前端代码中（火山引擎支持）。

**优点**：无需服务端中转
**缺点**：密钥暴露在前端（建议创建受限的 API Key）

#### 方案 B：自建 API 代理（更安全）

如需更强的安全性，可以通过自建 Node.js API 代理请求火山引擎：

```javascript
// api/ai-proxy.js
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));

app.post('/api/ai-proxy', async (req, res) => {
  const { imageBase64, ...options } = req.body;
  
  try {
    // 你的火山引擎密钥
    const config = {
      headers: {
        'Content-Type': 'application/json',
        // 添加你的认证头
      }
    };
    
    const response = await axios.post(
      'https://visual.volcengineapi.com',
      { image: imageBase64, ...options },
      config
    );
    
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001);
```

---

## 7. HTTPS 配置指南

生产环境强烈建议启用 HTTPS。

### 7.1 使用 Let's Encrypt 免费证书

```bash
# 安装 Certbot
sudo apt update
sudo apt install certbot python3-certbot-nginx

# 获取证书（Nginx）
sudo certbot --nginx -d your-domain.com

# 自动续期测试
sudo certbot renew --dry-run
```

### 7.2 自签名证书（仅限开发/测试）

```bash
# 使用项目中的脚本生成
node scripts/generate-cert.js
```

### 7.3 Nginx HTTPS 配置

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    root /var/www/perler-beads/out;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}

# HTTP 重定向到 HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

---

## 8. 生产环境清单

### 8.1 服务器要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 1 核 | 2 核+ |
| 内存 | 512MB | 1GB+ |
| 磁盘 | 5GB | 20GB+ |
| 带宽 | 1Mbps | 5Mbps+ |
| 系统 | Ubuntu 20.04+ / CentOS 8+ | Ubuntu 22.04 LTS |

### 8.2 部署检查清单

- [ ] 服务器系统已更新 (`apt update && apt upgrade`)
- [ ] Node.js 18+ 已安装
- [ ] PM2 已安装并配置开机自启
- [ ] Nginx 已安装并配置
- [ ] HTTPS 证书已配置
- [ ] 防火墙已开放 80/443 端口
- [ ] 域名已解析到服务器 IP
- [ ] AI API 密钥已配置（如需要）
- [ ] 静态文件已构建并部署
- [ ] 日志目录已创建
- [ ] 监控已配置（PM2 monit / 第三方）

### 8.3 推荐目录结构

```
/var/www/perler-beads/
├── out/                    # Next.js 构建产物
├── logs/                   # 日志目录
├── ecosystem.config.js      # PM2 配置
├── .env                    # 环境变量（不提交到 Git）
└── backups/                # 备份目录
```

### 8.4 环境变量文件 (.env)

```bash
# .env
NODE_ENV=production
PORT=3000
VOLC_ACCESS_KEY_ID=your_access_key_id
VOLC_SECRET_ACCESS_KEY=your_secret_access_key
```

---

## 9. 常见问题排查

### Q1: 页面显示空白

**可能原因**：
- 静态文件路径配置错误
- 路由 fallback 未正确配置

**解决方案**：
```nginx
# 确保 Nginx 配置了 try_files
location / {
    try_files $uri $uri/ /index.html;
}
```

### Q2: 静态资源 404

**可能原因**：
- `_next` 目录路径错误
- Nginx 未正确代理静态请求

**解决方案**：
```nginx
location /_next/ {
    alias /var/www/perler-beads/out/_next/;
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

### Q3: PM2 进程崩溃

**检查日志**：
```bash
pm2 logs perler-beads --lines 100
```

**常见原因**：
- 端口被占用
- 内存不足
- Node.js 版本不兼容

### Q4: HTTPS 证书失效

**续期 Let's Encrypt 证书**：
```bash
sudo certbot renew
sudo systemctl reload nginx
```

### Q5: 内存占用过高

**优化 PM2 内存限制**：
```javascript
// ecosystem.config.js
max_memory_restart: '512M'  // 降低限制
```

### Q6: 构建失败

**检查依赖**：
```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```

---

## 附录：快速部署脚本

一键部署脚本（Ubuntu/Debian）：

```bash
#!/bin/bash
set -e

# 变量配置
APP_DIR="/var/www/perler-beads"
GIT_REPO="https://github.com/liangdabiao/perler-beads.git"

echo "=== 开始部署拼豆底稿生成器 ==="

# 1. 安装依赖
echo "[1/6] 安装系统依赖..."
apt update && apt install -y nodejs npm nginx certbot python3-certbot-nginx

# 2. 安装 PM2
echo "[2/6] 安装 PM2..."
npm install -g pm2

# 3. 克隆/更新代码
echo "[3/6] 获取代码..."
if [ -d "$APP_DIR" ]; then
    cd $APP_DIR && git pull
else
    git clone $GIT_REPO $APP_DIR
fi

# 4. 构建
echo "[4/6] 构建项目..."
cd $APP_DIR
npm install
npm run build

# 5. 配置 PM2
echo "[5/6] 配置 PM2..."
cat > $APP_DIR/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'perler-beads',
    script: 'node_modules/next/dist/bin/next',
    args: 'start -p 3000',
    cwd: '/var/www/perler-beads',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
EOF

# 6. 启动服务
echo "[6/6] 启动服务..."
pm2 start $APP_DIR/ecosystem.config.js
pm2 save
pm2 startup

echo "=== 部署完成 ==="
echo "访问 http://your-server-ip:3000"
```

---

## 参考资料

- [Next.js 官方部署文档](https://nextjs.org/docs/app/guides/deployment)
- [PM2 官方文档](https://pm2.keymetrics.io/docs/usage/pm2-doc-single-page/)
- [Nginx 配置最佳实践](https://www.nginx.com/resources/wiki/start/)
- [Let's Encrypt 官方文档](https://letsencrypt.org/getting-started/)
