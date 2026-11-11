#!/usr/bin/env node
// ============================================================================
// Banaverse MCP server（stdio）——讓 Claude Desktop / Claude Code 透過 MCP
// 直接呼叫 Banaverse 生成。與 CLI／畫布共用同一套帳號、點數、守門邏輯。
//
// 工具（清單在下面的 TOOLS，這裡只列用途）：
//   banaverse_generate_image／_video／_audio／_3d  生成（扣點；呼叫前應向使用者確認花費）
//   banaverse_list_tools／banaverse_use_tool      工具（白背景、試穿、多尺寸…）：prompt 與模型是 Banaverse 調好的，只要給圖
//   banaverse_get_job         影片、3D 與排隊太久的自有機台圖片取件
//   banaverse_list_models     可用模型與售價（公開，免登入；登入了會標出未開通的）
//   banaverse_get_balance     帳號與點數餘額
//
// 網站另有一支免安裝的 HTTP 版 MCP（/api/mcp），取件分成 get_image／get_video／get_3d；
// 這支只有一支 banaverse_get_job——底層是同一個取件端點，分開只是名字不同。
//
// 認證：跑過 `banaverse login`（瀏覽器登入）後自動沿用 ~/.banaverse/config.json 的 OAuth token，
//       快過期會自動換新（lib/auth.mjs，與 CLI 同一份）；或設環境變數 BANAVERSE_API_KEY（bnv_…）。
//       BANAVERSE_URL 預設正式站。
// 圖：refs 與 images 都收本機檔案路徑（lib/refs.mjs 在這一側讀成 data URL），也收 data URL、純 base64、Banaverse 回傳的網址。
//     這是本機版勝過雲端版的地方：在 Claude Code 裡貼的圖會存成本機檔案，agent 給路徑就好，不必把整張圖轉成 base64 吐出來。
// 相依：零（Node 18+ 內建 fetch）。協定：JSON-RPC 2.0 over stdio（換行分隔）。
// 專案：https://github.com/The-Pocket-Company/Banaverse-CLI
// ============================================================================
import { stdin, stdout, stderr, env } from 'node:process';
import { readFileSync } from 'node:fs';
import { loadCfg, hasLogin, bearer, DEFAULT_URL } from '../lib/auth.mjs';
import { groupModels, priceLabel, lockedMark } from '../lib/catalog.mjs';
import { isRemote, localImage } from '../lib/refs.mjs';

// 認證來源優先序：環境變數 > CLI 設定檔（~/.banaverse/config.json，banaverse login 產生）> 預設。
// → 只要跑過 `banaverse login`，MCP 免再設 env 就能沿用同一份登入（金鑰或 OAuth token 都行，
//   後者快過期會自動換新——邏輯在 lib/auth.mjs，跟 CLI 同一份）。
const CFG = loadCfg();
const URL_BASE = (env.BANAVERSE_URL || CFG.url || DEFAULT_URL).replace(/\/$/, ''); // 正式站；本機測試設 BANAVERSE_URL 或用 CLI config
const PROTO = '2025-06-18';
// 版號跟套件走，不另寫一份：先前寫死 0.1.0，發到 0.3 版時 client 端看到的還是 0.1.0。
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; }
})();
const log = (...a) => stderr.write('[banaverse-mcp] ' + a.join(' ') + '\n'); // 一律走 stderr，stdout 只留給 JSON-RPC

// ── JSON-RPC over stdio（換行分隔訊息）──────────────────────────────────────
let buf = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) void handle(line);
  }
});

const send = (msg) => stdout.write(JSON.stringify(msg) + '\n');
// id === undefined ＝通知（notification），依 JSON-RPC 一律不回應（避免送出無 id 的畸形回覆）
const reply = (id, result) => { if (id === undefined) return; send({ jsonrpc: '2.0', id, result }); };
const replyErr = (id, code, message) => { if (id === undefined) return; send({ jsonrpc: '2.0', id, error: { code, message } }); };

