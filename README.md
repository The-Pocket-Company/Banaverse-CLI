# Banaverse CLI

**Banaverse for any AI.** Generate images from your terminal, or plug Banaverse into Claude, ChatGPT / Codex, and any MCP‑compatible agent — using the same account, credits, and models as the [Banaverse](https://banaverse.thepocket.company) web canvas.

- 🖼️ **Text‑to‑image** from the command line — `banaverse generate "…"`
- 🔌 **MCP server** — connect Banaverse to Claude Desktop / Claude Code / any MCP client
- 🤖 **Agent‑ready** — a bundled skill teaches coding agents to drive the CLI safely
- 🔑 **One sign‑in** — browser OAuth; no API keys to copy or paste
- 📦 **Zero dependencies** — single Node ≥ 18 files, nothing to build

> Generating spends the credits on your Banaverse account, so the CLI always confirms the cost before it charges.

## Install

```bash
npm install -g @banaverse/cli
```

Requires **Node 18+**. No runtime dependencies.

## Quickstart

```bash
banaverse login                 # opens your browser to sign in with Google
banaverse generate "a cyberpunk cat under a neon sign"
```

`login` runs a standard OAuth 2.1 flow (PKCE + loopback) and stores a long‑lived key in `~/.banaverse/config.json` — you never handle the key yourself. The MCP server reuses the same sign‑in.

## Commands

| Command | What it does |
|---|---|
| `banaverse login` | Browser sign‑in (OAuth). Advanced: `--key <bnv_…>` to use an existing key. |
| `banaverse whoami` | Show the signed‑in account and credit balance. |
| `banaverse models` | List available image models and their per‑image price. |
| `banaverse generate "<prompt>"` | Generate an image. Confirms the cost first (skip with `--yes`). |
| `banaverse logout` | Remove the local config. |

### `generate` options

| Flag | Meaning | Default |
|---|---|---|
| `--model <id>` | Model to use (see `banaverse models`) | cheapest (Nano Banana 2 Lite) |
| `--aspect <ratio>` | `1:1` / `16:9` / `9:16` … | `1:1` |
| `--size <res>` | `512` / `1K` / `2K` / `4K` | `1K` |
| `--out <file>` | Output path | `banaverse-<timestamp>.png` |
| `--yes` | Skip the "spend N credits?" confirmation | interactive prompt |

## Use it from your AI tools

### MCP (Claude Desktop, Claude Code, any MCP client)

After `npm install -g @banaverse/cli`, register the bundled MCP server. Example Claude Desktop config:

```json
{
  "mcpServers": {
    "banaverse": {
      "command": "banaverse-mcp"
    }
  }
}
```

It exposes three tools — `banaverse_generate_image`, `banaverse_list_models`, `banaverse_get_balance` — and authenticates with the key from `banaverse login` (or `BANAVERSE_API_KEY`).

> Prefer a hosted, no‑install option? The Banaverse web app also offers a **remote MCP connector** (paste a URL, sign in with Google) — see the **MCP & CLI** panel in your account menu on [banaverse.thepocket.company](https://banaverse.thepocket.company).

### Coding agents (Claude Code, Codex, …)

This package ships a skill at [`skills/banaverse/SKILL.md`](skills/banaverse/SKILL.md) that teaches an agent to check the balance, confirm the cost with you, and generate — without ever touching your key. Point your agent's skills directory at it, or just tell the agent to use the `banaverse` CLI.

## CI / headless

No browser available? Mint a key in the app and pass it via environment variables:

```bash
export BANAVERSE_API_KEY=bnv_xxx
export BANAVERSE_URL=https://banaverse.thepocket.company
banaverse generate "…" --yes
```

## Auth & safety

- Keys are `bnv_…` bearer tokens, stored **server‑side as SHA‑256 hashes** and revocable at any time.
- The CLI writes the key only to `~/.banaverse/config.json` in your home directory; it never prints your key.
- `generate` **confirms the credit cost first**. In non‑interactive contexts (pipes, agents) it refuses to spend until you pass `--yes`, so an agent must get your OK before charging.

## License

[MIT](LICENSE) © The Pocket Company
