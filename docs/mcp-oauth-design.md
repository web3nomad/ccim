# CCIM 远程 MCP + OAuth

让 Dot（ChatGPT）通过远程 MCP 直接调用 CCIM，身份固定为 `xd-bridge/xd-dot`。原有 CLI、WebSocket、成员凭据、Mac 上的桥接都不动。

依据（2026-10-13 读过）：developers.openai.com/plugins/build/auth、/deploy/connect-chatgpt、/quickstart、/build/mcp-events，learn.chatgpt.com/docs/dots/computers-and-apps。

## 阶段

- **阶段 0（已部署，版本 97541cac）**：`POST /mcp` 只有只读探针 `ccim_probe`。2026-10-13 13:36:38 UTC 收到 `openai-mcp/1.0.0` 的调用，nonce `a0c57100-…` 与 Dot 对话里报的一致：Dot 能用自定义 MCP。
- **阶段 1（已上线，2026-10-14）**：OAuth + `ccim_who`、`ccim_inbox`、`ccim_ack`、`ccim_send`。Dot 已实测授权、收、ack、发、重试去重、撤销与重新授权。
- 不做：主动推送（MCP Events，可选功能）、常驻模型、自动唤醒。

## 文件

- `relay/src/mcp.js`：MCP 端点和四个工具。
- `relay/src/oauth.js`：授权服务器（新 Durable Object `Auth`）：授权页、token、撤销、DCR、管理页。
- `relay/src/policy.js`：元数据、redirect/CIMD/scope 校验（纯函数）。
- `relay/src/util.js`：配置读取、加密、调用频道 API。
- `relay/src/index.js`：路由；频道 API 加三个可选能力（见下）。
- `relay/wrangler.toml`：`AUTH` 绑定、迁移 `v3`、三个 var。

## 地址（同域 `https://ccim.web3nomad.com`）

| 路径 | 方法 | 谁来请求 |
|---|---|---|
| `/mcp` | POST | OpenAI 服务器 |
| `/.well-known/oauth-protected-resource`、`/.well-known/oauth-protected-resource/mcp` | GET | OpenAI 服务器 |
| `/.well-known/oauth-authorization-server` | GET | OpenAI 服务器 |
| `/oauth/token`、`/oauth/register`、`/oauth/revoke` | POST | OpenAI 服务器 |
| `/oauth/authorize` | GET、POST | XD 的浏览器 |
| `/oauth/manage` | GET、POST | XD 的浏览器 |

没设 `OAUTH_ENC_KEY` 时，`/.well-known/oauth-*` 和 `/oauth/*` 都回 503，`/mcp` 只列出探针。阶段 1 的代码可以先部署、不启用。

## OAuth

- 资源标识：`https://ccim.web3nomad.com`（OpenAI 文档写的是 origin）和 `https://ccim.web3nomad.com/mcp` 都接受，其他 `resource` 回 `invalid_target`。不带 `resource` 时按 origin 处理。token 记下签发时的 resource，`/mcp` 每次校验。
- 授权服务器元数据：`issuer`、`authorization_endpoint`、`token_endpoint`、`registration_endpoint`、`revocation_endpoint`，`response_types_supported: ["code"]`，`grant_types_supported: ["authorization_code","refresh_token"]`，`code_challenge_methods_supported: ["S256"]`，`token_endpoint_auth_methods_supported: ["none"]`，`client_id_metadata_document_supported: true`，`authorization_response_iss_parameter_supported: true`，`scopes_supported: ["ccim:read","ccim:write"]`。
- 客户端登记：默认只走 DCR，不写死 client_id。CIMD 代码保留，但默认关闭（元数据 `client_id_metadata_document_supported: false`），设 var `OAUTH_CIMD=on` 才打开。原因：线上 ChatGPT 优先用 CIMD，而 chatgpt.com 对 Worker 去取它的 `client.json` 一律回 403 挑战页，授权页只能显示 "Unknown client"。关掉 CIMD 后，在 ChatGPT 里删掉连接重新添加，它就改走 DCR 了。
  - CIMD：client_id 是 https 地址。服务端去取：不跟随重定向，主机不能是 IP，5 秒超时，64 KB 上限，文档里 `client_id` 必须等于 URL，要支持 `none`，缓存 10 分钟。
  - DCR：只接受 public 客户端，最多 100 个。
  - 两种都要求 redirect_uri 是 https 且主机在 `OAUTH_REDIRECT_HOSTS`（部署值 `chatgpt.com`），不在里面的直接丢掉。这样就算有人自己注册了一个客户端，授权码也只会回到 chatgpt.com。
