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

// 精确拼音匹配与汉字高亮区间映射
export function matchPinyin(query, text) {
  if (!text || !/[一-鿿]/.test(text)) return null;
  const q = query.trim().toLowerCase();
  if (!q || !/^[a-z0-9]+$/.test(q)) return null;

  let pyFull = '';
  let pyInit = '';
  const charRanges = []; // 对应原 text 每个字符在 pyFull 中的 [start, end]

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const py = charPinyin(ch);
    const init = charPinyinInitial(ch);
    const chPy = py !== null ? py.toLowerCase() : ch.toLowerCase();
    const chInit = init !== null ? init.toLowerCase() : ch.toLowerCase();

    const start = pyFull.length;
    pyFull += chPy;
    const end = pyFull.length;
    charRanges.push([start, end]);

    pyInit += chInit;
  }

  // 1. 全拼全等 (ceshi -> 测试)
  if (pyFull === q) {
    const hits = [];
    for (let i = 0; i < text.length; i++) hits.push(i);
    return { type: 'equal', tier: 1, isEnglish: false, hits };
  }

  // 2. 首字母全等 (cs -> 测试)
  if (pyInit === q) {
    const hits = [];
    for (let i = 0; i < text.length; i++) hits.push(i);
    return { type: 'equal', tier: 1.2, isEnglish: false, hits };
  }

  // 3. 全拼前缀 (ce -> 测试)
  if (pyFull.startsWith(q)) {
    const hits = [];
    for (let i = 0; i < text.length; i++) {
      if (charRanges[i][0] < q.length) hits.push(i);
    }
    return { type: 'prefix', tier: 2, isEnglish: false, hits };
  }

  // 4. 首字母前缀 (c -> 测试)
  if (pyInit.startsWith(q)) {
    const hits = [];
    for (let i = 0; i < q.length; i++) hits.push(i);
    return { type: 'prefix', tier: 2.2, isEnglish: false, hits };
  }

  // 5. 全拼连续包含 (ceshi -> 自动化测试)
  const subIdx = pyFull.indexOf(q);
  if (subIdx !== -1) {
    const qEnd = subIdx + q.length;
    const hits = [];
    for (let i = 0; i < text.length; i++) {
      const [cs, ce] = charRanges[i];
      if (Math.max(cs, subIdx) < Math.min(ce, qEnd)) {
        hits.push(i);
      }
    }
    return { type: 'sub', tier: 3, isEnglish: false, hits };
  }

  // 6. 首字母连续包含 (cs -> 自动化测试)
  const initSubIdx = pyInit.indexOf(q);
  if (initSubIdx !== -1) {
    const hits = [];
    for (let i = initSubIdx; i < initSubIdx + q.length; i++) {
      hits.push(i);
    }
    return { type: 'sub', tier: 3.2, isEnglish: false, hits };
  }

  return null;
}

// 原生字符直接匹配 (英文/数字/原生直接命中)
export function matchExact(query, text) {
  if (!text) return null;
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return null;

  // 1. 完全相等
  if (t === q) {
    const hits = [];
    for (let i = 0; i < text.length; i++) hits.push(i);
    return { type: 'equal', tier: 1, isEnglish: true, hits };
  }

  // 2. 前缀匹配
  if (t.startsWith(q)) {
    const hits = [];
    for (let i = 0; i < q.length; i++) hits.push(i);
    return { type: 'prefix', tier: 2, isEnglish: true, hits };
  }

  // 3. 连续子串包含
  const idx = t.indexOf(q);
  if (idx !== -1) {
    const hits = [];
    for (let i = idx; i < idx + q.length; i++) hits.push(i);
    return { type: 'sub', tier: 3, isEnglish: true, hits };
  }

  return null;
}

// 综合字段匹配: 同等级别下英文/原生优先
export function matchField(query, text) {
  if (!text) return null;
  const exact = matchExact(query, text);
  const pinyin = matchPinyin(query, text);

  if (exact && !pinyin) return exact;
  if (!exact && pinyin) return pinyin;
  if (exact && pinyin) {
    if (exact.tier < pinyin.tier) return exact;
    if (pinyin.tier < exact.tier) return pinyin;
    return exact; // 同等匹配度，英文原生优先
  }
  return null;
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
