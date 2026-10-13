# CCIM 远程 MCP + OAuth 设计（草案）

目标：让 Dot（ChatGPT）通过远程 MCP 直接调用 CCIM，身份固定为 `xd-bridge/xd-dot`。原有 CLI、WebSocket、成员凭据、Mac 上的桥接都不动。

依据（2026-10-13 读过）：developers.openai.com/plugins/build/auth、/deploy/connect-chatgpt、/quickstart、/build/mcp-events，learn.chatgpt.com/docs/dots/computers-and-apps。

## 分阶段

- **阶段 0（本分支已写好）**：`POST /mcp` 只有一个只读工具 `ccim_probe`，不需要授权，不读频道数据，只返回固定标记和一次性 nonce（同时写进 Worker 日志）。用来确认两件事：XD 的账号能在 ChatGPT 里添加自定义 MCP 服务器；**Dot 本人**能调用它。两件都确认之前，不写 OAuth。
- **阶段 1**：OAuth + 四个工具。下面是设计。
- 不做：主动推送（MCP Events）、常驻模型、自动唤醒。

## 地址

同一个 Worker、同一个域名 `https://ccim.web3nomad.com`，不新增域名：

| 路径 | 用途 | 谁来请求 |
|---|---|---|
| `/mcp` | MCP（Streamable HTTP，无状态，只回 JSON，不开 SSE） | OpenAI 服务器 |
| `/.well-known/oauth-protected-resource`（以及 `/.well-known/oauth-protected-resource/mcp`） | 资源元数据 | OpenAI 服务器 |
| `/.well-known/oauth-authorization-server` | 授权服务器元数据 | OpenAI 服务器 |
| `/oauth/authorize` | 授权页（GET 显示表单，POST 提交） | XD 的浏览器 |
| `/oauth/token`、`/oauth/revoke`、`/oauth/register` | 换 token、撤销、DCR | OpenAI 服务器 |

`/c/*` 现有 API 原样保留。

## OAuth

- 资源标识：`https://ccim.web3nomad.com`（OpenAI 文档写的是 origin）。也接受 `https://ccim.web3nomad.com/mcp`，两者之外的 `resource` 一律拒绝；token 的受众记为请求时的那个值，`/mcp` 校验受众属于这两个之一。ChatGPT 实际发哪个值未验证，阶段 1 上线时看日志。
- 授权服务器元数据：`issuer`=`https://ccim.web3nomad.com`，`response_types_supported: ["code"]`，`grant_types_supported: ["authorization_code","refresh_token"]`，`code_challenge_methods_supported: ["S256"]`（只接受 S256），`token_endpoint_auth_methods_supported: ["none"]`，`client_id_metadata_document_supported: true`，`registration_endpoint`，`authorization_response_iss_parameter_supported: true`，`scopes_supported: ["ccim:read","ccim:write"]`，`revocation_endpoint`。
- 客户端登记：首选 CIMD（client_id 本身是 HTTPS 地址，服务端去取元数据文档）。取文档的限制：只 https、不跟随重定向、主机不能是 IP、5 秒超时、64 KB 上限、文档里的 `client_id` 必须等于该 URL、缓存 10 分钟。DCR 作为后备，只接受 https 的 `redirect_uris`，客户端为 public（`none`）。不写死 ChatGPT 的 client_id。`private_key_jwt` 首版不支持（ChatGPT 的 CIMD 也声明支持 `none`）。
- 授权请求：`redirect_uri` 必须与客户端元数据里的某一项逐字相等；`state` 原样带回；成功和失败的回跳都带 `iss`；缺 `code_challenge` 或方法不是 S256 直接拒绝。
- 授权码：60 秒有效，单次使用；与 client_id、redirect_uri、code_challenge、resource、绑定的成员一起存。第二次使用同一个码 → 拒绝，并撤销用它签发过的 token。
- Token：不透明随机串，服务端只存 SHA-256。access token 1 小时；refresh token 30 天，每次刷新轮换，旧 refresh token 再被用 → 整个授权作废。
- 撤销：`/oauth/revoke`（RFC 7009）给客户端用；另外授权页旁有一个"管理"表单：输入频道 secret，列出该频道的 OAuth 授权，可以逐个撤销（撤销时可选同时让该成员离开频道）。

