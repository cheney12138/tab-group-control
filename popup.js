// 按分组展示的标签页搜索:
// 读取 chrome.tabGroups 中由 Tabbiy 等插件创建的原生分组,
// 搜索结果按分组分区显示,支持模糊匹配与拼音首字母场景下的子串匹配。

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
let ordinalMap = new Map(); // tabId -> {idx, total} 组内序号,render() 时预计算

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

// 把 Chrome 内部窗口 id 映射为从 1 开始的序号,比裸 id 可读
function windowOrdinal(windowId) {
  const idx = windowIds.indexOf(windowId);
  return idx === -1 ? windowId : idx + 1;
}

async function loadTabs() {
  const t0 = performance.now();
  // 分组查询失败不应拖垮整个列表(例如权限缺失时仍可搜索,只是无分组头)
  const [tabs, groups, currentWin] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}).catch(err => {
      console.error('查询分组失败:', err);
      return [];
    }),
    chrome.windows.getCurrent().catch(() => null),
  ]);
  if (DEBUG) console.log(`[TGS] loadTabs 查询耗时: ${(performance.now() - t0).toFixed(1)}ms, 标签数: ${tabs.length}`);
  currentWindowId = currentWin ? currentWin.id : null;
  const groupById = new Map(groups.map(g => [g.id, g]));
  // 收集窗口序号映射(过滤发生在收集之后,保证编号连续且与实际窗口一致)
  windowIds = [...new Set(tabs.map(t => t.windowId))].sort((a, b) => a - b);
  // 按最近使用时间倒排: 分组区顺序由组内最新标签决定,组内同样按最近使用排序
  allTabs = tabs
    .filter(t => !t.url.startsWith('chrome-extension://'))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .map(t => ({ tab: t, group: groupById.get(t.groupId) || null }));
}

