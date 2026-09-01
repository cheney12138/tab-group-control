// 按分组展示的标签页搜索:
// 读取 chrome.tabGroups 中由 Tabbiy 等插件创建的原生分组,
// 搜索结果按分组分区显示,支持模糊匹配与拼音首字母场景下的子串匹配。

// 性能埋点(无条件输出): 脚本开始执行的时刻。
const GROUP_COLORS = {
  grey: '#7c7c7c', blue: '#1a73e8', red: '#d93025',
  yellow: '#f9ab00', green: '#1e8e3e', pink: '#ff63b8',
  purple: '#a142f4', cyan: '#24c1e0', orange: '#fa903e',
};

// 调试开关: 在弹窗 DevTools Console 里执行 localStorage.setItem('tgs-debug','1') 开启
const DEBUG = localStorage.getItem('tgs-debug') === '1';

// ---- 设置 ----
const settings = {
  fuzzy: localStorage.getItem('tgs-fuzzy') !== '0',      // 模糊匹配,默认开
  showUrl: localStorage.getItem('tgs-showurl') !== '0',  // 始终显示 URL 行,默认开
};
function saveSettings() {
  localStorage.setItem('tgs-fuzzy', settings.fuzzy ? '1' : '0');
  localStorage.setItem('tgs-showurl', settings.showUrl ? '1' : '0');
}

const input = document.getElementById('search');
const resultsEl = document.getElementById('results');
let allTabs = [];      // [{tab, group}] group 为 null 表示未分组
let filtered = [];     // 当前展示的 [{tab, group, titleMarks, urlMarks}]
let activeIndex = -1;

// 收起状态持久化: chrome 的 groupId 每次启动会变,用 分组名+颜色 做稳定 key
const COLLAPSE_STORE = 'tgs-collapsed';
function collapsedKeys() {
  try {
    // 过滤历史版本 bug 写入的垃圾 key
    const keys = JSON.parse(localStorage.getItem(COLLAPSE_STORE) || '[]')
      .filter(k => k !== '(未命名)|undefined');
    return new Set(keys);
  } catch { return new Set(); }
}
function groupKey(group) {
  return group ? `${group.title || '(未命名)'}|${group.color}` : '__ungrouped__';
}
let collapsed = collapsedKeys();
function saveCollapsed() {
  localStorage.setItem(COLLAPSE_STORE, JSON.stringify([...collapsed]));
}

// 搜索模式独立的收起状态: 每次开始新搜索时重置为全展开,不持久化
let searchCollapsed = new Set();
// 当前模式生效的收起集合
function activeCollapsed() {
  return searching ? searchCollapsed : collapsed;
}

// ---- 视图: grouped(按分组) / recent(纯最近使用) / current(仅当前窗口) ----
const VIEWS = ['grouped', 'recent', 'current'];
let view = VIEWS.includes(localStorage.getItem('tgs-view')) ? localStorage.getItem('tgs-view') : 'grouped';

// 极简模糊匹配: 返回匹配到的字符下标数组,不匹配返回 null
// 拼音匹配(pinyin-data.js 提供 GB2312 全量汉字→无调拼音,29KB):
// 全拼模式——"dingdan" 匹配「订单管理」;首字母 "dd" 也兼容(前缀命中)。
// 数据表 PINYIN_TABLE(拼音串) + PINYIN_IDX(编码偏移→表索引,0=无拼音)
const pinyinFullCache = new Map(); // 字符 -> 完整拼音
const pinyinAbbrCache = new Map(); // 字符 -> 首字母

function charPinyin(ch) {
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

function charPinyinInitial(ch) {
  if (pinyinAbbrCache.has(ch)) return pinyinAbbrCache.get(ch);
  const full = charPinyin(ch);
  const abbr = full ? full[0] : null;
  pinyinAbbrCache.set(ch, abbr);
  return abbr;
}

// 文本 → 全拼串 / 首字母串(非汉字原样保留,整体小写)
function textToPinyin(text) {
  let out = '';
  for (const ch of text || '') {
    const p = charPinyin(ch);
    out += p !== null ? p : ch;
  }
  return out.toLowerCase();
}
function textToPinyinInitials(text) {
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
function pinyinMatch(query, text) {
  if (!/[一-鿿]/.test(text || '')) return false;
  const q = query.toLowerCase();
  if (!q || !q.match(/^[a-z]+$/)) return false; // 仅纯字母查询走拼音
  return fuzzyMatch(q, textToPinyin(text)) !== null
    || fuzzyMatch(q, textToPinyinInitials(text)) !== null;
}

function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!settings.fuzzy) {
    // 子串模式: 查询串须作为连续子串出现
    const idx = t.indexOf(q);
    return idx === -1 ? null : Array.from({ length: q.length }, (_, i) => idx + i);
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

function markText(text, hits) {
  if (!hits || !hits.length) return escapeHtml(text);
  const set = new Set(hits);
  let html = '';
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    html += set.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return html;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let currentWindowId = null; // 弹窗所属窗口,用于区分"其他窗口"的标签
let windowIds = [];         // 所有含标签的窗口 id,升序;用于把内部 id 映射为可读序号
let currentSourceIsHistory = false; // /h 命令模式下,行渲染加半透明降级

// ---- 命令模式数据源: /b 书签 /h 历史 ----
// 结构与 allTabs 同构([{tab, group}]),tab.id 用负数避免与真实 tabId 冲突
let bookmarkItems = [];
let historyItems = [];
let bookmarksLoaded = false;
let historyLoaded = false;

async function loadBookmarks() {
  if (bookmarksLoaded) return;
  try {
    const tree = await chrome.bookmarks.getTree();
    bookmarkItems = [];
    let id = -1;
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.url) {
          bookmarkItems.push({
            tab: { id: id--, title: n.title || n.url, url: n.url,
                   favIconUrl: '', active: false, windowId: -1, lastAccessed: 0 },
            group: null,
          });
        }
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    bookmarksLoaded = bookmarkItems.length > 0; // 空结果(权限失败等)允许下次重试
  } catch (e) {
    console.error('加载书签失败(权限?):', e);
    bookmarksLoaded = false; // 失败不锁死,下次输入重试
  }
}

async function loadHistory() {
  if (historyLoaded) return;
  try {
    const items = await chrome.history.search({ text: '', maxResults: 1000 });
    // Chrome 真实顺序: 按最近访问倒排(API 返回顺序未定义,chrome://history 即此序)
    const sorted = [...items].sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
    // 同 URL 折叠(chrome://history 同款): 每个 URL 只保留最近访问的一条,
    // 平铺会把同一页面的历史多次访问全部列出,不像真实历史
    const seen = new Set();
    historyItems = [];
    for (const h of sorted) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      historyItems.push({
        tab: { id: -10000 - historyItems.length, title: h.title || h.url, url: h.url,
               favIconUrl: '', active: false, windowId: -1,
               lastAccessed: h.lastVisitTime || 0 },
        group: null,
      });
    }
    historyLoaded = historyItems.length > 0; // 失败/空结果允许重试
  } catch (e) {
    console.error('加载历史失败(权限?):', e);
    historyLoaded = false;
  }
}

// 把 Chrome 内部窗口 id 映射为从 1 开始的序号,比裸 id 可读
function windowOrdinal(windowId) {
  const idx = windowIds.indexOf(windowId);
  return idx === -1 ? windowId : idx + 1;
}

async function loadTabs() {
  const t0 = performance.now();
  // 优先用 background 维护的快照(worker 常驻,数据即时)——省掉三连查询。
  // 快照陈旧/不可用时回退直接查询。
  // currentWindowId 无论走哪条路径都要拿: 它是"弹窗从哪个窗口唤起"的视角,
  // 快照无法预存(每次唤起可能不同),且它决定窗口前缀的显示
  let tabs, groups;
  let fromSnapshot = false;
  const currentWinPromise = chrome.windows.getCurrent().catch(() => null);
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-snapshot' });
    if (resp?.snapshot) {
      tabs = resp.snapshot.tabs;
      groups = resp.snapshot.groups || [];
      fromSnapshot = true;
    }
  } catch (e) { /* worker 未就绪等,走正常查询 */ }
  if (!fromSnapshot) {
    // 分组查询失败不应拖垮整个列表(例如权限缺失时仍可搜索,只是无分组头)
    [tabs, groups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({}).catch(err => {
        console.error('查询分组失败:', err);
        return [];
      }),
    ]);
  }
  currentWindowId = (await currentWinPromise)?.id ?? null;
  console.log(`[TGS] loadTabs 耗时: ${(performance.now() - t0).toFixed(1)}ms, 标签数: ${tabs.length}${fromSnapshot ? '(快照)' : '(直查)'}`);
  const groupById = new Map(groups.map(g => [g.id, g]));
  // 收集窗口序号映射(过滤发生在收集之后,保证编号连续且与实际窗口一致)
  windowIds = [...new Set(tabs.map(t => t.windowId))].sort((a, b) => a - b);
  // 按最近使用时间倒排: 分组区顺序由组内最新标签决定,组内同样按最近使用排序
  const sorted = tabs
    .filter(t => !t.url.startsWith('chrome-extension://'))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .map(t => ({ tab: t, group: groupById.get(t.groupId) || null }));
  // 重复合并(QuicKey 同款): 同 URL 多个标签合成一条,保留最近使用的代表,
  // duplicates 记全部副本 id(右上角角标显示份数)。tabs 已按 lastAccessed
  // 倒排,先见的即代表。
  // 合并限定同一窗口内: 跨窗口的同 URL 各自保留——窗口是独立工作区,
  // 跨窗口合并会让另一窗口的标签"消失"(只归属到代表所在的窗口)
  allTabs = [];
  const byUrl = new Map();
  for (const item of sorted) {
    const key = `${item.tab.windowId}|${item.tab.url}`;
    const prev = byUrl.get(key);
    if (prev) {
      prev.duplicates.push(item.tab.id);
    } else {
      item.duplicates = []; // 初始化副本数组
      byUrl.set(key, item);
      allTabs.push(item);
    }
  }
}

