#!/usr/bin/env node
// ============================================================================
// Banaverse CLI — 從終端機或 AI agent 呼叫 Banaverse 生成圖片與影片。
//   banaverse login             瀏覽器登入（開瀏覽器用 Google 授權，免手動貼金鑰）
//   banaverse whoami            顯示帳號與點數餘額
//   banaverse models            列出可用模型與即時售價（圖片／影片／音訊／3D）
//   banaverse generate "<提示>"   生成圖片；--video 生成影片（預設先顯示花費並確認；--yes 跳過）
//   banaverse tools             列出工具（白背景、試穿、多尺寸…）
//   banaverse tool <代號>        用工具處理圖片：prompt、模型、比例是 Banaverse 調好的，你只給圖（與一句答案）
//   banaverse job <jobId>       取回先前送出的影片、排隊中的圖片或 3D
//   banaverse logout            清除本機設定
//
// 音訊與 3D 只在 MCP（mcp/banaverse-mcp.mjs）與 API：音訊沒有預設模型、3D 只吃特定輸入，
// 在終端機裡猜模型名不是好體驗。`models` 照樣列出來，讓人知道有、以及去哪裡用。
//
// 認證：`banaverse login` 走 OAuth 2.1（PKCE + loopback），登入後把 access／refresh token
//       存到 ~/.banaverse/config.json，之後自動續期；MCP server 讀同一份。
//       **不再拿 token 去換一把長效金鑰**——伺服器 2026-08-14 起金鑰管理只收網站正式登入
//       （擋連接器鑄永久金鑰的漏洞），CLI 的 OAuth token 正好是被擋的那種，繞那條路只會失敗。
//       生成、取件、模型、餘額這些端點本來就吃 OAuth token，沒有必要多一層金鑰。理由見 lib/auth.mjs。
//       進階／CI 可帶 --key <bnv_…> 或環境變數 BANAVERSE_API_KEY / BANAVERSE_URL。
// 相依：零（Node 18+ 內建 fetch / readline / http / crypto）。
// 專案：https://github.com/The-Pocket-Company/Banaverse-CLI
// ============================================================================
import { writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CFG_FILE, DEFAULT_URL, loadCfg, saveCfg, clearCfg, bearer } from '../lib/auth.mjs';
import { groupModels, priceLabel, imageQuote, lockedMark, KIND_ZH } from '../lib/catalog.mjs';
import { isRemote, localImage } from '../lib/refs.mjs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';

// ── config（讀寫與換 token 都在 lib/auth.mjs，MCP server 共用）──────────────
/** 這次要打哪個站、帶哪一把憑證。憑證可能是 --key／環境變數的金鑰，也可能是登入存下的
 *  OAuth token（快過期會先換新）——呼叫端不用分辨，都當 Bearer 送。 */
async function resolved(flags) {
  const c = loadCfg();
  const url = (flags.url || process.env.BANAVERSE_URL || c.url || DEFAULT_URL).replace(/\/$/, '');
  const key = await bearer(url, { key: flags.key, env: process.env });
  return { url, key };
}

