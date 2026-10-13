# CCIM 远程 MCP + OAuth 上线范围

给 XD 和 Codex 审阅用。本文不含任何 secret。设计见 [mcp-oauth-design.md](mcp-oauth-design.md)。

- 代码：分支 `mcp-oauth`。线上目前是阶段 0（版本 `97541cac-02c3-4f7c-8770-360792e95e32`，只有 `ccim_probe`）。
- 本文写到的"已验证"都指本地验证（`wrangler dev --local`、`wrangler deploy --dry-run`、`node --test`），出处标在每条后面。线上一项都没做过。

## 1. 放行矩阵

现有 Configuration Rule（XD 已加）对 `ccim.web3nomad.com` 的 `/c/*` 和 `/mcp` 跳过 Browser Integrity Check（下称 BIC），只按路径匹配，不看方法。

| 路径 | 方法 | 谁来请求 | 跳过 BIC | Worker 的行为 |
|---|---|---|---|---|
| `/c/*` | 现有，不变 | CLI、桥接 | 是（现状） | 不变 |
| `/mcp` | POST（OPTIONS 回 204，其他回 405） | OpenAI 服务器 | 是（现状） | MCP |
| `/.well-known/oauth-protected-resource` | GET | OpenAI 服务器 | **新增** | 资源元数据 |
| `/.well-known/oauth-protected-resource/mcp` | GET | OpenAI 服务器 | **新增** | 同上，resource 带 `/mcp` |
| `/.well-known/oauth-authorization-server` | GET | OpenAI 服务器 | **新增** | 授权服务器元数据 |
| `/oauth/token` | POST | OpenAI 服务器 | **新增** | 换 token、刷新 |
| `/oauth/register` | POST | OpenAI 服务器 | **新增** | DCR |
| `/oauth/revoke` | POST | OpenAI 服务器 | **新增** | 撤销 |
| `/oauth/authorize` | GET、POST | XD 的浏览器 | 否 | 授权页 |
| `/oauth/manage` | GET、POST | XD 的浏览器 | 否 | 管理、撤销页 |
| 其他路径（含 `/`） | 任意 | | 否 | 404 |

不跳过 BIC 的路径，在 Worker 里方法不对也会被拒（405 或 404）。

### 要不要加方法约束

**建议加。** 理由：

- BIC 只对浏览器以外的客户端有意义。被放行的路径越窄，被人拿来刷的面越小。
- 代价很小：只要哪条路径的方法写错，那条请求就会被 BIC 拦下（403 1010），不会放进不该进的东西。出问题时一眼能看出来，改规则即可。
- `/c/*` 保持现在的写法不动（只看路径），避免碰旧桥接。

完整表达式（替换现有那条规则的表达式；动作照旧，只跳过 BIC）：

```
(http.host eq "ccim.web3nomad.com" and (
  starts_with(http.request.uri.path, "/c/")
  or (http.request.uri.path eq "/mcp" and http.request.method in {"POST" "OPTIONS"})
  or (http.request.method eq "GET" and http.request.uri.path in {"/.well-known/oauth-protected-resource" "/.well-known/oauth-protected-resource/mcp" "/.well-known/oauth-authorization-server"})
  or (http.request.method eq "POST" and http.request.uri.path in {"/oauth/token" "/oauth/register" "/oauth/revoke"})
))
```

Cloudflare 的表达式编辑器接受换行；不接受就去掉换行写成一行。

不加方法约束的版本（仅供对照）：

```
(http.host eq "ccim.web3nomad.com" and (starts_with(http.request.uri.path, "/c/") or http.request.uri.path in {"/mcp" "/.well-known/oauth-protected-resource" "/.well-known/oauth-protected-resource/mcp" "/.well-known/oauth-authorization-server" "/oauth/token" "/oauth/register" "/oauth/revoke"}))
```

**未验证：** 表达式语法没在 Cloudflare 上校验过；改完后 OpenAI 服务器访问这些路径是否还会被别的防护拦，也没验证。

## 2. 非秘密配置（写在 `relay/wrangler.toml` 的 `[vars]`）

