// ============================================================================
// 本機素材 → data URL。CLI 的 --ref／--video 與本機 MCP（refs、banaverse_use_tool 的 images／videos）共用。
//
// 伺服器端只收 data URL、純 base64、或 Banaverse 自己回傳的網址（防 SSRF），所以本機檔案要在這一側讀好。
// 本機 MCP 收檔案路徑的理由（2026-11-11）：在 Claude Code 裡貼的圖會存成本機檔案，agent 手上只有路徑；
// 要它把整張圖轉成 base64 塞進工具參數，等於逐字吐幾百 KB 的字，又慢又燒 token。給路徑、這裡讀，才真的用得起來。
//
// 影片（2026-11-12，處理工具：影片去背、接成一支、轉比例）也走 data URL，因為 CLI 沒有別的路能把檔案交上去：
// 網站的上傳通道（/api/storage/upload）只認網頁登入的 Firebase token，CLI 的 OAuth token 與 API key 都進不去。
// 代價是大小：Banaverse 跑在 Cloud Run，單次請求整包最多 32 MiB，base64 又會膨脹三分之一，
// 所以一次送的本機檔案合計只能到 MAX_LOCAL_BYTES。超過的在這一側就擋下、講清楚，不送出去撞 413。
// Banaverse 回傳過的影片網址不受這個限制（伺服器直接轉給機台抓，不經過這個請求）。
// ============================================================================
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
// 跟伺服器（Banaverse lib/banaverseTools.ts 的 VIDEO_MIME_OF_EXT／AUDIO_MIME_OF_EXT）認得的同一組：其他格式機台那端會擋。
const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' };

const MiB = 1024 * 1024;
/** 整個 JSON body 的上限：Cloud Run 單次請求 32 MiB（連 header 一起算），留 1 MiB 餘裕。 */
export const MAX_BODY_BYTES = 31 * MiB;
/** 本機檔案合計上限：32 MiB 扣掉 base64 膨脹（×4/3）與 JSON 其他欄位的餘裕。也低於伺服器對單段 data 影片的 25 MiB。 */
export const MAX_LOCAL_BYTES = 23 * MiB;

const mb = (n) => (n / MiB).toFixed(1);

/** 已經是伺服器收得下的形式（data URL、網址）就原樣送。 */
export const isRemote = (r) => /^(data:|https?:)/i.test(r);

/** r 是本機檔案（路徑或 file:// 網址）就回絕對路徑；不是本機檔案回 null。 */
function localPath(r) {
  let p;
  try { p = /^file:/i.test(r) ? fileURLToPath(r) : resolve(r); } catch { return null; }
  // 純 base64 動輒幾十萬字，丟給 existsSync 在 Windows 會因為路徑過長出錯——太長的一律不當路徑。
  if (r.length > 4096 || !existsSync(p) || !statSync(p).isFile()) return null;
  return p;
}

const extOf = (p) => (p.split('.').pop() || '').toLowerCase();

/** r 是本機圖檔就讀成 data URL；不是本機檔案回 null；是檔案但格式不支援就丟錯。 */
export function localImage(r) {
  const p = localPath(r);
  if (!p) return null;
  const mime = MIME[extOf(p)];
  if (!mime) throw new Error(`參考圖格式不支援：${r}（支援 png / jpg / webp / gif）`);
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

/** r 是本機影片就讀成 data URL；不是本機檔案回 null；格式不支援或單檔就超過上限丟錯（先看大小，不把大檔整個讀進記憶體）。 */
export function localVideo(r) {
  const p = localPath(r);
  if (!p) return null;
  const mime = VIDEO_MIME[extOf(p)];
  if (!mime) throw new Error(`影片格式不支援：${r}（支援 mp4 / mov / webm / m4v）`);
  const size = statSync(p).size;
  if (size > MAX_LOCAL_BYTES) throw new Error(tooBig(`${r} 有 ${mb(size)} MB`));
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

/** r 是本機聲音檔（配上聲音的配音、配樂）就讀成 data URL；規則同 localVideo。 */
export function localAudio(r) {
  const p = localPath(r);
  if (!p) return null;
  const mime = AUDIO_MIME[extOf(p)];
  if (!mime) throw new Error(`聲音格式不支援：${r}（支援 mp3 / wav / m4a / aac / ogg / flac）`);
  const size = statSync(p).size;
  if (size > MAX_LOCAL_BYTES) throw new Error(tooBig(`${r} 有 ${mb(size)} MB`));
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

/** data:video/mp4（或 mov）的影片有幾秒：讀 moov 裡的 mvhd（timescale、duration）。讀不出來（WebM、網址）回 null。
 *  影片去背按秒計價（伺服器照 durationSec 扣點、機台再拿實際長度核對）：本機檔案在這一側就知道長度，
 *  替呼叫端填上，免得沒填被照 5 秒算、送到機台才被退回。 */
export function mp4Seconds(dataUrl) {
  const m = /^data:video\/(mp4|quicktime);base64,/i.exec(String(dataUrl));
  if (!m) return null;
  const buf = Buffer.from(String(dataUrl).slice(m[0].length), 'base64');
  const i = buf.indexOf('mvhd');
  if (i < 4 || i + 32 > buf.length) return null;
  const o = i + 8; // 跳過 version(1)＋flags(3)
  const v1 = buf[i + 4] === 1;
  const scale = buf.readUInt32BE(v1 ? o + 16 : o + 8);
  const dur = v1 ? Number(buf.readBigUInt64BE(o + 20)) : buf.readUInt32BE(o + 12);
  return scale > 0 && dur > 0 ? dur / scale : null;
}

/** --answer @檔案：文字題的回答從檔案讀（上字幕的整份字幕好幾行，在命令列上打不方便）。不是 @ 開頭、或檔案不在就原樣回。 */
export function answerText(raw) {
  const s = String(raw ?? '');
  if (!s.startsWith('@')) return s;
  const p = localPath(s.slice(1));
  return p ? readFileSync(p, 'utf8') : s;
}

/** 整包請求太大 → 回一句中文原因；放得下回 null。在送出之前檢查：送出去只會拿到一個看不懂的 413。 */
export function bodyTooBig(json) {
  const bytes = Buffer.byteLength(json);
  return bytes > MAX_BODY_BYTES ? tooBig(`這次要送的內容轉成文字後有 ${mb(bytes)} MB`) : null;
}

const tooBig = (what) => `${what}，超過一次能送給 Banaverse 的大小。本機檔案要轉成文字送出、會變大約三分之一，`
  + `所以一次給的本機檔案合計要在 ${mb(MAX_LOCAL_BYTES)} MB 以內（雲端單次請求上限 32 MB）。`
  + '請把影片壓小或剪短，或改給 Banaverse 回傳過的影片網址（網址不受這個限制）。';