// ── args ────────────────────────────────────────────────────────────────
// 只有這些旗標「吃下一個值」；布林旗標白名單明列——**不認識的旗標一律直接報錯**。
// 教訓（2026-07-29 實測）：舊版把未知旗標默默當布林，`--ref a.png` 在還沒有 --ref 的版本上
// 被吞掉、a.png 變成提示詞的一部分，八次生成 40 點全變成無參考的錯圖，全程零錯誤訊息。
// 拼錯參數的代價不能是「扣了點才發現」。
const VALUE_FLAGS = new Set(['url', 'key', 'model', 'aspect', 'size', 'out', 'label', 'seconds', 'ref', 'answer']);
const REPEATABLE = new Set(['ref']); // 可重複給的旗標 → 收成陣列（多張參考圖）
const BOOL_FLAGS = new Set(['yes', 'video', 'help', 'h']);
function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && !/^-\d/.test(a))) {
      const k = a.replace(/^--?/, '');
      if (VALUE_FLAGS.has(k)) {
        const nxt = argv[i + 1];
        if (nxt === undefined || nxt.startsWith('--')) fail(`旗標 --${k} 需要一個值。`); // 早退，避免扣點後才失敗
        if (REPEATABLE.has(k)) (flags[k] ??= []).push(nxt);
        else flags[k] = nxt;
        i++;
      } else if (BOOL_FLAGS.has(k)) {
        flags[k] = true;
      } else {
        fail(`未知參數：--${k}（拼錯了嗎？）。可用參數見：banaverse help`);
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

// --ref：本機檔案路徑 → data URL（lib/refs.mjs，本機 MCP 共用）；已經是 data:/https: 就原樣送。
// 伺服器端只收 data URL、base64、或 Banaverse 自己回傳的網址（防 SSRF），
// 所以外部圖片網址在這裡就會被伺服器擋成 400，不會白扣點。
function readRefs(flags) {
  const list = Array.isArray(flags.ref) ? flags.ref : flags.ref ? [flags.ref] : [];
  return list.map((r) => {
    if (isRemote(r)) return r;
    let data;
    try { data = localImage(r); } catch (e) { fail(e.message); }
    if (!data) fail(`找不到參考圖：${r}`);
    return data;
  });
}

// ── http ────────────────────────────────────────────────────────────────
// hint：失敗時接在錯誤訊息後面的一句。取件時用來把 jobId 交回給使用者——
// 輪詢中途一個暫時性的 5xx 就讓程式結束，而使用者手上沒有取件代號的話，只剩「重跑 generate」一條路，那會再扣一次點。
async function api(path, { method = 'GET', body, url, key, hint = '', _retried = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(url + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    fail(`連不到 ${url}${path}（${e.message}）。檢查網路，或用 --url 指定站台。${hint}`);
  }
  // 401 且帶的是登入存下的 token：可能剛好過期（時鐘差、或上次換新沒存到），
  // 強制換一次再試一回。換不到才是真的登出了。--key／環境變數那種金鑰換不出新的，直接落到下面報錯。
  if (res.status === 401 && key && !_retried) {
    const fresh = await bearer(url, { env: process.env, force: true });
    if (fresh && fresh !== key) return api(path, { method, body, url, key: fresh, hint, _retried: true });
  }
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) fail(`尚未登入或登入已過期。先跑：banaverse login${hint}`);
  if (!res.ok) fail(`HTTP ${res.status}：${d.error ?? '未知錯誤'}${hint}`);
  return d;
}

// 失敗時不呼叫 process.exit：Windows 上的 Node 24 在 fetch 的連線還沒收完時 exit，
// 會撞 libuv 的 assertion（UV_HANDLE_CLOSING）而以 127 結束、多印一行看不懂的錯。
// 改成丟一個記號錯誤一路退回 main()，設好 exitCode 讓行程自然結束。
class Exit extends Error {}
function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; throw new Exit(msg); }
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
  // 預設：瀏覽器登入（OAuth loopback）——登入後存 token 自動續期，你不用碰 key。
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

  // 直接存 OAuth token（含 refresh 與這次註冊的 client_id——換 token 時要帶同一個）。
  // 先前這裡會再拿 token 去 /api/cli/keys 換一把長效金鑰，那條路已被伺服器刻意擋掉，見檔頭。
  saveCfg({
    url,
    clientId: regData.client_id,
    access: tokData.access_token,
    refresh: tokData.refresh_token,
    expiresAt: Date.now() + (Number(tokData.expires_in) || 3600) * 1000,
  });
  const me = await api('/api/v1/me', { url, key: tokData.access_token });
  console.log(`✓ 已登入：${me.email || me.uid}（餘額 ${me.credits} 點）  → ${CFG_FILE}`);
}

function cmdLogout() {
  clearCfg();
  console.log('✓ 已清除本機設定。');
}

async function cmdWhoami(flags) {
  const { url, key } = await resolved(flags);
  if (!key) fail('尚未登入。先跑：banaverse login');
  const me = await api('/api/v1/me', { url, key });
  console.log(`${me.email || me.uid}${me.isAdmin ? '（admin，生成不扣點）' : ''}  餘額：${me.credits} 點`);
}