| 名字 | 拟用值 | 作用 |
|---|---|---|
| `OAUTH_ISSUER` | `https://ccim.web3nomad.com` | issuer、资源标识（也接受 `…/mcp`）、元数据里所有地址的前缀。回跳里的 `iss` 必须与它逐字相等 |
| `MCP_ALLOWED_BINDINGS` | `xd-bridge/xd-dot` | 唯一允许授权的频道/成员 |
| `OAUTH_REDIRECT_HOSTS` | `chatgpt.com` | 允许的回跳主机。OpenAI 文档里的两种回跳地址（`https://chatgpt.com/connector/oauth/{callback_id}`、`https://chatgpt.com/connector_platform_oauth_redirect`）都在这个主机上 |

出处：`wrangler deploy --dry-run` 输出里列出了这三个值和两个 Durable Object 绑定（见第 7 节）。

未验证：ChatGPT 实际用的回跳地址，以及它的客户端元数据文档在不在 chatgpt.com 上。回跳不在 chatgpt.com 时，授权页会显示"Invalid redirect"，不会回跳，此时只需要改这个 var。

## 3. 新的存储对象 `Auth` 和迁移 v3

`wrangler.toml` 新增：

```toml
[[durable_objects.bindings]]
name = "AUTH"
class_name = "Auth"

[[migrations]]
tag = "v3"
new_sqlite_classes = ["Auth"]
```

### 和旧数据怎么隔离

- `Auth` 是一个新的 Durable Object 类。在 Cloudflare 上每个类有自己的命名空间。Worker 只用固定名字 `"auth"` 取一个实例，所有 OAuth 数据都在里面。
- 频道数据仍在 `Channel` 类里，每个频道一个实例，v3 不改它，`v1`、`v2` 迁移也不动。
- `Auth` 不读写 `Channel` 的存储。它只调用频道已有的 HTTP 接口（`verify`、`join`、`who`、`leave`，加上工具用的 `inbox`、`send`、`ack`），在 Worker 内部走，不经公网。CLI 用的也是这些接口。
- 频道 API 新加的三个可选项（`verify` 接口、join 的 `ifAbsent`/`mustExist`、send 的 `clientId`）CLI 都不发，所以 CLI 和桥接的行为不变。
- 在 `Channel` 里只新增一类数据：带 `clientId` 的发送会留一条 24 小时的去重记录（`cid:`、`cidt:` 前缀），只有 MCP 发送会产生。

### 可逆吗

- **v3 是新增一个类，不改动、不删除旧类的数据。**
- **回滚代码不能直接回到 97541cac。** Cloudflare 的回滚文档写明："A Durable Object class lifecycle change … has occurred between the version in the active deployment and the version selected to roll back to" 时会拒绝回滚。v3 就是这种变化。所以 `wrangler rollback 97541cac…` 预计会被拒绝（没在线上试过）。
- 要撤掉 v3，只能再发一次带 `deleted_classes = ["Auth"]` 的迁移 v4。按 Cloudflare 迁移文档，这会永久删除 `Auth` 的全部数据，没有回收站。频道数据不受影响，但 xd-dot 这个频道成员会留下来，没人再持有它的 token（处理办法见第 4 节）。
- 所以真正可行的"回退"是**关掉开关**（第 4 节），代码留在线上。

### 验证证据（都是本地）

- `test/deploy.test.js`："migration v3: this branch starts on the same storage…"：先用 main 分支的代码建频道、成员和一条排队消息，再用本分支代码在**同一份本地存储**上启动。结果：频道、CLI token、排队消息都还在；没设密钥时 OAuth 关闭。
- `test/deploy.test.js`："main's code on storage written by this branch (local only)…"：本分支写过数据后，再用 main 的代码启动，频道 API 照常工作。这只说明旧代码读得懂新代码写的频道数据；**不说明 Cloudflare 会允许回滚**。本地 `wrangler dev` 不执行线上的迁移检查。
- 线上的迁移执行、回滚拒绝、`deleted_classes`：**都没验证**。依据是 Cloudflare 文档。

## 4. `OAUTH_ENC_KEY` 的影响

这把密钥只用来加密服务端保存的 xd-dot 成员 token。OAuth 开关也由它决定：缺这把密钥、或它不是 32 字节，OAuth 就全部关闭。

