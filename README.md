# AI Model Test Hub

一个用于 **模型能力测试 + 指标对比 + 流式输出** 的 Web App，支持：

- **Test**：单模型测试（文本 / 音频），支持 **SSE 流式输出** 与基础指标（Latency / TTFT / Tokens / TPS）
- **Agent Playground**：组合管线测试（LLM、ASR→LLM、OMNI），支持 Prompt、音频输入（上传/麦克风）、以及流式输出
- **Models**：管理模型配置（endpoint / type / api key），**API Key 只在后端保存并加密落库**
- **History**：保存测试记录

---

## 技术架构

- **Frontend**：Vite + React + Tailwind
- **Backend**：Express + TypeScript（同一个进程里同时提供 API 与前端静态资源）
- **DB**：SQLite（`platform.db`，使用 `better-sqlite3`）
- **Streaming**：Server-Sent Events（`text/event-stream`）
- **Secrets**：模型 API Key 使用 **AES-256-GCM** 加密后存入 SQLite（依赖 `ENCRYPTION_KEY`）

---

## 快速开始（本地运行）

### 依赖

- Node.js 18+（建议 20+）

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量（必须）

```bash
cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

把上面生成的值写入 `.env.local`：

- **`ENCRYPTION_KEY`**：用于加密存储模型 API Key（base64，32 bytes）
- **`JWT_SECRET`**：用于登录会话签名（建议随机长串）

> 注意：`.env.local` 会被 git 忽略（见 `.gitignore`），不要提交到仓库。

### 3) 启动

```bash
npm run dev
```

默认监听：

- App：`http://localhost:3000`

默认账号（首次启动会自动 seed 到 DB）：

- **admin / admin123**
- **user / user123**

---

## 模型配置（在哪里填 endpoint / key）

进入页面的 **Models** Tab：

- **`name`**：外部 API 的 `model` 名（例如 `deepseek-v4-flash`、`qwen3-asr-flash`）
- **`type`**：
  - `LLM`：文本输入 → 文本输出
  - `ASR`：音频输入 → 文本输出（也用于 “音频理解/omni” 类模型）
- **`endpoint`**：请求地址（部分 provider 支持 base URL，会自动补齐 DashScope 的 `/chat/completions`）
- **`api_key`**：仅在后端保存，写入 DB 前会加密

内置模板（首次启动自动插入，key 为空需要你在 Models 里补）：

- Alibaba DashScope（Qwen）：`qwen3-asr-flash`、`qwen3-omni-30b-a3b-captioner`、`qwen3-omni-flash`
- HuggingFace Whisper：`whisper-large-v3`
- Huawei ModelArts MaaS DeepSeek：`deepseek-v4-flash`

---

## Streaming（流式输出）说明

- 前端通过 SSE 逐帧接收 `delta` 并增量渲染
- 为避免词粘连：**不会 trim SSE data 的前导空格**
- 部分模型（例如 `qwen3-omni-flash`）要求强制 streaming
- Whisper（HuggingFace Router）不支持 streaming：UI 会自动禁用 Streaming

---

## 生产部署（华为云 Flexus L，推荐：PM2 + Nginx）

下面以 **Linux（Ubuntu/Debian）** 为例，假设你要把服务跑在 **3000** 端口并由 Nginx 反代。

### 1) 服务器安装依赖

```bash
sudo apt update
sudo apt install -y git nginx build-essential python3
```

安装 Node.js 20+（用你习惯的方式：nvm / apt / NodeSource 均可），并确认：

```bash
node -v
npm -v
```

### 2) 拉取代码并安装

```bash
sudo mkdir -p /opt/ai-model-test-hub
sudo chown -R $USER:$USER /opt/ai-model-test-hub
cd /opt/ai-model-test-hub

git clone <YOUR_REPO_URL> .
npm ci
```

### 3) 配置 `.env.local`（服务器上新建）

```bash
cp .env.example .env.local
nano .env.local
```

至少配置：

- `ENCRYPTION_KEY=...`
- `JWT_SECRET=...`

### 4) 构建前端

```bash
npm run build
```

### 5) 用 PM2 常驻运行（以生产模式启动）

本项目在 `NODE_ENV=production` 时会直接服务 `dist/`（见 `server.ts`）。

```bash
sudo npm i -g pm2
NODE_ENV=production pm2 start "npm run dev" --name ai-model-test-hub
pm2 save
pm2 startup
```

### 6) Nginx 反向代理到 3000

创建站点配置：

```bash
sudo nano /etc/nginx/sites-available/ai-model-test-hub
```

示例配置：

```nginx
server {
  listen 80;
  server_name your-domain.com;

  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

启用并重载：

```bash
sudo ln -s /etc/nginx/sites-available/ai-model-test-hub /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 7) HTTPS（可选但强烈建议）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 服务器更新发布（最常用）

```bash
cd /opt/ai-model-test-hub
git pull
npm ci
npm run build
pm2 restart ai-model-test-hub
```
