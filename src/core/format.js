// core/format.js: 纯展示格式化工具(无 DOM、无 Chrome API、无共享状态)
// 从 main.js 切出,函数体零改动

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 相对时间: 刚刚 / N 分钟 / 1小时内 / N 小时 / 昨天 / N 天前 / N 周
export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 10 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟`;
  if (diff < 60 * 60 * 1000) return '1 小时内';
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时`;
  if (diff < 48 * 60 * 60 * 1000) return '昨天';
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return `${Math.floor(diff / (7 * 86400000))} 周前`;
}

// 时间档位: hot(10分钟) / today(24小时) / recent(7天) / stale(30天) / zombie(更久)
export function timeTier(ts) {
  if (!ts) return 'recent';
  const diff = Date.now() - ts;
  if (diff < 10 * 60 * 1000) return 'hot';
  if (diff < 24 * 60 * 60 * 1000) return 'today';
  if (diff < 7 * 24 * 60 * 60 * 1000) return 'recent';
  if (diff < 30 * 24 * 60 * 60 * 1000) return 'stale';
  return 'zombie';
}

// URL 展示: 提取 host + path + search + hash; 内部页面(chrome://等)保留完整路径
export function displayUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'edge:') {
      return url;
    }
    return u.host + (u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname + u.search + u.hash);
  } catch {
    return url;
  }
}

// ---- URL 里的"业务标识"(撞车行的主标签) --------------------------------
// 病例(2026-09-19,本机):11 个 Raptor 日志 tab 标题完全相同,用户要的是 path 里那个服务名
// com.sankuai.hotel.train.active —— 不是 pageNum/pageSize 这类分页参数(那是噪声)。
// 判据:通用段(log/topic/view/detail…)扣分;含点/连字符/下划线的段(包名、git 仓、业务标识)加分。
const GENERIC_SEG = new Set(['log', 'logs', 'topic', 'view', 'detail', 'details', 'index', 'home',
  'list', 'page', 'pages', 'app', 'www', 'api', 'v1', 'v2', 'v3', 'search', 'result', 'results',
  'dashboard', 'console', 'admin', 'static', 'assets', 'html', 'en', 'zh', 'cn', 'issues', 'pull',
  'commit', 'tree', 'blob', 'wiki', 'settings', 'user', 'users', 'profile']);

export function identityOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const segs = urlSegments(u);   // pathname + hash(hash 路由的 SPA 同样能提取出业务标识)
    const scored = segs.map((s, i) => {
      let score = 0;
      if (/^[A-Za-z]/.test(s)) score += 1;
      if (/\d/.test(s)) score -= 1;                       // 纯 ID/数字段:信息少
      if (/[.\-_]/.test(s)) score += 3;                   // 包名/仓名/业务标识
      if (s.length >= 16) score += 1;
      if (GENERIC_SEG.has(s.toLowerCase())) score -= 5;    // 路由词:不是身份
      score += i * 0.1;                                    // 越靠后越具体
      return { s, score };
    }).filter(x => x.score > 0);
    if (!scored.length) return u.host;
    // 保留路径顺序,最多 3 段;超长时留尾部(最具体的部分)
    let picked = scored.slice(-3).map(x => x.s);
    let name = picked.join('/');
    while (name.length > 48 && picked.length > 1) { picked = picked.slice(1); name = picked.join('/'); }
    return shortenToken(name, 48);
  } catch { return ''; }
}

// query 里的"变化了也不算区分"的键:分页 / 展示 / 时间 / 埋点
const NOISE_KEY = /^(page\w*|pageNum|pageSize|iSLimit|limit|offset|showType|viewType|timeType|startDate|endDate|date|range|globalCityId|cityId|searchType|searchGrammar|lang|locale|theme|utm_.*|spm|ref|referrer|from|_t|t|ts|v|ver)$/i;

// URL 的"路径段":pathname + hash(hash 路由的 SPA 把路由写在 #/ 后面,只读 pathname 会什么都看不见)
function urlSegments(u) {
  if (!u) return [];
  // 拼接用 '/' 而不是别的符号 —— 任何非 '/' 的占位符都会被 split('/') 当成一段(踩过:type 变成 "|")
  const raw = u.pathname + '/' + u.hash.replace(/^#!?/, '').split('?')[0];
  return raw.split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { return x; } });
}

