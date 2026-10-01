---
name: banaverse
description: Generate images and video with Banaverse (Nano Banana images, Veo video), from a text prompt or from reference images — via the Banaverse MCP tools if they are available in this session, otherwise via the banaverse CLI. Use when the user wants to create / draw / make an image, make a video or animate a picture, and mentions Banaverse, or wants to spend Banaverse credits to generate. Generating spends credits, so always confirm the cost with the user before generating.
---

# Banaverse image and video generation

Banaverse shares the **same account and credit wallet** as the Banaverse website — generating here
spends the user's credits. **Always confirm the cost with the user before spending.**

## Pick your route first

There are two ways in. Check which one you have **before** doing anything else:

1. **MCP tools** — if `banaverse_generate_image` / `banaverse_generate_video` are in your tool list,
   **use them** and skip the CLI entirely. Nothing to install.
2. **The `banaverse` CLI** — use this when the MCP tools aren't there, or when the user wants the
   file written to disk (MCP returns a URL, not a local file).

If the user just connected the Banaverse MCP server and the tools are still missing, that is normal:
tool lists don't hot-reload. Say so, and either use the CLI route or ask them to start a new session.
Do **not** conclude the connection failed.

### If your runtime has its own built-in image generator

Some agents ship a free built-in image tool. **Don't silently substitute one for the other** — say
which one you used, either way. Rough rule:

- **Their built-in** is usually free and fine for a quick throwaway picture.
- **Banaverse** is the right call when the user asks for it by name, or needs something the built-in
  can't do: **video** (Veo), **animating a still image**, **multiple reference images**, or results
  tied to their **Banaverse account and credit wallet** so they show up alongside their other work.

Banaverse spends real credits, so never reach for it just because it is there — but equally, never
quietly swap in a different generator when the user asked for Banaverse.

## The command

Prefer the globally installed `banaverse` command. If it isn't installed yet, install it:

```bash
npm i -g @banaverse/cli
```

If you can't install globally, the one-off form is `npx -p @banaverse/cli banaverse <subcommand>`.

> `npx @banaverse/cli` **does not work** — it fails with `could not determine executable to run`,
> because the package is `@banaverse/cli` but the binary is `banaverse`. That error does **not** mean
> the package is private or missing; it is public. Use one of the two forms above.

Never fall back to a `cli/banaverse.mjs` file inside a checked-out repo. That copy is frozen, has no
video support, and is marked private — running it gives behaviour that does not match this document.

(Below always says `banaverse`.)

## Standard flow

1. **Confirm the user is signed in** (once):

   ```bash
   banaverse whoami
   ```

   - Success → prints email + credit balance; continue.
   - Failure (`尚未登入` / 401) → tell the user to run `banaverse login` (it opens their browser to sign in with Google). **Do not** enter or guess a key for them.

2. **Check the price and confirm the spend** (required before spending):

   ```bash
   banaverse models
   ```

   Find the chosen model's price, then **tell the user explicitly**: "This will use <model>, costing N credits (balance M). Generate?" — and wait for a yes. Do **not** generate without explicit consent.

   Prices come from the server and change — always read them from `banaverse models`, never from memory or
   from this file. Image prices depend on resolution (and, for some models, on whether it is an edit), so
   `models` shows a range. For the exact figure, run the same `generate` command **without** `--yes`: in a
   non-interactive shell it prints the exact charge and stops without spending anything.

3. **Generate** (only after the user agrees — that is when you may pass `--yes`):

   ```bash
   banaverse generate "<a clear, specific prompt>" --model <id> --out <descriptive-name>.png --yes
   ```

   - Turn the user's request into a clear, specific prompt (subject, style, composition, lighting).
   - Add `--aspect` (`1:1` / `16:9` / `9:16` …) and `--size` (`512px` / `1K` / `2K` / `4K`) as needed. Values depend on
     the model (Nano Banana 2 Lite only does 1K). Leave them out to get the model's default: Nano Banana
     text-to-image is 16:9 and edits keep the reference's ratio; Seedream and Banaverse Image are 1:1;
     Nano Banana Pro defaults to 2K. Size changes the price.
   - No model specified → the default, Nano Banana 2 Lite, is used.
   - Some image models (Banaverse Image) run on Banaverse's own GPUs and can queue. The command keeps
     polling; if it stops and prints a `jobId`, retrieve with `banaverse job <jobId>` — never re-run
     `generate`, that charges again.

