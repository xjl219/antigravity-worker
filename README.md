# antigravity-worker

Cloudflare Worker adapter for an authorized Google Code Assist / Antigravity-compatible upstream.

> **目标**：把 Antigravity-compatible 的账号管理、OAuth、Code Assist 调用和 OpenAI / Anthropic 兼容接口部署成一个 Cloudflare Worker。
>
> **合规边界**：本项目不创建 Google quota、不绕过 Google entitlement、不提供规避账号/配额限制的机制。每个账号都必须由账号所有者正常授权并使用其自身可用的服务额度。

## 1. 傻瓜式部署：推荐方式

最简单的生产部署方式是：

**GitHub + GitHub Actions + Cloudflare Workers**

你只需要做一次配置，之后发布新版本只需要：

```bash
git tag v0.1.0
git push origin v0.1.0
```

然后 GitHub Actions 会自动：

1. 安装依赖
2. TypeScript 检查
3. 单元测试
4. 部署 Cloudflare Worker
5. 如果配置了 `DEPLOYED_WORKER_URL`，自动访问 `/health` 做 Smoke Test

当前部署工作流：`.github/workflows/deploy.yml`

---

# 2. 第一次部署前，你需要准备什么

准备以下 4 类东西：

| 项目 | 用途 | 是否上传 Git |
|---|---|---|
| Cloudflare Account | Worker / Durable Object 所在账户 | 不需要 |
| Cloudflare API Token | GitHub Actions 自动部署 | **GitHub Secret** |
| Google OAuth Client | Google 账号授权登录 | Cloudflare Secret |
| Worker 配置 | 上游地址、默认模型等 | `wrangler.jsonc` |

---

# 3. Cloudflare 配置

## 3.1 创建 Cloudflare API Token

进入 Cloudflare Dashboard：

**My Profile → API Tokens → Create Token**

建议使用最小权限原则，只授予当前 Worker 所需的 Workers 部署权限。

创建后得到：

```text
CLOUDFLARE_API_TOKEN
```

同时准备：

```text
CLOUDFLARE_ACCOUNT_ID
```

Account ID 可以在 Cloudflare Dashboard 对应 Account 的概览页面找到。

> API Token 只保存到 GitHub Secrets，不要写入 `.env`、`wrangler.jsonc` 或 Git。

---

# 4. GitHub Secrets 配置

进入：

**GitHub → xjl219/antigravity-worker → Settings → Secrets and variables → Actions**

添加以下 Secrets：

| Secret | 必填 | 作用 |
|---|---:|---|
| `CLOUDFLARE_API_TOKEN` | 是 | GitHub Actions 部署 Worker |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare Account ID |
| `ADMIN_API_KEY` | 是 | Worker 管理接口/API 鉴权 |
| `GOOGLE_CLIENT_ID` | 是 | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | 是 | Google OAuth Client Secret |
| `TOKEN_ENCRYPTION_KEY` | 是 | Durable Object 中 OAuth token 的 AES-GCM 加密密钥 |
| `DEPLOYED_WORKER_URL` | 推荐 | 部署后的 Worker 基础 URL，用于自动 `/health` Smoke Test |

其中：

```text
DEPLOYED_WORKER_URL
```

例如：

```text
https://antigravity-worker.example.workers.dev
```

**不要填写最后的 `/health`。**

如果暂时不配置 `DEPLOYED_WORKER_URL`，部署仍然会成功，只是 GitHub Actions 会跳过 Smoke Test。

---

# 5. 生成 ADMIN_API_KEY

建议生成一个高熵随机字符串。

例如本地执行：

```bash
openssl rand -base64 32
```

把输出保存为：

```text
ADMIN_API_KEY
```

所有管理接口和当前兼容 API 都使用它进行鉴权。

请求示例：

```http
Authorization: Bearer YOUR_ADMIN_API_KEY
```

---

# 6. 生成 TOKEN_ENCRYPTION_KEY

这个密钥用于加密 Durable Object 中保存的 Google OAuth access token / refresh token。

建议：

```bash
openssl rand -base64 32
```

把结果作为：

```text
TOKEN_ENCRYPTION_KEY
```

### 非常重要

这个密钥一旦用于生产环境：

