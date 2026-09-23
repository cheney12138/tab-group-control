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
// 病例一(2026-09-19,本机):11 个 Raptor 日志 tab 标题完全相同,用户要的是 path 里那个服务名
// com.sankuai.hotel.train.active —— 不是 pageNum/pageSize 这类分页参数(那是噪声)。
// 病例二(2026-09-21,本机):Lion 配置 tab 的 path 是一群路由词(/config/dync ×4),彼此一样,
// 真正区分它们的是 query 里的 appKey=com.sankuai.train.train.honour ⇒ 于是把 query 也当候选,
// "谁分高谁当身份"。
// 病例三(2026-09-21,本机):tbms 订单详情的 path(/customerservice/orderdetail)本来就是对的,
// 但 query 里 indexName=2026-09-21 是个日期,按"分高者胜"把身份抢走了 ⇒ 第二次过拟合,
// 这次是拟合到"query 里有身份"这个新假设上。
// 教训:身份既不"在 path 里"也不"在 query 里",它是**这批 tab 之间真正不同的那一部分**。
// ⇒ 两种表述各算一遍,谁在这批 tab 里分得更开(distinct 更多)就用谁;一样开就守 path。
//    "只有图标颜色/环境不同"的 tab 于是自然撞在一起 —— 不硬造区分。
// 判据:通用段(log/topic/view/detail…)扣分;含点/连字符/下划线的段(包名、git 仓、业务标识)加分。
const GENERIC_SEG = new Set(['log', 'logs', 'topic', 'view', 'detail', 'details', 'index', 'home',
  'list', 'page', 'pages', 'app', 'www', 'api', 'v1', 'v2', 'v3', 'search', 'result', 'results',
  'dashboard', 'console', 'admin', 'static', 'assets', 'html', 'en', 'zh', 'cn', 'issues', 'pull',
  'commit', 'tree', 'blob', 'wiki', 'settings', 'user', 'users', 'profile']);

// query 里的"变化了也不算区分"的键:分页 / 展示 / 时间 / 埋点。这些键的值不进候选
const NOISE_KEY = /^(page\w*|pageNum|pageSize|iSLimit|limit|offset|showType|viewType|timeType|startDate|endDate|date|range|globalCityId|cityId|searchType|searchGrammar|lang|locale|theme|utm_.*|spm|ref|referrer|from|_t|t|ts|v|ver)$/i;

// "标识形状":被 . _ - 切成两段以上的裸 token(com.sankuai.hotel.train.active、tab-group-search、
// x_supply-master)。空格/斜杠/百分号/中文都不算 —— 那是标题或参数串,不是标识;
// 并且**必须含字母**:indexName=2026-09-21 这种"纯数字 + 分隔符"是日期/序号,不是标识
const ID_SHAPE = /^[A-Za-z0-9_]+(?:[._-][A-Za-z0-9_]+)+$/;
function looksLikeId(s) { return ID_SHAPE.test(s) && /[A-Za-z]/.test(s); }

// 身份是不是"像标识"的(带 . _ - 的包名/仓名/业务名)。像 = path 已经说人话了,别让 query 抢
const IDENT_SHAPED = /[.\-_]/;
function isIdentityShaped(s) { return IDENT_SHAPED.test(s); }

// 单个 token 有多像"身份" —— path 段与 query 值共用这一把尺子(不按来源分两套规则)
function scoreIdentity(s) {
  let score = 0;
  if (/^[A-Za-z]/.test(s)) score += 1;
  if (/\d/.test(s)) score -= 1;                       // 纯 ID/数字段:信息少
  if (/[.\-_]/.test(s)) score += 3;                   // 包名/仓名/业务标识
  if (s.length >= 16) score += 1;
  if (GENERIC_SEG.has(s.toLowerCase())) score -= 5;    // 路由词:不是身份
  return score;
}

// path/hash 段的身份:分最高的段当锚点,再把与它相邻、同样像标识的段接回来
// (/application/business 这种分层路由),最多 3 段;说不出话就返回空串,由调用方兜底
function pathIdentityOf(u) {
  const segs = urlSegments(u);
  const scored = segs.map((s, i) => ({ s, i, score: scoreIdentity(s) + i * 0.1 }))
    .filter(x => x.score > 0);
  if (!scored.length) return '';
  const anchor = scored.reduce((a, b) => (b.score > a.score ? b : a));
  let lo = anchor.i, hi = anchor.i;
  while (hi + 1 < segs.length && hi - lo + 1 < 3 && scoreIdentity(segs[hi + 1]) > 0) hi++;
  while (lo - 1 >= 0 && hi - lo + 1 < 3 && scoreIdentity(segs[lo - 1]) > 0) lo--;
  let picked = segs.slice(lo, hi + 1);
  let name = picked.join('/');
  while (name.length > 48 && picked.length > 1) { picked = picked.slice(1); name = picked.join('/'); }
  return shortenToken(name, 48);
}

