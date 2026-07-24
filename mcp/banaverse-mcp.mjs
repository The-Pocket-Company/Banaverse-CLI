#!/usr/bin/env node
// ============================================================================
// Banaverse MCP server（stdio）——讓 Claude Desktop / Claude Code 透過 MCP
// 直接呼叫 Banaverse 生成。與 CLI／畫布共用同一套帳號、點數、守門邏輯。
//
// 工具：
//   banaverse_generate_image  文字→圖片（扣點；呼叫前應向使用者確認花費）
//   banaverse_list_models     可用圖片模型與售價（公開，免 key）
//   banaverse_get_balance     帳號與點數餘額
//
// 認證：跑過 `banaverse login`（瀏覽器登入）後自動沿用 ~/.banaverse/config.json 的金鑰；
//       或設環境變數 BANAVERSE_API_KEY（bnv_…）。BANAVERSE_URL 預設正式站。
// 相依：零（Node 18+ 內建 fetch）。協定：JSON-RPC 2.0 over stdio（換行分隔）。
// 專案：https://github.com/The-Pocket-Company/Banaverse-CLI
// ============================================================================
import { stdin, stdout, stderr, env } from 'node:process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 認證來源優先序：環境變數 > CLI 設定檔（~/.banaverse/config.json，banaverse login 產生）> 預設。
// → 只要跑過 `banaverse login`，MCP 免再設 env 就能沿用同一把 key。
function cliConfig() {
  try { return JSON.parse(readFileSync(join(homedir(), '.banaverse', 'config.json'), 'utf8')); } catch { return {}; }
}
const CFG = cliConfig();
const URL_BASE = (env.BANAVERSE_URL || CFG.url || 'https://banaverse.thepocket.company').replace(/\/$/, ''); // 正式站；本機測試設 BANAVERSE_URL 或用 CLI config
const KEY = env.BANAVERSE_API_KEY || CFG.key || '';
const PROTO = '2025-06-18';
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
          serverInfo: { name: 'banaverse', version: '0.1.0' },
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
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const res = await fetch(URL_BASE + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

// ── Tools ─────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'banaverse_generate_image',
    description:
      '用 Banaverse 從文字提示生成一張圖片。會扣使用者點數——呼叫前請先向使用者確認花費（可先用 banaverse_list_models 查價、banaverse_get_balance 查餘額）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '圖片描述（具體：主體、風格、構圖、光線）' },
        model: { type: 'string', description: '模型 id（預設 gemini-3.1-flash-lite-image，最省 5 點）' },
        aspectRatio: { type: 'string', description: '1:1 / 16:9 / 9:16 …（預設 1:1）' },
        imageSize: { type: 'string', description: '512 / 1K / 2K / 4K（預設 1K）' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'banaverse_list_models',
    description: '列出可用的 Banaverse 圖片模型與每次生成的點數售價。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'banaverse_get_balance',
    description: '查詢目前 API key 對應帳號的身分與點數餘額。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'banaverse_list_models': {
      const d = await api('/api/v1/models');
      const lines = d.models.map((m) => `${m.default ? '★' : ' '} ${m.id} — ${m.label} — ${m.credits} 點`).join('\n');
      return textResult('可用圖片模型（售價/次）：\n' + lines);
    }
    case 'banaverse_get_balance': {
      const d = await api('/api/v1/me');
      return textResult(`帳號 ${d.email || d.uid}${d.isAdmin ? '（admin，生成不扣點）' : ''}｜餘額 ${d.credits} 點`);
    }
    case 'banaverse_generate_image': {
      if (!args.prompt) return errResult('缺少 prompt');
      const d = await api('/api/v1/generate', {
        method: 'POST',
        body: { prompt: args.prompt, model: args.model, aspectRatio: args.aspectRatio, imageSize: args.imageSize },
      });
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(d.dataUrl || '');
      const content = [];
      if (m) content.push({ type: 'image', data: m[2], mimeType: m[1] }); // MCP 圖片內容→Claude 看得到圖
      content.push({ type: 'text', text: `已用 ${d.label}（${d.model}）生成，花 ${d.credits} 點。` });
      return { content };
    }
    default:
      return errResult(`未知工具：${name}`);
  }
}

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const errResult = (text) => ({ content: [{ type: 'text', text: '✗ ' + text }], isError: true });

log(`ready · URL=${URL_BASE} · key=${KEY ? 'set' : 'MISSING（設 BANAVERSE_API_KEY）'}`);