- 不要提交 Git
- 不要随意修改
- 不要因为重新部署而重新生成
- 修改后历史账号 token 可能无法解密

也就是说：

```text
TOKEN_ENCRYPTION_KEY
        ↓
生产数据的一部分
        ↓
必须长期保存
```

---

# 7. 创建 Google OAuth Client

Google OAuth 用于让用户正常授权自己的 Google 账号。

进入 Google Cloud Console：

**APIs & Services → Credentials → Create Credentials → OAuth client ID**

选择适合 Web 应用的 OAuth Client。

创建后获得：

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
```

---

# 8. Google OAuth 回调地址

假设你的 Worker 地址是：

```text
https://antigravity-worker.example.workers.dev
```

Google OAuth Authorized redirect URI 必须配置：

```text
https://antigravity-worker.example.workers.dev/oauth/google/callback
```

代码会根据实际请求 URL 构造 callback，不需要把域名硬编码进 TypeScript。

### 注意

下面两个地址不是一回事：

```text
Worker 首页
https://antigravity-worker.example.workers.dev/

OAuth callback
https://antigravity-worker.example.workers.dev/oauth/google/callback
```

Google OAuth 必须填写第二个。

---

# 9. Worker 配置文件

生产配置位于：

```text
wrangler.jsonc
```

当前配置：

```jsonc
{
  "name": "antigravity-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-18",
  "compatibility_flags": ["nodejs_compat"],

  "vars": {
    "GOOGLE_CODE_ASSIST_BASE_URL": "https://daily-cloudcode-pa.googleapis.com",
    "GOOGLE_OAUTH_REDIRECT_PATH": "/oauth/google/callback",
    "PUBLIC_BASE_URL": "https://CHANGE-ME.workers.dev",
    "DEFAULT_MODEL": "gemini-2.5-flash"
  }
}
```

---

# 10. 所有配置项说明

## 10.1 Worker / Cloudflare

### `name`

Worker 名称。

当前：

```text
antigravity-worker
```

如果修改，Cloudflare Worker 名称也会随之改变。

---

### `main`

Worker 入口：

```text
src/index.ts
```

通常不要修改。

---

### `compatibility_date`

Cloudflare Workers Runtime compatibility date。

当前：

```text
2026-09-18
```

不要为了追求“最新”而随意修改。Runtime 行为变化应该经过 CI 和 Smoke Test 验证。

---

## 10.2 Google Code Assist

### `GOOGLE_CODE_ASSIST_BASE_URL`

Google Code Assist upstream 基础地址。

当前：

```text
https://daily-cloudcode-pa.googleapis.com
```

代码会自动补充：

```text
/v1internal
```

并包含备用 endpoint。

如果 Google 服务端地址发生变化，应首先修改这个配置，而不是修改业务代码。

---

## 10.3 OAuth

### `GOOGLE_OAUTH_REDIRECT_PATH`

OAuth callback 路径：

```text
/oauth/google/callback
```

一般不要修改。

最终 callback：

```text
https://YOUR_WORKER_HOST/oauth/google/callback
```

---

### `PUBLIC_BASE_URL`

当前代码已经可以根据实际请求 URL 自动构造 OAuth redirect。

因此它不是 OAuth callback 构造的核心依赖。

为了兼容现有配置，目前仍保留：

```text
PUBLIC_BASE_URL
```

如果后续确认没有任何其他用途，可以从配置中删除。

---

## 10.4 默认模型

### `DEFAULT_MODEL`

客户端没有传 `model` 时使用的默认模型。

当前：

```text
gemini-2.5-flash
```

例如：

```json
{
  "messages": [
    {
      "role": "user",
      "content": "hello"
    }
  ]
}
```

会使用：

```text
DEFAULT_MODEL
```

如果客户端明确传：

```json
{
  "model": "..."
}
```

则使用请求中的模型。

---

# 11. Worker Secrets 与 wrangler vars 的区别

这是第一次部署最容易搞错的地方。

## 可以放在 wrangler.jsonc

非敏感配置：

```text
GOOGLE_CODE_ASSIST_BASE_URL
GOOGLE_OAUTH_REDIRECT_PATH
PUBLIC_BASE_URL
DEFAULT_MODEL
```

## 必须使用 Secret

敏感配置：

```text
ADMIN_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
```

不要把下面这些写进 `wrangler.jsonc`：

```text
ADMIN_API_KEY
GOOGLE_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
OAuth refresh token
OAuth access token
```

---

# 12. 一键发布

完成上述配置以后：

```bash
git add .
git commit -m "release: v0.1.0"
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

