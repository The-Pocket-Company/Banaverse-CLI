// ============================================================================
// 參考圖：本機檔案 → data URL。CLI 的 --ref 與本機 MCP（refs、banaverse_use_tool 的 images）共用。
//
// 伺服器端只收 data URL、純 base64、或 Banaverse 自己回傳的網址（防 SSRF），所以本機檔案要在這一側讀好。
// 本機 MCP 收檔案路徑的理由（2026-11-11）：在 Claude Code 裡貼的圖會存成本機檔案，agent 手上只有路徑；
// 要它把整張圖轉成 base64 塞進工具參數，等於逐字吐幾百 KB 的字，又慢又燒 token。給路徑、這裡讀，才真的用得起來。
// ============================================================================
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** 已經是伺服器收得下的形式（data URL、網址）就原樣送。 */
export const isRemote = (r) => /^(data:|https?:)/i.test(r);

/** r 是本機圖檔（路徑或 file:// 網址）就讀成 data URL；不是本機檔案回 null；是檔案但格式不支援就丟錯。 */
export function localImage(r) {
  let p;
  try { p = /^file:/i.test(r) ? fileURLToPath(r) : resolve(r); } catch { return null; }
  // 純 base64 動輒幾十萬字，丟給 existsSync 在 Windows 會因為路徑過長出錯——太長的一律不當路徑。
  if (r.length > 4096 || !existsSync(p) || !statSync(p).isFile()) return null;
  const mime = MIME[(p.split('.').pop() || '').toLowerCase()];
  if (!mime) throw new Error(`參考圖格式不支援：${r}（支援 png / jpg / webp / gif）`);
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}