async function cmdModels(flags) {
  // 帶憑證查（有的話）：清單才會標出這個帳號哪些模型沒開通；沒登入照樣能看公開價目。
  const { url, key } = await resolved(flags);
  const d = await api('/api/v1/models', { url, key });
  const idW = Math.max(...d.models.map((m) => m.id.length)) + 2;
  const labelW = Math.max(...d.models.map((m) => m.label.length)) + 2;
  for (const g of groupModels(d.models)) {
    const cli = g.kind === 'image' ? '' : g.kind === 'video' ? '（加 --video）' : '（CLI 不生成，請用 MCP 或 API）';
    console.log(`${g.title}${/[A-Za-z0-9]$/.test(g.title) ? ' ' : ''}模型${cli}——${g.unit}：`);
    for (const m of g.models) {
      console.log(`  ${m.default ? '★' : ' '} ${m.id.padEnd(idW)}${m.label.padEnd(labelW)}${priceLabel(m)}${lockedMark(m)}`);
    }
    console.log('');
  }
  console.log('  ★＝該類預設；用 --model <id> 指定其他。點數為伺服器即時售價，實扣以生成回應為準。');
}

// 只有這兩類能從終端機生成；其餘（音訊、3D）在確認與扣點之前就擋下，並指出該去哪裡。
// 守門用「只放行」而不是「只擋影片」：先前指定音訊／3D 模型時 CLI 會先報價、問要不要繼續，
// 按了 y 才被伺服器回一句「未知或不支援的圖片模型」，跟使用者選的東西對不上。
const CLI_KINDS = new Set(['image', 'video']);

async function cmdGenerate(pos, flags) {
  const { url, key } = await resolved(flags);
  if (!key) fail('尚未登入。先跑：banaverse login');
  const prompt = pos.join(' ').trim();
  if (!prompt) fail('缺少提示。用法：banaverse generate "一隻賽博龐克貓" [--video] [--model …] [--out cat.png] [--yes]');
  if (flags.seconds !== undefined && !(Number(flags.seconds) > 0)) fail(`--seconds 要是正數（收到：${flags.seconds}）。`);

  // 查型錄（帶憑證才知道 available）：--video，或 --model 指到影片模型 → 走影片（非同步長任務）
  const catalog = await api('/api/v1/models', { url, key });
  const usable = catalog.models.filter((m) => CLI_KINDS.has(m.kind));
  const picked = flags.model ? catalog.models.find((m) => m.id === flags.model) : null;
  if (flags.model && !picked) fail(`未知模型：${flags.model}。可用：${usable.map((m) => m.id).join(', ')}`);
  const wantVideo = !!flags.video || picked?.kind === 'video';
  // 只挑同類的預設——清單裡圖、影各有一顆★，靠排序撿第一顆是脆弱依賴
  const info = picked || catalog.models.find((m) => m.default && m.kind === (wantVideo ? 'video' : 'image'));
  if (!info) fail('伺服器沒有標出預設模型。用 --model <id> 指定（見 banaverse models）。');
  if (!CLI_KINDS.has(info.kind)) {
    fail(`${info.id} 是${KIND_ZH[info.kind] || info.kind}模型——CLI generate 只做圖片與影片。音訊、3D 請用 MCP（banaverse-mcp）或 API（${url}/api-docs）。`);
  }
  if (flags.video && info.kind !== 'video') fail(`--video 搭配的 ${info.id} 是圖片模型。拿掉 --video 生圖，或換一個影片模型（見 banaverse models）。`);
  if (info.available === false) fail(`這個帳號沒有開通 ${info.label}（${info.id}）。換一個模型（banaverse models 標「未開通」的都不能用）。`);

  // 參考圖先讀進來：路徑打錯就在問使用者之前失敗，不會確認完、扣了點才發現檔案不存在。
  const refs = readRefs(flags);
  const isVideo = info.kind === 'video';
  const action = isVideo
    ? (refs.length ? `用 ${refs.length} 張參考圖生成影片` : '生成影片')
    : (refs.length ? `改圖（${refs.length} 張參考圖）` : '生成');
  // 圖片報的是實扣（prices 與伺服器扣點同一條算式）；影片只能報基準售價，理由見 lib/catalog.mjs。
  const cost = isVideo
    ? `基準售價 ${info.credits} 點（一份的價錢，實扣依秒數與解析度；送出後會印出實扣）`
    : `將花 ${imageQuote(info, flags.size, refs.length > 0)} 點`;

  // 生成前確認（花點數）：--yes 跳過；互動終端問 y/N；非互動（agent/pipe）要求 --yes。
  // 免費模型（本地版）不必問：這道確認是為了「花點數」。
  if (!flags.yes && !info.free) {
    if (stdin.isTTY && stdout.isTTY) {
      const a = await ask(`用 ${info.label}（${info.id}）${action}，${cost}。繼續？[y/N] `);
      if (!/^y(es)?$/i.test(a)) { console.log('已取消。'); return; }
    } else {
      fail(`用 ${info.label}（${info.id}）${action}，${cost}。確認後加 --yes 再跑（或先 banaverse models 看價格）。`);
    }
  }

  if (isVideo) return await generateVideo({ url, key, prompt, info, flags, refs });

  process.stderr.write(`⏳ 生成中（${info.label}）…\n`);
  let r = await api('/api/v1/generate', {
    method: 'POST', url, key,
    body: { prompt, model: info.id, aspectRatio: flags.aspect, imageSize: flags.size, refs: refs.length ? refs : undefined },
  });
  // 自有機台的圖片（Banaverse Image）排隊太久時，伺服器回 async＋jobId（點已扣、工單在跑）。
  // 在這裡接著取件，**不要重送**——重送會再生成一次、再扣一次點。
  if (r.async && r.jobId) {
    process.stderr.write(`⏳ 機台排隊中（點數已扣，不要重跑 generate）。中途離開可用這個 jobId 取回：\n   ${r.jobId}\n`);
    const j = await waitJob({ url, key, jobId: r.jobId, everyMs: 5000 });
    if (!j) return;
    r = { ...j, credits: j.credits ?? r.credits };
  }
  const out = await saveResult(r, flags.out);
  console.log(`✓ 生成完成（${spent(r.credits)}）→ ${out}`);
}

