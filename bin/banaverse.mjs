#!/usr/bin/env node
// ============================================================================
// Banaverse CLI — 從終端機或 AI agent 呼叫 Banaverse 生成圖片。
//   banaverse login             瀏覽器登入（開瀏覽器用 Google 授權，免手動貼金鑰）
//   banaverse whoami            顯示帳號與點數餘額
//   banaverse models            列出可用圖片模型與售價
//   banaverse generate "<提示>"   生成圖片（預設先顯示花費並確認；--yes 跳過）
//   banaverse logout            清除本機設定
//
// 認證：`banaverse login` 走 OAuth 2.1（PKCE + loopback），登入後自動存一把長效金鑰到
//       ~/.banaverse/config.json，之後免再登入；MCP server 也沿用同一把。
//       進階／CI 可帶 --key <bnv_…> 或環境變數 BANAVERSE_API_KEY / BANAVERSE_URL。
// 相依：零（Node 18+ 內建 fetch / readline / http / crypto）。
// 專案：https://github.com/The-Pocket-Company/Banaverse-CLI
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';

const CFG_DIR = join(homedir(), '.banaverse');
const CFG_FILE = join(CFG_DIR, 'config.json');
const DEFAULT_URL = 'https://banaverse.thepocket.company'; // 正式站；本機測試自行帶 --url http://localhost:5181

// ── config ──────────────────────────────────────────────────────────────
function loadCfg() {
  try { return JSON.parse(readFileSync(CFG_FILE, 'utf8')); } catch { return {}; }
}
function saveCfg(c) {
  mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(CFG_FILE, JSON.stringify(c, null, 2));
}
function resolved(flags) {
  const c = loadCfg();
  const url = flags.url || process.env.BANAVERSE_URL || c.url || DEFAULT_URL;
  const key = flags.key || process.env.BANAVERSE_API_KEY || c.key || '';
  return { url: url.replace(/\/$/, ''), key };
}