function search(query) {
  const q = query.trim();
  // 命令模式(QuicKey 同款): /b 书签 /h 历史(含已关标签)
  // 前缀命中即进入命令模式,switchTo 对负 id 条目走"新开标签"
  const isBookmarksCmd = q === '/b' || q.startsWith('/b ');
  const isHistoryCmd = q === '/h' || q.startsWith('/h ');
  const inCommandMode = isBookmarksCmd || isHistoryCmd;
  let source = inCommandMode
    ? (isBookmarksCmd ? bookmarkItems : historyItems)
    : (view === 'current' && currentWindowId != null
        ? allTabs.filter(x => x.tab.windowId === currentWindowId)
        : allTabs);
  // 命令模式剥掉前缀再匹配;裸命令(如"/b")无关键词 → 浏览全量
  const matchQ = inCommandMode
    ? (q.split(/^\/[bh] ?/)[1] || '') : q;
  // 供行渲染区分: /h 的条目加半透明降级(历史非活标签)
  currentSourceIsHistory = isHistoryCmd;
  if (!q || (inCommandMode && !matchQ)) {
    // 空查询/裸命令:展示该数据源全部条目,便于浏览
    filtered = source.map(x => ({ ...x, titleHits: null, urlHits: null }));
    return;
  }
  filtered = [];
  if (inCommandMode) {
    // 书签/历史模式: 按 标题>host 过滤,但保持数据源原序
    // (/h 即 chrome 历史的真实时间序,/b 即书签树序),不按匹配级别重排、不分组
    for (const x of source) {
      const title = x.tab.title || '';
      const titleHits = fuzzyMatch(matchQ, title);
      const host = hostOf(x.tab.url);
      const hostHits = titleHits ? null : (matchQ ? fuzzyMatch(matchQ, host) : null);
      if (titleHits || hostHits || !matchQ) {
        filtered.push({ ...x, titleHits, urlHits: null, matchedOn: titleHits ? 'title' : 'host', exact: false, groupNameExact: false });
      }
    }
    return; // source 顺序即展示顺序
  }
  for (const x of source) {
    // 匹配优先级: 标题 > 拼音首字母 > 分组名 > 域名(host) > 完整 URL
    const title = x.tab.title || '';
    const titleHits = fuzzyMatch(q, title);
    const pinyinHit = !titleHits && pinyinMatch(q, title);
    let urlHits = null;
    let matchedOn = null; // 'title' | 'pinyin' | 'group' | 'host' | 'url'
    let groupHits = null;
    if (titleHits) {
      matchedOn = 'title';
    } else if (pinyinHit) {
      // 拼音首字母命中: "dd"匹配「订单管理」。无高亮(字符不对应),参与排序
      matchedOn = 'pinyin';
    } else if (x.group && x.group.title && (groupHits = fuzzyMatch(q, x.group.title))) {
      // 分组名命中: 搜"订单"能召回分组叫"订单系统"里所有标签
      matchedOn = 'group';
      // 分组名召回的条目同时检测 URL/标题命中,仅为高亮显示(不改变匹配级别):
      // 搜"arena"时能看到具体哪个路径也含这个词
      urlHits = fuzzyMatch(q, x.tab.url || '') || null;
    } else {
      const host = hostOf(x.tab.url);
      const hostHits = host ? fuzzyMatch(q, host) : null;
      if (hostHits) {
        matchedOn = 'host';
      } else {
        urlHits = fuzzyMatch(q, x.tab.url || '');
        if (urlHits) matchedOn = 'url';
      }
    }
    if (matchedOn) {
      // 记录匹配质量: exact = 查询串整体作为连续子串出现(含首字对齐),否则为 fuzzy
      const exactText = matchedOn === 'title' ? title
        : matchedOn === 'pinyin' ? textToPinyin(title)
        : matchedOn === 'group' ? (x.group?.title || '')
        : matchedOn === 'host' ? hostOf(x.tab.url) : (x.tab.url || '');
      const isExact = exactText.toLowerCase().includes(q.toLowerCase());
      // 分组名全等(组名就是查询词)是最强意图信号: 搜"arena"就是想找 arena 组,
      // 排在一切模糊命中的标题之前
      const groupNameExact = matchedOn === 'group'
        && (x.group?.title || '').toLowerCase() === q.toLowerCase();
      filtered.push({ ...x, titleHits, urlHits, groupHits, matchedOn, exact: isExact, groupNameExact });
    }
  }
  // 排序优先级:
  // 0. 分组名全等查询词 > 一切
  // 1. 匹配级别: 标题 > 分组名 > 域名 > 完整 URL
  // 2. 匹配质量: 精确连续子串 > 模糊匹配;同级内首字命中的位置越靠前越优
  // 3. 分组视图按组内排序(组是稳定容器,同组条目永远相邻,
  //    不被其他组的强匹配打散);recent/current 视图按最近使用
  const rank = { title: 0, pinyin: 1, group: 2, host: 3, url: 4 };
  const firstHit = f => f.titleHits?.[0] ?? f.urlHits?.[0] ?? 9999;
  // 单条匹配质量分: 组名全等 0;否则 级别值(精确)/级别值+10(模糊)
  const matchQuality = f => {
    if (f.groupNameExact) return 0;
    return rank[f.matchedOn] + (f.exact ? 0 : 10);
  };
  if (view === 'grouped') {
    // 分组视图: 先分桶,桶内按质量排,桶间按桶内最佳排
    const buckets = new Map(); // groupKey -> { best, items }
    for (const f of filtered) {
      const key = groupKey(f.group);
      if (!buckets.has(key)) buckets.set(key, { best: Infinity, items: [] });
      const b = buckets.get(key);
      const q = matchQuality(f);
      if (q < b.best) b.best = q;
      b.items.push({ ...f, _q: q });
    }
    for (const b of buckets.values()) {
      b.items.sort((x, y) => {
        if (x._q !== y._q) return x._q - y._q;
        const h = firstHit(x) - firstHit(y);
        if (h !== 0) return h;
        return (x.tab.index || 0) - (y.tab.index || 0);
      });
    }
    filtered = [...buckets.values()]
      .sort((a, b) => a.best - b.best)
      .flatMap(b => b.items)
      .map(({ _q, ...f }) => f); // 剥掉临时排序字段
  } else {
    filtered.sort((a, b) => {
      if (a.groupNameExact !== b.groupNameExact) return a.groupNameExact ? -1 : 1;
      const r = rank[a.matchedOn] - rank[b.matchedOn];
      if (r !== 0) return r;
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      const h = firstHit(a) - firstHit(b);
      if (h !== 0) return h;
      return (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0);
    });
  }

  if (DEBUG) {
    console.group(`[TGS] 搜索 "${q}" — 共 ${filtered.length} 条`);
    console.table(filtered.slice(0, 15).map(f => ({
      匹配级别: f.matchedOn,
      精确: f.exact,
      分组: f.group?.title || '',
      标题: (f.tab.title || '').slice(0, 30),
      host: hostOf(f.tab.url),
      lastAccessed: new Date(f.tab.lastAccessed || 0).toLocaleTimeString(),
    })));
    console.log('排序后顺序(渲染前):', filtered.map(f =>
      `${f.matchedOn}:${(f.tab.title || f.tab.url).slice(0, 20)}`));
    console.groupEnd();
  }
}