| 操作 | 已有的 OAuth 授权 | 加密存放的成员 token | xd-dot 未 ack 的消息 | CLI、桥接凭据 | 出处 |
|---|---|---|---|---|---|
| **删除密钥（停用）** | 全部不能用：`/oauth/*`、`/.well-known/oauth-*` 回 503，四个工具从清单中消失、调用报 unknown tool。授权记录还在存储里 | 还在，没被解密也没被删除 | 还在；xd-dot 仍是频道成员，别人还能给它发消息，直到 200 条上限 | 不受影响 | deploy.test.js "key removed…" |
| **放回同一把密钥** | 原授权立即恢复。refresh token 在 30 天内还能用；access token 过了 1 小时就要刷新 | 能解密，照常使用 | 都还在，能读到 | 不受影响 | deploy.test.js "same key A restored…" |
| **换一把不同的密钥** | 下一次调用：成员 token 解不开，服务端删掉它、作废授权，回 401。之后 refresh 也被拒 | 被删除（读不出来） | 还在 xd-dot 的队列里，但没有任何人能读或 ack | 不受影响 | deploy.test.js "different key B…" |

换密钥之后，重新授权会被拒（"已被另一会话占用"）。原因是 xd-dot 仍是频道成员，而安全 join 不会替换已有成员。要恢复：

1. 用 CLI 以 xd-dot 加入一次（最新加入者占有这个名字，CCIM 原有规则），然后 `ccim leave`。这会同时清掉 xd-dot 队列里的消息。
2. 在 ChatGPT 里重新授权。

这条恢复路径在 deploy.test.js "different key B…" 里测过。

### 停用和安全回滚是两回事

- **停用**（已在本地验证）：删除 `OAUTH_ENC_KEY`。OAuth 立即关闭，频道和 CLI 不受影响，数据都留着。放回同一把密钥就恢复。**这是推荐的紧急开关。**
- **代码回滚到 97541cac**：预计被 Cloudflare 拒绝（见第 3 节），**未验证，不能当作安全回滚**。
- **删除 `Auth` 类**（v4 `deleted_classes`）：不可逆，会永久删掉所有 OAuth 数据，**未验证**。不建议，除非决定彻底放弃这个功能。
- 删除密钥只是停用，不会自动撤销 xd-dot 的频道成员身份。如果担心授权记录已泄露，要做的是"撤销并离开"（第 6 节），而不是只删密钥。

注意：密钥是 Worker 的 secret，`wrangler secret put/delete` 会生成一个新的 Worker 版本立即上线，不需要重新部署代码。

## 5. 生成并设置 `OAUTH_ENC_KEY`

在 XD 自己的终端里做。密钥不显示、不写文件、不进 shell 历史、不进聊天：

```sh
cd ~/workspace/misc/ccim/.claude/worktrees/mcp-probe/relay
openssl rand -base64 32 | npx wrangler secret put OAUTH_ENC_KEY
```

- `openssl rand -base64 32` 输出 32 个随机字节的 base64，通过管道直接交给 wrangler，屏幕上不显示。wrangler 在 stdin 不是终端时从 stdin 读值（已在 wrangler 4.134.0 源码 `readFromStdin` 处确认），不会提示输入。
- 命令行里没有密钥本身，所以 shell 历史里只有这条命令。
- 不要先存成文件，也不要 `echo` 出来。
- 确认（只列名字，不显示值）：`npx wrangler secret list` 里应能看到 `OAUTH_ENC_KEY`。
- 这把密钥没有备份。日后如果删掉了想"放回同一把"，前提是当初另外保存过；没保存的话，删除就等于换钥，按第 4 节的"换一把不同的密钥"处理。想保留恢复能力的话，可以改成先生成到密码管理器里，再从密码管理器粘贴到 `npx wrangler secret put OAUTH_ENC_KEY` 的隐藏输入提示里。这个由 XD 决定。

## 6. 真实验收顺序

每一步写了"停下"的条件。出现停止条件就不要往下做，按"怎么退"处理，然后把现象发回来。

**第 0 步：上线前**
- 在 `relay/` 下跑 `npm test`，应 40/40 通过。
- 打开 `wrangler tail ccim-relay`，在第 2 步之后一直开着。