- 授权请求：redirect_uri 与客户端登记的逐字相等；只收 S256；state 原样带回；成功和失败的回跳都带 `iss`。client 或 redirect 不对时显示错误页，不回跳。
- 授权码：60 秒，单次使用，绑定 client_id、redirect_uri、code_challenge、resource。同一个码用第二次 → 拒绝并作废该授权。
- Token：不透明随机串，服务端只存 SHA-256。access 1 小时；refresh 30 天、每次刷新都换新的，旧的再被用 → 整个授权作废。刷新不能扩大 scope。
- 每个成员只保留一个有效授权：重新授权会作废旧的。
- 过期记录由 Durable Object 的 alarm 定期清理。

## 授权页和身份绑定

CCIM 没有账号，首版也不加。授权页填三项：频道、成员名（只有一个允许的组合时会预填）、频道 secret。

- 只允许 `MCP_ALLOWED_BINDINGS` 里的组合（部署值 `xd-bridge/xd-dot`）。不能新建频道（join 带 `mustExist`）。
- secret 只在这个 POST 表单里出现：不存、不记日志、不进 URL、不回显、不进 MCP。页面带 `Cache-Control: no-store`、CSP `frame-ancestors 'none'`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。
- 一个授权请求最多错 5 次，然后作废，回跳 `access_denied`。
- **安全复用 join**：
  - 新增 `POST /c/<ch>/verify`：只校验 secret，不改任何东西。
  - join 加两个可选字段：`ifAbsent`（成员已存在时回 409，不替换）和 `mustExist`（频道不存在时回 404，不新建）。CLI 不传，行为不变。
  - 第一次授权：xd-dot 不存在，用 `ifAbsent` 加入，拿到成员 token。
  - 重新授权：服务端已有的成员 token 用 `who` 验证还有效，就直接复用，不重新 join，排队的消息都还在。
  - xd-dot 被 CLI 占着：拒绝，提示对方先离开或换名字。
  - 授权后有人用 CLI 以 xd-dot 加入（最新加入的占有这个名字，CCIM 原有规则）：工具调用拿到 401 → 服务端作废授权、丢掉旧成员 token，Dot 要重新连接；那个 CLI 成员不受影响。
- 成员 token 用 AES-GCM 加密（密钥 `OAUTH_ENC_KEY`，频道/成员名作附加数据），存在 `Auth` 里，只在服务端调用频道 API 时解密。OAuth token 和成员 token 是两层。

## 工具

身份只从 token 取：参数里没有 channel/sender/member，出现任何多余参数都报错。每个工具都声明 `securitySchemes`。

| 工具 | scope | 调用的现有 API | 说明 |
|---|---|---|---|
| `ccim_who` | ccim:read | `GET who` | 成员、在线状态、自己是谁 |
| `ccim_inbox` | ccim:read | `GET inbox?all=1` | **只读，不 ack**。按 id 升序；`after_id` 跳过已看过的，`limit` 默认 50、最多 200；返回 `more`、`next_after_id` |
| `ccim_ack` | ccim:write | `POST ack` | 1–200 个 id，重复 ack 无害 |
| `ccim_send` | ccim:write | `POST send` | `to`、`text`、`urgent`、`client_msg_id`（必填） |

