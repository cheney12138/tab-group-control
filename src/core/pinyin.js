// core/pinyin.js: 拼音匹配与模糊高亮(纯函数,读全局 PINYIN_TABLE/PINYIN_IDX)
// 数据表由 pinyin-data.js(classic script)提供,顶层 const 对 module 可见
// 从 main.js 切出,函数体零改动
import { escapeHtml } from './format.js';

// 数据表 PINYIN_TABLE(拼音串) + PINYIN_IDX(编码偏移→表索引,0=无拼音)
const pinyinFullCache = new Map(); // 字符 -> 完整拼音
const pinyinAbbrCache = new Map(); // 字符 -> 首字母

export function charPinyin(ch) {
  if (pinyinFullCache.has(ch)) return pinyinFullCache.get(ch);
  let py = null;
  const code = ch.codePointAt(0);
  // 码点直查表(之前用 TextEncoder 转 gb2312 查——但 Chrome 的 TextEncoder
  // 不支持 gb2312 标签,构造直接抛 EncodingError,拼音层整体失效过)
  if (code >= 0x4E00 && code <= 0x9FFF && typeof PINYIN_IDX !== 'undefined') {
    const idx = PINYIN_IDX[code - 0x4E00];
    if (idx > 0) py = PINYIN_TABLE[idx - 1];
  }
  pinyinFullCache.set(ch, py);
  return py;
}

export function charPinyinInitial(ch) {
  if (pinyinAbbrCache.has(ch)) return pinyinAbbrCache.get(ch);
  const full = charPinyin(ch);
  const abbr = full ? full[0] : null;
  pinyinAbbrCache.set(ch, abbr);
  return abbr;
}

// 文本 → 全拼串 / 首字母串(非汉字原样保留,整体小写)
export function textToPinyin(text) {
  let out = '';
  for (const ch of text || '') {
    const p = charPinyin(ch);
    out += p !== null ? p : ch;
  }
  return out.toLowerCase();
}
export function textToPinyinInitials(text) {
  let out = '';
  for (const ch of text || '') {
    const p = charPinyinInitial(ch);
    out += p !== null ? p : ch;
  }
  return out.toLowerCase();
}

// 拼音匹配: 查询串(英文)对标题(含汉字)的拼音形态做模糊匹配。
// 两级: 全拼("dingdan"→订单管理) 和 首字母("dd"→订单管理)。
// 无汉字的标题直接 false
export function pinyinMatch(query, text) {
  if (!/[一-鿿]/.test(text || '')) return false;
  const q = query.toLowerCase();
  if (!q || !q.match(/^[a-z]+$/)) return false; // 仅纯字母查询走拼音
  return fuzzyMatch(q, textToPinyin(text)) !== null
    || fuzzyMatch(q, textToPinyinInitials(text)) !== null;
}

export function fuzzyMatch(query, text) {
  // 固定模糊匹配: 按序散字符命中(子串是其特例)。曾有「模糊匹配」开关
  // 已删——低频配置不值得占设置面板,模糊匹配是更好的默认
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  // 优先整串连续子串命中: query 若整段连续出现在文本里(如 honour 在
  // "ho12321/honour" 里),直接返回该连续区间。既让得分命中整块,也让
  // 高亮(markText)覆盖整段,而不是散成开头 ho + 结尾 nour 两截。
  if (q) {
    const start = t.indexOf(q);
    if (start !== -1) {
      const span = [];
      for (let i = start; i < start + q.length; i++) span.push(i);
      return span;
    }
  }
  const hits = [];
  let ti = 0;
  for (const qc of q) {
    if (qc === ' ') continue;
    const idx = t.indexOf(qc, ti);
    if (idx === -1) return null;
    hits.push(idx);
    ti = idx + 1;
  }
  return hits;
}

export function markText(text, hits) {
  if (!hits || !hits.length) return escapeHtml(text);
  const set = new Set(hits);
  let html = '';
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    html += set.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return html;
}