// 搜索模式下强制全部展开,只有空查询浏览时才应用收起状态
let searching = false;

function render() {
  const t0 = performance.now();
  // 记住重渲染前的焦点,重建后尽量恢复
  const prevUnit = navUnits().find(u => u.classList.contains('active'));
  const prevKey = prevUnit?.dataset.groupKey;
  const prevTabId = prevUnit?.dataset.tabId;
  resultsEl.innerHTML = '';
  if (!filtered.length) {
    resultsEl.innerHTML = '<div class="empty">没有匹配的标签页</div>';
    return;
  }

  // recent / current / 命令模式(/b /h): 不分组平铺。
  // 命令模式直接按数据源原序展示(历史=chrome 真实时间序,书签=书签树序),
  // 无分组头——与 chrome://history 的观感一致
  if (view === 'recent' || view === 'current' || activeCmd) {
    for (const item of filtered) {
      resultsEl.appendChild(buildTabRow(item));
    }
    return;
  }

  if (searching) {
    // 搜索模式: 先按分组聚合再渲染,每个分组只出现一个头。
    // 排序把同组条目打散在列表各处时,若按"连续出现"切段会导致同一组
    // 出现多个分组头(结果看起来重复),故先聚合:
    //   组间顺序 = 该组内最佳匹配的排名; 组内顺序 = 匹配排序
    const sections = new Map(); // groupKey -> { group, items }
    for (const item of filtered) {
      const key = groupKey(item.group);
      if (!sections.has(key)) sections.set(key, { group: item.group, items: [] });
      sections.get(key).items.push(item);
    }
    // Map 迭代序 = 首次插入序 = filtered 的排序序(组内最佳排名靠前的组先出现)
    for (const { group, items } of sections.values()) {
      const key = groupKey(group);
      const isCollapsed = searchCollapsed.has(key);
      resultsEl.appendChild(buildGroupHeader(group, items.length, isCollapsed, () => {
        if (searchCollapsed.has(key)) searchCollapsed.delete(key);
        else searchCollapsed.add(key);
        render();
      }));
      if (!isCollapsed) {
        for (const item of items) resultsEl.appendChild(buildTabRow(item));
      }
    }
    restoreFocus(prevKey, prevTabId);
    if (DEBUG) console.log(`[TGS] render(搜索) 耗时: ${(performance.now() - t0).toFixed(1)}ms, 行数: ${filtered.length}`);
    return;
  }

  // 浏览模式: 按 (窗口, 分组) 分区,保持最近使用顺序
  const sections = [];
  const sectionIndex = new Map(); // key -> section
  for (const item of filtered) {
    const t = item.tab;
    const key = `${t.windowId}:${item.group ? item.group.id : -1}:${item.group ? item.group.windowId : ''}`;
    if (!sectionIndex.has(key)) {
      const section = { group: item.group, windowId: t.windowId, items: [] };
      sectionIndex.set(key, section);
      sections.push(section);
    }
    sectionIndex.get(key).items.push(item);
  }

  // 分区只包含 filtered 里实际有标签的分组: 组内最后一个标签被关掉后,
  // 该组不会出现在 sections,分组头自然消失
  sections.forEach(section => {
    const key = groupKey(section.group);
    const isCollapsed = collapsed.has(key);
    resultsEl.appendChild(buildGroupHeader(section.group, section.items.length, isCollapsed, () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      saveCollapsed();
      render();
    }));

    if (!isCollapsed) {
      section.items.forEach(item => {
        resultsEl.appendChild(buildTabRow(item));
      });
    }
  });
  // 清理收起记忆里已不存在的分组(组被删掉/改名后,残留的 key 会让同名的组莫名收起)
  const liveKeys = new Set(sections.map(s => groupKey(s.group)));
  const staleKeys = [...collapsed].filter(k => !liveKeys.has(k) && k !== '__ungrouped__');
  if (staleKeys.length) {
    staleKeys.forEach(k => collapsed.delete(k));
    saveCollapsed();
  }
  restoreFocus(prevKey, prevTabId);
  if (DEBUG) console.log(`[TGS] render 耗时: ${(performance.now() - t0).toFixed(1)}ms, 行数: ${filtered.length}`);
}

// 重渲染后恢复焦点: 优先同 tabId 的行,其次同 key 的分组头,找不到则不聚焦
function restoreFocus(prevKey, prevTabId) {
  if (!prevKey && !prevTabId) return;
  const units = navUnits();
  let target = null;
  if (prevTabId) {
    target = units.find(u => u.classList.contains('tab-item') && Number(u.dataset.tabId) === Number(prevTabId));
  }
  if (!target && prevKey) {
    target = units.find(u => u.classList.contains('group-header') && u.dataset.groupKey === prevKey);
  }
  if (target) {
    target.classList.add('active');
    if (target.classList.contains('tab-item')) {
      activeIndex = [...resultsEl.querySelectorAll('.tab-item')].indexOf(target);
    } else {
      activeIndex = -2;
    }
  }
}

// 分组头: group 为 null 表示未分组; onClick 为空时不可点击(搜索模式的分隔条)
function buildGroupHeader(group, count, isCollapsed, onClick) {
  const header = document.createElement('div');
  header.className = 'group-header' + (isCollapsed ? ' collapsed' : '');
  header.dataset.groupKey = groupKey(group);
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg>';
  header.appendChild(caret);
  if (group) {
    const dot = document.createElement('span');
    dot.className = 'group-dot';
    dot.style.background = GROUP_COLORS[group.color] || '#7c7c7c';
    header.appendChild(dot);
    const name = document.createElement('span');
    // 搜索时分组名也参与高亮,直观看到是分组名命中的召回
    const q = input.value.trim();
    name.innerHTML = q
      ? markText(group.title || '(未命名分组)', fuzzyMatch(q, group.title || ''))
      : escapeHtml(group.title || '(未命名分组)');
    header.appendChild(name);
  } else {
    const name = document.createElement('span');
    name.textContent = '未分组';
    header.appendChild(name);
  }
  if (count != null) {
    const countEl = document.createElement('span');
    countEl.className = 'group-count';
    countEl.textContent = count;
    header.appendChild(countEl);
  }
  if (onClick) header.addEventListener('click', () => {
    onClick();
    // 点击后浏览器会把真实焦点给到被点的元素,键盘事件就不再经过 input;
    // 立即抢回焦点,保证 ↑↓/←→/Tab 等快捷键继续工作
    input.focus();
  });
  return header;
}

