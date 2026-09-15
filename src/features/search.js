// features/search.js: 搜索与 slash 命令(组件)
// search() 查询解析与匹配(标签/书签/历史三源),/b /h 命令模式;
// 输入框事件与命令胶囊、数据源按钮均在本模块注册。
// 状态: core/store.state(allTabs/filtered/searching/activeCmd/view/...)
import { fuzzyMatch, pinyinMatch, textToPinyin, matchField } from '../core/pinyin.js';
import { hostOf, cleanTitle, isBadTitle, groupKey } from '../core/format.js';
import { resultsEl, showToast, input, indexOfRow, rowByTabId } from '../core/dom.js';
import { DEBUG } from '../core/platform.js';
import { setActive, focusCurrentTab, clearActiveUnit } from './nav.js';
import { state, searchCollapsed, collapsed, saveCollapsed, mediaTabIds } from '../core/store.js';

let actions = null; // initSearch 注入: { render, refreshData, focusInput, getInputValue, setInputValue }
export function initSearch(injected) { actions = injected; }

// ---- 命令模式数据源: /b 书签 /h 历史 /r 最近关闭 ----
// 结构与 state.allTabs 同构([{tab, group}]),tab.id 用负数避免与真实 tabId 冲突
let bookmarkItems = [];
let historyItems = [];
let closedItems = [];
let bookmarksLoaded = false;
let historyLoaded = false;
let closedLoaded = false;

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
    // 当前打开的标签 URL 集合: /h 的目的是找回"没开着的"页面,
    // 已开着的(尤其当前标签,它必然是最新历史)从结果中排除
    const openUrls = new Set(state.allTabs.map(x => x.tab.url).filter(Boolean));
    // 同 URL 折叠(chrome://history 同款): 每个 URL 只保留最近访问的一条,
    // 平铺会把同一页面的历史多次访问全部列出,不像真实历史
    const seen = new Set();
    historyItems = [];
    for (const h of sorted) {
      if (seen.has(h.url)) continue;
      if (openUrls.has(h.url)) continue; // 已开着的页面不进历史列表
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

// /r 最近关闭: Chrome sessions 给的"关闭现场"快照(关的那一刻的标题/URL/favIcon),
// 与 /h 的浏览足迹语义不同(CONTEXT.md「最近关闭」)
async function loadClosed() {
  if (closedLoaded) return;
  try {
    const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    // 只收单标签会话: 窗口级条目(.window)一开就是一窝,与"找回那一页"的场景不合
    // 同 URL 折叠: 关了开、开了又关的页面只留最近关闭的一次(取 API 原生倒序的首见)
    const seen = new Set();
    closedItems = [];
    for (const s of sessions) {
      const t = s.tab;
      if (!t || !t.url || seen.has(t.url)) continue;
      seen.add(t.url);
      closedItems.push({
        tab: { id: -20000 - closedItems.length, title: t.title || t.url, url: t.url,
               favIconUrl: t.favIconUrl || '', active: false, windowId: -1,
               lastAccessed: (s.lastModified || 0) * 1000 }, // lastModified 是秒
        group: null,
      });
    }
    closedLoaded = closedItems.length > 0; // 失败/空结果允许重试
  } catch (e) {
    console.error('加载最近关闭失败:', e);
    closedLoaded = false;
  }
}


// 比较两种匹配质量:
// 1. 先比 tier (越小越优: 1=全等, 2=前缀, 3=连续子串, 4=域名/URL, 5=紧凑模糊)
// 2. 同等级下: 英文原生匹配优先于拼音转译
// 3. 同语言下: 首字符出现越靠前越好
function compareQuality(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.isEnglish !== b.isEnglish) {
    return a.isEnglish ? -1 : 1;
  }
  const aFirst = a.hits?.[0] ?? 9999;
  const bFirst = b.hits?.[0] ?? 9999;
  return aFirst - bFirst;
}