async function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion || PROTO,
          capabilities: { tools: {} },
          serverInfo: { name: 'banaverse', version: VERSION },
        });
      case 'notifications/initialized':
      case 'initialized':
        return; // 通知，無需回應
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call':
        try { return reply(id, await callTool(params?.name, params?.arguments || {})); }
        catch (e) { return reply(id, errResult(String(e?.message ?? e))); } // 工具執行錯誤→isError result（讓 Claude 看得到）
      default:
        if (id !== undefined) return replyErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) replyErr(id, -32603, String(e?.message ?? e));
  }
}

// ── Banaverse API ───────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body, _retried = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // 每次呼叫現取：MCP server 會活很久，一小時前拿的 token 這一刻可能已經過期
  const key = await bearer(URL_BASE, { env, force: _retried });
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(URL_BASE + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  // 401 且還沒重試過：強制換一次 token 再來一回（時鐘差、或上次換新沒存到）
  if (res.status === 401 && key && !_retried) return api(path, { method, body, _retried: true });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('尚未登入或登入已過期：請先跑 banaverse login');
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

// ── Tools ─────────────────────────────────────────────────────────────────
// 工具說明裡不寫任何點數：售價是伺服器現算、後台還能覆寫，寫在這裡一定會過期。
// 一律叫 agent 先查 banaverse_list_models（讀 /api/v1/models，與扣點同一條算式）。
const TOOLS = [
  {
    name: 'banaverse_generate_image',
    description:
      '用 Banaverse 生成一張圖片。給了 refs 就是「看圖改圖」（圖生圖），沒給就是純文字生圖。'
      + '會扣使用者點數——呼叫前請先向使用者確認花費（可先用 banaverse_list_models 查價、banaverse_get_balance 查餘額）。'
      + '跑在 Banaverse 自有機台上的模型（banaverse-image 與其本地版）需要排隊：通常仍直接回圖，'
      + '排隊太久時會改回 jobId，請用 banaverse_get_job 取件（不要重送，重送會再扣一次點）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '圖片描述（具體：主體、風格、構圖、光線）。有 refs 時寫「要怎麼改」' },
        model: { type: 'string', description: '模型 id（預設 gemini-3.1-flash-lite-image）。價格一律以 banaverse_list_models 為準——那邊是現算的，寫在這裡的數字一定會過期。' },
        aspectRatio: { type: 'string', description: '1:1 / 16:9 / 9:16 …（預設依模型：Nano Banana 系文生圖 16:9、改圖沿用參考圖比例；Seedream 與 Banaverse Image 1:1）' },
        imageSize: { type: 'string', description: '512px / 1K / 2K / 4K（可用值與預設依模型：Nano Banana 2 Lite 只有 1K、Pro 預設 2K；不支援的值會被夾回預設，自有機台模型則回錯誤並列出可用值、不扣點）。解析度影響售價' },
        searchGrounding: { type: 'boolean', description: '生成前先用 Google 搜尋取得真實資訊（僅 Nano Banana Pro 與 2 支援）。會加價：每張另加一筆搜尋費（目前約 0.38 份基準售價），banaverse_list_models 的價目不含這項' },
        refs: { type: 'array', items: { type: 'string' }, description: '參考圖（本機檔案路徑（png／jpg／webp／gif）、data URL、純 base64，或本工具回傳的網址），給了＝圖生圖。不接受其他網站的圖片網址（會回 400）；張數上限依模型，超過的會被截掉' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'banaverse_generate_video',
    description:
      '生成一支影片。長任務：本工具只送出並回傳 jobId，接著每隔約 15 秒呼叫 banaverse_get_job 取件，通常 1–5 分鐘。'
      + '影片比圖片貴很多，而且按秒數與解析度計價——呼叫前先用 banaverse_list_models 查價並向使用者確認。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '影片描述（主體、動作、運鏡、場景、光線）' },
        model: { type: 'string', description: '影片模型 id（預設 veo-3.1-lite-generate-preview）' },
        aspectRatio: { type: 'string', description: '16:9 / 9:16 …（依模型；預設 16:9）' },
        durationSec: { type: 'number', description: '秒數（依模型範圍；超出會被夾回。自有機台模型 banaverse-h3、banaverse-h3-local 例外：給了不在清單裡的秒數會回錯誤 unsupported_option 並列出可用值，不扣點）' },
        resolution: { type: 'string', description: '480p / 720p / 1080p / 4k（依模型；直接影響售價）' },
        generateAudio: { type: 'boolean', description: '是否生成原生配音（部分模型恆開，關不掉）' },
        negativePrompt: { type: 'string', description: '不想出現的內容（僅 Veo）' },
        refs: { type: 'array', items: { type: 'string' }, description: '參考圖（本機檔案路徑（png／jpg／webp／gif）、data URL、純 base64，或本工具回傳的網址），給了＝圖生影。一律當風格／主體參考，不是首幀（veo-3.1-lite-generate-preview 例外：只取第一張當首幀）；Veo 3.1／Fast 掛參考圖時固定 8 秒、照 8 秒扣點。要讓圖動起來請在 prompt 裡描述' },
        videoRefs: { type: 'array', items: { type: 'string' }, description: '參考影片（目前僅 seedance-2.5）。形式：data:video/…;base64,… 或 Banaverse 回傳的網址；不接受純 base64 與其他網站的網址' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'banaverse_generate_audio',
    description: '生成音訊。音樂（Lyria，描述曲風／情緒／樂器）或語音朗讀（Gemini 語音）。同步完成，直接回網址。'
      + '語音按朗讀長度計價（每 60 秒一份，中文約 300 字）；一次最多約 7 分鐘（約 2,100 字），超過回錯誤、不扣點，請拆段。'
      + '語音模型只負責「唸」：把要唸的那句話直接給它。音訊沒有預設模型，一定要指定 model。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '音樂＝描述曲風、情緒、樂器；語音＝要唸出來的那句話本身' },
        model: { type: 'string', description: '模型 id（必填，例：lyria-3 音樂、gemini-tts 語音）' },
        voice: { type: 'string', description: '語音專用：內建聲音名（Kore、Puck、Zephyr… 共 30 個，預設 Kore）' },
      },
      required: ['prompt', 'model'],
    },
  },
  {
    name: 'banaverse_generate_3d',
    description: '生成 3D 模型（GLB，或含 OBJ／材質的 ZIP，依模型）。長任務，用 banaverse_get_job 取件。有的模型只吃圖片（hitem3d-2.0）。'
      + '**多視角能大幅提升品質**：只給正面時，背面與側面是模型自己編的。多給幾張不加錢。3D 沒有預設模型，一定要指定 model。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '物件描述（形狀、材質、風格）。hitem3d-2.0 不吃文字，寫了也不會送出（但仍不能是空字串）。' },
        model: { type: 'string', description: '模型 id（必填，例：hyper3d-gen2、hitem3d-2.0）' },
        refs: {
          type: 'array', items: { type: 'string' }, maxItems: 5,
          description: '參考圖（本機檔案路徑（png／jpg／webp／gif）、data URL、純 base64，或本工具回傳的網址），給了＝圖生 3D。hyper3d-gen2 最多 5 張、hitem3d-2.0 最多 4 張。'
            + '**hitem3d-2.0 的順序固定為正面、背面、左側、右側**。每張長寬比要在 0.40～2.50 之間。',
        },
        material: { type: 'string', enum: ['PBR', 'Shaded', 'None'], description: 'hyper3d-gen2 專用。None＝純白模。不影響售價。' },
        meshMode: { type: 'string', enum: ['Raw', 'Quad'], description: 'hyper3d-gen2 專用。Raw＝三角面（預設）、Quad＝四邊面。不影響售價。' },
        detail: { type: 'string', enum: ['high', 'medium', 'low'], description: 'hyper3d-gen2 專用，面數檔位。預設 high。不影響售價。' },
        textures4K: { type: 'boolean', description: 'hyper3d-gen2 專用。4K 貼圖（預設開）。不加錢，檔案較大。' },
        tPose: { type: 'boolean', description: 'hyper3d-gen2 專用。強制 T/A 字站姿。預設關。' },
      },
      required: ['prompt', 'model'],
    },
  },
  {
    name: 'banaverse_list_tools',
    description: 'Banaverse 的工具清單：白背景、換背景、試穿、AI 模特兒、形象照、多尺寸、換畫風、讓圖動起來…共 8 類。'
      + '工具的 prompt、模型與比例是 Banaverse 調好的，你只要給圖（與一句答案）。使用者要做的事屬於這些時，'
      + '先呼叫本工具看要幾張圖、answer 怎麼填，再用 banaverse_use_tool——比自己寫 prompt 叫 banaverse_generate_image 穩定。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'banaverse_use_tool',
    description: '用一個 Banaverse 工具處理圖片（清單、每個工具要幾張圖、answer 怎麼填，見 banaverse_list_tools）。'
      + '會扣使用者點數，一次好幾版的工具（多尺寸、系列圖、角色寫真）每一版各扣一次——呼叫前請先向使用者確認花費（banaverse_list_models 查價）。'
      + '圖片工具直接回圖（自有機台排隊太久時回 jobId）；影片工具回 jobId。兩者都用 banaverse_get_job 取件，不要重送。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具代號（banaverse_list_tools 列的那個，例：whitebg、tryon、resize）' },
        answer: { type: 'string', description: '工具要問的那一題的答案（例：換背景填「大理石桌面」、換畫風填「水彩繪本」、多尺寸填「1:1、9:16」）。沒有題目的工具不用給；選項題不給就用預設。' },
        images: {
          type: 'array', items: { type: 'string' },
          description: '要處理的圖，照工具要的順序（例：試穿＝先人物、再衣服）。每筆可以是本機檔案路徑（png／jpg／webp／gif）、data URL、純 base64，或本工具回傳的網址；不接受其他網站的圖片網址。使用者貼在對話裡的圖若有本機路徑，直接給路徑。',
        },
        model: { type: 'string', description: '選填。不給就用工具預設的模型；要換就填同一類（圖片／影片）的模型 id。' },
        aspectRatio: { type: 'string', description: '選填。只對只出一版的工具有效（多尺寸的比例就是答案本身）。' },
        imageSize: { type: 'string', description: '選填，圖片解析度（512px／1K／2K／4K，依模型）。影響售價。' },
      },
      required: ['tool', 'images'],
    },
  },
  {
    name: 'banaverse_get_job',
    description: '用 banaverse_generate_video、banaverse_generate_3d 回傳的 jobId 取件（自有機台排隊太久的圖片，banaverse_generate_image 也會回 jobId）。未完成回進度。',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  {
    name: 'banaverse_list_models',
    description: '列出可用的 Banaverse 模型與售價（圖片、影片、音訊、3D）。圖片列一張的實扣（依解析度與是否改圖）；'
      + '影片列一份的基準售價，實扣依秒數與解析度；語音按朗讀長度計。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'banaverse_get_balance',
    description: '查詢目前登入帳號（或 API key 對應帳號）的身分與點數餘額。',
    inputSchema: { type: 'object', properties: {} },
  },
];

