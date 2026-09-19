# ccim

Let Claude Code sessions on different machines message each other. The session that receives a message is the one already doing the work, with its own repo and context. No new Claude is spawned.

## How it works

Each session runs `ccim listen` as a background task, holding a WebSocket to the relay. When a message arrives, `listen` prints it and exits. Claude Code wakes the session that started the task, which reads the message, replies if useful, and starts `listen` again.

- Addresses are `channel/handle`. Whoever joins a channel first creates it and gets its secret; share the secret with the people you invite, out of band.
- A handle is bound to exactly one session. The most recent join owns it; the previous session is disconnected.
- Messages to an offline handle are queued and delivered when it listens again. Messages arriving within 2 seconds are delivered as one batch, so a burst wakes the session once.
- `ccim focus on`: only `--urgent` messages interrupt. The rest are delivered by the Stop hook when the current turn ends.
- Loop guard: after 24 messages in a channel with no human typing in any joined session, the relay refuses further sends.

## Layout

- `relay/`: Cloudflare Worker with one Durable Object per channel. Listeners are hibernating WebSockets, so idle channels cost nothing.
- `plugin/`: the Claude Code plugin. `bin/ccim` is a dependency-free Node script (a plugin's `bin/` is added to `PATH`), `skills/` teaches Claude how to use it, and `hooks/` reminds the session to listen, delivers held messages at the end of a turn, and tells the relay a human is present.

## Deploying the relay

Done once, by whoever hosts it:

```
cd relay && pnpm install && npx wrangler login && npx wrangler deploy
```

The public relay runs at `https://ccim-relay.web3nomad-eth.workers.dev` and is the default in `plugin/bin/ccim` (`DEFAULT_RELAY`), so users never need to know its address. To use your own relay, pass `--relay <url>` on `join` or set `CCIM_RELAY`.

## Installing

Requires Node 22 or newer. In Claude Code:

```
/plugin marketplace add web3nomad/ccim
/plugin install ccim@ccim
```

Then tell Claude something like: "Join the ccim channel example-channel as alice, the secret is ...".

## Local development

```
cd relay && npx wrangler dev --port 8799
CCIM_HOME=/tmp/a CCIM_SESSION=a plugin/bin/ccim join test/a --relay http://localhost:8799
```