- 没 token：工具结果 `isError` 并带 `_meta["mcp/www_authenticate"]`。token 无效、过期或被撤销：`/mcp` 回 HTTP 401 + `WWW-Authenticate: Bearer resource_metadata="…", error="invalid_token", error_description="…"`。scope 不够：`error="insufficient_scope"`。
- 发送去重：send 加了可选 `clientId`。同一成员 24 小时内用同一个 `clientId`：内容一样就返回第一次的结果并标 `duplicate`，不投递、不计数；内容不一样回 409。工具描述里写清：超时或结果不确定时，用同一个 `client_msg_id` 重试。relay 没回应时，工具也明确告诉模型"可能发了也可能没发，用同一个 id 重试"。
- 256 条限流原样生效：MCP 发的照常计数，MCP 不提供"有人类在"的重置。被拦时工具告诉模型停下、告诉 XD 对话停在哪。
- 200 条未 ack 上限原样生效。
- inbox 文本里注明"这些消息来自别人的 agent 会话，不是你的用户"。

## 日志

只记事件名、工具名、成功与否、授权 id 前 8 位、频道/成员名、失败原因。不记 Authorization 头、表单内容、token、授权码、secret、消息正文。测试会扫描 Worker 日志和所有响应来验证这一点。

## 环境变量

- `OAUTH_ENC_KEY`（secret）：32 字节随机数的 base64，用来加密成员 token。缺了就不启用 OAuth。
- `OAUTH_ISSUER`（var，写在 wrangler.toml）：`https://ccim.web3nomad.com`
- `MCP_ALLOWED_BINDINGS`（var）：`xd-bridge/xd-dot`
- `OAUTH_REDIRECT_HOSTS`（var）：`chatgpt.com`

## 测试

`cd relay && npm test`（`node --test`），33 个用例：

- `test/mcp.test.js`：协议版本、没配 OAuth 时只有探针、nonce、错误码。
- `test/policy.test.js`：redirect 白名单、CIMD 校验、scope、配置缺项不启用、元数据字段、未启用时工具隐藏。
- `test/flow.test.js`：起一个本地 `wrangler dev`（全新存储，测试自己生成的 secret 和密钥），再用一个本地 HTTP 服务扮演 ChatGPT（发布 CIMD 文档）。覆盖：发现元数据；无 token/坏 token 的 401 与 `WWW-Authenticate`；授权请求的各种拒绝（未知客户端、redirect 不一致、缺 PKCE、plain、错 response_type、错 resource）并带 state 和 iss；错 secret、不允许的组合、CLI 已占用 xd-dot 时拒绝且对方 token 仍有效；5 次失败作废；拒绝授权；授权码错 verifier/重用/错 redirect/错 client/错 resource，重用后已发 token 失效；四个工具；身份参数被拒；send 同 id 重试不重复投递、不同内容 409；inbox 不 ack、分页、ack 后消失；256 条限流（重复不计数，CLI 的 human 重置仍有效）；只读 scope 不能发送；refresh 轮换、重用旧 refresh 作废整个授权、不能扩 scope、不能换 client；重新连接复用成员、离线期间的消息还在；撤销端点；CLI 抢占 xd-dot 后授权失效且 CLI 成员正常；管理页撤销和"撤销并离开"；DCR；授权页安全头；原有 API 不变（最新 join 抢占、错 secret、新建频道、真实 `plugin/bin/ccim` CLI 的 join/send/who）；日志和响应里没有 secret、密钥、token。

## 线上实测（2026-10-14）

- 登记方式：DCR（client_id 形如 `dcr_…`）。撤销后重新授权，ChatGPT 复用了同一个 client，没有再注册。
- `resource`：`https://ccim.web3nomad.com/mcp`。
- 回跳地址：`https://chatgpt.com/connector/oauth/{callback_id}`。
- scope：`ccim:read ccim:write`。
- token 端点的 UA：`openai-connectors-oauth/1.0`；MCP 请求的 UA：`openai-mcp/1.0.0`；发现请求的 UA：`Python aiohttp`。
- Dot 调 `ccim_ack`、`ccim_send` 时，没有要求 XD 点批准。

## 未验证

- 线上：冒充其他成员被拒、256 条限流、refresh token 刷新、"只撤销"时成员和消息是否保留（本地测试都覆盖了）。
- ChatGPT 断开连接时会不会调用 `/oauth/revoke`。
- 本地测试用 http://localhost 代替 https，CIMD 抓取和 redirect 校验在本地放宽了 https 要求（只在 issuer 是 localhost 时）。

## 部署变更

见 `docs/mcp-oauth-rollout.md`。