**第 1 步：部署代码（这时 OAuth 还是关的）**
- `cd ~/workspace/misc/ccim/.claude/worktrees/mcp-probe/relay && npx wrangler deploy`
- 检查：
  - `/c/xd-bridge/who`：curl 和 urllib 都是 401。
  - `/mcp` 的 tools/list 只有 `ccim_probe`。
  - `/.well-known/oauth-authorization-server` 回 503。
  - Dot 再调一次 `ccim_probe` 能拿到 nonce。
  - 本机的 ccim 正常收发。
- 停下：`/c/` 行为变了，或 ccim 收发异常，或部署因迁移报错。
- 怎么退：代码还没启用 OAuth，这时的回退就是重新部署 main。这同样跨过了 v3 迁移，预计会被 Cloudflare 拒绝；**未验证**。所以这一步的停止条件出现时，先别动，把现象发回来。

**第 2 步：设置密钥（打开 OAuth）**
- 按第 5 节做。
- 检查：
  - `/.well-known/oauth-authorization-server` 返回 JSON，`issuer` 正好是 `https://ccim.web3nomad.com`。
  - `/mcp` 的 tools/list 有五个工具。
- 停下：返回 503、500，或 issuer 不对。
- 怎么退：`npx wrangler secret delete OAUTH_ENC_KEY`。

**第 3 步：改 Cloudflare 放行规则**
- 换成第 1 节"建议"的表达式。
- 检查（用 urllib）：
  - 三个 `.well-known` 路径 GET 都是 200。
  - `/oauth/token` POST 一个空表单，回 400 和一个 OAuth 错误 JSON（`invalid_request` 或 `unsupported_grant_type`），不是 403 1010。
  - `/` 仍是 1010。
  - `/c/xd-bridge/who` 仍是 401。
- 停下：`/` 或其他路径被放开了，或 `/c/` 变了。
- 怎么退：规则改回现在的表达式。

**第 4 步：在 ChatGPT 里授权**
- Plugins → 加号 → Add custom MCP server。地址填 `https://ccim.web3nomad.com/mcp`，认证选 OAuth，Create as a plugin。
- 点连接后会跳到 `ccim.web3nomad.com` 的授权页。核对页面上写的回跳主机是 `chatgpt.com`；频道 `xd-bridge`、成员 `xd-dot` 是预填的。
- 填频道 secret（在 `~/workspace/misc/bridge/.env` 或 `~/.ccim/config.json` 里，只在这个页面里粘贴），点 Allow，会跳回 ChatGPT。
- `wrangler tail` 里应依次看到：
  - `oauth_register`（只有走 DCR 才会出现；走 CIMD 不会有这条）
  - `oauth_granted`（`member` 是 `xd-bridge/xd-dot`，第一次 `reused` 为 false）
  - `oauth_token`
- 停下：
  - 授权页显示 "Unknown client" 或 "Invalid redirect"。这说明 ChatGPT 的客户端文档或回跳不在预期里。记下 `wrangler tail` 里的请求，可能要改 `OAUTH_REDIRECT_HOSTS`。
  - 页面提示 xd-dot 已被占用：先确认没有别的会话在用这个名字。
  - ChatGPT 报授权失败。
  - 日志出现 `oauth_error`。
- 怎么退：在 ChatGPT 里删掉这个连接；在管理页撤销（见下）。

**第 5 步：Dot 只读调用**
- 在 Dot（不是普通对话）里说：「用 CCIM 调 ccim_who」。
- 应看到 `you = xd-dot`，`wrangler tail` 里有 `mcp_tool` 事件。
- 停下：Dot 看到的身份不是 xd-dot，或调用报授权错误。
- 怎么退：管理页撤销。

**第 6 步：收**
- 本会话执行 `ccim send xd-dot "验收消息"`。
- Dot 调 `ccim_inbox` 应看到它。再调一次，还在（读不 ack）。
- Dot 调 `ccim_ack`，再调 `ccim_inbox`，消失。
- 停下：读一次就消失了（说明自动 ack 了），或 ack 不生效。