export function search(query) {
  const q = query.trim();
  // 命令模式(QuicKey 同款): /b 书签 /h 历史 /r 最近关闭
  // 前缀命中即进入命令模式,switchTo 对负 id 条目走"新开标签"
  const isBookmarksCmd = q === '/b' || q.startsWith('/b ');
  const isHistoryCmd = q === '/h' || q.startsWith('/h ');
  const isClosedCmd = q === '/r' || q.startsWith('/r ');
  const inCommandMode = isBookmarksCmd || isHistoryCmd || isClosedCmd;
  let source = inCommandMode
    ? (isBookmarksCmd ? bookmarkItems : isHistoryCmd ? historyItems : closedItems)
    : (state.view === 'current' && state.currentWindowId != null
        ? state.allTabs.filter(x => x.tab.windowId === state.currentWindowId)
        : state.allTabs);
  // 命令模式剥掉前缀再匹配;裸命令(如"/b")无关键词 → 浏览全量
  const matchQ = inCommandMode
    ? (q.split(/^\/[bhr] ?/)[1] || '') : q;
  // 供行渲染区分: /h 的条目加半透明降级(历史非活标签)
  state.currentSourceIsHistory = isHistoryCmd;
  if (!q || (inCommandMode && !matchQ)) {
    // 空查询/裸命令:展示该数据源全部条目,便于浏览
    state.filtered = source.map(x => ({ ...x, titleHits: null, urlHits: null, matchQuality: null }));
    return;
  }
  state.filtered = [];
  if (inCommandMode) {
    // 书签/历史模式: 按 标题>host 过滤,但保持数据源原序
    // (/h 即 chrome 历史的真实时间序,/b 即书签树序),不按匹配级别重排、不分组
    for (const x of source) {
      const title = x.tab.title || '';
      const host = hostOf(x.tab.url) || '';
      const titleMatch = matchField(matchQ, title);
      const hostMatch = host ? matchField(matchQ, host) : null;
      if (titleMatch || hostMatch || !matchQ) {
        state.filtered.push({
          ...x,
          titleHits: titleMatch?.hits || null,
          urlHits: hostMatch?.hits || null,
          matchedOn: titleMatch ? 'title' : 'host',
          exact: titleMatch?.tier === 1,
          groupNameExact: false,
          matchQuality: titleMatch || hostMatch || null,
        });
      }
    }
    return; // source 顺序即展示顺序
  }
  const qLower = q.toLowerCase();
  for (const x of source) {
    // 多维度匹配: 标题 / 分组名 / 域名 / 完整 URL (支持英文原生 + 中文拼音)
    const title = x.tab.title || '';
    const groupTitle = x.group?.title || '';
    const host = hostOf(x.tab.url) || '';
    const url = x.tab.url || '';

    // 1. 分组名匹配 (原生字符 + 拼音)
    const groupMatch = matchField(q, groupTitle);

    // 2. 标题匹配 (原生字符 + 拼音)
    const titleMatch = matchField(q, title);

    // 3. 域名连续包含匹配 (英文原生，严格连续字串)
    let hostMatch = null;
    if (host) {
      const hLower = host.toLowerCase();
      const hIdx = hLower.indexOf(qLower);
      if (hIdx !== -1) {
        const hits = [];
        for (let i = hIdx; i < hIdx + qLower.length; i++) hits.push(i);
        const isPrefix = hIdx === 0;
        hostMatch = {
          type: isPrefix ? 'prefix' : 'sub',
          tier: isPrefix ? 3.5 : 4,
          isEnglish: true,
          hits,
        };
      }
    }

    // 4. URL 路径连续包含匹配 (英文原生，严格连续子串，禁止跨参数散字母乱入)
    let urlMatch = null;
    if (url) {
      const uLower = url.toLowerCase();
      const uIdx = uLower.indexOf(qLower);
      if (uIdx !== -1) {
        const hits = [];
        for (let i = uIdx; i < uIdx + qLower.length; i++) hits.push(i);
        urlMatch = {
          type: 'sub',
          tier: 4.5,
          isEnglish: true,
          hits,
        };
      }
    }

    // 5. 标题紧凑模糊匹配兜底 (仅针对标题，且跨度不超过 2 倍查询长度，防止长标题散乱噪音)
    let titleFuzzyMatch = null;
    if (!titleMatch && !groupMatch && !hostMatch && !urlMatch) {
      const fHits = fuzzyMatch(q, title);
      if (fHits && fHits.length) {
        const span = fHits[fHits.length - 1] - fHits[0] + 1;
        if (span <= qLower.length * 2 + 2) {
          titleFuzzyMatch = {
            type: 'fuzzy',
            tier: 5,
            isEnglish: true,
            hits: fHits,
          };
        }
      }
    }

    // 收集所有候选命中
    const candidates = [
      groupMatch ? { ...groupMatch, target: 'group' } : null,
      titleMatch ? { ...titleMatch, target: 'title' } : null,
      hostMatch ? { ...hostMatch, target: 'host' } : null,
      urlMatch ? { ...urlMatch, target: 'url' } : null,
      titleFuzzyMatch ? { ...titleFuzzyMatch, target: 'title' } : null,
    ].filter(Boolean);

    // 未命中任何有效规则则彻底过滤，杜绝长 URL 假阳性
    if (!candidates.length) continue;

    candidates.sort(compareQuality);
    const best = candidates[0];

    state.filtered.push({
      ...x,
      titleHits: titleMatch?.hits || titleFuzzyMatch?.hits || null,
      groupHits: groupMatch?.hits || null,
      urlHits: urlMatch?.hits || hostMatch?.hits || null,
      matchedOn: best.target,
      exact: best.tier <= 2,
      groupNameExact: best.target === 'group' && best.tier === 1,
      matchQuality: best,
    });
  }

  if (state.view === 'grouped') {
    // 分组视图: 按组分桶，桶间按最佳匹配质量排，桶内按匹配质量排
    const buckets = new Map(); // groupKey -> { best, items }
    for (const f of state.filtered) {
      const key = groupKey(f.group);
      if (!buckets.has(key)) buckets.set(key, { best: null, items: [] });
      const b = buckets.get(key);
      if (!b.best || compareQuality(f.matchQuality, b.best) < 0) {
        b.best = f.matchQuality;
      }
      b.items.push(f);
    }
    for (const b of buckets.values()) {
      b.items.sort((x, y) => {
        const qDiff = compareQuality(x.matchQuality, y.matchQuality);
        if (qDiff !== 0) return qDiff;
        // 同等匹配质量内: 最近使用的排前面(相对时间显示为升序: 4小时 -> 7小时 -> 9小时)
        const timeDiff = (y.tab.lastAccessed || 0) - (x.tab.lastAccessed || 0);
        if (timeDiff !== 0) return timeDiff;
        return (x.tab.index || 0) - (y.tab.index || 0);
      });
    }
    state.filtered = [...buckets.values()]
      .sort((a, b) => {
        const qDiff = compareQuality(a.best, b.best);
        if (qDiff !== 0) return qDiff;
        const aTime = Math.max(...a.items.map(i => i.tab.lastAccessed || 0));
        const bTime = Math.max(...b.items.map(i => i.tab.lastAccessed || 0));
        return bTime - aTime;
      })
      .flatMap(b => b.items);
  } else {
    state.filtered.sort((a, b) => {
      const qDiff = compareQuality(a.matchQuality, b.matchQuality);
      if (qDiff !== 0) return qDiff;
      const timeDiff = (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0);
      if (timeDiff !== 0) return timeDiff;
      return (a.tab.index || 0) - (b.tab.index || 0);
    });
  }

  if (DEBUG) {
    console.group(`[TGS] 搜索 "${q}" — 共 ${state.filtered.length} 条`);
    console.table(state.filtered.slice(0, 15).map(f => ({
      匹配级别: f.matchedOn,
      精确: f.exact,
      分组: f.group?.title || '',
      标题: (f.tab.title || '').slice(0, 30),
      host: hostOf(f.tab.url),
      lastAccessed: new Date(f.tab.lastAccessed || 0).toLocaleTimeString(),
    })));
    console.log('排序后顺序(渲染前):', state.filtered.map(f =>
      `${f.matchedOn}:${(f.tab.title || f.tab.url).slice(0, 20)}`));
    console.groupEnd();
  }
}