function search(query) {
  const q = query.trim();
  // current 视图: 先收窄到当前窗口,再参与搜索/排序
  const source = view === 'current' && currentWindowId != null
    ? allTabs.filter(x => x.tab.windowId === currentWindowId)
    : allTabs;
  if (!q) {
    // 空查询:展示全部(保持标签页顺序),便于浏览
    filtered = source.map(x => ({ ...x, titleHits: null, urlHits: null }));
    return;
  }
  filtered = [];
  for (const x of source) {
    // 匹配优先级: 标题 > 分组名 > 域名(host) > 完整 URL
    const title = x.tab.title || '';
    const titleHits = fuzzyMatch(q, title);
    let urlHits = null;
    let matchedOn = null; // 'title' | 'group' | 'host' | 'url'
    let groupHits = null;
    if (titleHits) {
      matchedOn = 'title';
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
  // 3. grouped 视图按标签页自然顺序;recent 视图按最近使用
  const rank = { title: 0, group: 1, host: 2, url: 3 };
  const firstHit = f => f.titleHits?.[0] ?? f.urlHits?.[0] ?? 9999;
  filtered.sort((a, b) => {
    if (a.groupNameExact !== b.groupNameExact) return a.groupNameExact ? -1 : 1;
    const r = rank[a.matchedOn] - rank[b.matchedOn];
    if (r !== 0) return r;
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    const h = firstHit(a) - firstHit(b);
    if (h !== 0) return h;
    if (view === 'recent' || view === 'current') {
      return (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0);
    }
    if (a.tab.windowId !== b.tab.windowId) return a.tab.windowId - b.tab.windowId;
    return (a.tab.index || 0) - (b.tab.index || 0);
  });

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
  // 预计算组内序号: 一次遍历代替行构建时每行对 filtered 的全量 filter/findIndex
  // (后者在几百标签时是 O(n²),是渲染卡顿的主要来源)
  ordinalMap = new Map();
  const groupCounts = new Map(); // groupKey -> 组内条目总数
  for (const f of filtered) {
    if (!f.group) continue;
    const key = groupKey(f.group);
    groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
  }
  const seen = new Map(); // groupKey -> 已分配序号
  for (const f of filtered) {
    if (!f.group) continue;
    const key = groupKey(f.group);
    const idx = (seen.get(key) || 0) + 1;
    seen.set(key, idx);
    ordinalMap.set(f.tab.id, { idx, total: groupCounts.get(key) });
  }
  resultsEl.innerHTML = '';
  if (!filtered.length) {
    resultsEl.innerHTML = '<div class="empty">没有匹配的标签页</div>';
    return;
  }

  // recent / current 视图: 不分组,纯按顺序平铺(空查询=最近使用倒排,搜索=匹配优先+最近使用)
  // current 视图的数据源已在 search() 收窄到当前窗口
  if (view === 'recent' || view === 'current') {
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
function buildFaviconEl(t) {
  const img = document.createElement('img');
  img.src = t.favIconUrl || '';
  img.onerror = () => { img.style.visibility = 'hidden'; };
  return img;
}

function buildTabRow(item) {
  const t = item.tab;
  const row = document.createElement('div');
  row.className = 'tab-item';
  row.dataset.tabId = t.id;

  // 组内序号: 只在分组视图显示——平铺视图(recent/current)没有分组语境,
  // 序号既无上下文又占行首,纯噪音。序号在 render() 里预计算,这里 O(1) 查询
  if (item.group && view === 'grouped') {
    const ord = ordinalMap.get(t.id);
    if (ord && ord.total > 1) {
      const ordinal = document.createElement('span');
      ordinal.className = 'group-ordinal';
      ordinal.textContent = ord.idx;
      ordinal.title = `组内第 ${ord.idx} / ${ord.total} 个`;
      row.appendChild(ordinal);
    }
  }

  // favicon 只用 tab 快照自带的 URL,拿不到直接给默认图标。
  // 不做运行时兜底请求(_favicon/字母占位会引入二次加载与重排,拖慢渲染),
  // 弹窗内图标是辅助信息,快和稳优先于全
  const iconEl = buildFaviconEl(t);

  const info = document.createElement('div');
  info.className = 'tab-info';
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = markText(t.title || t.url, item.titleHits);
  info.appendChild(title);
  const isOtherWindow = currentWindowId != null && t.windowId !== currentWindowId;
  // 其他窗口的行强制显示 URL 行: 窗口前缀本身是有效信息,不跟随 showUrl 设置隐藏
  if (settings.showUrl || item.urlHits || isOtherWindow) {
    const url = document.createElement('div');
    url.className = 'url';
    const shownUrl = displayUrl(t.url);
    // URL 兜底匹配发生在完整 URL 上,但展示的是 host+path,需在展示文本上重算高亮
    const urlHits = item.urlHits
      ? (fuzzyMatch(input.value.trim(), shownUrl) || item.urlHits)
      : null;
    const prefix = isOtherWindow
      ? `<span class="win-prefix">窗口${windowOrdinal(t.windowId)} · </span>` : '';
    url.innerHTML = prefix + markText(shownUrl, urlHits);
    info.appendChild(url);
  }

  row.appendChild(iconEl);
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
  search(input.value);
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

// ---- 清理僵尸标签 ----
// 批量关闭 stale(7~30天) + zombie(30天+) 档位的标签。
// 排除当前激活标签(正在用的不杀);全部进入撤销栈,可 ⌘Z 整批救回
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
  // 二次确认: 批量关 tab 是破坏性操作
  const ok = confirm(`将关闭 ${targets.length} 个 7 天以上未使用的标签(当前标签不受影响),可通过 ⌘Z 撤销。确定?`);
  if (!ok) return;
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
  search(input.value);
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
  search(input.value);
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
input.addEventListener('input', () => {
  // 防抖: 大标签量时每个字符全量重建 DOM 会有卡顿感
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    activeIndex = -1;
    const wasSearching = searching;
    searching = input.value.trim().length > 0;
    // 开始一次新搜索(从空查询进入)时,搜索模式的分组全部重置为展开
    if (searching && !wasSearching) searchCollapsed = new Set();
    search(input.value);
    render();
    // 空查询时光标落在当前激活标签(打开弹窗最常见意图:回到刚离开的 tab)
    // 搜索时落在第一条结果
    if (filtered.length) {
      if (searching) setActive(0);
      else focusCurrentTab();
    }
  }, 30);
});

// ---- 设置面板 ----
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const optFuzzy = document.getElementById('optFuzzy');
const optShowUrl = document.getElementById('optShowUrl');

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('open');
  input.focus();
});
// 快捷键速查已改为 hover 气泡(纯 CSS),无需 JS
optFuzzy.checked = settings.fuzzy;
optShowUrl.checked = settings.showUrl;
optFuzzy.addEventListener('change', () => {
  settings.fuzzy = optFuzzy.checked;
  saveSettings();
  search(input.value);
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

// 全局键盘路由: 监听 document 而非 input,任何元素拿走焦点后快捷键依然有效。
// 仅当焦点在其他真实输入控件(设置面板的 checkbox 等)时放行原生行为
document.addEventListener('keydown', (e) => {
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
  // Esc: 有搜索词时清空,没有时关闭弹窗
  if (e.key === 'Escape') {
    e.preventDefault();
    if (input.value) {
      input.value = '';
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
  } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) {
    // ⌘⌫ / Ctrl+Backspace 关闭当前选中的标签页
    e.preventDefault();
    if (focusedUnit.classList.contains('tab-item')) {
      closeTab(Number(focusedUnit.dataset.tabId));
    }
  }
}

(async () => {
  await loadTabs();
  search('');
  render();
  // 初始光标落在当前激活标签,Enter 直接回去
  focusCurrentTab();
  input.focus();
})();