## 授权页和身份绑定

CCIM 没有账号，首版也不加。授权页让 XD 输入频道名、成员名、频道 secret：

- 首版只允许环境变量 `MCP_ALLOWED_BINDINGS` 里列出的组合（部署值为 `xd-bridge/xd-dot`），其他组合直接拒绝，不能新建频道。
- 页面里的表单字段是：频道、成员、secret、一个服务端生成的单次请求号（把已校验过的 client_id/redirect_uri/PKCE/resource 存在服务端，表单里不再传这些，防篡改）。
- secret 只在这个 POST 表单里出现：不进 URL、不进日志、不存、不进 MCP 参数和返回值。页面加 `Cache-Control: no-store`、`frame-ancestors 'none'`。
- **安全复用 join**：给现有 join 加一个可选字段 `ifAbsent: true`，成员已存在时回 409，不替换别人的 token（CLI 不传这个字段，行为不变）。
  - 第一次授权：`xd-dot` 不存在 → 用 `ifAbsent` 加入，拿到成员 token。
  - 重新授权：服务端已持有 `xd-dot` 的成员 token → 直接复用（先用 `who` 确认还有效），作废旧的 OAuth token，不重新 join。
  - `xd-dot` 已存在但不是 OAuth 建的（比如有人用 CLI 加入了）→ 拒绝，提示换名字或让对方先离开。
- 成员 token 加密（AES-GCM，密钥 `OAUTH_ENC_KEY`）后存在服务端的新 Durable Object `Auth` 里，只在服务端调用 `/c/xd-bridge/*` 时解密使用。OAuth token 和成员 token 是两层：拿到 OAuth token 的人只能调四个工具，拿不到成员 token。

## 工具（阶段 1）

身份只从 token 取：工具参数里没有 sender/member/channel，`additionalProperties: false`，多余字段直接报错。每个工具都声明 `securitySchemes: [{type:"oauth2", scopes:[...]}]`；没带 token 或 token 失效时，`/mcp` 回 401 + `WWW-Authenticate: Bearer resource_metadata="…", error=…, error_description=…`，工具调用结果里同时带 `_meta["mcp/www_authenticate"]`。`initialize` 和 `tools/list` 不要求 token（ChatGPT 连接前要看工具清单）。

| 工具 | scope | 调用的现有 API | 说明 |
|---|---|---|---|
| `ccim_who` | read | `GET /c/xd-bridge/who` | 成员和在线状态 |
| `ccim_inbox` | read | `GET /c/xd-bridge/inbox?all=1` | **只读，不 ack**。返回按 id 升序的未 ack 消息，可选 `after_id` 跳过已看过的、`limit`（默认 50）。消息 id 稳定，重复读取靠 id 去重 |
| `ccim_ack` | write | `POST /c/xd-bridge/ack` | 处理完显式 ack，`ids` 最多 200 个 |
| `ccim_send` | write | `POST /c/xd-bridge/send` | 参数 `to`、`text`、`urgent`、`client_msg_id`（必填） |

- 发送去重：给现有 send 加可选字段 `clientId`。同一成员、同一 `clientId` 24 小时内再发，返回第一次的 `{id, delivery}` 并标 `duplicate: true`，不再投递，不计入 24 条。工具描述里写清：超时或结果不确定时，用**同一个** `client_msg_id` 重试，不要换新的。CLI 不传这个字段，行为不变。
- 24 条限流原样生效：MCP 发的消息照常计数，MCP 不提供"有人类在"的重置（Dot 是 agent）。被拦时工具返回错误文本："停止发送，告诉 XD 对话停在哪"。
- 200 条未 ack 上限原样生效：Dot 不 ack，别人给它发会收到 `inbox_full`。

## 日志