// query 值的身份:"像名字"的才算 —— 带 . _ - 且含字母(com.sankuai.hotel.train.active、tab-group-search)。
// 刻意**不**收数字。用户口径(2026-09-21):「tbms 展示订单号效率也不高,本质上搜索也支持匹配 url,
// 用 orderid 能搜索出来。」⇒ 数字序号一律不当身份:
//   ① 标签只回答"这是哪一类页面",定位到具体哪一条是**搜索**的活(search.js 对完整 URL
//      做连续子串匹配,搜 orderId 就能命中并高亮)
//   ② orderId=1789962338990001 和 _t=1789962338990 这种时间戳形状一致,收进来必然重演病例三
//      (indexName=2026-09-21 抢走身份)。宁可让它们撞车。
function queryIdentityOf(u) {
  let best = '', top = 0;
  for (const [k, v] of urlParams(u)) {
    if (!v || NOISE_KEY.test(k) || !looksLikeId(v)) continue;
    const score = scoreIdentity(v);
    if (score > top) { best = v; top = score; }   // 同分保留先出现的(书写顺序稳定)
  }
  return best;
}

// 单个 URL 的身份(不分组时的兜底口径):path 优先,path 说不出话再看 query,都不行退域名。
// 撞车行的群体判别在 distinguishingLabels —— 只有拿到整批 URL 才知道"够不够分得开"
export function identityOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return pathIdentityOf(u) || queryIdentityOf(u) || u.host;
  } catch { return ''; }
}

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
// (曾经做过"query 值内部 token diff / 参数贪心"那一套,连续四轮产出噪声 —— 已删。
//  现在的做法只比"两种身份的 distinct 数",不拼原始参数串。)
function shortenToken(v, max = 24) {
  if (v.length <= max) return v;
  const head = Math.max(6, Math.ceil((max - 1) * 0.6));
  const tail = Math.max(3, max - 1 - head);
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}

export function distinguishingLabels(urls) {
  // 口径(2026-09-19,用户最终定稿):
  //   「log、business 这种区分/分区是**常驻**的;后面只保留**简短的服务名**就行;
  //     后面怎么又跟了一堆乱糟糟的参数啊?」
  // ⇒ 标签 = 第一段(类型位) · 身份。**不追加任何 query 参数**(不吃原始参数串,
  //   吃的是"query 里那个像标识的值"——病例二/三逼出来的)。
  const n = urls.length;
  if (n < 2) return new Array(n).fill('');
  // 非 http(s)(chrome:// / file:// / about:)没有"身份"可言 —— 当作解析失败,整行返回空
  const parsed = urls.map(u => {
    try {
      const x = new URL(u);
      return (x.protocol === 'http:' || x.protocol === 'https:') ? x : null;
    } catch { return null; }
  });
  // 每个 tab 的两种身份:① path/hash 里的 ② query 里的(rawPath 不含域名兜底 ——
  // 兜底域名用来看"是哪台机器",但它不该参与"path 里有没有像名字的东西"这个判断)
  const rawPath = parsed.map(u => (u ? pathIdentityOf(u) : ''));
  const pathIds = rawPath.map((id, i) => id || (parsed[i] ? parsed[i].host : ''));
  const queryIds = parsed.map(u => (u ? queryIdentityOf(u) : ''));
  // 口径(2026-09-21,三次过拟合之后):
  //   ① path 里有"像标识"的(带 . _ -:包名/仓名/业务名)⇒ 用 path。Raptor 的服务名不能被 traceId 顶掉。
  //   ② 否则 query 里有"像标识"的 ⇒ 用 query。Lion 的 /config/dync 是路由词,说不了人话;
  //      就算同一 appKey 的 tab 有好几个(只是环境/泳道不同),显示 appKey 也比显示 dync 有用。
  //   ③ 都没有 ⇒ 用 path。tbms 的 /customerservice/orderdetail 属于这种:它是路径,
  //      但没有"名字形状",而 query 里只有 orderId 这类数字序号 —— 不收。
  // **为什么不比 distinct(谁分得更开)**:那是上一版的写法,在我手上那 2 个 Lion tab 的样本里
  // 碰巧成立,换成"4 个 tab 同 appKey 不同环境"就退回 config/dync。“谁分得更开”本身就是从样本反推规则 ——
  // 第三次过拟合。现在这三条只看"这条身份像不像个名字",不依赖这批数据分得开不开。
  const shapedPath = rawPath.some(isIdentityShaped);
  const lines = shapedPath ? pathIds
    : (queryIds.some(isIdentityShaped) ? queryIds.map((id, i) => id || pathIds[i]) : pathIds);
  return lines.map((id, i) => {
    const type = parsed[i] ? (urlSegments(parsed[i])[0] || '') : '';   // 类型位:log / application / config
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
