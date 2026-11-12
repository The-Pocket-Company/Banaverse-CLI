# Banaverse CLI

**Banaverse for any AI.** Generate images and video from your terminal, or plug Banaverse into Claude, ChatGPT / Codex, and any MCP‑compatible agent — using the same account, credits, and models as the [Banaverse](https://banaverse.thepocket.company) web canvas.

- 🖼️ **Text‑to‑image** from the command line — `banaverse generate "…"`
- 🎬 **Text‑to‑video** — `banaverse generate "…" --video` (Veo; long job, polls and saves the .mp4 for you)
- 🧰 **Tools** — `banaverse tool tryon --ref person.jpg --ref shirt.jpg`: white background, try‑on, multi‑size, restyle… with prompts tuned by Banaverse
- ✂️ **Video tools** — `banaverse tool join --video a.mp4 --video b.mp4`: background removal, video background removal, join clips, reframe to 9:16 / 16:9 / 1:1
- 🔌 **MCP server** — connect Banaverse to Claude Desktop / Claude Code / any MCP client (images, video, audio and 3D)
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
banaverse generate "a duck bobbing on calm water" --video   # 影片（長任務，1–5 分鐘）
```

`login` runs a standard OAuth 2.1 flow (PKCE + loopback) and stores the resulting tokens in `~/.banaverse/config.json`; they refresh automatically, so you never handle a key yourself. The MCP server reuses the same sign‑in.

## Commands

| Command | What it does |
|---|---|
| `banaverse login` | Browser sign‑in (OAuth). Advanced: `--key <bnv_…>` to use an existing key. |
| `banaverse whoami` | Show the signed‑in account and credit balance. |
| `banaverse models` | List available models (image, video, audio, 3D) with live prices from the server. |
| `banaverse generate "<prompt>"` | Generate an image — add `--video` for video, `--ref` to start from an image. Confirms the cost first (skip with `--yes`). |
| `banaverse tools` | List the tools (white background, try‑on, background removal, multi‑size, restyle, animate, join clips, reframe…) and what each needs. |
| `banaverse tool <id> --ref <file>` | Run a tool on your image(s). Prompt, model and aspect ratio are tuned by Banaverse; add `--answer "…"` when the tool asks one thing (e.g. which background). Multi‑version tools save one file per version. Confirms the cost first. |
| `banaverse tool <id> --video <file>` | Run a video tool (`videocutout`, `join`, `reframe`) on your clip(s), in order. See [`tool` options](#tool-options). |
| `banaverse job <jobId>` | Retrieve a job submitted earlier: a video you interrupted, a queued image, or a 3D model submitted via MCP / API. |
| `banaverse logout` | Remove the local config. |

### `generate` options

| Flag | Meaning | Default |
|---|---|---|
| `--video` | Generate video instead of an image (long job, 1–5 min) | off |
| `--ref <file>` | Reference image (image‑to‑image / image‑to‑video). Repeat for several; the limit depends on the model. Local png/jpg/webp/gif, a data URL, or a URL Banaverse returned. For video, only Veo 3.1 Lite uses the first image as the first frame; other models treat refs as references, and Veo 3.1 / Fast with refs are fixed at 8 s (charged as 8 s). | none |
| `--model <id>` | Model to use (see `banaverse models`) | Nano Banana 2 Lite / Veo 3.1 Lite |
| `--aspect <ratio>` | `1:1` / `16:9` / `9:16` … (values per model) | model default: Nano Banana text‑to‑image 16:9, edits keep the source ratio; Seedream and Banaverse Image 1:1; video 16:9 |
| `--size <res>` | `512px` / `1K` / `2K` / `4K` (images only; values per model, affects the price) | model default (e.g. 1K; Nano Banana Pro 2K) |
| `--seconds <n>` | Video length (per model limits) | model default |
| `--out <file>` | Output path | `banaverse-<timestamp>.<ext>` (extension from the file type) |
| `--yes` | Skip the "spend N credits?" confirmation | interactive prompt |

Prices are never hard‑coded here — `banaverse models` shows the server's live prices. For images the confirmation quotes the exact charge for that resolution and edit/no‑edit; for video it shows the base price for one unit (the actual charge depends on length and resolution and is printed right after submitting). Allowed values per model: [API docs → model reference](https://banaverse.thepocket.company/api-docs).

Some image models run on Banaverse's own GPUs and can queue. If the queue is long the CLI keeps polling for you; if you stop it, retrieve the image later with `banaverse job <jobId>` — don't re‑run `generate`, that charges again. Audio and 3D are available through MCP and the API, not `generate`.

### `tool` options

| Flag | Meaning |
|---|---|
| `--ref <file>` | The image(s) to process, in the order the tool expects (try‑on: person, then garment). Same formats as `generate --ref`. |
| `--video <file>` | The video(s) to process, in order — `join` takes 2–10 clips and joins them in that order. A local mp4/mov/webm/m4v, or a video URL Banaverse returned. |
| `--audio <file>` | `dub` only: the voice‑over or music to put into the video (mp3/wav/m4a/aac/ogg/flac, or an audio URL Banaverse returned). |
| `--mix <replace\|music\|voice>` | `dub` only: replace the original sound (default), lay it under as background music, or use it as narration over a lowered original. |
| `--answer "…"` | The one question the tool asks (which background, which sizes…). Choice questions fall back to their defaults. `--answer @file.txt` reads it from a file — `subtitle` takes the whole subtitle text, one line per caption starting with its time (`0:00-0:03 Hello`). |
| `--aspect <ratio>` | Single‑version tools only. For `reframe`: `9:16` (default), `16:9` or `1:1`. |
| `--fit <blur\|crop>` | `reframe` only: `blur` keeps the whole frame and fills the bars with a blurred copy (default); `crop` crops from the centre to fill. |
| `--model` / `--size` / `--seconds` / `--out` / `--yes` | As for `generate`. `videocutout` is priced per second of video: for a local mp4/mov the CLI reads the length itself; for a Banaverse URL pass `--seconds`. |

**Local video size limit.** The CLI has to send local files inside the request, and one request to Banaverse can be at most 32 MB; base64 adds about a third, so local files in one call must total **about 23 MB or less**. Larger files are refused before anything is sent (nothing is charged) — compress or trim them, or pass a video URL Banaverse returned, which has no such limit.

Background removal, video background removal, join, reframe, dub and subtitle run on Banaverse's RTX machines: if your company has its own machine they run there for free, otherwise on Banaverse's machine at the listed price. These tools are not in `banaverse models`; the actual charge is printed after submitting.

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

It exposes `banaverse_generate_image`, `banaverse_generate_video`, `banaverse_generate_audio`, `banaverse_generate_3d`, `banaverse_list_tools` + `banaverse_use_tool`, `banaverse_get_job` (retrieves video, 3D, and queued images), `banaverse_list_models`, `banaverse_get_balance` — and reuses the `banaverse login` sign‑in (or `BANAVERSE_API_KEY`). Image inputs (`refs`, `images`) can be **local file paths**, so an agent can pass the path of an image you pasted instead of base64. `banaverse_use_tool` also takes `videos` (local paths or Banaverse video URLs, same ~23 MB limit for local files), `fit` for `reframe`, `audios` + `audioMix` for `dub`, and `durationSec` for `videocutout` (read automatically from local mp4/mov files).

> Prefer a hosted, no‑install option? The Banaverse web app also offers a **remote MCP connector** (paste a URL, sign in with Google) — see the **MCP & CLI** panel in your account menu on [banaverse.thepocket.company](https://banaverse.thepocket.company).

### Coding agents (Claude Code, Codex, …)

This package ships a skill at [`skills/banaverse/SKILL.md`](skills/banaverse/SKILL.md) that teaches an agent to check the balance, confirm the cost with you, and generate — without ever touching your key. Point your agent's skills directory at it, or just tell the agent to use the `banaverse` CLI.

## CI / headless

No browser available? Create a key in the app (account menu → **API 金鑰**) and pass it via environment variables:

```bash
export BANAVERSE_API_KEY=bnv_xxx
export BANAVERSE_URL=https://banaverse.thepocket.company
banaverse generate "…" --yes
```

## Auth & safety

- Browser sign‑in stores short‑lived OAuth tokens (access 1 h, refresh 30 d, rotated on every refresh) in `~/.banaverse/config.json`; `banaverse logout` deletes them from this machine. Logging out does not revoke them on the server; an unused refresh token lapses after 30 days.
- API keys (`bnv_…`, for CI or `--key`) are stored **server‑side as SHA‑256 hashes** and revocable at any time; the CLI never prints your key.
- `generate` **confirms the credit cost first**. In non‑interactive contexts (pipes, agents) it refuses to spend until you pass `--yes`, so an agent must get your OK before charging.

## License

[MIT](LICENSE) © The Pocket Company