// ── 工具（白背景、試穿、多尺寸…；型錄在伺服器 /api/v1/tools，跟網頁上的工具同一份）──────────
// 跟 generate 的差別：prompt、模型與比例由 Banaverse 決定，呼叫端只給圖與一句答案（換背景＝換成什麼）。
// 為什麼（2026-11-11）：agent 自己寫試穿、白背景的 prompt，好壞看它的功力、每次還不一樣；
// 工具是調過的那一份，誰叫都拿到一樣的成品，agent 也不必花 token 寫 prompt。

/** 一行講清楚要給什麼：幾張圖（每張是什麼）、--answer 填什麼、出圖還是出影片。 */
function toolNeeds(t) {
  const n = t.images.min === t.images.max ? `${t.images.min} 張圖` : `${t.images.min}–${t.images.max} 張圖`;
  const slots = t.slots ? `：${t.slots.join('、')}` : '';
  const opts = t.ask?.kind === 'pick' ? t.ask.options.map((o) => o.id) : [];
  const ask = !t.ask ? '' : t.ask.kind === 'pick'
    ? `；--answer ${opts.length > 6 ? `${opts.slice(0, 6).join('／')}…` : opts.join('／')}${t.ask.single ? '' : '（可複選）'}`
    : `；--answer「${t.ask.question}」${t.ask.required ? '' : '（可省略）'}`;
  return `${n}${slots}${ask}${t.out === 'video' ? '；出影片' : ''}`;
}

/** 某個工具的完整說明（給錯參數時一起印出來，不必再查一次）。 */
function toolDetail(t) {
  const lines = [`${t.id}「${t.label}」：${t.hint}`, `  要給：${toolNeeds(t)}`];
  if (t.ask?.kind === 'pick') lines.push(`  ${t.ask.question}可填：${t.ask.options.map((o) => o.id).join('、')}（不給＝${t.ask.defaults.join('、')}）`);
  const refs = t.slots ? t.slots.map((s) => ` --ref ${s}.jpg`).join('') : ' --ref 圖.jpg'.repeat(t.images.min);
  lines.push(`  例：banaverse tool ${t.id}${refs}${t.ask?.kind === 'text' && t.ask.required ? ' --answer "…"' : ''}`);
  return lines.join('\n');
}