let debounceTimer = null;
// 命令模式数据源异步加载完成后的补渲染(加载耗时通常 <50ms,
// 若用户已继续输入,render 用的是当前输入框内容,不冲突)。
// 判断依据是胶囊状态 state.activeCmd——前缀已被从输入框剥离,
// 检查 input.value.startsWith('/h') 会永远 false,裸命令就永远空白
export function refreshIfCmdMode() {
  if (state.activeCmd === '/b' || state.activeCmd === '/h' || state.activeCmd === '/r') {
    search(searchValue());
    actions.render();
    if (state.filtered.length) setActive(0);
  }
}

// ---- slash 命令胶囊 ----
// 输入 /b /h 打全后,前缀从输入框"提取"为高亮胶囊(等宽字体标签);
// 输入框只留关键词部分。退格(光标在关键词最前/输入框空)删除整个胶囊
const cmdChip = document.getElementById('cmdChip');
const cmdChipText = document.getElementById('cmdChipText');
// state.activeCmd 在 core/store.state.state.activeCmd

// 完整搜索值 = 激活的命令前缀 + 输入框关键词(胶囊是视觉层,search 需要完整值)
export function searchValue() {
  return state.activeCmd ? state.activeCmd + ' ' + input.value : input.value;
}

// ⌘⌫ 逐个清理重复副本: 关闭该行副本中的一份,按一次删一份,
// 直到只剩代表(最近使用的那份)。副本按合并时的入序删(后入 = 较旧)。
// 注意: 删完后必须同步 state.allTabs 源头的 duplicates(而非 pop 局部引用)——
// search() 会从 state.allTabs 重建 state.filtered,旧引用的修改会丢,导致
// 角标不减且第二次删除时 victimId 重复(删已关的标签,静默失败)
export async function closeOneDuplicate(target) {
  if (!target || !target.duplicates || !target.duplicates.length) return;
  const victimId = target.duplicates[target.duplicates.length - 1];
  try {
    await chrome.tabs.remove(victimId);
    mediaTabIds.delete(victimId); // 探测缓存同步清理,防幽灵按钮
    // 从 state.allTabs 源头移除该副本(重建后的 state.filtered 才能拿到正确状态)
    const src = state.allTabs.find(x => x.tab.url === target.tab.url);
    if (src && src.duplicates) {
      src.duplicates = src.duplicates.filter(id => id !== victimId);
    }
    search(searchValue());
    actions.render();
    // render 的自动焦点恢复在 async 路径上不可靠(捕获时机早于 DOM 重建),
    // 显式把焦点设回代表行(行还在,代表未删),支持连续 ⌘⌫
    const row = rowByTabId(target.tab.id);
    if (row) {
      clearActiveUnit();
      row.classList.add('active');
      state.activeIndex = indexOfRow(row);
    }
    const remaining = (src?.duplicates?.length ?? target.duplicates.length - 1) + 1;
    showToast(`已关闭一份副本,剩余 ${remaining} 份`);
  } catch (e) {
    console.error('关闭副本失败:', e);
  }
}