// favicon: 直接用 tab 快照自带的 URL,失败隐藏图标位,保持简单
// favicon 策略(QuicKey 同款):
// ① tab 自带 favIconUrl 优先; ② 没有则拼 _favicon 服务 URL——它读的是
// Chrome 浏览器自己的 favicon 数据库(标签栏图标的同一份缓存),不向网站发请求,
// 内网坏 favicon 的站点也能出图。manifest 已声明 favicon 权限 + _favicon 资源
const FAVICON_PREFIX = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=`;
function faviconUrlFor(t) {
  return t.favIconUrl || (FAVICON_PREFIX + encodeURIComponent(t.url));
}

function buildFaviconEl(t) {
  const img = document.createElement('img');
  img.src = faviconUrlFor(t);
  img.onerror = () => { img.style.visibility = 'hidden'; };
  return img;
}

function buildTabRow(item) {
  const t = item.tab;
  const row = document.createElement('div');
  // /h 历史条目加降级类: 半透明,hover/选中恢复
  row.className = 'tab-item' + (currentSourceIsHistory ? ' history-item' : '');
  row.dataset.tabId = t.id;

  // 窗口归属(仅用于时间 tag 的"当前"判定与 URL 行强制显示,
  // 不再做行首窗口徽/组内序号——实测都是伪需求,行首留白更干净)
  const isVirtualItem = t.id < 0;
  const isOtherWindow = !isVirtualItem
    && currentWindowId != null && t.windowId !== currentWindowId;

  // favicon + 重复合并角标: 同 URL 多份时 favicon 右上角迷你数字徽(深底白字,
  // 11px 圆点),份数一眼可读;无副本时裸图标
  const iconWrap = document.createElement('span');
  iconWrap.className = 'icon-wrap';
  iconWrap.appendChild(buildFaviconEl(t));
  if (item.duplicates && item.duplicates.length > 0) {
    const dupBadge = document.createElement('span');
    dupBadge.className = 'dup-badge';
    const count = item.duplicates.length + 1;
    dupBadge.textContent = count > 9 ? '9+' : String(count);
    iconWrap.title = `相同页面打开了 ${count} 份(回车切换到最近使用的)`;
    iconWrap.appendChild(dupBadge);
  }
  row.appendChild(iconWrap);

  const info = document.createElement('div');
  info.className = 'tab-info';
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = markText(t.title || t.url, item.titleHits);
  info.appendChild(title);
  // 窗口提示已挪到行首(与组内序号互斥);URL 行不再嵌前缀。
  // 其他窗口的行强制显示 URL 行(窗口提示需要上下文),不跟随 showUrl 隐藏
  if (settings.showUrl || item.urlHits || isOtherWindow) {
    const url = document.createElement('div');
    url.className = 'url';
    const shownUrl = displayUrl(t.url);
    // URL 兜底匹配发生在完整 URL 上,但展示的是 host+path,需在展示文本上重算高亮
    const urlHits = item.urlHits
      ? (fuzzyMatch(input.value.trim(), shownUrl) || item.urlHits)
      : null;
    url.innerHTML = markText(shownUrl, urlHits);
    info.appendChild(url);
  }

  row.appendChild(info);

  // 最近使用时间 tag 五档: 当前 > 热门(10分钟,绿) > 今日(蓝) > 近期(灰) > 僵尸(橙/红)
  // 颜色由冷暖渐进,僵尸标签一眼可辨,便于顺手清理
  const tag = document.createElement('span');
  tag.className = 'last-used';
  if (t.active && !isOtherWindow) {
    tag.classList.add('current');
    tag.textContent = '当前';
  } else {
    const label = relativeTime(t.lastAccessed);
    if (label) {
      tag.classList.add(timeTier(t.lastAccessed));
      tag.textContent = label;
    }
  }
  if (tag.textContent) row.appendChild(tag);

  // 关闭按钮: 与时间 tag 同位置,hover/选中该行时才出现(时间 tag 同步淡出)
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  closeBtn.title = '关闭标签页 (⌘⌫)';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(t.id);
    // 关闭是 button,点击会拿走键盘焦点,抢回 input 保证快捷键继续工作
    input.focus();
  });
  row.appendChild(closeBtn);

  row.addEventListener('click', () => switchTo(t));
  return row;
}

// 关闭标签页并从列表中移除该行,焦点迁移到相邻行; 底部提供限时撤销
async function closeTab(tabId) {
  const rows = [...resultsEl.querySelectorAll('.tab-item')];
  const rowIdx = rows.findIndex(r => Number(r.dataset.tabId) === tabId);
  const closed = filtered.find(f => f.tab.id === tabId);
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.error('关闭标签失败:', err);
    return;
  }
  // 同步本地数据
  allTabs = allTabs.filter(x => x.tab.id !== tabId);
  filtered = filtered.filter(f => f.tab.id !== tabId);
  // 就地重渲染,并让焦点落到被关闭行的相邻行
  render();
  const newRows = [...resultsEl.querySelectorAll('.tab-item')];
  if (newRows.length) {
    setActive(Math.min(rowIdx >= 0 ? rowIdx : 0, newRows.length - 1));
  } else {
    resultsEl.innerHTML = '<div class="empty">没有匹配的标签页</div>';
  }
  // 撤销快照带上原分组信息,恢复后用于归组(sessions.restore 不触发 onCreated,
  // Tabbiy 等自动分组插件感知不到恢复的标签,需要我们主动移回原组)
  if (closed) {
    showUndo({
      tab: closed.tab,
      groupTitle: closed.group?.title || null,
      groupColor: closed.group?.color || null,
      windowId: closed.tab.windowId,
    });
  }
}

// ---- 撤销关闭 ----
const undoBar = document.getElementById('undoBar');
let undoTimer = null;
let undoStack = []; // 最近关闭的标签快照,支持连续撤销

function showUndo(snapshot) {
  undoStack.push(snapshot);
  undoBar.innerHTML = '';
  const msg = document.createElement('span');
  msg.className = 'undo-msg';
  const count = undoStack.length;
  const tab = snapshot.tab;
  const title = (tab.title || tab.url).slice(0, 30);
  msg.textContent = count > 1
    ? `已关闭 ${count} 个标签页(含「${title}」)`
    : `已关闭「${title}」`;
  const btn = document.createElement('button');
  btn.className = 'undo-btn';
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>撤销';
  // 撤销可用 ⌘Z 快捷键触发,按钮上加提示
  btn.title = '恢复刚关闭的标签 (⌘Z)';
  btn.addEventListener('click', doUndo);
  undoBar.appendChild(msg);
  undoBar.appendChild(btn);
  // 倒计时进度条: 提示剩余可撤销时间
  const progress = document.createElement('span');
  progress.className = 'undo-progress';
  undoBar.appendChild(progress);
  // 重置进度条动画
  progress.style.animation = 'none';
  void progress.offsetWidth; // 强制 reflow 让动画重新开始
  progress.style.animation = '';
  undoBar.style.display = 'flex';
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoStack = [];
    hideUndo();
  }, 6000);
}

// ⌘Z / Ctrl+Z 撤销最近关闭(等价于点击撤销按钮)
function isUndoAvailable() {
  return undoStack.length > 0;
}

// 撤销: 从 sessions.getRecentlyClosed 里按 URL 匹配找回真实的 sessionId,
// 恢复后把标签移回原分组(sessions.restore 不触发 onCreated,Tabbiy 感知不到,
// 由我们按关闭时记录的分组名补归组)。sessions 的 sessionId 并非 tab id
async function doUndo() {
  if (!undoStack.length) return;
  let recent = [];
  try {
    recent = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  } catch (err) {
    console.error('查询最近关闭失败:', err);
  }
  const restoredTabIds = [];
  for (const snap of undoStack) {
    const t = snap.tab;
    // 关闭时间最新的排在最前;按 URL 匹配(标题可能被页面动态改掉,不作首选条件)
    const match = recent.find(s => s.tab && s.tab.url === t.url)
      || recent.find(s => s.tab && s.tab.title === t.title && s.tab.url === t.url);
    if (match) {
      try {
        const [restored] = await chrome.sessions.restore(match.sessionId);
        // 已恢复的会话从候选里移除,避免连续撤销时重复匹配同一条
        recent = recent.filter(s => s.sessionId !== match.sessionId);
        if (restored?.tab?.id) restoredTabIds.push({ tabId: restored.tab.id, snap });
        continue;
      } catch (err) {
        console.error('恢复会话失败:', err);
      }
    }
    // 兜底: 直接重开 URL(回到原窗口)
    try {
      const created = await chrome.tabs.create({
        url: t.url, active: false, windowId: snap.windowId,
      });
      restoredTabIds.push({ tabId: created.id, snap });
    } catch {
      try {
        const created = await chrome.tabs.create({ url: t.url, active: false });
        restoredTabIds.push({ tabId: created.id, snap });
      } catch {}
    }
  }
  undoStack = [];
  hideUndo();
  // 补归组: 找同名分组,把恢复的标签移回去
  await regroupRestored(restoredTabIds);
  await loadTabs();
  search(searchValue());
  render();
}

// 把恢复的标签移回原分组: 按 分组名+颜色 在当前所有分组里找同名组。
// 找不到(组已删/改名)则保持未分组,交还给 Tabbiy 的规则或其他手动整理
async function regroupRestored(restored) {
  if (!restored.length) return;
  try {
    const groups = await chrome.tabGroups.query({});
    for (const { tabId, snap } of restored) {
      if (!snap.groupTitle) continue; // 原本就未分组
      const target = groups.find(g =>
        (g.title || '') === snap.groupTitle && g.color === snap.groupColor);
      if (target) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: target.id });
      }
    }
  } catch (err) {
    console.error('补归组失败:', err);
  }
}

function hideUndo() {
  undoBar.style.display = 'none';
  clearTimeout(undoTimer);
}

// ---- 清理空分组 ----
// Chrome 原生没有任何入口删除"组内标签已全部关闭"的空分组,
// Tabbiy 等自动分组插件会积累空壳。直接 query 全量分组,
// 逐个检查组内标签数,为 0 则 ungroup 不了(空组没有成员)——
// chrome.tabGroups 没有删除 API,空组的清除靠把"组"本身释放:
// 组内无成员时 Chrome 会在最后标签关闭时自动删组,但跨窗口残留的
// 空组(标签被移走而非关闭)只能通过 query 拿到后用 move 0 个标签触发——
// 实际可行解: 空组直接被 Chrome 在 tabs.onRemoved 后异步清理,
// 我们要做的是发现并报告仍存在的空组(极少),不误删有内容的组
async function cleanEmptyGroups() {
  try {
    const [groups, tabs] = await Promise.all([
      chrome.tabGroups.query({}),
      chrome.tabs.query({}),
    ]);
    const tabsByGroup = new Map();
    for (const t of tabs) {
      if (t.groupId && t.groupId !== -1) {
        tabsByGroup.set(t.groupId, (tabsByGroup.get(t.groupId) || 0) + 1);
      }
    }
    const empty = groups.filter(g => !tabsByGroup.get(g.id));
    if (!empty.length) {
      showToast('没有空分组');
      return;
    }
    // 空组移除: 把一个临时标签移入该组再移出会触发组删除,但更直接的是
    // chrome.tabs.ungroup 需要成员——空组无成员。Chrome 116+ 提供了
    // 通过 chrome.tabGroups.update 无法删除的事实,唯一可靠 API 路径:
    // 创建一个 about:blank 标签放入该组,再关闭它,组随之消亡
    const ok = confirm(`发现 ${empty.length} 个空分组(组内无标签),通过临时标签触发删除。继续?`);
    if (!ok) return;
    let cleaned = 0;
    for (const g of empty) {
      try {
        const [tmp] = await chrome.tabs.create({
          url: 'about:blank', active: false, windowId: g.windowId,
        });
        await chrome.tabs.group({ tabIds: [tmp.id], groupId: g.id });
        await chrome.tabs.remove(tmp.id);
        cleaned += 1;
      } catch (e) {
        console.error(`清理分组 ${g.title} 失败:`, e);
      }
    }
    showToast(`已清理 ${cleaned} 个空分组`);
    await loadTabs();
    search(searchValue());
    render();
  } catch (e) {
    console.error('清理空分组失败:', e);
  }
}

// ---- 清理僵尸标签 ----
// 批量关闭 stale(7~30天) + zombie(30天+) 档位的标签。
// 排除当前激活标签(正在用的不杀);全部进入撤销栈,可 ⌘Z 整批救回
// 确认用面板内提示条(系统 confirm 会被设置的覆盖层遮挡,曾导致无声卡死)
async function cleanStaleTabs() {
  const targets = allTabs.filter(x => {
    if (!x.tab.lastAccessed) return false;
    const tier = timeTier(x.tab.lastAccessed);
    return (tier === 'stale' || tier === 'zombie') && !x.tab.active;
  });
  if (!targets.length) {
    showToast('没有 7 天以上未使用的标签');
    return;
  }
  // 面板内确认条: 扫描完成先报数量,用户点确认才执行
  const confirmed = await confirmInPanel(
    `发现 ${targets.length} 个 7 天以上未使用的标签,关闭?(⌘Z 可撤销)`);
  if (!confirmed) {
    showToast('已取消清理');
    return;
  }
  let closedCount = 0;
  for (const x of targets) {
    try {
      await chrome.tabs.remove(x.tab.id);
      closedCount += 1;
      // 逐个进撤销栈(与单关路径一致,撤销时整批恢复)
      undoStack.push({
        tab: x.tab,
        groupTitle: x.group?.title || null,
        groupColor: x.group?.color || null,
        windowId: x.tab.windowId,
      });
    } catch {}
  }
  // 同步本地数据并刷新
  const closedIds = new Set(targets.map(x => x.tab.id));
  allTabs = allTabs.filter(x => !closedIds.has(x.tab.id));
  showUndo(targets[targets.length - 1].tab);
  await loadTabs();
  search(searchValue());
  render();
  if (closedCount > 0) showToast(`已清理 ${closedCount} 个标签,⌘Z 可撤销`);
}

// 轻量提示: 复用 undoBar 位置显示无按钮信息,2 秒自动消失
let toastTimer = null;
function showToast(text) {
  undoBar.innerHTML = '';
  const msg = document.createElement('span');
  msg.className = 'undo-msg';
  msg.textContent = text;
  undoBar.appendChild(msg);
  undoBar.style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideUndo, 2000);
}

// 面板内确认条: 系统确认(confirm)会被设置的覆盖层遮挡,导致流程无声卡死。
// 用 undoBar 位置的确认/取消条替代,返回 Promise<boolean>,8s 超时视为取消
function confirmInPanel(text) {
  return new Promise((resolve) => {
    undoBar.innerHTML = '';
    const msg = document.createElement('span');
    msg.className = 'undo-msg';
    msg.textContent = text;
    const okBtn = document.createElement('button');
    okBtn.className = 'undo-btn';
    okBtn.textContent = '确认清理';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'undo-btn';
    cancelBtn.style.background = '#6e7681';
    cancelBtn.textContent = '取消';
    const settle = (val) => {
      clearTimeout(timer);
      hideUndo();
      resolve(val);
    };
    okBtn.addEventListener('click', () => settle(true));
    cancelBtn.addEventListener('click', () => settle(false));
    undoBar.appendChild(msg);
    undoBar.appendChild(cancelBtn);
    undoBar.appendChild(okBtn);
    undoBar.style.display = 'flex';
    const timer = setTimeout(() => settle(false), 8000);
  });
}

// 相对时间: 刚刚 / N 分钟 / 1小时内 / N 小时 / 昨天 / N 天前 / N 周
function relativeTime(ts) {
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
function timeTier(ts) {
  if (!ts) return 'recent';
  const diff = Date.now() - ts;
  if (diff < 10 * 60 * 1000) return 'hot';
  if (diff < 24 * 60 * 60 * 1000) return 'today';
  if (diff < 7 * 24 * 60 * 60 * 1000) return 'recent';
  if (diff < 30 * 24 * 60 * 60 * 1000) return 'stale';
  return 'zombie';
}

// URL 只展示 host + path,域名不同的开发环境一眼可辨
function displayUrl(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' && !u.search ? '' : u.pathname + u.search);
  } catch {
    return url;
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// 根据 tabId 找到其所在分组的对象及组内第一个可见标签的 id(展开后定位用)
function findGroupOfTab(tabId) {
  const item = filtered.find(f => f.tab.id === tabId);
  if (!item || !item.group) return null;
  // 未分组的标签没有可收起的分组头
  const sameGroup = filtered.filter(f => f.group && groupKey(f.group) === groupKey(item.group));
  if (!sameGroup.length) return null;
  return { group: item.group, firstTabId: sameGroup[0].tab.id };
}

async function switchTo(tab) {
  // 书签/历史条目(id 为负): 新开标签页,而非切换已有标签
  if (tab.id < 0) {
    await chrome.tabs.create({ url: tab.url, active: true });
    window.close();
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

function setActive(idx) {
  const rows = resultsEl.querySelectorAll('.tab-item');
  if (!rows.length) return;
  clearActiveUnit();
  activeIndex = Math.max(0, Math.min(idx, rows.length - 1));
  const el = rows[activeIndex];
  if (el) {
    el.classList.add('active');
    el.scrollIntoView({ block: 'nearest' });
  }
}

// 定位当前标签: 只认 active 且属于弹窗所在窗口的行。
// 多窗口时每个窗口各有一个 active 标签,不加窗口条件会定位到别的窗口去
function focusCurrentTab() {
  const rows = [...resultsEl.querySelectorAll('.tab-item')];
  const currentRow = rows.find(r => {
    const f = filtered.find(x => x.tab.id === Number(r.dataset.tabId));
    return f && f.tab.active
      && (currentWindowId == null || f.tab.windowId === currentWindowId);
  });
  setActive(currentRow ? rows.indexOf(currentRow) : 0);
}

// 可聚焦单元 = 分组头 + 标签行,统一编址,←→/↑↓/Enter 都基于它工作
function navUnits() {
  return [...resultsEl.querySelectorAll('.group-header, .tab-item')];
}
function clearActiveUnit() {
  navUnits().forEach(u => u.classList.remove('active'));
}
// 分组头的选中态
function focusGroupHeader(header) {
  clearActiveUnit();
  header.classList.add('active');
  activeIndex = -2; // 标记当前焦点在分组头上,不在标签行序列里
}

// ---- 视图切换 ----
// 语义: 两个视图是对同一结果集的不同排布,搜索词跨视图保留并立即按新视图重排
const viewTabs = [...document.querySelectorAll('.view-tab')];
function setView(v) {
  if (v === view) return;
  view = v;
  localStorage.setItem('tgs-view', v);
  viewTabs.forEach(b => b.classList.toggle('active', b.dataset.view === v));
  activeIndex = -1;
  search(searchValue());
  render();
  // 空查询时定位当前标签,搜索时选第一条
  if (filtered.length) {
    if (searching) setActive(0);
    else focusCurrentTab();
  }
}
viewTabs.forEach(b => b.addEventListener('click', () => {
  setView(b.dataset.view);
  input.focus();
}));
// 初始化时应用已保存的视图
viewTabs.forEach(b => b.classList.toggle('active', b.dataset.view === view));

let debounceTimer = null;
// 命令模式数据源异步加载完成后的补渲染(加载耗时通常 <50ms,
// 若用户已继续输入,render 用的是当前输入框内容,不冲突)。
// 判断依据是胶囊状态 activeCmd——前缀已被从输入框剥离,
// 检查 input.value.startsWith('/h') 会永远 false,裸命令就永远空白
function refreshIfCmdMode() {
  if (activeCmd === '/b' || activeCmd === '/h') {
    search(searchValue());
    render();
    if (filtered.length) setActive(0);
  }
}

// ---- slash 命令胶囊 ----
// 输入 /b /h 打全后,前缀从输入框"提取"为高亮胶囊(等宽字体标签);
// 输入框只留关键词部分。退格(光标在关键词最前/输入框空)删除整个胶囊
const cmdChip = document.getElementById('cmdChip');
const cmdChipText = document.getElementById('cmdChipText');
let activeCmd = null; // null | '/b' | '/h'

// 完整搜索值 = 激活的命令前缀 + 输入框关键词(胶囊是视觉层,search 需要完整值)
function searchValue() {
  return activeCmd ? activeCmd + ' ' + input.value : input.value;
}

// ⌘⌫ 逐个清理重复副本: 关闭该行副本中的一份,按一次删一份,
// 直到只剩代表(最近使用的那份)。副本按合并时的入序删(后入 = 较旧)。
// 注意: 删完后必须同步 allTabs 源头的 duplicates(而非 pop 局部引用)——
// search() 会从 allTabs 重建 filtered,旧引用的修改会丢,导致
// 角标不减且第二次删除时 victimId 重复(删已关的标签,静默失败)
async function closeOneDuplicate(target) {
  if (!target || !target.duplicates || !target.duplicates.length) return;
  const victimId = target.duplicates[target.duplicates.length - 1];
  try {
    await chrome.tabs.remove(victimId);
    // 从 allTabs 源头移除该副本(重建后的 filtered 才能拿到正确状态)
    const src = allTabs.find(x => x.tab.url === target.tab.url);
    if (src && src.duplicates) {
      src.duplicates = src.duplicates.filter(id => id !== victimId);
    }
    search(searchValue());
    render();
    // render 的自动焦点恢复在 async 路径上不可靠(捕获时机早于 DOM 重建),
    // 显式把焦点设回代表行(行还在,代表未删),支持连续 ⌘⌫
    const row = [...resultsEl.querySelectorAll('.tab-item')]
      .find(r => Number(r.dataset.tabId) === target.tab.id);
    if (row) {
      clearActiveUnit();
      row.classList.add('active');
      activeIndex = [...resultsEl.querySelectorAll('.tab-item')].indexOf(row);
    }
    const remaining = (src?.duplicates?.length ?? target.duplicates.length - 1) + 1;
    showToast(`已关闭一份副本,剩余 ${remaining} 份`);
  } catch (e) {
    console.error('关闭副本失败:', e);
  }
}

function syncCmdChip() {
  // 状态机: 胶囊未激活时,检测输入是否以 /b /h 开头(可激活);
  // 已激活后 input.value 只存纯关键词,不再重新检测(否则剥掉前缀后
  // 下次 input 事件匹配不到命令,胶囊会误消失)
  if (!activeCmd) {
    const m = input.value.match(/^(\/[bh])\s?/);
    if (m) {
      activeCmd = m[1];
      const kw = input.value.replace(/^\/[bh]\s?/, '');
      input.value = kw; // 剥掉前缀只留关键词
    }
  }
  // 渲染胶囊 + 数据源按钮高亮
  if (activeCmd) {
    cmdChipText.textContent = activeCmd;
    cmdChip.style.display = 'inline-flex';
  } else {
    cmdChip.style.display = 'none';
  }
  syncSrcButtons();
}
// 胶囊上的 × 点击移除
cmdChip.querySelector('.cmd-chip-x').addEventListener('click', () => {
  activeCmd = null;
  cmdChip.style.display = 'none';
  input.value = '';
  input.dispatchEvent(new Event('input'));
});

// ---- 数据源按钮: 点击 = 激活/取消对应命令(等价输入 /b /h) ----
const bmBtn = document.getElementById('bmBtn');
const histBtn = document.getElementById('histBtn');
function setCmd(cmd) {
  // toggle 语义: 再点同一个取消;点另一个切换
  activeCmd = (activeCmd === cmd) ? null : cmd;
  cmdChipText.textContent = activeCmd || '';
  cmdChip.style.display = activeCmd ? 'inline-flex' : 'none';
  syncSrcButtons();
  input.value = ''; // 切换数据源时清空关键词,从头搜
  input.focus();
  input.dispatchEvent(new Event('input'));
}
bmBtn.addEventListener('click', () => setCmd('/b'));
histBtn.addEventListener('click', () => setCmd('/h'));
// 按钮高亮与 activeCmd 同步(在 syncCmdChip 渲染胶囊处一并维护)
function syncSrcButtons() {
  bmBtn.classList.toggle('active', activeCmd === '/b');
  histBtn.classList.toggle('active', activeCmd === '/h');
}

// 输入法拼音直搜: 中文输入法未上屏的拼音串(composing 状态)直接参与搜索——
// 输入法忘了切英文时,拼音打一半列表已在实时过滤,无需上屏或切输入法。
// 原理: composition 期间 input 事件里输入框的值就是拼音字母本身,
// 常规搜索链路天然可用;唯一要处理的是上屏汉字后别把拼音残留当查询词
input.addEventListener('compositionend', () => {
  // 上屏完成: 值已变成汉字,触发一次常规 input 流程即可(汉字会被拼音匹配兜住)
  input.dispatchEvent(new Event('input'));
});

input.addEventListener('input', () => {
  // 先同步命令胶囊(可能修改 input.value 剥离前缀),再做常规搜索流
  syncCmdChip();
  // 防抖: 大标签量时每个字符全量重建 DOM 会有卡顿感
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    activeIndex = -1;
    const wasSearching = searching;
    // 搜索态判定: 命令胶囊激活时即使关键词空也算搜索态(显示命令结果)
    searching = input.value.trim().length > 0 || activeCmd !== null;
    // 开始一次新搜索(从空查询进入)时,搜索模式的分组全部重置为展开
    if (searching && !wasSearching) searchCollapsed = new Set();
    // 命令模式触发对应数据源的按需加载(书签/历史,弹窗存活期内缓存)
    if (activeCmd === '/b') loadBookmarks().then(refreshIfCmdMode);
    else if (activeCmd === '/h') loadHistory().then(refreshIfCmdMode);
    // search() 需要完整值(含前缀)判定命令模式——胶囊只是视觉层
    search(activeCmd ? activeCmd + ' ' + input.value : input.value);
    render();
    // 空查询时光标落在当前激活标签(打开弹窗最常见意图:回到刚离开的 tab)
    // 搜索时落在第一条结果
    if (filtered.length) {
      if (searching) setActive(0);
      else focusCurrentTab();
    }
  }, 30);
});

// 退格整删胶囊: 光标在起点(或空输入)按 Backspace,清除整个命令而非逐字
input.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' && activeCmd
    && (input.value === '' || input.selectionStart === 0 && input.selectionEnd === 0)) {
    e.preventDefault();
    activeCmd = null;
    cmdChip.style.display = 'none';
    input.value = '';
    input.dispatchEvent(new Event('input'));
  }
});

// ---- 设置面板 ----
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const optFuzzy = document.getElementById('optFuzzy');
const optShowUrl = document.getElementById('optShowUrl');

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('open');
  // 展开时加载分组规则(storage 读取 <5ms,每次展开刷新保持与 background 同步)
  if (settingsPanel.classList.contains('open')) {
    loadRulesForEdit();
    loadAutoGroupSwitch();
  }
});
// 覆盖层的关闭按钮
document.getElementById('settingsCloseBtn').addEventListener('click', () => {
  settingsPanel.classList.remove('open');
});

// 自动分组总开关: 存 chrome.storage.local(background 读同一 key 判定是否归组)。
// Tabbiy 的痛点之一是自动分组"用着用着就关了"——我们显式开关 + 显式状态,
// 行为可预测
const optAutoGroup = document.getElementById('optAutoGroup');
async function loadAutoGroupSwitch() {
  try {
    const stored = await chrome.storage.local.get('autoGroupEnabled');
    // 默认开启(undefined = 未设置过)
    optAutoGroup.checked = stored?.autoGroupEnabled !== false;
  } catch (e) {
    optAutoGroup.checked = true;
  }
}
optAutoGroup.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoGroupEnabled: optAutoGroup.checked });
  if (optAutoGroup.checked) {
    // 开启时立即触发存量归组(散标签按规则+Others兜底收组),归完顺带整理
    showToast('自动分组已开启,正在归组存量标签…');
    try {
      await chrome.runtime.sendMessage({ type: 'group-existing' });
      setTimeout(async () => {
        await loadTabs();
        search(searchValue());
        render();
      }, 1500);
    } catch (e) { /* worker 未就绪时静默,规则已在 worker 生效 */ }
  } else {
    showToast('自动分组已关闭');
  }
});
// 快捷键速查已改为 hover 气泡(纯 CSS),无需 JS
optFuzzy.checked = settings.fuzzy;
optShowUrl.checked = settings.showUrl;
optFuzzy.addEventListener('change', () => {
  settings.fuzzy = optFuzzy.checked;
  saveSettings();
  search(searchValue());
  render();
  if (filtered.length) setActive(0);
});
optShowUrl.addEventListener('change', () => {
  settings.showUrl = optShowUrl.checked;
  saveSettings();
  render();
});
// chrome:// 链接在扩展弹窗里不能直接打开,交由后台页处理
document.getElementById('shortcutLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// 清理僵尸标签按钮
document.getElementById('cleanBtn').addEventListener('click', () => {
  input.focus();
  cleanStaleTabs();
});

// ---- 自动分组规则编辑器 ----
// 规则存 chrome.storage.local(background 同源读取,storage.onChanged 即时生效)。
// UI: 每组一个"组名输入框 + 域名芯片流",增删组,保存。
// 脏状态: 任何编辑 → 保存按钮变琥珀+脉动,标题旁圆点;保存/重载后清除
const rulesListEl = document.getElementById('rulesList');
const saveRulesBtn = document.getElementById('saveRulesBtn');
const rulesDirtyDot = document.getElementById('rulesDirtyDot');

function markRulesDirty() {
  saveRulesBtn.classList.add('dirty');
  saveRulesBtn.textContent = '保存规则 •';
  rulesDirtyDot.classList.add('show');
}
function clearRulesDirty() {
  saveRulesBtn.classList.remove('dirty');
  saveRulesBtn.textContent = '保存规则';
  rulesDirtyDot.classList.remove('show');
}
// 事件委托: 规则区内所有输入/键入都算编辑(input 覆盖打字/粘贴/删除,
// click 覆盖 chip × 删除和组删除按钮——这些不触发 input)
rulesListEl.addEventListener('input', markRulesDirty);
rulesListEl.addEventListener('click', (e) => {
  // 只有点删除类按钮才算编辑(点 chip 文本等不算)
  if (e.target.closest('.rule-del-btn') || e.target.closest('.host-chip button')) {
    markRulesDirty();
  }
});
// 增删组直接标脏(发生在 rulesListEl 之外)
async function loadRulesForEdit() {
  try {
    const stored = await chrome.storage.local.get('groupRules');
    if (stored?.groupRules && Object.keys(stored.groupRules).length) {
      renderRulesEditor(stored.groupRules);
      clearRulesDirty(); // 重载 = 回到已保存状态
      return;
    }
    // storage 为空(background 首次写入还没跑): 给空态提示,
    // 用户保存任意规则后即建立 storage 数据流
    renderRulesEditor({});
  } catch (e) {
    console.error('读取规则失败:', e);
    renderRulesEditor({});
  }
}

function renderRulesEditor(rules) {
  rulesListEl.innerHTML = '';
  const entries = Object.entries(rules);
  if (!entries.length) {
    rulesListEl.innerHTML = '<div style="padding:8px 0;color:#8b949e;font-size:11px">暂无规则,点击下方新增组</div>';
    return;
  }
  for (const [name, hosts] of entries) {
    rulesListEl.appendChild(buildRuleGroup(name, hosts || []));
  }
}

// 单个规则组的编辑行: 组名输入 + 域名芯片流(每枚可删) + 内联追加输入
function buildRuleGroup(name, hosts) {
  const groupDiv = document.createElement('div');
  groupDiv.className = 'rule-group';

  // 组名行
  const nameRow = document.createElement('div');
  nameRow.className = 'rule-group-name';
  const nameInput = document.createElement('input');
  nameInput.value = name;
  nameInput.placeholder = '组名';
  nameInput.className = 'rule-name-input';
  const delBtn = document.createElement('button');
  delBtn.className = 'rule-del-btn';
  delBtn.textContent = '×';
  delBtn.title = '删除该组规则';
  delBtn.addEventListener('click', () => groupDiv.remove());
  nameRow.appendChild(nameInput);
  nameRow.appendChild(delBtn);
  groupDiv.appendChild(nameRow);

  // 域名芯片流
  const chipFlow = document.createElement('div');
  chipFlow.className = 'rule-hosts';
  const addHostChip = (host) => {
    const chip = document.createElement('span');
    chip.className = 'host-chip';
    const label = document.createElement('span');
    label.textContent = host;
    label.title = host;
    const chipDel = document.createElement('button');
    chipDel.textContent = '×';
    chipDel.title = '移除该域名';
    chipDel.addEventListener('click', () => chip.remove());
    chip.appendChild(label);
    chip.appendChild(chipDel);
    chipFlow.insertBefore(chip, addInput);
  };
  // 内联追加输入: 回车/失焦确认(逗号分隔可批量)
  const addInput = document.createElement('input');
  addInput.className = 'host-add-input';
  addInput.placeholder = '+ 域名,回车确认';
  const commit = () => {
    const parts = addInput.value.split(/[,，\n]/)
      .map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    parts.forEach(addHostChip);
    addInput.value = '';
  };
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') addInput.blur();
    e.stopPropagation(); // 不触发全局快捷键
  });
  addInput.addEventListener('blur', commit);
  chipFlow.appendChild(addInput);

  hosts.forEach(addHostChip);
  groupDiv.appendChild(chipFlow);
  return groupDiv;
}

document.getElementById('addRuleBtn').addEventListener('click', () => {
  // 追加一个空模板组(不动已有内容)
  rulesListEl.appendChild(buildRuleGroup('', []));
  rulesListEl.scrollTop = rulesListEl.scrollHeight;
  markRulesDirty();
  // 聚焦新组的组名输入
  const groups = rulesListEl.querySelectorAll('.rule-group');
  groups[groups.length - 1]?.querySelector('.rule-name-input')?.focus();
});

document.getElementById('saveRulesBtn').addEventListener('click', async () => {
  // 从 DOM 收集: 组名输入框 + 芯片文本
  const rules = {};
  let invalid = 0;
  rulesListEl.querySelectorAll('.rule-group').forEach(g => {
    const name = g.querySelector('.rule-name-input')?.value.trim();
    const hosts = [...g.querySelectorAll('.host-chip > span')]
      .map(el => el.textContent.trim()).filter(Boolean);
    if (name && hosts.length) {
      rules[name] = hosts;
    } else {
      invalid += 1;
    }
  });
  if (!Object.keys(rules).length) {
    showToast('规则为空,未保存');
    return;
  }
  try {
    await chrome.storage.local.set({ groupRules: rules });
    clearRulesDirty();
    showToast(`规则已保存(${Object.keys(rules).length} 组)${invalid ? `,${invalid} 个无效组被忽略` : ''}`);
    chrome.runtime.sendMessage({ type: 'group-existing' }).catch(() => {});
  } catch (e) {
    showToast('保存失败:' + e.message);
  }
});

// (规则加载已合并进上方 settingsBtn 主监听器——展开即刷新,
// 独立监听器的时序判断曾与主监听器的 toggle 竞态导致永远不加载)

// 全局键盘路由: 监听 document 而非 input,任何元素拿走焦点后快捷键依然有效。
// 仅当焦点在其他真实输入控件(设置面板的 checkbox 等)时放行原生行为
document.addEventListener('keydown', (e) => {
  // 诊断: 所有退格按键的真实修饰键状态(排查"没按 cmd 却触发关闭"的键位映射问题)
  if (e.key === 'Backspace') {
    console.log('[TGS] Backspace 按下:', {
      meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
      key: e.key, code: e.code,
      focusIn: document.activeElement === input,
    });
  }
  const activeEl = document.activeElement;
  const isOtherInput = activeEl && activeEl !== input
    && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT'
      || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
  if (isOtherInput) return;
  handleShortcuts(e);
});

// 点击文档任意位置后焦点还给搜索框(行/气泡/空白处的点击都会把焦点带走,
// 带 shortcode 的按钮各自已 focus(),这里兜住其余所有情况)
document.addEventListener('click', (e) => {
  // 设置面板内的交互(checkbox/链接)保持自身焦点
  if (e.target.closest('#settingsPanel')) return;
  input.focus();
});

function handleShortcuts(e) {
  // Esc 分层退出: 设置面板开 → 关面板;有关键词/胶囊 → 清空;最后才关弹窗
  if (e.key === 'Escape') {
    e.preventDefault();
    if (settingsPanel.classList.contains('open')) {
      settingsPanel.classList.remove('open');
      return;
    }
    if (input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    } else if (activeCmd) {
      activeCmd = null;
      cmdChip.style.display = 'none';
      input.dispatchEvent(new Event('input'));
    } else {
      window.close();
    }
    return;
  }
  // Tab / Shift+Tab 在 分组 → 最近使用 → 当前窗口 三个视图间循环切换
  if (e.key === 'Tab') {
    e.preventDefault();
    const idx = VIEWS.indexOf(view);
    const next = e.shiftKey
      ? VIEWS[(idx - 1 + VIEWS.length) % VIEWS.length]
      : VIEWS[(idx + 1) % VIEWS.length];
    setView(next);
    return;
  }
  const units = navUnits();
  if (!units.length) return;
  // 当前焦点单元: 优先取带 active 的单元(可能是分组头或行)
  const focusedUnit = units.find(u => u.classList.contains('active')) || units[0];
  const focusIdx = units.indexOf(focusedUnit);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = focusIdx + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= units.length) return;
    const el = units[next];
    clearActiveUnit();
    el.classList.add('active');
    el.scrollIntoView({ block: 'nearest' });
    if (el.classList.contains('tab-item')) {
      activeIndex = [...resultsEl.querySelectorAll('.tab-item')].indexOf(el);
    } else {
      activeIndex = -2; // 焦点在分组头
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // → 收起 / ← 展开焦点所在的分组; 焦点在标签行上时取该行所属分组
    // recent / current 视图没有分组头,收起无处展示,不响应
    if (view !== 'grouped') return;
    let key;
    if (focusedUnit.classList.contains('group-header')) {
      key = focusedUnit.dataset.groupKey;
    } else {
      const found = findGroupOfTab(Number(focusedUnit.dataset.tabId));
      if (!found) return; // 未分组的标签,无组可收
      key = groupKey(found.group);
    }
    const set = activeCollapsed();
    if (DEBUG) console.log('[TGS] 分组键:', key, '已收起:', set.has(key));
    if (e.key === 'ArrowRight' && !set.has(key)) {
      set.add(key);
      if (!searching) saveCollapsed();
      render();
      // 收起后光标落在该分组头上,再按 ← 可原地展开
      const header = navUnits().find(u => u.classList.contains('group-header') && u.dataset.groupKey === key);
      if (header) {
        header.classList.add('active');
        header.scrollIntoView({ block: 'nearest' });
        activeIndex = -2;
      }
    } else if (e.key === 'ArrowLeft' && set.has(key)) {
      set.delete(key);
      if (!searching) saveCollapsed();
      render();
      // 展开后选中该分组下第一行
      const rows = [...resultsEl.querySelectorAll('.tab-item')];
      const firstRow = rows.find(r => {
        const found = findGroupOfTab(Number(r.dataset.tabId));
        return found && groupKey(found.group) === key;
      });
      if (firstRow) {
        setActive(rows.indexOf(firstRow));
      } else {
        // 组内无可见行(如未分组区),光标留在分组头
        const header = navUnits().find(u => u.classList.contains('group-header') && u.dataset.groupKey === key);
        if (header) { header.classList.add('active'); activeIndex = -2; }
      }
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (focusedUnit.classList.contains('tab-item')) {
      const tabId = Number(focusedUnit.dataset.tabId);
      const target = filtered.find(f => f.tab.id === tabId);
      if (target) switchTo(target.tab);
    }
    // 焦点在分组头上时回车不做操作
  } else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    // ⌘⇧K / Ctrl+Shift+K 清理 7 天以上未使用的标签
    e.preventDefault();
    cleanStaleTabs();
  } else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
    // ⌘Z / Ctrl+Z 撤销最近关闭的标签
    e.preventDefault();
    if (isUndoAvailable()) {
      undoBar.querySelector('.undo-btn')?.click();
    }
  } else if (e.key === 'Backspace'
    && (e.metaKey || e.ctrlKey)
    && !e.altKey && !e.shiftKey) {
    // ⌘⌫ / Ctrl+Backspace 删除当前选中行:
    // 有重复副本 → 只删一份副本(逐个清理,代表永不动,按一次少一份);
    // 无副本 → 删除标签本身。
    // 修饰键显式要求: 裸退格(删字)和其他组合不进这里
    e.preventDefault();
    if (focusedUnit.classList.contains('tab-item')) {
      const target = filtered.find(f => f.tab.id === Number(focusedUnit.dataset.tabId));
      if (target && target.duplicates && target.duplicates.length) {
        closeOneDuplicate(target);
      } else {
        closeTab(Number(focusedUnit.dataset.tabId));
      }
    }
  } else if ((e.key === 'c' || e.key === 'C') && (e.metaKey || e.ctrlKey)) {
    // ⌘C: 光标在标签行上时复制该 tab 的 URL(不切换过去)。
    // 若输入框里有选中文本,放行原生复制
    const sel = window.getSelection();
    if (sel && sel.toString()) return;
    if (focusedUnit.classList.contains('tab-item')) {
      e.preventDefault();
      const target = filtered.find(f => f.tab.id === Number(focusedUnit.dataset.tabId));
      if (target) copyTabUrl(target.tab);
    }
  }
}

// 复制 tab 的 URL 到剪贴板,轻提示确认(不关弹窗,可连续复制多个)
async function copyTabUrl(tab) {
  const url = tab.url || '';
  try {
    await navigator.clipboard.writeText(url);
    showToast(`已复制: ${displayUrl(url).slice(0, 40)}`);
  } catch (err) {
    console.error('复制失败:', err);
    showToast('复制失败,请重试');
  }
}

(async () => {
  const bootT0 = performance.now();
  await loadTabs();
  search('');
  render();
  // 初始光标落在当前激活标签,Enter 直接回去
  focusCurrentTab();
  input.focus();
  console.log(`[TGS] 首帧完成, JS 侧总耗时 ${(performance.now() - bootT0).toFixed(1)}ms`);
  // 快照追帧: 首帧可能拿到 Tabbiy 归组/新标签 URL 定型前的中间态
  // (新开标签暂在未分组、重复未合并),1s 后静默复核,有变化才重渲染
  setTimeout(async () => {
    const sig = (list) => JSON.stringify(list.map(x =>
      [x.tab.id, x.tab.url, x.duplicates?.length || 0, x.group?.title || '']));
    const before = sig(allTabs);
    await loadTabs();
    if (sig(allTabs) !== before) {
      search(searchValue());
      render();
      if (!searching) focusCurrentTab();
    }
  }, 1000);
  // 唤起时异步触发分组整理(同名合并+空组清理),在 background 静默执行,
  // 不阻塞弹窗;整理结果由下一次唤起自然看到
  chrome.runtime.sendMessage({ type: 'tidy-groups' }).catch(() => {});
  // [临时探针] 排查 saved tab group 在书签树的结构特征,定位后删除
  chrome.bookmarks.getTree(tree => {
    const bar = tree[0].children.find(c => c.id === '1') || tree[0].children[0];
    console.log('[TGS 探针] 书签栏一级节点:', JSON.stringify(
      (bar.children || []).map(c => ({
        id: c.id, title: c.title, type: c.type,
        childCount: c.children ? c.children.length : undefined,
        keys: Object.keys(c),
      })), null, 2));
  });
})();
