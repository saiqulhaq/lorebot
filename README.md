# lorebot

**Your team's lore, on demand.** A Slack bot that answers questions from your markdown knowledge base — grounded, cited, and read-only — powered by [OpenCode](https://opencode.ai).

Mention `@lorebot` in a channel, ask a question, get an answer sourced from your team's docs with file citations. Follow up in the thread without mentioning it again.

```
┌───────┐     mention/reply      ┌─────────┐   HTTP API    ┌──────────────┐
│ Slack │ ─────────────────────▶ │ lorebot │ ────────────▶ │ OpenCode v2  │
│       │ ◀───────────────────── │         │ ◀──────────── │   server     │
└───────┘    threaded answer     └─────────┘               └──────┬───────┘
                                      │                           │ read-only agent
                                      │ git pull (interval)       ▼
                                      └────────────────────▶ ┌─────────┐
                                                             │ KB repo │ (markdown)
                                                             └─────────┘
```

## Features

- **Grounded answers** — the agent greps/reads your actual docs before answering, and cites sources as file paths (optionally linked to GitHub)
- **Honest** — says "not covered" instead of hallucinating when the KB has no answer
- **Threaded conversations** — each Slack thread maps to a persistent OpenCode session, so follow-ups keep context (even across bot restarts)
- **Read-only by design** — the bundled agent can only `read`/`glob`/`grep`; it cannot edit files or run shell commands
- **Fresh content** — pulls the KB repo on an interval (default 5 min)
- **Zero Slack infrastructure** — Socket Mode, no public URL needed

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- [OpenCode v2](https://opencode.ai) installed and authenticated with a model provider
- A git repository of markdown files (your knowledge base)
- A Slack workspace where you can create apps

## Setup

### 1. Create the Slack app

At [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch:

1. **Socket Mode** → enable → create an app-level token with `connections:write` (this is `SLACK_APP_TOKEN`, `xapp-...`)
2. **OAuth & Permissions** → Bot Token Scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history` → install to workspace (this is `SLACK_BOT_TOKEN`, `xoxb-...`)
3. **Event Subscriptions** → enable → subscribe to bot events: `app_mention`, `message.channels`, `message.groups`
4. Invite the bot to your channels: `/invite @lorebot`

### 2. Start the OpenCode server

```sh
opencode2 serve
```

Runs on `http://localhost:4096` by default. To require a password, set `OPENCODE_SERVER_PASSWORD` on the server and give the bot the same value.

### 3. Run the bot

```sh
git clone https://github.com/saiqulhaq/lorebot && cd lorebot
bun install
cp .env.example .env   # fill in your tokens and KB repo URL
bun start
```

On boot, lorebot clones your KB (or uses `KB_DIR`), installs its read-only `kb` agent into the clone's `.opencode/agents/`, verifies the OpenCode server is reachable, and connects to Slack.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | yes | — | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | — | App-level token (`xapp-...`) for Socket Mode |
| `KB_REPO_URL` | one of these | — | Git URL to clone the knowledge base from |
| `KB_DIR` | one of these | — | Path to an existing KB clone (skips cloning) |
| `OPENCODE_URL` | no | `http://localhost:4096` | OpenCode v2 server base URL |
| `OPENCODE_SERVER_PASSWORD` | no | — | Basic-auth password if the server requires one |
| `OPENCODE_AGENT` | no | `kb` | Agent name used for sessions |
| `KB_SYNC_INTERVAL_SECONDS` | no | `300` | `git pull` interval; `0` disables |
| `KB_MANAGE_AGENT` | no | `true` | Install the bundled agent into the KB clone on boot |
| `KB_LINK_BASE` | no | — | Linkify citations, e.g. `https://github.com/org/kb/blob/main/` |
| `ANSWER_TIMEOUT_SECONDS` | no | `300` | Give up waiting for an answer after this |
| `DATA_DIR` | no | `./data` | Sqlite session store + default clone location |
| `LOG_LEVEL` | no | `info` | `debug` logs every question |

## Customizing the agent

The bundled agent lives at [`agent/kb.md`](agent/kb.md) — a system prompt plus a deny-by-default permission ruleset. Two ways to customize:

- Edit `agent/kb.md` in your lorebot checkout (reinstalled into the KB clone on every boot), or
- Set `KB_MANAGE_AGENT=false` and commit your own `.opencode/agents/kb.md` to the knowledge-base repo itself.

You can also point `OPENCODE_AGENT` at any other agent your OpenCode config defines. The model is whatever your OpenCode server/agent config specifies — lorebot never pins one.

## Deployment

Run it anywhere Bun and OpenCode run. A systemd unit is the simplest production setup:

```ini
[Unit]
Description=lorebot
After=network.target

[Service]
WorkingDirectory=/opt/lorebot
EnvironmentFile=/opt/lorebot/.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

A `Dockerfile` is included; note the container needs network access to the OpenCode server (which itself needs your provider credentials), so host-process deployment is usually simpler.

## Troubleshooting

- **Can't reach OpenCode**: `curl http://localhost:4096/api/health` — or use the built-in CLI client: `opencode2 api get /api/health`
- **Inspect sessions the bot created**: `opencode2 api get /api/session | jq '.data[].title'`
- **Bot doesn't answer thread replies**: it only follows up in threads it already answered in (tracked in `$DATA_DIR/lorebot.db`); new questions need an @mention
- **Answers aren't grounded**: check that the agent installed — `cat <kb-clone>/.opencode/agents/kb.md`

## Development

```sh
bun test          # unit tests
bun run typecheck # tsc --noEmit
bun run dev       # run with --watch
```

For a local end-to-end test without a real KB, point the bot at the bundled fixtures: `KB_DIR=$PWD/fixtures/kb bun start` (run `git init && git add -A && git commit -m kb` inside `fixtures/kb` first, or set `KB_SYNC_INTERVAL_SECONDS=0`).

## Contributing

Issues and PRs welcome. Keep it small — the whole bot is ~6 files on purpose.

## License

[MIT](LICENSE)