// 复位命令态(main 的 locateCurrentTab/ESC 分支共用): 清 activeCmd + 藏胶囊
export function resetCmd() {
  state.activeCmd = null;
  cmdChip.style.display = 'none';
}

export function syncCmdChip() {
  // 状态机: 胶囊未激活时,检测输入是否以 /b /h 开头(可激活);
  // 已激活后 input.value 只存纯关键词,不再重新检测(否则剥掉前缀后
  // 下次 input 事件匹配不到命令,胶囊会误消失)
  if (!state.activeCmd) {
    const m = input.value.match(/^(\/[bhr])\s?/);
    if (m) {
      state.activeCmd = m[1];
      const kw = input.value.replace(/^\/[bhr]\s?/, '');
      input.value = kw; // 剥掉前缀只留关键词
    }
  }
  // 渲染胶囊 + 数据源按钮高亮
  if (state.activeCmd) {
    cmdChipText.textContent = state.activeCmd;
    cmdChip.style.display = 'inline-flex';
  } else {
    cmdChip.style.display = 'none';
  }
  syncSrcButtons();
}
// 胶囊上的 × 点击移除
cmdChip.querySelector('.cmd-chip-x').addEventListener('click', () => {
  state.activeCmd = null;
  cmdChip.style.display = 'none';
  input.value = '';
  input.dispatchEvent(new Event('input'));
});

