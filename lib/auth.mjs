// ============================================================================
// 登入狀態（設定檔讀寫 + 取一把可用的憑證）——CLI 與 MCP server 共用這一支。
//
// ── 為什麼瀏覽器登入不再去鑄一把長效金鑰 ──────────────────────────────────
// 原本的流程是「OAuth 換到 access token → 拿它去 /api/cli/keys 鑄一把 bnv_ 金鑰 → 存起來」。
// 2026-08-14 伺服器補了一個真的漏洞：claude.ai 連接器的授權頁只寫「生圖＋讀帳號」，
// 但那個 token 可以偷偷鑄一把永不過期的金鑰、列出並撤銷使用者其他所有金鑰，
// 而且移除連接器也收不回。修法是金鑰管理三個方法一律只收「網站正式登入」的憑證。
// CLI 拿到的正好是被擋的那一種，於是 `banaverse login` 整條路死掉——
// 而 README 還寫著「一次登入、不用複製貼上金鑰」。
//
// 這裡的修法是**不要繞路**：登入完就直接存 OAuth 的 access／refresh token。
// 生成、取件、模型、餘額那些端點本來就吃 OAuth token（伺服器的 identifyCli 認得），
// 所以完全不需要金鑰這一層——那一步從頭到尾只是為了「存一個不會過期的東西」。
// 代價是 access token 一小時要換一次，換的邏輯就寫在這支裡。
// **安全邊界一行都不用鬆**：伺服器那道「金鑰只給正式登入」的檢查維持原樣。
//
// ── 為什麼 clientId 也要存 ────────────────────────────────────────────────
// CLI 每次登入都動態註冊一個 loopback client（免上架），所以 client_id 是當次產生的。
// 換 token 的請求要帶同一個 client_id，沒存起來就換不了，使用者會在一小時後莫名其妙被登出。
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CFG_DIR = join(homedir(), '.banaverse');
export const CFG_FILE = join(CFG_DIR, 'config.json');
export const DEFAULT_URL = 'https://banaverse.thepocket.company';

export function loadCfg() {
  try { return JSON.parse(readFileSync(CFG_FILE, 'utf8')); } catch { return {}; }
}
export function saveCfg(c) {
  mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(CFG_FILE, JSON.stringify(c, null, 2));
}
export function clearCfg() {
  try { if (existsSync(CFG_FILE)) rmSync(CFG_FILE); } catch { /* 沒有就算了 */ }
}

/** 提前多久換 token。access 是 1 小時；抓 5 分鐘的緩衝，
 *  免得「檢查時還沒過期、請求送到時剛好過期」——那種失敗看起來像伺服器的錯。 */
const SKEW_MS = 5 * 60 * 1000;

/** 用 refresh token 換一組新的。伺服器是**輪替制**（發新的同時撤掉舊的），
 *  所以拿到新的一定要立刻存回去；存失敗的話下一次就會拿一把已經被撤銷的去換，
 *  而伺服器對「重用」的處理是整條撤掉，使用者會被登出。 */
async function refreshAccess(url, cfg) {
  if (!cfg.refresh || !cfg.clientId) return null;
  const form = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: cfg.refresh, client_id: cfg.clientId,
  });
  let res;
  try {
    res = await fetch(url + '/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch { return null; } // 離線：不要把登入狀態清掉，下次再試就好
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) return null;
  const next = {
    ...cfg,
    access: d.access_token,
    // 伺服器沒回新的 refresh 就沿用舊的（規格允許不輪替）
    refresh: d.refresh_token || cfg.refresh,
    expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000,
  };
  saveCfg(next);
  return next.access;
}

/**
 * 這次請求要帶哪一把。優先序刻意是「呼叫端指定 > 環境變數 > 設定檔的金鑰 > OAuth token」：
 *  · 前兩者是 CI 與進階用法，明講了就照做。
 *  · 金鑰排在 OAuth 前面，是為了讓既有使用者（手上已經有 bnv_ 金鑰）行為完全不變——
 *    這次修的是「新使用者登不進來」，不是要動到已經在用的人。
 *
 * force＝已經被打回 401 了，不管有沒有過期都換一次再試。
 */
export async function bearer(url, { key, env = {}, force = false } = {}) {
  if (key) return key;
  if (env.BANAVERSE_API_KEY) return env.BANAVERSE_API_KEY;
  const cfg = loadCfg();
  if (cfg.key) return cfg.key;
  if (!cfg.access) return '';
  const stale = force || !cfg.expiresAt || Date.now() > cfg.expiresAt - SKEW_MS;
  if (!stale) return cfg.access;
  return (await refreshAccess(url, cfg)) || (force ? '' : cfg.access);
}

/** 有沒有登入過（不保證還有效——那要打 API 才知道）。 */
export const hasLogin = () => { const c = loadCfg(); return !!(c.key || c.access); };
