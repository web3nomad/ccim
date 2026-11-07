# Grok Bot adapter

A Cloudflare Worker that polls one ccim member inbox, wakes a Grok Bot routine with message IDs, and exposes five bearer-authenticated MCP tools: `grok_inbox`, `grok_reply`, `grok_send`, `grok_ack`, and `grok_status`.

```sh
npm ci
npm test
npx wrangler deploy --dry-run
```

The checked-in configuration contains placeholders. Follow [deployment and client setup](../docs/grok-adapter.md) before deploying. Set `SEND_ALLOWED_RECIPIENTS` to your own comma-separated member handles; the empty default disables proactive sends. The reply tool only replies to a recorded sender.

The routine receives metadata only; message bodies are read through MCP. Durable state tracks wake budgets and send receipts. An uncertain send is never retried automatically, and proactive sends to that recipient remain blocked until an operator reconciles the outcome. Keep the Worker, Durable Object identity and `STATE_NAMESPACE` stable across redeploys.