// ---- 数据源按钮: 点击 = 激活/取消对应命令(等价输入 /b /h) ----
const bmBtn = document.getElementById('bmBtn');
const histBtn = document.getElementById('histBtn');
export function setCmd(cmd) {
  // toggle 语义: 再点同一个取消;点另一个切换
  state.activeCmd = (state.activeCmd === cmd) ? null : cmd;
  cmdChipText.textContent = state.activeCmd || '';
  cmdChip.style.display = state.activeCmd ? 'inline-flex' : 'none';
  syncSrcButtons();
  input.value = ''; // 切换数据源时清空关键词,从头搜
  input.focus();
  input.dispatchEvent(new Event('input'));
}
bmBtn.addEventListener('click', () => setCmd('/b'));
histBtn.addEventListener('click', () => setCmd('/h'));
// 按钮高亮与 state.activeCmd 同步(在 syncCmdChip 渲染胶囊处一并维护)
export function syncSrcButtons() {
  bmBtn.classList.toggle('active', state.activeCmd === '/b');
  histBtn.classList.toggle('active', state.activeCmd === '/h');
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
    state.activeIndex = -1;
    const wasSearching = state.searching;
    // 搜索态判定: 命令胶囊激活时即使关键词空也算搜索态(显示命令结果)
    state.searching = input.value.trim().length > 0 || state.activeCmd !== null;
    // 开始一次新搜索(从空查询进入)时,搜索模式的分组全部重置为展开
    // 开始新搜索时重置为全展开: 原地清空而非重赋新 Set——
    // searchCollapsed 是 store 共享容器,重赋值会断开引用且 import 绑定不允许
    if (state.searching && !wasSearching) searchCollapsed.clear();
    // 命令模式触发对应数据源的按需加载(书签/历史,弹窗存活期内缓存)
    if (state.activeCmd === '/b') loadBookmarks().then(refreshIfCmdMode);
    else if (state.activeCmd === '/h') loadHistory().then(refreshIfCmdMode);
    else if (state.activeCmd === '/r') loadClosed().then(refreshIfCmdMode);
    // search() 需要完整值(含前缀)判定命令模式——胶囊只是视觉层
    search(state.activeCmd ? state.activeCmd + ' ' + input.value : input.value);
    actions.render();
    // 空查询时光标落在当前激活标签(打开弹窗最常见意图:回到刚离开的 tab)
    // 搜索时落在第一条结果
    if (state.filtered.length) {
      if (state.searching) setActive(0);
      else focusCurrentTab();
    }
  }, 30);
});

// 退格整删胶囊: 光标在起点(或空输入)按 Backspace,清除整个命令而非逐字
input.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' && state.activeCmd
    && (input.value === '' || input.selectionStart === 0 && input.selectionEnd === 0)) {
    e.preventDefault();
    state.activeCmd = null;
    cmdChip.style.display = 'none';
    input.value = '';
    input.dispatchEvent(new Event('input'));
  }
});