// ── args ────────────────────────────────────────────────────────────────
// 只有這些旗標「吃下一個值」；其餘一律布林（如 --yes）——否則 `generate --yes "貓"`
// 會把提示當成 --yes 的值吞掉，或 `--out`（漏值）變成 true 導致扣點後才炸在存檔。
const VALUE_FLAGS = new Set(['url', 'key', 'model', 'aspect', 'size', 'out', 'label', 'seconds']);
function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (VALUE_FLAGS.has(k)) {
        const nxt = argv[i + 1];
        if (nxt === undefined || nxt.startsWith('--')) fail(`旗標 --${k} 需要一個值。`); // 早退，避免扣點後才失敗
        flags[k] = nxt; i++;
      } else {
        flags[k] = true; // 布林旗標（--yes / --help …），不吃下一個 token
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

// ── http ────────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body, url, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(url + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    fail(`連不到 ${url}${path}（${e.message}）。dev server 有開嗎？（npm run dev）或用 --url 指定。`);
  }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) fail(`HTTP ${res.status}：${d.error ?? '未知錯誤'}`);
  return d;
}

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
async function ask(q) {
  const rl = createInterface({ input: stdin, output: stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

// ── commands ──────────────────────────────────────────────────────────────
async function cmdLogin(flags) {
  const cur = loadCfg();
  const url = (flags.url || cur.url || DEFAULT_URL).replace(/\/$/, '');
  // --key：直接存已有金鑰（給 CI / 進階）
  if (flags.key) {
    if (!String(flags.key).startsWith('bnv_')) fail('key 格式不對（應以 bnv_ 開頭）。');
    saveCfg({ url, key: flags.key });
    const me = await api('/api/v1/me', { url, key: flags.key });
    console.log(`✓ 已登入：${me.email || me.uid}（餘額 ${me.credits} 點）  → ${CFG_FILE}`);
    return;
  }
  // 預設：瀏覽器登入（OAuth loopback）——登入後自動發一把長效金鑰存起來，你不用碰 key。
  await browserLogin(url);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function openBrowser(u) {
  const plat = process.platform;
  // win32：用 rundll32 開，避免 `cmd /c start` 把 URL 裡的 & 當命令分隔符而截斷參數。
  let cmd, args;
  if (plat === 'win32') { cmd = 'rundll32'; args = ['url.dll,FileProtocolHandler', u]; }
  else if (plat === 'darwin') { cmd = 'open'; args = [u]; }
  else { cmd = 'xdg-open'; args = [u]; }
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* 手動開；URL 已印在終端機 */ }
}

async function browserLogin(url) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = randomBytes(16).toString('hex');

  // 本機 loopback server 收授權碼
  let resolveCode, rejectCode;
  const codeP = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = createServer((req, res) => {
    const q = new URL(req.url, 'http://127.0.0.1');
    if (q.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0b0b0d;color:#f4f4f6;display:grid;place-items:center;height:100vh"><h2>&#10003; Banaverse 登入完成，回終端機即可（可關閉此分頁）。</h2>');
    const err = q.searchParams.get('error');
    if (err) rejectCode(new Error(q.searchParams.get('error_description') || err));
    else if (q.searchParams.get('state') !== state) rejectCode(new Error('state 不符，請重試。'));
    else resolveCode(q.searchParams.get('code'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;

  // 動態註冊一個 loopback client（免上架）
  let reg;
  try { reg = await fetch(url + '/api/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Banaverse CLI' }) }); }
  catch (e) { server.close(); fail(`連不到 ${url}（${e.message}）。dev server 有開嗎？或用 --url 指定。`); }
  const regData = await reg.json().catch(() => ({}));
  if (!reg.ok) { server.close(); fail(`註冊失敗：${regData.error_description || regData.error || reg.status}`); }

  const authUrl = `${url}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(regData.client_id)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256`
    + `&state=${state}&scope=${encodeURIComponent('image:generate account:read')}`;
  console.log('→ 正在開啟瀏覽器登入 Banaverse…\n  若沒自動開、或頁面報參數錯誤，請「整條」複製下面網址貼進瀏覽器：\n  ' + authUrl + '\n');
  openBrowser(authUrl);

  let code;
  try { code = await codeP; } finally { server.close(); }

  const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: regData.client_id, redirect_uri: redirect, code_verifier: verifier });
  const tok = await fetch(url + '/api/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const tokData = await tok.json().catch(() => ({}));
  if (!tok.ok) fail(`授權失敗：${tokData.error_description || tokData.error || tok.status}`);

  // 用 OAuth token 發一把長效個人金鑰存起來（之後直接用它、免 refresh；MCP 也讀同一把）
  const keyRes = await fetch(url + '/api/cli/keys', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokData.access_token}` }, body: JSON.stringify({ label: 'CLI (browser login)' }) });
  const keyData = await keyRes.json().catch(() => ({}));
  if (!keyRes.ok || !keyData.key) fail(`發放金鑰失敗：${keyData.error || keyRes.status}`);

  saveCfg({ url, key: keyData.key });
  const me = await api('/api/v1/me', { url, key: keyData.key });
  console.log(`✓ 已登入：${me.email || me.uid}（餘額 ${me.credits} 點）  → ${CFG_FILE}`);
}

function cmdLogout() {
  try { if (existsSync(CFG_FILE)) rmSync(CFG_FILE); } catch {}
  console.log('✓ 已清除本機設定。');
}

async function cmdWhoami(flags) {
  const { url, key } = resolved(flags);
  if (!key) fail('尚未登入。先跑：banaverse login');
  const me = await api('/api/v1/me', { url, key });
  console.log(`${me.email || me.uid}${me.isAdmin ? '（admin，生成不扣點）' : ''}  餘額：${me.credits} 點`);
}

async function cmdModels(flags) {
  const { url } = resolved(flags);
  const d = await api('/api/v1/models', { url });
  const row = (m) => `  ${m.default ? '★' : ' '} ${m.id.padEnd(32)} ${m.label.padEnd(18)} ${m.credits} 點`;
  const imgs = d.models.filter((m) => m.kind !== 'video');
  const vids = d.models.filter((m) => m.kind === 'video');
  console.log('圖片模型（售價／次）：');
  for (const m of imgs) console.log(row(m));
  if (vids.length) {
    console.log('\n影片模型（售價／次，生成約 1–5 分鐘）：');
    for (const m of vids) console.log(row(m));
    console.log('\n  影片用：banaverse generate "…" --video');
  }
  console.log('  （★＝預設；用 --model <id> 指定其他）');
}

async function cmdGenerate(pos, flags) {
  const { url, key } = resolved(flags);
  if (!key) fail('尚未登入。先跑：banaverse login');
  const prompt = pos.join(' ').trim();
  if (!prompt) fail('缺少提示。用法：banaverse generate "一隻賽博龐克貓" [--video] [--model …] [--out cat.png] [--yes]');

  // --video，或 --model 指到影片模型 → 走影片（非同步長任務）
  const catalog = await api('/api/v1/models', { url });
  const wantVideo = !!flags.video || catalog.models.some((m) => m.id === flags.model && m.kind === 'video');
  const chosen = flags.model || catalog.models.find((m) => m.default && (wantVideo ? m.kind === 'video' : m.kind !== 'video'))?.id;
  const info = catalog.models.find((m) => m.id === chosen);
  if (!info) fail(`未知模型：${chosen}。可用：${catalog.models.map((m) => m.id).join(', ')}`);

  // 生成前確認（花點數）：--yes 跳過；互動終端問 y/N；非互動（agent/pipe）要求 --yes
  if (!flags.yes) {
    if (stdin.isTTY && stdout.isTTY) {
      const a = await ask(`用 ${info.label}（${chosen}）生成，將花 ${info.credits} 點。繼續？[y/N] `);
      if (!/^y(es)?$/i.test(a)) { console.log('已取消。'); return; }
    } else {
      fail(`這會花 ${info.credits} 點（${info.label}）。確認後加 --yes 再跑（或先 banaverse models 看價格）。`);
    }
  }

  if (info.kind === 'video') return await generateVideo({ url, key, prompt, chosen, info, flags });

  process.stderr.write(`⏳ 生成中（${info.label}）…\n`);
  const r = await api('/api/v1/generate', {
    method: 'POST', url, key,
    body: { prompt, model: chosen, aspectRatio: flags.aspect, imageSize: flags.size },
  });
  if (!r.dataUrl) fail('沒有拿到影像。');

  // data:image/…;base64,… → 存檔
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(r.dataUrl);
  const ext = m ? (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg') : 'png';
  const b64 = m ? m[2] : r.dataUrl.split(',')[1] || '';
  const out = pathResolve(flags.out || `banaverse-${stamp()}.${ext}`);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`✓ 生成完成（花 ${r.credits} 點）→ ${out}`);
}

// 影片是長任務：POST 只拿到 jobId，要輪詢 /api/v1/jobs/{id} 直到 done。
// 伺服器完成後會把影片放上 Cloud Storage 並回公開網址，這裡直接抓那個網址存檔。
async function generateVideo({ url, key, prompt, chosen, info, flags }) {
  const sub = await api('/api/v1/generate', {
    method: 'POST', url, key,
    body: { kind: 'video', prompt, model: chosen, aspectRatio: flags.aspect, durationSec: flags.seconds ? Number(flags.seconds) : undefined },
  });
  if (!sub.jobId) fail('沒有拿到 jobId。');
  process.stderr.write(`⏳ 影片生成中（${info.label}）…通常 1–5 分鐘，可按 Ctrl+C 離開，之後用 jobId 再取：\n   ${sub.jobId}\n`);

  const started = Date.now();
  const LIMIT_MS = 15 * 60 * 1000; // 15 分鐘還沒好就把 jobId 留給使用者自己取，不要無限掛著
  for (;;) {
    await new Promise((r) => setTimeout(r, 10000));
    const j = await api(`/api/v1/jobs/${encodeURIComponent(sub.jobId)}`, { url, key });
    if (j.done) {
      if (!j.url) fail('影片完成但沒有網址。');
      const res = await fetch(j.url);
      if (!res.ok) fail(`影片下載失敗：HTTP ${res.status}`);
      const out = pathResolve(flags.out || `banaverse-${stamp()}.mp4`);
      writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      console.log(`✓ 影片完成（花 ${j.credits} 點）→ ${out}`);
      return;
    }
    process.stderr.write(`   …${Math.round((j.progress || 0) * 100)}%\r`);
    if (Date.now() - started > LIMIT_MS) {
      console.log(`\n仍在生成中。稍後用這個 jobId 取件：\n  banaverse job ${sub.jobId}`);
      return;
    }
  }
}

/** 取件既有的影片工單（generate 中途離開後用）。 */
async function cmdJob(pos, flags) {
  const { url, key } = resolved(flags);
  if (!key) fail('尚未登入。先跑：banaverse login');
  const jobId = pos.join(' ').trim();
  if (!jobId) fail('用法：banaverse job <jobId>');
  const j = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { url, key });
  if (!j.done) { console.log(`還在生成中（${Math.round((j.progress || 0) * 100)}%）。稍後再試。`); return; }
  if (!j.url) fail('影片完成但沒有網址。');
  const res = await fetch(j.url);
  if (!res.ok) fail(`影片下載失敗：HTTP ${res.status}`);
  const out = pathResolve(flags.out || `banaverse-${stamp()}.mp4`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`✓ 影片完成（花 ${j.credits} 點）→ ${out}`);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const HELP = `banaverse — Banaverse 生成 CLI（文字生成圖片／影片）

用法：
  banaverse login [--url <base>]                   瀏覽器登入（開瀏覽器授權，免貼金鑰）
  banaverse whoami                                  帳號與點數餘額
  banaverse models                                  可用圖片／影片模型與售價
  banaverse generate "<提示>" [選項]                 生成圖片（加 --video 生成影片）
  banaverse job <jobId>                             取回先前送出的影片
  banaverse logout                                  清除本機設定

generate 選項：
  --video          生成影片（長任務，會自動輪詢到完成；預設 Veo 3.1 Lite）
  --model <id>     指定模型（預設＝Nano Banana 2 Lite；影片預設 Veo 3.1 Lite）
  --aspect <比例>  1:1 / 16:9 / 9:16 …（圖片預設 1:1、影片 16:9）
  --size <解析度>  512 / 1K / 2K / 4K（預設 1K，僅圖片）
  --seconds <秒>   影片長度（依模型支援範圍）
  --out <檔名>     輸出檔（預設 banaverse-<時間>.png ／ .mp4）
  --yes            跳過「花 N 點」確認（agent 請先向使用者確認再帶此旗標）

影片會花較多點數（Veo Lite 100 點起），且需 1–5 分鐘。中途 Ctrl+C 離開後，
可用印出來的 jobId 跑 banaverse job <jobId> 取回。

登入：banaverse login 會開瀏覽器授權，登入後自動存下一把金鑰（不用手動貼）。
進階：也可 --key <bnv_…> 直接帶金鑰，或用環境變數 BANAVERSE_API_KEY / BANAVERSE_URL。`;

async function main() {
  let argv = process.argv.slice(2);
  if (argv[0] === 'auth') argv = argv.slice(1); // 支援 "banaverse auth login"
  const { pos, flags } = parse(argv.slice(1));
  const cmd = argv[0];
  switch (cmd) {
    case 'login': return cmdLogin(flags);
    case 'logout': return cmdLogout();
    case 'whoami': return cmdWhoami(flags);
    case 'models': return cmdModels(flags);
    case 'generate': case 'gen': return cmdGenerate(pos, flags);
    case 'job': return cmdJob(pos, flags);
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return;
    default: console.error(`未知指令：${cmd}\n`); console.log(HELP); process.exit(1);
  }
}

main().catch((e) => fail(String(e?.message ?? e)));