**第 7 步：发**
- 让 Dot 调 `ccim_send` 发给 `xd-m5-pro-claude`，本会话应收到，来源是 xd-dot。
- 记下 Dot 每次写操作是否要 XD 点批准。
- 停下：发出的消息来源不是 xd-dot，或发了两遍。

**第 8 步：撤销演练**
- 在 `https://ccim.web3nomad.com/oauth/manage` 里撤销（只点 Revoke），Dot 再调 `ccim_who` 应要求重新连接。
- 重新授权，`oauth_granted` 的 `reused` 应为 true，撤销前的未 ack 消息还在。

### 授权和撤销的日常操作

- **授权**：第 4 步。重新授权会作废同一成员之前的授权（同一时间只保留一个）。
- **只撤销 Dot 的访问**：打开 `https://ccim.web3nomad.com/oauth/manage`，填频道和 secret，点 xd-dot 的 **Revoke**。成员和消息保留，下次授权直接复用。
- **撤销并移出频道**：同一页面点 **Revoke and leave channel**。xd-dot 退出频道，它的未 ack 消息一起删掉。
- **ChatGPT 侧断开**：在 ChatGPT 里删掉连接。ChatGPT 会不会调用我们的 `/oauth/revoke` **未验证**，所以断开后再去管理页撤销一次。
- **紧急全部停用**：`npx wrangler secret delete OAUTH_ENC_KEY`（第 4 节）。

## 7. 验证出处

全部是本地验证。`cd relay && npm test` 跑了 40 个用例，40 个全过，0 失败。

- **`test/deploy.test.js`（7 个）**：同一份本地存储，按顺序换着起不同的代码和配置。
  - main 的代码 → 本分支、不设密钥 → 设密钥 A → 删密钥 → 放回 A → 换成密钥 B → 再回到 main 的代码。
  - 用例名：
    - "main's code creates a channel…"
    - "migration v3: this branch starts on the same storage…"
    - "with key A…"
    - "key removed…"
    - "same key A restored…"
    - "different key B: grant ends cleanly (401, no 500)…"
    - "main's code on storage written by this branch (local only)…"
- **`test/flow.test.js`（22 个）**：本地 relay 加一个扮演 ChatGPT 的本地服务，走完整 OAuth 和四个工具（细节见设计文档"测试"一节）。和本文相关的几个：
  - "authorization request validation"：redirect 逐字匹配、只收 S256、resource 白名单、state 和 iss。
  - "code exchange: PKCE, single use…"
  - "refresh rotates…"
  - "revocation endpoint ends the grant"
  - "manage page…"
  - "existing channel API unchanged…"：包括用真实 `plugin/bin/ccim` 跑 join、send、who。
  - "no secret or OAuth token appears in the relay log…"
- **`test/policy.test.js`（6 个）**：redirect 主机白名单、CIMD 校验、配置缺项时 OAuth 不开、元数据字段、OAuth 关闭时工具隐藏。
- **`test/mcp.test.js`（5 个）**：MCP 协议基础行为。
- **`wrangler deploy --dry-run`（wrangler 4.134.0）**：打包 57.27 KiB（gzip 15.98 KiB）。绑定为 `env.CHANNEL (Channel)`、`env.AUTH (Auth)`，以及三个 var，值和第 2 节一致。没有上传任何东西。
- **Cloudflare 文档**（2026-10-13 读过）：
  - [rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)：跨 Durable Object 类变化的回滚会被拒。
  - [migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)：删除类会永久删除其数据。

## 8. 未验证汇总

- 线上执行 v3 迁移，以及之后 `wrangler rollback 97541cac` 是否真的被拒（依据是文档，没实测）。
- `deleted_classes` 的实际效果。
- 第 1 节的表达式在 Cloudflare 上的语法，以及放行后 OpenAI 服务器能不能访问到这些路径。
- ChatGPT 走 CIMD 还是 DCR、实际发的 `resource` 值、实际用的回跳地址，以及 Worker 能否取到它的 CIMD 文档。
- ChatGPT 是否接受不透明 token、断开连接时会不会调用 `/oauth/revoke`。
- Dot 做写操作时是否每次都要 XD 批准。
- `wrangler secret put` 从管道读值：只在 wrangler 源码里确认过，没实际运行（不能用真密钥测）。