// URL 的"参数":search + hash 里的 query(SPA 常把 traceId 之类写在 hash 的 query 里)
function urlParams(u) {
  const sp = new URLSearchParams(u ? u.search : '');
  if (u && u.hash.includes('?')) {
    for (const [k, v] of new URLSearchParams(u.hash.slice(u.hash.indexOf('?') + 1))) {
      if (!sp.has(k)) sp.append(k, v);
    }
  }
  return sp;
}

// ---- 标题撞车时的"差异片段" ------------------------------------------------
// 病例(2026-09-19,本机):Raptor 日志页 11 个 tab 标题完全相同,URL 各带一个 traceId。
// displayUrl() 给出 286 字符(host 27 + path 46 + query 213),而能区分的 traceId 在第 138 字符
// —— 正中间。行内一省略(text-overflow)就等于没显示 ⇒ "看不出是哪一个"。
// 目标:只取"它们彼此不一样的那一小段"。
// 层级:① query 里取值不全相同的键 ⇒ ② 该值内部 token 级 diff ⇒ ③ 路径段 diff ⇒ ④ 序号兜底
function shortenToken(v, max = 24) {
  if (v.length <= max) return v;
  const head = Math.max(6, Math.ceil((max - 1) * 0.6));
  const tail = Math.max(3, max - 1 - head);
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

// 把 query 值里的 DSL 切成 token: condition=traceId__: "-1819674858102614175"
//   ⇒ ['traceId__:', '-1819674858102614175']   (引号/AND/OR/顿号都当分隔)
function valueTokens(v) {
  return String(v).split(/[\s,()[\]"']+|\b(?:AND|OR)\b/i).filter(Boolean);
}

export function distinguishingLabels(urls) {
  // 口径(2026-09-19,用户最终定稿):
  //   「log、business 这种区分/分区是**常驻**的;后面只保留**简短的服务名**就行;
  //     后面怎么又跟了一堆乱糟糟的参数啊?」
  // ⇒ 标签 = 第一段(类型位) · identityOf(服务名/分区)。**不追加任何 query 参数**。
  // 之前的"差异 diff / 参数贪心"整套删掉了 —— 它连续四轮产出噪声与 bug,而用户要的从始至终是
  // "一个稳定的类型 + 一个简短的名字"。
  const n = urls.length;
  if (n < 2) return new Array(n).fill('');
  return urls.map(u => {
    let parsed = null;
    try { parsed = new URL(u); } catch { return ''; }
    const id = identityOf(u);                        // 服务名 / 分区(短,来自 path/hash)
    const type = urlSegments(parsed)[0] || '';        // 类型位:log / application
    let s = id || '';
    // 第一段已经在名字里就不重复(如 /application/business ⇒ application/business)
    if (type && !s.includes(type)) s = s ? `${type} · ${s}` : type;
    return s;
  });
}
export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// 标题是否为“占位/错误”(无标题、标题=URL、标题本身是 URL、New Tab 等)。
// 这类标题没有辨识度,配合“标题完全重复”才值得展示完整 URL;否则只给域名。
export function isBadTitle(title, url) {
  const t = (title || '').trim();
  if (!t) return true;
  if (t === url) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^about:/i.test(t) || /^chrome:\/\//i.test(t)) return true;
  if (/^New Tab$/i.test(t) || / - Google Chrome$/.test(t)) return true;
  return false;
}

export function cleanTitle(str) {
  if (!str) return '';
  return str
    .replace(/^[\s\u200B-\u200D\uFEFF\u{1F4A4}💤zZ\[\]\-—·]+/u, '')
    .replace(/[\s\u200B-\u200D\uFEFF\u{1F4A4}💤zZ\[\]\-—·]+$/u, '')
    .trim()
    .toLowerCase();
}

// favicon: 直接用 tab 快照自带的 URL,失败隐藏图标位,保持简单
// Chrome 官方标准 Favicon 构造方式 (带 size=32, 且仅在 http/https 下有效)
export function getChromeFaviconUrl(url) {
  try {
    if (!url || typeof url !== 'string') return null;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
  } catch {
    return null;
  }
}

export function faviconUrlFor(t) {
  return t.favIconUrl || getChromeFaviconUrl(t.url) || '';
}

// 收起状态持久化用的稳定 key: chrome 的 groupId 每次启动会变,用 分组名+颜色
export function groupKey(group) {
  return group ? `${group.title || '(未命名)'}|${group.color}` : '__ungrouped__';
}