GitHub Actions 自动执行：

```text
Tag v0.1.0
    ↓
Checkout
    ↓
npm ci
    ↓
npm run check
    ↓
npm test
    ↓
wrangler deploy
    ↓
/health Smoke Test
    ↓
PASS
```

以后版本只需要：

```bash
git tag v0.1.1
git push origin v0.1.1
```

---

# 13. 不想打 Tag？手工一键发布

进入：

**GitHub → Actions → Deploy → Run workflow**

点击：

```text
Run workflow
```

GitHub 会直接执行相同的：

```text
check → test → deploy → smoke test
```

---

# 14. 本地直接部署

如果不使用 GitHub Actions，也可以本地部署。

先安装：

```bash
npm install
```

登录 Cloudflare：

```bash
npx wrangler login
```

然后配置 Secrets：

```bash
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

最后：

```bash
npm run check
npm test
npm run deploy
```

---

# 15. 本地开发

复制：

```text
.dev.vars.example
```

为：

```text
.dev.vars
```

填写：

```dotenv
ADMIN_API_KEY="your-admin-key"
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
TOKEN_ENCRYPTION_KEY="your-encryption-key"
```

启动：

```bash
npm run dev
```

---

# 16. 健康检查

部署完成后：

```bash
curl https://YOUR_WORKER_HOST/health
```

预期返回：

```json
{"ok":true}
```

如果 GitHub Secret 配置了：

```text
DEPLOYED_WORKER_URL
```

GitHub Actions 会自动执行这个检查。

---

# 17. Google OAuth 登录

打开：

```text
https://YOUR_WORKER_HOST/oauth/google/start
```

当前实现要求管理鉴权，因此需要携带：

```http
Authorization: Bearer YOUR_ADMIN_API_KEY
```

浏览器实际使用时，需要通过你的管理客户端/请求方式携带授权头。

OAuth 流程：

```text
Worker
  ↓
Google OAuth
  ↓
用户登录 Google
  ↓
用户授权
  ↓
/oauth/google/callback
  ↓
exchange code
  ↓
获取 access_token + refresh_token
  ↓
加密保存到 Durable Object
  ↓
账户进入 AccountPool
```

---

# 18. Account Pool

账号池使用 Cloudflare Durable Object SQLite 保存：

- Google 账号
- 加密 access token
- 加密 refresh token
- access token 过期时间
- 账号状态
- health score
- failure count
- cooldown
- sticky session
- OAuth pending state
- refresh lock

Worker 不直接把 refresh token 返回给客户端。

---

# 19. OpenAI 兼容接口

地址：

```text
POST /v1/chat/completions
```

请求：

```bash
curl https://YOUR_WORKER_HOST/v1/chat/completions \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": "hello"
      }
    ],
    "stream": true
  }'
