// ============================================================================
// 模型清單怎麼呈現、報價怎麼算——CLI 的 `models`／確認提示與 MCP 的 banaverse_list_models 共用這一支。
//
// ── 為什麼這裡不寫任何點數 ──────────────────────────────────────────────
// 售價是伺服器用「成本 × 匯率」現算、後台還能覆寫，寫死的數字一定會過期
// （0.3.0 的說明寫「Veo Lite 100 點、最便宜的圖 5 點」，線上早就不是這個價）。
// 所以點數一律讀 /api/v1/models：圖片看 prices（每個解析度 × 文生圖／改圖一張實扣幾點，
// 與伺服器扣點同一條算式），其餘看 credits（基準售價）。
//
// ── 為什麼影片只能報「基準售價」 ──────────────────────────────────────────
// 影片的 credits 是「一份」的價錢（例：Veo 每 8 秒 720p），實扣照秒數與解析度算，
// 而 /api/v1/models 沒有給單位資訊。與其自己猜一個數字讓使用者同意，不如明講是基準價，
// 送出後再印伺服器回報的實扣（提交回應的 credits）。
// ============================================================================

/** 依序分組；清單裡出現認不得的 kind 會排在最後、用原名當標題（伺服器先上新類型時不會整組消失）。 */
export const KINDS = [
  { kind: 'image', title: '圖片', unit: '每張實扣；依解析度與是否改圖' },
  { kind: 'video', title: '影片', unit: '基準售價＝一份的價錢；實扣依秒數與解析度' },
  {
    kind: 'audio', title: '音訊',
    // 語音的計價方式 /api/v1/models 看不出來（credits 只是一份），只能在這裡講清楚，
    // 否則使用者會以為一段 5 分鐘的朗讀只要一份的錢。數字照 /api-docs 的「音訊生成」。
    unit: '音樂每段；語音按朗讀長度，每 60 秒一份（中文約 300 字），一次最多約 7 分鐘（約 2,100 字）',
  },
  { kind: '3d', title: '3D', unit: '每個模型；輸出 GLB 或含 OBJ／材質的 ZIP，依模型' },
];
export const KIND_ZH = { image: '圖片', video: '影片', audio: '音訊', '3d': '3D', text: '文字' };

/** 把清單照 KINDS 分組，回 [{ kind, title, unit, models }]（空的組不回）。 */
export function groupModels(models) {
  const known = new Set(KINDS.map((k) => k.kind));
  const extra = [...new Set(models.map((m) => m.kind).filter((k) => !known.has(k)))]
    .map((kind) => ({ kind, title: KIND_ZH[kind] || kind, unit: '基準售價' }));
  return [...KINDS, ...extra]
    .map((g) => ({ ...g, models: models.filter((m) => m.kind === g.kind) }))
    .filter((g) => g.models.length);
}

/** 清單上那一格的價錢。free＝本地版（算力是客戶自己的機台）：印「免費」而不是 0 點，0 讀起來像價目還沒填。 */
export function priceLabel(m) {
  if (m.free) return '免費（需自有主機在線）';
  const ps = (Array.isArray(m.prices) ? m.prices : []).map((p) => p.credits).filter(Number.isFinite);
  if (!ps.length) return `${m.credits} 點`; // 非圖片模型，或舊伺服器沒有 prices
  const lo = Math.min(...ps), hi = Math.max(...ps);
  if (lo === hi) return `${lo} 點`;
  // 講出是哪個因素讓價錢變：同為文生圖（或同為改圖）時解析度不同就不同價 → 依解析度；
  // 同一個解析度、文生圖與改圖不同價 → 依是否改圖。
  const differs = (same) => m.prices.some((p) => m.prices.some((q) => same(p, q) && p.credits !== q.credits));
  const why = [
    differs((p, q) => p.i2i === q.i2i && p.imageSize !== q.imageSize) && '解析度',
    differs((p, q) => p.i2i !== q.i2i && p.imageSize === q.imageSize) && '是否改圖',
  ].filter(Boolean).join('與');
  return `${lo}–${hi} 點${why ? `（依${why}）` : ''}`;
}

/** 這張圖實際會扣幾點：解析度不在清單裡時伺服器會夾回預設，這裡照做（找不到就用 default 那格）。
 *  自有機台模型（Banaverse Image）例外：給了不支援的值伺服器會在扣點前 400 並列出可用值，這個報價不會被收。 */
export function imageQuote(m, size, i2i) {
  const rows = (Array.isArray(m.prices) ? m.prices : []).filter((p) => p.i2i === i2i);
  const row = rows.find((p) => p.imageSize === size) || rows.find((p) => p.default);
  return row ? row.credits : m.credits;
}

/** 未開通標記：available 只有帶了憑證查才會是 true／false，null＝不知道，不標。 */
export const lockedMark = (m) => (m.available === false ? '（未開通）' : '');