4. **Report the result**: print the saved file path and confirm the charge via the balance change. On failure (402 insufficient credits / 502 generation failed), relay the error verbatim; failed generations are auto‑refunded.

## Video

Same flow, plus `--video`. Video is a **long job** (1–5 minutes) and costs far more than an image —
**the cost confirmation matters even more here**. `banaverse models` lists each video model's base price
for one unit (e.g. 8 seconds at 720p); the actual charge scales with length and resolution, and the CLI
prints the amount actually charged right after submitting. Tell the user it is a base price.

```bash
banaverse generate "<a clear, specific prompt>" --video --aspect 16:9 --seconds 4 --out clip.mp4 --yes
```

- The command submits, then polls until done and saves the `.mp4` — no extra step needed
  (checks every 10s, gives up after 15 minutes and hands you back the `jobId`).
- It prints a `jobId` first. If the user interrupts, retrieve it later with `banaverse job <jobId>`; do **not** re-run `generate`, that would charge again.
- `banaverse models` lists video models and prices alongside the image ones.

### Always run video in the background

Video takes 1–5 minutes. **Run the video command as a background job** — in Claude Code, use the
Bash tool with `run_in_background: true`. The command polls to completion and writes the `.mp4`
before exiting, so you get a completion notification and can report back then.

Tell the user "submitted, ~N minutes, I'll let you know" and **carry on with other work** —
do not sit and wait.

Do **not** use the MCP route (`banaverse_generate_video` + repeated `banaverse_get_video`, or
`banaverse_get_job` on the bundled `banaverse-mcp` server) for long video jobs. MCP tools are synchronous, so polling that way blocks the conversation and burns
tokens on every check. MCP suits "the user just wants a URL and is happy to wait"; use the CLI
when it should run in the background.

## Reference images — image-to-image and image-to-video

Pass `--ref` to work from an existing image; repeat it for multiple references:

```bash
banaverse generate "change the background to night" --ref photo.jpg --out night.png --yes
banaverse generate "have him turn to camera, slow push in" --ref photo.jpg --video --out clip.mp4 --yes
```

- Takes local file paths (png/jpg/webp/gif), plus data URLs and URLs Banaverse itself returned.
- **Other sites' image URLs are rejected** (the server only trusts its own storage, for SSRF safety) —
  download the image locally first, then `--ref` it.
- Video: only Veo 3.1 Lite (the default) uses the first image as the **first frame**. Every other model
  treats refs as style / subject references, not a first frame — Veo 3.1 and Veo 3.1 Fast included, and
  with refs those two are fixed at 8 seconds (charged as 8 seconds). To make a picture move on those
  models, describe the motion in the prompt.
- If the chosen model can't take references, the call fails with a 400 explaining why — it will
  **not** silently ignore them and still charge.

With `--ref`, write the prompt as **what to change / how it should move**, not a fresh description
of the whole picture.

## MCP alternative

The same account also exposes an MCP server at `https://banaverse.thepocket.company/api/mcp`
(tools include `banaverse_generate_image` + `banaverse_get_image`, `banaverse_generate_video` +
`banaverse_get_video`, `banaverse_generate_audio`, `banaverse_generate_3d` + `banaverse_get_3d`,
`banaverse_list_models`, `banaverse_get_balance`). This package also ships a local stdio server,
`banaverse-mcp`, with the same generate tools and a single `banaverse_get_job` for retrieval.
If those tools are already available in this session, prefer them — no install needed. The CLI is the
better choice when the user wants the file written to disk, since MCP returns a URL rather than a local file.

**Audio and 3D are MCP / API only** — `banaverse generate` does images and video. For music, speech or a
3D model, use `banaverse_generate_audio` / `banaverse_generate_3d` (both need an explicit `model`; speech
is priced by length; 3D comes back as GLB or a ZIP with OBJ and materials, depending on the model).

## Hard rules

- **Never** pass `--yes` before the user has confirmed the cost.
- **Never** create, enter, or store an API key for the user — only guide them to run `banaverse login`.
- Generate one image at a time; for multiple, confirm each, or agree the total cost up front.
- The default endpoint is the production site. For a different environment, use `banaverse login --url <base>` or set `BANAVERSE_URL`.