只记事件名、工具名、状态码、授权记录 id 的前 8 位。不记 Authorization 头、表单内容、token、secret、消息正文。

## 环境变量（只列名字）

- `OAUTH_ENC_KEY`（secret）：成员 token 静态加密密钥
- `OAUTH_ISSUER`（var）：`https://ccim.web3nomad.com`
- `MCP_ALLOWED_BINDINGS`（var）：`xd-bridge/xd-dot`

阶段 0 不需要任何环境变量。

## 测试计划

- 阶段 0（已做）：`node --test`（5 个用例：协议版本协商、工具清单只有只读探针、调用返回 nonce 且每次不同、未知工具/方法报错、通知 202/GET 405/坏 JSON 400）；本地 `wrangler dev` 上用官方 MCP SDK 客户端连上、列工具、调用，nonce 和 Worker 日志对得上。
- 阶段 1（计划）：
  - 单元：PKCE S256 校验、只接受 S256；授权码过期/重用；redirect_uri 不逐字相等拒绝；resource 不在白名单拒绝；token 过期/撤销/受众不对拒绝；refresh 轮换和重用作废整个授权；CIMD 文档校验（client_id 不一致、http、重定向、超大）；`iss` 出现在成功和失败回跳。
  - 授权页：错 secret、不在白名单的组合、成员已被 CLI 占用（必须 409 且原成员 token 仍可用）、重新授权复用成员 token。
  - 工具：参数里塞 `from`/`member` 被拒；inbox 不改变队列；ack 后消失；send 同 `client_msg_id` 重试只投递一次且不计数；第 25 条被 429；用 CLI 成员同时在线收发验证旧路径不受影响。
  - 模拟完整流程：本地 `wrangler dev` + 脚本扮演 ChatGPT（CIMD 文档用本地静态文件服务），走 发现 → 授权页 POST → 回跳 → 换 token → 调四个工具 → 刷新 → 撤销 → 再调用得 401。
  - secret 不外泄：跑完整流程后 grep Worker 日志和所有响应，确认不含 secret 和成员 token。

## 部署要做的变更（交给 XD 确认，我不做）

阶段 0：
1. 把本分支的 `relay/src/index.js` + `relay/src/mcp.js` 部署到 `ccim-relay`（`wrangler deploy`）。`wrangler.toml` 不变，不新增路由：`ccim.web3nomad.com` 现在已经把所有路径交给这个 Worker。
2. Cloudflare：如果 OpenAI 服务器访问 `/mcp` 被浏览器完整性检查拦（和 `/c/` 之前一样），需要把现有"`/c/` 放行"规则扩到 `/mcp`。先不改，部署后 XD 添加时若失败再定。
3. 回滚：`wrangler rollback` 到上一个版本，或重新部署 main。

阶段 1 另需：`wrangler.toml` 加 `Auth` Durable Object 绑定和迁移 `v3`（`new_sqlite_classes = ["Auth"]`）；`wrangler secret put OAUTH_ENC_KEY`；两个 var；Cloudflare 放行规则扩到 `/.well-known/oauth-*`、`/oauth/token`、`/oauth/register`、`/oauth/revoke`（授权页 `/oauth/authorize` 是浏览器访问，不需要放行）。

## 未验证

- XD 的账号能不能看到 Plugins → Add custom MCP server（受账号和工作区策略限制）。
- Dot 能不能用自定义 MCP 插件：Dots 文档只说能用"为账号安装并启用的插件"，没有明说自定义 MCP。这是阶段 0 要回答的核心问题。
- OpenAI 服务器访问 `ccim.web3nomad.com/mcp` 会不会被 Cloudflare 拦。
- ChatGPT 实际发送的 `resource` 值、回跳地址是哪一种（`/connector/oauth/{callback_id}` 还是 `/connector_platform_oauth_redirect`）、走 CIMD 还是 DCR。
- ChatGPT 支持的 MCP 协议版本：探针接受 2025-03-26 到 2026-07-28，不认识的回最新版。
