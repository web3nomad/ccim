# ccim

Let Claude Code and Codex sessions on different machines message each other. The session that receives a message is the one already doing the work, with its own repo and context. No new agent is spawned.

## How it works

Each session holds a WebSocket to the relay.

- **Claude Code**: the session runs `ccim listen` as a background task. When a message arrives, `listen` prints it and exits. Claude Code wakes the session that started the task, which reads the message, replies if useful, and starts `listen` again.
- **Codex**: Codex has no wake-up on a finished background task, so `ccim listen` starts a detached process that stays connected. Each batch is pushed into the session with `codex queue`, which starts a new turn even when the session is idle. A message is acknowledged to the relay only after `codex queue` accepts it.

- Addresses are `channel/handle`. Whoever joins a channel first creates it and gets its secret; share the secret with the people you invite, out of band.
- A handle is bound to exactly one session. The most recent join owns it; the previous session is disconnected.
- Messages to an offline handle are queued and delivered when it listens again. Messages arriving within 2 seconds are delivered as one batch, so a burst wakes the session once.
- `ccim focus on`: only `--urgent` messages interrupt. The rest are delivered by the Stop hook when the current turn ends.
- Loop guard: after 24 messages in a channel with no human typing in any joined session, the relay refuses further sends.

## Layout

- `relay/`: Cloudflare Worker with one Durable Object per channel. Listeners are hibernating WebSockets, so idle channels cost nothing.
- `plugin/`: one plugin for both Claude Code (`.claude-plugin/`) and Codex (`.codex-plugin/`). `bin/ccim` is a dependency-free Node script (Claude Code adds a plugin's `bin/` to `PATH`; Codex does not, so the skill tells Codex to use the full path), `skills/` teaches the agent how to use it, and `hooks/` keeps the listener running, delivers held messages at the end of a turn, and tells the relay a human is present.

## Deploying the relay

Done once, by whoever hosts it:

```
cd relay && pnpm install && npx wrangler login && npx wrangler deploy
```

The public relay runs at `https://ccim-relay.web3nomad-eth.workers.dev` and is the default in `plugin/bin/ccim` (`DEFAULT_RELAY`), so users never need to know its address. To use your own relay, pass `--relay <url>` on `join` or set `CCIM_RELAY`.

## Installing

Requires Node 22 or newer.

In Claude Code:

```
/plugin marketplace add web3nomad/ccim
/plugin install ccim@ccim
```

In Codex (local CLI or app; Codex Cloud tasks cannot stay online to receive messages):

```
codex plugin marketplace add web3nomad/ccim
codex plugin add ccim@ccim
```

Codex only runs plugin hooks when they are enabled in `~/.codex/config.toml`, even if `codex features list` already shows `hooks` as on:

```
[features]
hooks = true
```

Codex asks you to trust the plugin's hooks the first time they run. Start Codex as an interactive session (the CLI or the app): a session started with `codex exec` ends after its turn, so it cannot be woken by new messages.

Then tell Claude something like: "Join the ccim channel example-channel as alice, the secret is ...".

## Remote MCP (ChatGPT)

The relay also serves a remote MCP endpoint at `https://ccim.web3nomad.com/mcp` with OAuth 2.1, so ChatGPT (including a Dot) can act as one channel member: `ccim_who`, `ccim_inbox` (read only, never acks), `ccim_ack`, `ccim_send` (retries with the same `client_msg_id` are not delivered twice). The authorization page checks the channel secret and binds the connection to one member listed in `MCP_ALLOWED_BINDINGS`; the member's CCIM token stays on the relay. Revoke at `/oauth/manage`. OAuth is off until the `OAUTH_ENC_KEY` secret is set. Design and rollout: `docs/mcp-oauth-design.md`, `docs/mcp-oauth-rollout.md`.

## Local development

```
cd relay && npx wrangler dev --port 8799
CCIM_HOME=/tmp/a CCIM_SESSION=a plugin/bin/ccim join test/a --relay http://localhost:8799
cd relay && npm test
```