async function cmdTools(flags) {
  const { url } = await resolved(flags);
  const d = await api('/api/v1/tools', { url });
  const idW = Math.max(...d.tools.map((t) => t.id.length)) + 2;
  for (const c of d.categories) {
    const list = d.tools.filter((t) => t.category === c.id);
    if (!list.length) continue;
    console.log(`${c.label}：`);
    for (const t of list) console.log(`  ${t.id.padEnd(idW)}${t.label}　${t.hint}（${toolNeeds(t)}）`);
    console.log('');
  }
  console.log('用法：banaverse tool <代號> --ref <圖> [--ref <圖>] [--answer "…"]\n例：  banaverse tool tryon --ref 人物.jpg --ref 衣服.jpg');
}

/** --answer 整理成伺服器要的樣子（規則同伺服器的 toolAnswer）：選項題不給就用預設；文字題必填的沒給就擋。 */
function toolAnswer(t, raw) {
  const ask = t.ask;
  if (!ask) return undefined;
  if (ask.kind === 'pick') {
    if (raw === undefined) return ask.defaults;
    // 單選不切字：選項本身可能有空白（「3D 卡通」）。複選照伺服器的規則用頓號、逗號或空白分。
    const list = ask.single ? [String(raw).trim()] : String(raw).split(/[、,，\s]+/);
    const picked = list.map((x) => x.trim()).filter((id) => ask.options.some((o) => o.id === id));
    if (!picked.length) fail(`「${t.label}」的 --answer 只能填：${ask.options.map((o) => o.id).join('、')}`);
    return ask.single ? [picked[0]] : [...new Set(picked)];
  }
  const text = String(raw ?? '').trim();
  if (!text && ask.required) fail(`「${t.label}」要先回答：${ask.question}（加 --answer "…"）\n${toolDetail(t)}`);
  return [text];
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '');