```

---

# 20. Anthropic 兼容接口

地址：

```text
POST /v1/messages
```

请求：

```http
Authorization: Bearer YOUR_ADMIN_API_KEY
Content-Type: application/json
```

当前实现包含 Anthropic Messages / SSE 的兼容层。

由于 Anthropic thinking、tool use、thought signature 等字段与上游协议存在强耦合，生产环境应该以真实 upstream smoke test 结果作为最终验证，而不是仅依赖 TypeScript 编译。

---

# 21. 管理接口

### 查看账号

```text
GET /admin/accounts
```

### 查看账号 quota

```text
GET /admin/accounts/:id/quota
```

这些接口需要：

```http
Authorization: Bearer YOUR_ADMIN_API_KEY
```

---

# 22. 一键发布前检查清单

第一次部署只需要检查：

- [ ] Cloudflare Account ID
- [ ] Cloudflare API Token
- [ ] GitHub Secret `CLOUDFLARE_API_TOKEN`
- [ ] GitHub Secret `CLOUDFLARE_ACCOUNT_ID`
- [ ] GitHub Secret `ADMIN_API_KEY`
- [ ] GitHub Secret `GOOGLE_CLIENT_ID`
- [ ] GitHub Secret `GOOGLE_CLIENT_SECRET`
- [ ] GitHub Secret `TOKEN_ENCRYPTION_KEY`
- [ ] Google OAuth redirect URI
- [ ] `DEPLOYED_WORKER_URL`（推荐）
- [ ] `wrangler.jsonc` 中 upstream / model 配置确认

然后：

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

# 23. 发布失败怎么处理

## CI TypeScript 失败

看：

```text
Actions → Deploy
```

不要直接修改 Cloudflare。

必须先修复：

```text
npm run check
```

---

## Unit Test 失败

本地执行：

```bash
npm test
```

确认通过后再发布。

---

## Wrangler deploy 失败

重点检查：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

以及 Token 是否具有当前 Worker 的部署权限。

---

## Smoke Test 失败

如果：

```text
wrangler deploy
```

成功但：

```text
/health
```

失败，说明：

```text
Cloudflare 部署成功
≠
Worker 服务正常
```

检查：

- Worker URL
- Cloudflare Worker 状态
- `DEPLOYED_WORKER_URL`
- Worker runtime logs

---

# 24. 生产环境建议

建议生产环境采用：

```text
main
 ↓
CI
 ↓
tag vX.Y.Z
 ↓
Deploy
 ↓
Smoke Test
 ↓
Production
```

不要直接把：

```text
git push main
```

绑定生产部署。

这样可以保证：

```text
代码提交
≠
生产发布
```

而：

```text
明确版本
=
明确生产版本
```

---

# 25. 当前架构

```text
Client
   │
   ▼
Cloudflare Worker
   │
   ├── /oauth/google/start
   ├── /oauth/google/callback
   ├── /admin/accounts
   ├── /admin/accounts/:id/quota
   ├── /v1/chat/completions
   ├── /v1/messages
   └── /health
   │
   ▼
AccountPool Durable Object
   │
   ├── SQLite
   ├── OAuth state
   ├── encrypted token
   ├── refresh lock
   ├── health
   ├── cooldown
   └── sticky session
   │
   ▼
Google Code Assist / Antigravity upstream
```

---

# 26. 安全注意事项

### 不要提交

```text
.dev.vars
access token
refresh token
ADMIN_API_KEY
GOOGLE_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
CLOUDFLARE_API_TOKEN
```

### 不要把 token 打进日志

尤其不要：

```text
console.log(accessToken)
console.log(refreshToken)
Authorization header
```

### 不要共享生产 ADMIN_API_KEY

建议不同环境使用不同 key。

---

# 27. 当前能力边界

当前版本重点覆盖：

- Google OAuth PKCE
- encrypted token storage
- access token refresh
- Durable Object account pool
- account health / cooldown
- quota lookup
- OpenAI-compatible chat
- OpenAI-compatible streaming
- Anthropic Messages compatibility
- Anthropic SSE
- GitHub Actions 自动检查
- Cloudflare 自动部署
- 部署后 health smoke test

Antigravity 上游属于服务控制协议，客户端行为、endpoint、header、模型和协议字段都可能发生变化。

因此：

**CI 绿色 = 代码质量检查通过。**

**Smoke Test 绿色 = Worker 已部署并能正常响应健康检查。**

**真正的 Google/Antigravity E2E 可用 = 还必须使用真实授权账号完成实际 upstream 请求验证。**

不要把这三件事混为一谈。

---

# 28. 最短操作版

如果你已经有：

- Cloudflare Account
- Cloudflare API Token
- Google OAuth Client

那么只做：

### GitHub Secrets

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ADMIN_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
TOKEN_ENCRYPTION_KEY
DEPLOYED_WORKER_URL
```

### Google OAuth

添加：

```text
https://YOUR_WORKER_HOST/oauth/google/callback
```

### 发布

```bash
git tag v0.1.0
git push origin v0.1.0
```

然后等待：

```text
✓ npm ci
✓ npm run check
✓ npm test
✓ wrangler deploy
✓ /health
✓ Production
```

**以后发布新版本只需要：**

```bash
git tag v0.1.1
git push origin v0.1.1
```

