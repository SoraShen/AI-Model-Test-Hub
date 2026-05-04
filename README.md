# AI Model Test Hub

一个用于 **模型能力测试 + 指标对比 + 流式输出** 的 Web App，支持：

- **响应式**：完整适配手机浏览器（iPhone / Android），桌面侧边栏在移动端折叠为汉堡菜单抽屉
- **Test**：单模型测试（文本 / 音频 / 图片 / 视频），支持 **SSE 流式输出** 与基础指标（Latency / TTFT / Tokens / TPS）
- **Agent Playground**：组合管线测试（LLM / ASR→LLM / OMNI），支持 Prompt、麦克风/上传输入、流式输出
  - LLM 下拉框现在也支持选择 **OMNI** 模型（自动开启文件 / 麦克风 / 英文语音回复控件）
  - OMNI 模型支持**只输入文本**也能拿到英文语音回复（适合 chatbot 场景）
  - 语音回复支持**实时流式播放**（Web Audio API，边生成边播放）
- **Models**：管理模型配置（endpoint / type / api key），**API Key 只在后端保存并加密落库**
- **History**（仅 admin 可见）：保存每次测试 / Agent 调用的输入与输出，按用户隔离

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
  - `ASR`：音频输入 → 文本输出
  - `OMNI`：文本 / 音频 / 图片 / 视频输入 → 文本（可选语音）输出，支持流式播放
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

> **务必先做一次：把 `platform.db` 从 git 追踪移除**（见下方“一次性修复”）。
> 当前仓库历史里追踪了 `platform.db`，直接 `git pull` 会**用仓库里的 DB 覆盖服务器上的生产 DB**（用户、历史、API Key 全丢，且 API Key 用本机 `ENCRYPTION_KEY` 加密过，覆盖后即使 DB 文件回来了密文也对不上）。

### 标准更新流程

> 假设：应用目录 `/opt/ai-model-test-hub`，PM2 进程名 `ai-model-test-hub`，端口 `PORT=4000`（或 3000，按你机器实际配置）。

```bash
cd /opt/ai-model-test-hub

# 1) 备份生产数据库与环境变量（强烈建议）
mkdir -p backups
cp -p platform.db   backups/platform.db.$(date +%Y%m%d-%H%M%S)
cp -p .env.local    backups/.env.local.$(date +%Y%m%d-%H%M%S) 2>/dev/null || true

# 2) 暂存服务器上的任何本地改动（保险，未提交的修改不会丢）
git stash push -u -m "pre-update $(date +%F-%H%M)" || true

# 3) 拉取最新代码
git fetch --all --prune
git checkout main
git pull --ff-only origin main

# 4) 如果仓库还在追踪 platform.db（首次升级前会发生），把刚刚备份的生产 DB 还原回来
LATEST_DB=$(ls -t backups/platform.db.* 2>/dev/null | head -n1)
[ -n "$LATEST_DB" ] && cp -p "$LATEST_DB" platform.db

# 5) 装依赖（lockfile 没变就基本是 no-op；变了才会装新包）
npm ci

# 6) 构建前端（生产模式下 server.ts 会直接 serve dist/）
npm run build

# 7) 重启 PM2 进程，并让新环境变量生效
pm2 restart ai-model-test-hub --update-env
pm2 save

# 8) 健康检查
pm2 logs ai-model-test-hub --lines 80   # 看到 "Server running on http://localhost:<PORT>" 即可
ss -lntp | egrep ':4000|:3000|:80|:443'
curl -i http://127.0.0.1:4000/api/me     # 期望返回 401（未登录），证明应用起来了
```

> 数据库迁移会在每次启动时自动跑（见 `db.ts` 里的 `migrateExpandModelTypes` / `migrateFixBrokenModelForeignKeys` / `migrateModelTemplates` / `migrateAndEncryptExternalKeys`），不需要手工干预。

### 一次性修复：把 `platform.db` 从 git 中剔除

为避免每次 `git pull` 都要走第 4 步“还原 DB”，在**本地开发机**上做一次：

```bash
# 在本地仓库
git rm --cached platform.db
printf "\nplatform.db\nplatform.db-journal\n*.db.bak.*\n" >> .gitignore
git add .gitignore
git commit -m "chore: untrack platform.db so production DB is not overwritten by git pull"
git push origin main
```

之后服务器再 `git pull` 就不会再触碰 `platform.db` 了，标准更新流程可以省略第 4 步。

### 回滚（出问题时）

```bash
cd /opt/ai-model-test-hub
# 回滚代码到上一个提交（或某个具体 commit）
git reset --hard HEAD~1

# 还原最近一次备份的 DB
LATEST_DB=$(ls -t backups/platform.db.* | head -n1) && cp -p "$LATEST_DB" platform.db

npm ci
npm run build
pm2 restart ai-model-test-hub --update-env
```

### 仅前端样式/组件改动时的最简流程

如果你只改了 `src/` 里的纯前端代码（没动 `server.ts` / `db.ts` / 依赖），可以省到只两步：

```bash
cd /opt/ai-model-test-hub && git pull --ff-only && npm run build && pm2 restart ai-model-test-hub
```