async function cmdTool(pos, flags) {
  const { url, key } = await resolved(flags);
  if (!key) fail('尚未登入。先跑：banaverse login');
  const id = (pos[0] || '').trim();
  if (!id) fail('用法：banaverse tool <代號> --ref <圖> [--answer "…"]（工具清單：banaverse tools）');
  const [{ tools }, catalog] = await Promise.all([api('/api/v1/tools', { url }), api('/api/v1/models', { url, key })]);
  const t = tools.find((x) => x.id === id);
  if (!t) fail(`沒有「${id}」這個工具。工具清單：banaverse tools`);
  // 圖、答案、模型都先驗過，才問要不要花點數：不會確認完、扣了點才發現少一張圖。
  const refs = readRefs(flags);
  if (refs.length < t.images.min || refs.length > t.images.max) {
    const n = t.images.min === t.images.max ? `${t.images.min}` : `${t.images.min}–${t.images.max}`;
    fail(`「${t.label}」要 ${n} 張圖${t.slots ? `（照順序：${t.slots.join('、')}）` : ''}，這次給了 ${refs.length} 張。\n${toolDetail(t)}`);
  }
  const answer = toolAnswer(t, flags.answer);

  // 模型：指定就用（要同一類）；沒指定就照工具排的順序，挑第一顆這個帳號開通了的——跟伺服器挑的一樣，報價才對得上。
  let info;
  if (flags.model) {
    info = catalog.models.find((m) => m.id === flags.model);
    if (!info) fail(`未知模型：${flags.model}。可用：${catalog.models.filter((m) => m.kind === t.out).map((m) => m.id).join(', ')}`);
    if (info.kind !== t.out) fail(`「${t.label}」做的是${KIND_ZH[t.out]}，--model 要填${KIND_ZH[t.out]}模型（${info.id} 是${KIND_ZH[info.kind] || info.kind}）。`);
    if (info.available === false) fail(`這個帳號沒有開通 ${info.label}（${info.id}）。`);
  } else {
    info = t.models.map((m) => catalog.models.find((x) => x.id === m)).find((m) => m && m.available !== false);
    if (!info) fail(`這個帳號沒有開通「${t.label}」用得到的模型（${t.models.join('、')}）。`);
  }

  // 一個工具可能出好幾版（多尺寸一個比例一版、系列圖四版），每一版各扣一次。
  const versions = t.versions?.perOption ? answer.length : (t.versions?.count || 1);
  const isVideo = t.out === 'video';
  const each = isVideo ? info.credits : imageQuote(info, flags.size, true);
  const cost = isVideo
    ? `${versions > 1 ? `${versions} 版，` : ''}每版基準售價 ${each} 點（實扣依秒數與解析度；送出後會印出實扣）`
    : `將花 ${each * versions} 點${versions > 1 ? `（${versions} 版，每版 ${each} 點）` : ''}`;
  if (!flags.yes && !info.free) {
    const q = `用「${t.label}」（${info.label}）處理 ${refs.length} 張圖，${cost}。`;
    if (stdin.isTTY && stdout.isTTY) {
      const a = await ask(`${q}繼續？[y/N] `);
      if (!/^y(es)?$/i.test(a)) { console.log('已取消。'); return; }
    } else {
      fail(`${q}確認後加 --yes 再跑（或先 banaverse models 看價格）。`);
    }
  }

  process.stderr.write(`⏳ ${t.label}中（${info.label}${versions > 1 ? `，${versions} 版` : ''}）…\n`);
  const r = await api('/api/v1/tools', {
    method: 'POST', url, key,
    body: {
      tool: t.id, answer, images: refs, model: info.id, aspectRatio: flags.aspect, imageSize: flags.size,
      durationSec: flags.seconds ? Number(flags.seconds) : undefined,
    },
  });
  let saved = 0;
  const base = `banaverse-${t.id}-${stamp()}`;
  for (const [i, s] of r.steps.entries()) {
    const name = r.steps.length > 1 ? s.step : '';
    if (!s.ok) { console.error(`✗ ${name || t.label}：${s.error}`); continue; }
    let res = s;
    // 影片、排隊太久的自有機台圖片：點已扣、工單在跑，在這裡接著取件——不要重跑 tool，那會再扣一次。
    if (s.async) {
      process.stderr.write(`⏳ ${name || t.label}${isVideo ? '影片生成中，通常 1–5 分鐘' : '機台排隊中'}（${s.credits ? `已扣 ${s.credits} 點` : '未扣點'}）。中途離開可用這個 jobId 取回：\n   ${s.jobId}\n`);
      const j = await waitJob({ url, key, jobId: s.jobId, everyMs: isVideo ? 10000 : 5000 });
      if (!j) continue;
      res = { ...j, credits: j.credits ?? s.credits };
    }
    // 好幾版時檔名帶上那一版的名字（多尺寸＝比例），不然同一秒存的會互相蓋掉。
    const tag = safeName(name) || String(i + 1);
    const out = r.steps.length > 1 && flags.out ? flags.out.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-${tag}${ext}`) : flags.out;
    const path = await saveResult(res, out, r.steps.length > 1 ? `${base}-${tag}` : base);
    saved++;
    console.log(`✓ ${name || t.label}（${spent(res.credits)}）→ ${path}`);
  }
  if (!saved) process.exitCode = 1;
}

// 影片是長任務：POST 只拿到 jobId，要輪詢 /api/v1/jobs/{id} 直到 done。
// 伺服器完成後會把影片放上 Cloud Storage 並回公開網址，這裡抓那個網址存檔。
async function generateVideo({ url, key, prompt, info, flags, refs = [] }) {
  const sub = await api('/api/v1/generate', {
    method: 'POST', url, key,
    body: {
      kind: 'video', prompt, model: info.id, aspectRatio: flags.aspect,
      durationSec: flags.seconds ? Number(flags.seconds) : undefined,
      refs: refs.length ? refs : undefined,
    },
  });
  if (!sub.jobId) fail('沒有拿到 jobId。');
  // 確認時只報得出基準售價，這裡把伺服器實際扣的講出來。
  process.stderr.write(`⏳ 影片生成中（${info.label}，${sub.credits ? `已扣 ${sub.credits} 點，失敗會在取件時退點` : '未扣點'}）…`
    + `通常 1–5 分鐘，可按 Ctrl+C 離開，之後用 jobId 再取：\n   ${sub.jobId}\n`);
  const j = await waitJob({ url, key, jobId: sub.jobId, everyMs: 10000 });
  if (!j) return;
  const out = await saveResult(j, flags.out);
  console.log(`✓ 影片完成（${spent(j.credits ?? sub.credits)}）→ ${out}`);
}

/** 輪詢到完成，回完成的工單；超過本地等待上限回 null（已印出取件指令）。
 *  停止等待不會取消工單——所以上限到了是把 jobId 交回去，不是報錯。 */
async function waitJob({ url, key, jobId, everyMs, limitMs = 15 * 60 * 1000 }) {
  const hint = `\n  工單沒有取消。稍後可用 banaverse job ${jobId} 再查；不要重跑 generate（會再扣一次點）。`;
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, everyMs));
    const j = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { url, key, hint });
    if (j.done) { process.stderr.write('\n'); return j; }
    process.stderr.write(`   …${Math.round((j.progress || 0) * 100)}%\r`);
    if (Date.now() - started > limitMs) {
      console.log(`\n仍在生成中。稍後用這個 jobId 取件：\n  banaverse job ${jobId}`);
      return null;
    }
  }
}

/** 取件既有的工單：影片、排隊太久的自有機台圖片，或從 MCP／API 送出的 3D。 */
async function cmdJob(pos, flags) {
  const { url, key } = await resolved(flags);
  if (!key) fail('尚未登入。先跑：banaverse login');
  const jobId = pos.join(' ').trim();
  if (!jobId) fail('用法：banaverse job <jobId> [--out <檔名>]');
  const j = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { url, key });
  if (!j.done) { console.log(`還在生成中（${Math.round((j.progress || 0) * 100)}%）。稍後再試。`); return; }
  const out = await saveResult(j, flags.out);
  console.log(`✓ ${KIND_ZH[j.kind] || ''}完成（${spent(j.credits)}）→ ${out}`);
}

const spent = (c) => (c ? `花 ${c} 點` : '未扣點');

// 副檔名照實際內容決定，不照種類寫死：3D 依模型可能是 GLB，也可能是含 OBJ／材質的 ZIP，
// 一律存成 .glb 的話，ZIP 會打不開而且看不出原因。
const EXT_OF_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'model/gltf-binary': 'glb', 'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};
const FALLBACK_EXT = { image: 'png', video: 'mp4', audio: 'mp3' }; // 3D 猜不出就不猜（.bin），理由同上

/** 把生成結果寫到檔案，回寫入的路徑。有 dataUrl 就直接用（同一份位元組，省一次下載）；
 *  取件回來的常常只有網址（dataUrl 是空字串），那就下載它。 */
async function saveResult(r, outFlag, base) {
  let bytes, ext;
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(r.dataUrl || '');
  if (m) {
    ext = EXT_OF_TYPE[m[1].toLowerCase()];
    bytes = Buffer.from(m[2], 'base64');
  } else if (r.url) {
    const res = await fetch(r.url).catch((e) => fail(`下載失敗（${e.message}）：${r.url}`));
    if (!res.ok) fail(`下載失敗（HTTP ${res.status}）：${r.url}`);
    ext = EXT_OF_TYPE[(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()] || extOfUrl(r.url);
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    fail('完成了但沒有拿到檔案（沒有網址也沒有內容）。');
  }
  const out = pathResolve(outFlag || `${base || `banaverse-${stamp()}`}.${ext || FALLBACK_EXT[r.kind] || 'bin'}`);
  writeFileSync(out, bytes);
  return out;
}
function extOfUrl(u) {
  try {
    const name = decodeURIComponent(new URL(u).pathname).split('/').pop() || '';
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return /^[a-z0-9]{2,5}$/.test(ext) ? ext : '';
  } catch { return ''; }
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
  banaverse models                                  可用模型與即時售價（圖片／影片／音訊／3D）
  banaverse generate "<提示>" [選項]                 生成圖片（加 --video 生成影片；加 --ref 用參考圖）
  banaverse tools                                   工具清單（白背景、換背景、試穿、多尺寸、換畫風…）
  banaverse tool <代號> --ref <圖> [--answer "…"]    用工具處理圖片（prompt 與模型是調好的，只要給圖）
  banaverse job <jobId> [--out <檔名>]              取回先前送出的影片、排隊中的圖片或 3D
  banaverse logout                                  清除本機設定

generate 選項：
  --video          生成影片（長任務，會自動輪詢到完成；預設 Veo 3.1 Lite）
  --ref <檔案>     參考圖：圖生圖／圖生影片。可重複給多張（--ref a.png --ref b.png），上限依模型。
                   吃本機檔案路徑（png/jpg/webp/gif），也接受 data URL 或 Banaverse 回傳的網址。
                   影片：只有 Veo 3.1 Lite（預設）拿第一張當首幀；其他模型一律當參考圖，
                   其中 Veo 3.1／Fast 掛參考圖時固定 8 秒、照 8 秒扣點。
  --model <id>     指定模型（預設＝Nano Banana 2 Lite；影片預設 Veo 3.1 Lite）
  --aspect <比例>  1:1 / 16:9 / 9:16 …（不給＝模型預設：Nano Banana 系文生圖 16:9、改圖沿用參考圖比例；
                   Seedream 與 Banaverse Image 1:1；影片 16:9）
  --size <解析度>  512px / 1K / 2K / 4K（僅圖片；可用值與預設依模型，例：Nano Banana 2 Lite 只有 1K、
                   Pro 預設 2K。解析度影響售價）
  --seconds <秒>   影片長度（依模型支援範圍）
  --out <檔名>     輸出檔（預設 banaverse-<時間>.<依檔案類型>）
  --yes            跳過「花 N 點」確認（agent 請先向使用者確認再帶此旗標）

售價以 banaverse models 為準（伺服器即時算）。圖片依解析度與是否改圖，確認時報的就是實扣；
影片列的是一份的基準售價，實扣依秒數與解析度，送出後會印出實扣。各模型的可用值見
https://banaverse.thepocket.company/api-docs 的「模型參考」。

tool 選項：
  --ref <檔案>     要處理的圖，照工具要的順序（例：試穿＝先人物、再衣服）。張數見 banaverse tools。
  --answer "…"     工具要問的那一題（換背景＝換成什麼、多尺寸＝1:1、9:16）。選項題不給就用預設。
  --model／--aspect／--size／--seconds／--out／--yes  同 generate。好幾版的工具（多尺寸、系列圖）
                   每一版各扣一次點、各存一個檔（檔名帶上那一版的名字）。

影片需 1–5 分鐘。中途 Ctrl+C 離開後，可用印出來的 jobId 跑 banaverse job <jobId> 取回；
不要重跑 generate，那會再扣一次點。音訊與 3D 不在 CLI，請用 MCP（banaverse-mcp）或 API。

登入：banaverse login 會開瀏覽器授權，登入後自動續期（不用手動貼金鑰）。
進階：也可 --key <bnv_…> 直接帶金鑰，或用環境變數 BANAVERSE_API_KEY / BANAVERSE_URL。`;

async function main() {
  let argv = process.argv.slice(2);
  if (argv[0] === 'auth') argv = argv.slice(1); // 支援 "banaverse auth login"
  const { pos, flags } = parse(argv.slice(1));
  const cmd = argv[0];
  if (flags.help || flags.h) { console.log(HELP); return; } // `banaverse generate --help` 也要能看說明
  switch (cmd) {
    case 'login': return cmdLogin(flags);
    case 'logout': return cmdLogout();
    case 'whoami': return cmdWhoami(flags);
    case 'models': return cmdModels(flags);
    case 'generate': case 'gen': return cmdGenerate(pos, flags);
    case 'job': return cmdJob(pos, flags);
    case 'tools': return cmdTools(flags);
    case 'tool': return cmdTool(pos, flags);
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return;
    default: console.error(`未知指令：${cmd}\n`); console.log(HELP); process.exitCode = 1;
  }
}

main().catch((e) => {
  if (e instanceof Exit) return; // 已印過訊息
  console.error('✗ ' + String(e?.message ?? e));
  process.exitCode = 1;
});
