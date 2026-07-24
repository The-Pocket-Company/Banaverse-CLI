---
name: banaverse
description: Generate images with Banaverse (Nano Banana / Gemini image models) from the command line. Use when the user wants to create / draw / make an image and mentions Banaverse, or wants to spend Banaverse credits to generate an image. Generating spends credits, so always confirm the cost with the user before generating.
---

# Banaverse image generation

Call Banaverse through the `banaverse` CLI to generate images. The CLI shares the **same account and credit wallet** as the Banaverse website — generating here spends the user's credits. **Always confirm the cost with the user before spending.**

## The command

Prefer the globally installed `banaverse` command (`npm i -g @banaverse/cli`). If it isn't installed, use `npx @banaverse/cli` in its place. (Below always says `banaverse`.)

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

3. **Generate** (only after the user agrees — that is when you may pass `--yes`):

   ```bash
   banaverse generate "<a clear, specific prompt>" --model <id> --out <descriptive-name>.png --yes
   ```

   - Turn the user's request into a clear, specific prompt (subject, style, composition, lighting).
   - Add `--aspect` (`1:1` / `16:9` / `9:16`) and `--size` (`512` / `1K` / `2K` / `4K`) as needed.
   - No model specified → the default (cheapest, Nano Banana 2 Lite) is used.

4. **Report the result**: print the saved file path and confirm the charge via the balance change. On failure (402 insufficient credits / 502 generation failed), relay the error verbatim; failed generations are auto‑refunded.

## Hard rules

- **Never** pass `--yes` before the user has confirmed the cost.
- **Never** create, enter, or store an API key for the user — only guide them to run `banaverse login`.
- Generate one image at a time; for multiple, confirm each, or agree the total cost up front.
- The default endpoint is the production site. For a different environment, use `banaverse login --url <base>` or set `BANAVERSE_URL`.
