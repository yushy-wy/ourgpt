# ChatGPT Plus 反代实施方案

> 当前（2026-10-28）：账号是 Free。Codex OAuth 后端返回 401，普通网页 API 被 Turnstile 风控 403；
> 已用 Chrome CDP 驱动网页 UI 打通 `chatgpt-web`（50–70 秒/请求、无工具调用），只适合个人低频。
> 拿到 Plus 后按本文切到原生通道：秒级响应、支持工具调用。

## 1. 前置确认

- 账号套餐是 Plus/Pro（网页左下角或升级页可见）
- 本机网络能访问 `auth.openai.com` 与 `chatgpt.com/backend-api`（走系统代理 18081 即可）

## 2. 原生通道切换步骤（约 10 分钟）

1. `codex login` 完成浏览器 OAuth，生成 `~/.codex/auth.json`
   - **必须验证 `tokens.refresh_token` 非空**：Free 时期手工注入的 auth.json 缺这个，会在数小时后 token 过期即失效
   - `node -e "const t=require('os').homedir()+'/.codex/auth.json';console.log(!!JSON.parse(require('fs').readFileSync(t,'utf8')).tokens?.refresh_token)"`
2. `config/upstreams.json` 加 `chatgpt` 上游（`adapters/chatgpt.js` 已就绪，读同一个 auth.json、自动刷新 token）：
   ```json
   "chatgpt": { "adapter": "chatgpt", "models": ["gpt-5.5"], "auth_file": "~/.codex/auth.json" }
   ```
   模型名以账号可用为准，先用 `gpt-5.5`，再按 `/v1/models` 与实测校准
3. `npm start`，跑网关自测：`POST /v1/responses` 应 200；ledger 出现 `upstream=chatgpt`
4. Codex CLI 实测（**必须带 `NO_PROXY=127.0.0.1,localhost`**，见 §5）
5. 员工分发：控制台"创建 key"发内部 key，Base URL 用 `/admin/info` 里自动探测的局域网地址

### 验收标准

- Codex CLI 走网关完成一个需要读写文件 + 执行命令的真实任务，工具调用不掉链子

## 3. 多账号池（撞墙转移，对应 README §5 Phase 2）

- `auth.json` 扩展成账号数组：`config/accounts.json`，每项 `{ name, auth_file }`
- `adapters/chatgpt.js` 增加选号逻辑：识别 429 / `usage_limit` / `plan` 类错误 → 切下一个账号重发本轮，**把已生成内容保留在上下文**（不丢半截输出）
- 每日 1-token 探针检查各账号可用性与剩余额度，失败在控制台标红并告警
- 账号被停 = 全员断供：控制台需要一眼看出哪个上游掉了

## 4. 服务器侧出网代理

Node 的 `fetch` **不走系统代理**。chatgpt adapter 直连 chatgpt.com 会失败，需要二选一：

- 把网关部署在可直连 OpenAI 的机器上（最干净）
- 或在 adapter 里显式挂代理：装 `undici`，`setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY))`，网关启动带 `HTTPS_PROXY=http://127.0.0.1:18081`

## 5. 客户端侧代理坑（已实测）

- Codex CLI 指向本机网关时**必须设 `NO_PROXY=127.0.0.1,localhost`**：否则系统代理（18081）会介入本地请求、把 HTTP 头结束符混进请求体，网关报 `Unterminated string` 400
- CC Switch 的 provider 配置里同样注意本地回环不要走代理

## 6. 合规与风险（决策者需书面确认，README §8）

- 订阅凭证跨人共享违反 OpenAI ToS；团队规模 >1 人时这是"要不要做"的核心前提
- 单点故障：网关或账号挂 = 全员停工；保留 L0 回退（CC Switch 手动切号）
- Plus/Pro 额度由网页与 Codex 共享，重度使用会互相挤占——这是池化调度存在的意义，但不是凭空造额度