const spent = (c) => (c ? `花 ${c} 點` : '未扣點');

/** refs／images：本機檔案讀成 data URL，其餘（data URL、網址、純 base64）原樣送給伺服器判斷。 */
function resolveImages(list) {
  if (!Array.isArray(list)) return list;
  return list.map((r) => (typeof r !== 'string' || isRemote(r) ? r : (localImage(r) ?? r)));
}
const IMG_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;

/** 圖片結果 → MCP 內容：圖本體（Claude 看得到圖）＋一行說明。網址一定要附：
 *  refs 吃「本工具回傳的網址」，沒給網址的話 agent 想拿這張接著改圖只能整張 base64 再傳一次。 */
function imageContent(d, head) {
  const m = IMG_RE.exec(d.dataUrl || '');
  const content = [];
  if (m) content.push({ type: 'image', data: m[2], mimeType: m[1] });
  content.push({ type: 'text', text: `${head}：${d.label}（${d.model}），${spent(d.credits)}。` + (d.url ? `\n網址：${d.url}` : '') });
  return { content };
}

async function callTool(name, args) {
  switch (name) {
    case 'banaverse_list_models': {
      const d = await api('/api/v1/models');
      // 依種類分組，不再用「不是影片就是圖片」的二分法：那寫法會把音訊與 3D 標成圖，
      // agent 照著去叫 generate_image 一定失敗，看起來像模型壞了。
      const out = groupModels(d.models).map((g) => `${g.title}（${g.unit}）：\n`
        + g.models.map((m) => `${m.default ? '★' : ' '} ${m.id} — ${m.label} — ${priceLabel(m)}${lockedMark(m)}`).join('\n'));
      return textResult('可用模型（★＝該類預設；實扣以生成回應為準）：\n\n' + out.join('\n\n')
        + '\n\n標「未開通」的這個帳號用不了，選了會被拒絕。圖片開 searchGrounding 另外加價，上面的價目不含這項。');
    }
    case 'banaverse_get_balance': {
      const d = await api('/api/v1/me');
      return textResult(`帳號 ${d.email || d.uid}${d.isAdmin ? '（admin，生成不扣點）' : ''}｜餘額 ${d.credits} 點`);
    }
    case 'banaverse_generate_image': {
      if (!args.prompt) return errResult('缺少 prompt');
      // 全欄位原樣轉發（undefined 會被 JSON.stringify 丟掉）——只轉一部分的話，
      // agent 給了 refs／searchGrounding 會被靜默吃掉、照樣扣點，比報錯更糟。
      const d = await api('/api/v1/generate', {
        method: 'POST',
        body: {
          prompt: args.prompt, model: args.model, aspectRatio: args.aspectRatio, imageSize: args.imageSize,
          searchGrounding: args.searchGrounding, refs: resolveImages(args.refs),
        },
      });
      // 自有機台的圖片排隊太久：伺服器回 async＋jobId（點已扣、工單在跑）。叫 agent 去取件、不要重送。
      if (d.async && d.jobId) {
        return textResult(`已送出「${d.label}」圖片生成，機台正在排隊，jobId：${d.jobId}\n`
          + `${d.credits ? `已扣 ${d.credits} 點（工單失敗時，下一次取件會退點——所以要一直取到有結果或錯誤）。` : '未扣點。'}`
          + '請每隔約 10 秒用 banaverse_get_job 帶這個 jobId 取件；不要重送，重送會再生成並再扣一次點。');
      }
      return imageContent(d, '已生成');
    }
    case 'banaverse_generate_video':
    case 'banaverse_generate_3d': {
      if (!args.prompt) return errResult('缺少 prompt');
      const is3d = name === 'banaverse_generate_3d';
      if (is3d && !args.model) return errResult('3D 沒有預設模型，請指定 model（見 banaverse_list_models）');
      const d = await api('/api/v1/generate', {
        method: 'POST',
        // 兩支工具共用這條路，但**能送的欄位完全不同**：不分模態一律把影片那組
        // （aspectRatio／durationSec／resolution／generateAudio／videoRefs）全部送出的話，
        // 3D 的型錄一個都沒有，只會被伺服器丟掉並殘留在生成紀錄裡，讓紀錄上出現這顆模型根本沒有的旋鈕。
        body: is3d
          ? {
              kind: '3d', prompt: args.prompt, model: args.model, refs: resolveImages(args.refs),
              material: args.material, meshMode: args.meshMode, detail: args.detail,
              textures4K: args.textures4K, tPose: args.tPose,
            }
          : {
              kind: 'video',
              prompt: args.prompt, model: args.model, aspectRatio: args.aspectRatio,
              durationSec: args.durationSec, resolution: args.resolution,
              generateAudio: args.generateAudio, negativePrompt: args.negativePrompt,
              refs: resolveImages(args.refs), videoRefs: args.videoRefs,
            },
      });
      return textResult(`已送出「${d.label}」${is3d ? '3D' : '影片'}生成，jobId：${d.jobId}\n`
        + `${d.credits ? `已扣 ${d.credits} 點（工單失敗時，下一次取件會退點——所以要一直取到有結果或錯誤）。` : '未扣點。'}\n`
        + '請每隔約 15 秒用 banaverse_get_job 帶這個 jobId 取件；不要重送，重送會再扣一次點。');
    }
    case 'banaverse_list_tools': {
      // 說明文字由伺服器出（跟雲端 MCP 的 banaverse_list_tools 同一份，型錄改了這裡不必跟著改）。
      const d = await api('/api/v1/tools');
      return textResult(`Banaverse 工具（用 banaverse_use_tool 呼叫；images 照順序給，可以是本機檔案路徑）：\n\n${d.reference}`);
    }
    case 'banaverse_use_tool': {
      if (!args.tool) return errResult('缺少 tool（工具代號，見 banaverse_list_tools）');
      const d = await api('/api/v1/tools', {
        method: 'POST',
        body: {
          tool: args.tool, answer: args.answer, images: resolveImages(args.images), model: args.model,
          aspectRatio: args.aspectRatio, imageSize: args.imageSize,
        },
      });
      // 一版就照 generate_image 的樣子回（圖本體＋網址）；好幾版只給網址——四張內嵌圖動輒十幾 MB，client 會整段截掉。
      const ok = d.steps.filter((s) => s.ok);
      if (d.steps.length === 1 && ok.length === 1 && !ok[0].async) return imageContent(ok[0], `用「${d.toolLabel}」完成`);
      const lines = d.steps.map((s) => {
        if (!s.ok) return `「${s.step}」失敗：${s.error}`;
        if (s.async) return `「${s.step}」已送出，jobId：${s.jobId}（${s.credits ? `已扣 ${s.credits} 點` : '未扣點'}）——每隔約 ${d.out === 'video' ? 15 : 10} 秒用 banaverse_get_job 取件，不要重送。`;
        return `「${s.step}」：${s.url ?? '（上傳失敗，請改用單版重做）'}（${spent(s.credits)}）`;
      });
      return { content: [{ type: 'text', text: `用「${d.toolLabel}」（${d.model}）：\n${lines.join('\n')}` }], ...(ok.length ? {} : { isError: true }) };
    }
    case 'banaverse_get_job': {
      if (!args.jobId) return errResult('缺少 jobId');
      const d = await api('/api/v1/jobs/' + encodeURIComponent(args.jobId));
      if (!d.done) return textResult(`還在生成中（進度 ${Math.round((d.progress ?? 0) * 100)}%）。請稍候約 15 秒再取一次。`);
      // 自有機台排隊的圖片也走這支取件：完成時把圖本體一起帶回去（與 generate_image 同一個形狀）。
      if (d.kind === 'image') return imageContent(d, '圖片完成');
      const what = d.kind === '3d' ? '3D 模型（GLB 或 ZIP，依模型；請照實際檔案類型處理）' : '影片';
      return textResult(`${what}完成：${d.label}（${d.model}），${spent(d.credits)}。\n`
        + (d.url ? `網址（可直接開啟或下載）：${d.url}` : '（上傳失敗，僅能於本次回應取得內容）'));
    }
    case 'banaverse_generate_audio': {
      if (!args.prompt) return errResult('缺少 prompt');
      if (!args.model) return errResult('音訊沒有預設模型，請指定 model（見 banaverse_list_models）');
      const d = await api('/api/v1/generate', {
        method: 'POST',
        body: { kind: 'audio', prompt: args.prompt, model: args.model, voice: args.voice },
      });
      return textResult(`已用 ${d.label}（${d.model}）生成音訊，${spent(d.credits)}。\n`
        + (d.url ? `音檔網址：${d.url}` : '（上傳失敗）'));
    }
    default:
      return errResult(`未知工具：${name}`);
  }
}

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const errResult = (text) => ({ content: [{ type: 'text', text: '✗ ' + text }], isError: true });

log(`ready · v${VERSION} · URL=${URL_BASE} · auth=${env.BANAVERSE_API_KEY || hasLogin() ? 'set' : 'MISSING（先跑 banaverse login，或設 BANAVERSE_API_KEY）'}`);
