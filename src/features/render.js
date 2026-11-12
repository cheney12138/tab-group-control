// features/render.js: 列表渲染与行动作(组件)
// render() 全量重绘 + 分组头/标签行构建 + closeTab/switchTo/copyTabUrl。
// 单向依赖: → search(刷新 filtered) / nav(光标) / settings(归档) / dnd(拖拽) /
// media(媒体按钮) / undo(撤销) / core 各层;不依赖 main。
import { escapeHtml, relativeTime, timeTier, displayUrl, hostOf, isBadTitle, cleanTitle, getChromeFaviconUrl, groupKey, distinguishingLabels } from '../core/format.js';
import { groupOrderKey, arrangeGroupKeys, noteGroupOrder } from '../core/group-order.js';
import { textToPinyin, fuzzyMatch, markText, matchField } from '../core/pinyin.js';
import { resultsEl, input, showToast, rowByTabId, indexOfRow } from '../core/dom.js';
import { buildInkBleedSvg, themeAssets } from '../core/colors.js';
import { state, collapsed, searchCollapsed, saveCollapsed, activeCollapsed, mediaTabIds, tabItemByTabId } from '../core/store.js';
import { MOD, DEBUG } from '../core/platform.js';
import { search, searchValue } from './search.js';
import { setActive, navUnits, scrollPastSticky, clearActiveUnit } from './nav.js';
import { buildMediaControls } from './media.js';
import { showUndo } from './undo.js';
import { archiveGroupAction } from './settings.js';
import { moveTabToGroupAction, beginTabDrag, finishTabDrag } from './dnd.js';
import { openTabMenu, openGroupMenu, closeContextMenu } from './contextmenu.js';
import { collapseRows, collapseHeaders, vanishingHeaders } from './row-anim.js';
import { syncMultiSelectionUI, toggleMultiSelection } from './multi-select.js';

let actions = null; // initRender 注入: { refreshData, getSettings }
export function initRender(injected) {
  actions = injected;
  initTitleTooltip();
}

// ---- 标题超长省略时的 Hover 浮层提示 ----
let titleHoverTimer = null;
let activeTitleTooltip = null;

export function hideTitleTooltip() {
  if (titleHoverTimer) {
    clearTimeout(titleHoverTimer);
    titleHoverTimer = null;
  }
  if (activeTitleTooltip) {
    activeTitleTooltip.remove();
    activeTitleTooltip = null;
  }
}

// text 由调用方决定:标题行给完整标题,URL 行给完整 URL
function showTitleTooltip(targetEl, text) {
  hideTitleTooltip();
  const tip = document.createElement('div');
  tip.className = 'tab-title-tooltip';
  tip.textContent = text;
  document.body.appendChild(tip);
  activeTitleTooltip = tip;

  const rect = targetEl.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();

  let left = rect.left;
  if (left + tipRect.width > window.innerWidth - 10) {
    left = window.innerWidth - tipRect.width - 10;
  }
  if (left < 10) left = 10;

  // 优先在标题正上方，若距顶不足则放在正下方
  let top = rect.top - tipRect.height - 6;
  if (top < 6) {
    top = rect.bottom + 6;
  }

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  requestAnimationFrame(() => tip.classList.add('visible'));
}

function initTitleTooltip() {
  resultsEl.addEventListener('pointerover', (e) => {
    // 提示对象:标题行(完整标题)**与 URL 行(完整 URL)**。
    // 用户口径(2026-09-19):「把那个 hover 的对象改一下,展示完整 URL 好了」——
    // URL 行几乎总是被省略的,而完整 URL 恰是撞车行最需要看的东西(列表里那行只放差异片段 + 业务标识)。
    const el = e.target.closest('.tab-item .title, .tab-item .url');
    if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;

    hideTitleTooltip();
    // 仅当文字**实际发生溢出省略**时才提示(没被截断就别打扰)
    if (el.scrollWidth <= el.clientWidth) return;
    const fullText = el.dataset.fullTitle || el.dataset.fullUrl;
    if (!fullText) return;

    titleHoverTimer = setTimeout(() => {
      showTitleTooltip(el, fullText);
    }, 180);
  });

  resultsEl.addEventListener('pointerout', (e) => {
    const el = e.target.closest('.tab-item .title, .tab-item .url');
    if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hideTitleTooltip();
  });

  resultsEl.addEventListener('scroll', hideTitleTooltip, { passive: true });
  window.addEventListener('blur', hideTitleTooltip);
  document.addEventListener('keydown', hideTitleTooltip);
}

// 把 Chrome 内部窗口 id 映射为从 1 开始的序号,比裸 id 可读
function windowOrdinal(windowId) {
  const idx = state.windowIds.indexOf(windowId);
  return idx === -1 ? windowId : idx + 1;
}

let staggerIdx = 0; // stagger 入场: render 内每行取号
// 入场动效只为"弹窗首次渲染"播放;之后任何重渲染(敲搜索/切分组/操作后刷新)都不播。
// 病例(本机 2026-09-18):强行动效打开后每次输入整套列表重新上浮 = 闪烁。
// 计时:最长 stagger 96ms(12 行 × 8ms) + 动画 160ms ⇒ 420ms 足够走完。
let entrancePlayed = false;
let entranceTimer = 0;
let queuedDuringEntrance = false;
let entranceSpreadMs = 0; // 级联总跨度(行延迟上限), 由浏览路径的首帧测量回填
function staggerDelay(step = 1) {
  staggerIdx += step;
  const i = Math.min(staggerIdx, 200);
  // 2026-10-14 用户口径: "顺序 1、2、3、4 那种线性的掉落…看起来帧率很高的样子" ——
  // 节拍 = 16ms = 一帧: 每行比上一行晚一帧起跳, 落差逐帧错开, 读成一条连续瀑布。
  // (此前 20ms 拍 + 组头 2 拍空隙 → 大列表压缩到 10ms/行 < 一帧, 相邻行同帧起跳,
  //  读成"一坨直接掉下来"; 组间空拍又造成"循环感"。两头一起治: 无空拍 + 一帧一行。)
  return `${i * 16}ms`;
}
// 入场收场原语: 用户一动手(↑↓ 导航)就立即结束入场。
// 病例(本机 2026-10-14, 用户报"⌘E 唤起按 ⬇️ 时 tab 闪烁, 只闪前几个就正常"):
// 420ms 入场窗口内换选中, 旧 active 行摘掉 .active 后重新命中 body.entrance 的
// row-enter —— 动画**从头重播**(backwards 先把它按回 opacity:0 再淡入)= 闪一下;
// 窗口一过没动画可重播, 所以"只闪前几个"。与敲搜索立即停入场同一语义: 用户介入, 动效让路。
// 按实际级联总长挂收场定时器: staggerIdx 在 build 完成后即总拍数。
// 必须在每个 build 出口调用(空态/搜索态/浏览态), 否则串行级联没有终点。
function scheduleEntranceEnd() {
  if (!document.body.classList.contains('entrance')) return;
  clearTimeout(entranceTimer);
  const total = entranceSpreadMs + 500 + 200; // 压缩后的级联跨度 + 单行动画(统一 0.5s) + 余量
  entranceTimer = setTimeout(() => {
    entranceTimer = 0;
    document.body.classList.remove('entrance');
    if (queuedDuringEntrance) { queuedDuringEntrance = false; render(); }
  }, total);
}

export function endEntrance(flush = false) {
  if (entranceTimer) { clearTimeout(entranceTimer); entranceTimer = 0; }
  document.body.classList.remove('entrance');
  resultsEl.classList.remove('ink-in');
  if (flush && queuedDuringEntrance) { queuedDuringEntrance = false; render(); }
}

// 空态文案按数据源区分(纯机器文案的认知成本小优化)
function emptyMessage() {
  if (state.activeCmd === '/b') return '书签里没有匹配项';
  if (state.activeCmd === '/h') return '历史里没找到这条记录';
  if (state.activeCmd === '/r') return '最近关闭里没有匹配项';
  if (state.searching) return '没有匹配的标签页,试试拼音首字母?';
  return '没有打开的标签页';
}

export function render() {
  hideTitleTooltip();
  cancelCopyBadge(); // 全量重绘扔掉节点时, 浮标的定时器要跟着走
  const t0 = performance.now();
  // 记住重渲染前的焦点,重建后尽量恢复
  const prevUnit = navUnits().find(u => u.classList.contains('active'));
  const prevTabId = prevUnit?.dataset.tabId;
  closeContextMenu(); // 列表重建后, 已打开的菜单指着旧 DOM 行
  resultsEl.innerHTML = '';
  staggerIdx = 0; // stagger 入场计数器,每行取号后递增(封顶 12 防长列表拖尾)
  if (!entrancePlayed) {
    entrancePlayed = true;
    document.body.classList.add('entrance');
    resultsEl.classList.add('ink-in'); // 容器级墨迹晕开(单层 blur, 见 popup.html)
    // 收场定时器改到 build 完成后按**实际级联总长**挂(scheduleEntranceEnd) ——
    // 组数/行数不定的串行级联, 写死窗口必然掐尾巴或白等
  } else if (document.body.classList.contains('entrance')) {
    // 2026-10-14 病例(用户报"像是整体刷新了一下, 然后做了个非常短暂的展开"):
    // 启动期追帧渲染(归组刷新的 400ms 防抖/快照追帧)落在入场窗口内, 原来直接摘
    // entrance ⇒ 动画中的行被瞬间钉到终态 = 整体刷新感, 级联被拦腰斩断。
    // 现在排队: 入场播完后一次性补渲染(内容更新不丢, 动效播完整)。
    // 打字不受此限(state.searching ⇒ 立即摘, 09-18 病例的老语义不变)。
    if (state.searching) {
      document.body.classList.remove('entrance');
    } else {
      queuedDuringEntrance = true;
      return;
    }
  }
  if (!state.filtered.length) {
    resultsEl.innerHTML = `<div class="empty">${emptyMessage()}</div>`;
    syncMultiSelectionUI(); // 列表空了, 选择集也跟着空
    scheduleEntranceEnd();
    return;
  }

  // 标题去重统计: 在渲染任何视图/搜索前全局统一计算,供 URL 展示策略使用。
  // 过滤休眠标记(💤、zzz、零宽空格等),确保休眠 tab 与正常 tab 能准确匹配出标题重复
  const titleCount = new Map();
  for (const it of state.filtered) {
    const k = cleanTitle(it.tab.title || it.tab.url);
    if (k) titleCount.set(k, (titleCount.get(k) || 0) + 1);
  }
  for (const it of state.filtered) {
    const k = cleanTitle(it.tab.title || it.tab.url);
    it.titleDup = (titleCount.get(k) || 0) > 1;
  }
  // 撞车标签:只有当 URL 行**会被显示**时才算(开关关着就"通通不显示 URL"⇒ 算了也没人看,
  // 还白花每帧的 URL 解析)。URL 行的口径见下。
  if (actions.getSettings().showUrl) {
    const dupGroups = new Map();
    for (const it of state.filtered) {
      const k = cleanTitle(it.tab.title || it.tab.url);
      if (!k) continue;
      if (!dupGroups.has(k)) dupGroups.set(k, []);
      dupGroups.get(k).push(it);
    }
    for (const group of dupGroups.values()) {
      if (group.length < 2) continue;
      const labels = distinguishingLabels(group.map(x => x.tab.url || ''));
      group.forEach((it, i) => {
        it.dupLabel = labels[i] || '';
      });
    }
  }
  // 离屏构建再一次性挂载: 逐行 append 到已挂载的容器会引发增量布局,
  // 长列表(几百行)时白白多算多次;fragment 只触发一次挂载级布局
  const frag = document.createDocumentFragment();

  // recent / current / 命令模式(/b /h): 不分组平铺。
  // 命令模式直接按数据源原序展示(历史=chrome 真实时间序,书签=书签树序),
  // 无分组头——与 chrome://history 的观感一致
  if (state.view === 'recent' || state.view === 'current' || state.activeCmd) {
    for (const item of state.filtered) {
      frag.appendChild(buildTabRow(item));
    }
    resultsEl.appendChild(frag);
    // ⚠️ 病例: 本路径早退曾经漏掉 scheduleEntranceEnd —— body.entrance 永远
    // 挂着, 窗口内的重渲染全被排队直到用户输入才冲掉
    syncMultiSelectionUI(); // 重绘扔掉所有行节点, 选择态类必须重贴
    scheduleEntranceEnd();
    return;
  }

  if (state.searching) {
    // 搜索模式: 先按分组聚合再渲染,每个分组只出现一个头。
    // 排序把同组条目打散在列表各处时,若按"连续出现"切段会导致同一组
    // 出现多个分组头(结果看起来重复),故先聚合:
    //   组间顺序 = 该组内最佳匹配的排名; 组内顺序 = 匹配排序
    const sections = new Map(); // groupKey -> { group, items }
    for (const item of state.filtered) {
      const key = groupKey(item.group);
      if (!sections.has(key)) sections.set(key, { group: item.group, items: [] });
      sections.get(key).items.push(item);
    }
    // Map 迭代序 = 首次插入序 = state.filtered 的排序序(组内最佳排名靠前的组先出现)
    const maxCount = Math.max(...[...sections.values()].map(s => s.items.length));
    for (const { group, items } of sections.values()) {
      const key = groupKey(group);
      const isCollapsed = searchCollapsed.has(key);
      frag.appendChild(buildGroupHeader(group, items.length, isCollapsed, () => {
        if (searchCollapsed.has(key)) searchCollapsed.delete(key);
        else searchCollapsed.add(key);
        render();
      }, maxCount, null)); // 搜索态未分组分区跨窗口合并 ⇒ 回落到当前窗口
      if (!isCollapsed) {
        for (const item of items) {
          const row = buildTabRow(item);
          row.classList.add('nested'); // 树状: 子项缩进在分组头下
          frag.appendChild(row);
        }
      }
    }
    resultsEl.appendChild(frag);
    restoreFocus(prevTabId);
    if (DEBUG) console.log(`[TGS] render(搜索) 耗时: ${(performance.now() - t0).toFixed(1)}ms, 行数: ${state.filtered.length}`);
    syncMultiSelectionUI();
    scheduleEntranceEnd();
    return;
  }

  // 浏览模式: 按 (窗口, 分组) 分区,保持最近使用顺序
  let sections = [];
  const sectionIndex = new Map(); // key -> section
  for (const item of state.filtered) {
    const t = item.tab;
    const key = `${t.windowId}:${item.group ? item.group.id : -1}:${item.group ? item.group.windowId : ''}`;
    if (!sectionIndex.has(key)) {
      const section = { group: item.group, windowId: t.windowId, items: [] };
      sectionIndex.set(key, section);
      sections.push(section);
    }
    sectionIndex.get(key).items.push(item);
  }

  // 2026-10-14 用户口径: "当前停留的 tab 的素材分组没有排在第一位, 而是排在
  // 最后一位了"(重启+换机后)。病根: 恢复的 tab lastAccessed 全部近似相等,
  // 分区序(依赖 filtered 序)退化成任意序。确定钉顶: 含当前窗口活动 tab 的
  // 分区恒排第一, 不依赖 lastAccessed。
  const curIdx = sections.findIndex(s2 =>
    s2.items.some(it => it.tab.active && it.tab.windowId === state.currentWindowId));
  if (curIdx > 0) sections.unshift(sections.splice(curIdx, 1)[0]);

  // 分区序的最终裁决: 记账本(core/group-order.js)优先, 数据序只在某个分区**首次出现**
  // 时决定它插在哪。上面那条"当前组钉顶"因此只在首帧播种时起作用 —— 否则关掉激活标签
  // 后 Chrome 换了激活标签, 整个列表会当场重排(这正是"批量关闭后跳到别处"的一半病根)。
  // 另一半病根在时间戳上: 某组最新标签被关 ⇒ 该组 lastAccessed 降级 ⇒ 掉到后面;
  // 记账本两个都治: 剩下能看见的组不换位, 被清空的组留座 12s 等撤销回来。
  // 身份键撞车(同窗口允许有两个同名同色的组)时第二个起加序号 —— 不然 Map 会把一个
  // 分区整块吞掉, 那一组的标签直接从列表里消失。
  const keyOf = [];
  const usedKeys = new Map();
  for (const s of sections) {
    const base = groupOrderKey(s.windowId, s.group);
    const n = (usedKeys.get(base) || 0) + 1;
    usedKeys.set(base, n);
    keyOf.push(n === 1 ? base : `${base}#${n}`);
  }
  const byKey = new Map(sections.map((s, i) => [keyOf[i], s]));
  const orderedKeys = arrangeGroupKeys(keyOf);
  sections = orderedKeys.map(k => byKey.get(k));
  noteGroupOrder(orderedKeys);

  // 同窗同名分组 = 异常态(docs/group-uniqueness.md)。Chrome 允许同窗口并存同名组,
  // 没有删组 API, 只能靠 tidy 兜底合并 —— 兜底没跑成(worker 休眠 / 建组竞态)时就
  // 老老实实摆在列表里, 而两个同名组头看起来**一模一样**。给它们挂一个 dup 标记 +
  // 右键“合并同名分组”, 让异常看得见、也能一键收掉。
  // 判定只看 **窗口 + 组名**: 颜色不同也算重复(tidy / merge 都只按名字合), 而
  // 跨窗口同名完全合法(每个窗口各有一个「工作」很正常), 一根都不标。
  const sameTitle = new Map();
  for (const section of sections) {
    const title = section.group?.title;
    if (!title) continue; // 未分组不是组, 没有“名字”
    const k = `${section.windowId}|${title}`;
    sameTitle.set(k, (sameTitle.get(k) || 0) + 1);
  }
  const isDupGroup = (group, windowId) =>
    !!group?.title && (sameTitle.get(`${windowId}|${group.title}`) || 0) > 1;

  // 分区只包含 state.filtered 里实际有标签的分组: 组内最后一个标签被关掉后,
  // 该组不会出现在 sections,分组头自然消失
  const maxCount = sections.reduce((m, s) => Math.max(m, s.items.length), 0);
  sections.forEach(section => {
    // 组内排序: 严格按最近使用时间倒排(相对时间显示为升序: 4小时 -> 7小时 -> 9小时)
    section.items.sort((a, b) => (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0) ||
                                  Number(!!b.tab.active) - Number(!!a.tab.active)); // 平局时活动 tab 领先
    const key = groupKey(section.group);
    // 搜索模式下强制全部展开,只有空查询浏览时才应用收起状态
    const isCollapsed = collapsed.has(key);
    const isDup = isDupGroup(section.group, section.windowId);
    frag.appendChild(buildGroupHeader(section.group, section.items.length, isCollapsed, () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      saveCollapsed();
      render();
    }, maxCount, section.windowId, isDup)); // 未分组分区必须带上自己的窗口, 否则会关错窗口

    if (!isCollapsed) {
      section.items.forEach(item => {
        const row = buildTabRow(item);
        row.classList.add('nested'); // 树状: 子项缩进在分组头下
        frag.appendChild(row);
      });
    }
  });
  resultsEl.appendChild(frag);
  if (document.body.classList.contains('entrance')) {
    // 级联总跨度封顶 800ms, 等比压缩行延迟(顺序不变, 节拍变密) ——
    // 病例: "稀稀拉拉一直在往下掉, 形成一个循环"(大列表级联拖到 2s+)。
    // (row-settle 原位晕开, 不再需要 --drop-y 绳距测量)
    const entranceRows = [];
    for (const el of resultsEl.children) {
      if (el.classList.contains('tab-item')) {
        entranceRows.push(el);
      }
    }
    const delays = entranceRows.map(r => parseFloat(r.style.animationDelay) || 0);
    const maxDelay = Math.max(0, ...delays);
    entranceSpreadMs = maxDelay;
    if (maxDelay > 650) {
      const k = 650 / maxDelay;
      entranceRows.forEach((r, i) => { r.style.animationDelay = `${Math.round(delays[i] * k)}ms`; });
      entranceSpreadMs = 650;
    }
  }
  // 清理收起记忆里已不存在的分组(组被删掉/改名后,残留的 key 会让同名的组莫名收起)
  const liveKeys = new Set(sections.map(s => groupKey(s.group)));
  const staleKeys = [...collapsed].filter(k => !liveKeys.has(k) && k !== '__ungrouped__');
  if (staleKeys.length) {
    staleKeys.forEach(k => collapsed.delete(k));
    saveCollapsed();
  }
  restoreFocus(prevTabId);
  if (DEBUG) console.log(`[TGS] render 耗时: ${(performance.now() - t0).toFixed(1)}ms, 行数: ${state.filtered.length}`);
  // 选择集对着 state.filtered 剪枝 + 重贴 .multi-selected(搜索缩小范围后
  // 不能把看不见的行留在选择里 —— 否则 ⌘⌫ 会关掉屏幕外的标签)
  syncMultiSelectionUI();
  scheduleEntranceEnd();
}

// 重渲染后恢复焦点: 优先同 tabId 的行,找不到则不聚焦
function restoreFocus(prevTabId) {
  if (!prevTabId) return;
  const units = navUnits();
  const target = units.find(u => Number(u.dataset.tabId) === Number(prevTabId));
  if (target) {
    target.classList.add('active');
    state.activeIndex = indexOfRow(target);
  }
}

// 分组头: group 为 null 表示未分组; onClick 为空时不可点击(搜索模式的分隔条)
// maxCount: 本次渲染中最大的组内条目数(迷你条形图的分母),空则不画条
// scopeWindowId: **仅未分组分区用**。未分组不是组对象, 拿不到 group.windowId,
//   而不分窗口的浏览模式会把每个窗口的未分组标签各排一个分区 —— 不把窗口传下来,
//   右键任意一个都会去关「当前窗口」那一堆(错窗口)。搜索模式未分组分区是跨窗口合并的
//   (哨兵 __ungrouped__), 传 null ⇒ 回落到 state.currentWindowId。
// isDup: 本分区属于“同窗口存在同名分组”的异常态(见 render 的 sameTitle)。
//   只在组头挂个小徽章 + 告诉右键菜单“可以合并”, 不改任何数据 —— 收场由
//   background 的 merge-dup-groups 做, 渲染层不碰 chrome.tabGroups。
function buildGroupHeader(group, count, isCollapsed, onClick, maxCount, scopeWindowId = null, isDup = false) {
  const header = document.createElement('div');
  header.className = 'group-header' + (isCollapsed ? ' collapsed' : '');
  // 组头本身不入场(锚定, 见 popup.html), 但它仍是"一次展开"的节拍边界:
  // 在这里多走两拍不加延迟, 组与组之间留出呼吸, 组内行紧跟着连续入场
  // ⇒ 每组读成"箭头刚展开, tab 向下露出", 而不是全列表一锅粥地浮现
  // 组头不吃节拍(2026-10-14: 组间空拍读成"循环感"; 行序本身就保持分组顺序)
  header.dataset.groupKey = groupKey(group);
  const assets = themeAssets();
  const groupColor = assets.groupColors[(group && group.color) || 'grey'] || assets.groupColors.grey;
  header.style.setProperty('--group-c', groupColor);

  // 1. 分组竖线: 统一挪到展开/收起箭头的前面 (两主题均生效)
  const dot = document.createElement('span');
  dot.className = 'group-dot';
  dot.style.background = groupColor;
  header.appendChild(dot);

  // 2. 展开/收起箭头
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.innerHTML = '<svg viewBox="0 0 12 12"><path d="M1 3.5l5 5 5-5"/></svg>';
  header.appendChild(caret);

  // 3. 分组名称
  const name = document.createElement('span');
  name.className = 'group-title';
  if (group) {
    // 搜索时分组名也参与高亮,直观看到是分组名命中的召回
    const q = input.value.trim();
    const hits = q ? (matchField(q, group.title || '')?.hits || fuzzyMatch(q, group.title || '')) : null;
    name.innerHTML = hits
      ? markText(group.title || '(未命名分组)', hits)
      : escapeHtml(group.title || '(未命名分组)');
  } else {
    name.textContent = '未分组';
  }
  header.appendChild(name);
  if (isDup) {
    // 异常态徽章: 两个同名组头否则长得完全一样, 用户根本没线索知道这是异常。
    // 文案用“重名”而不是“重复” —— 重复在本面板里指的是重复标签(amber 徽章)。
    const dupBadge = document.createElement('span');
    dupBadge.className = 'group-dup';
    dupBadge.textContent = '重名';
    dupBadge.title = '同窗口存在同名分组, 右键可合并';
    dupBadge.setAttribute('aria-label', dupBadge.title);
    header.appendChild(dupBadge);
    header.dataset.dup = '1';
  }
  if (count != null) {
    // 迷你条形图: 长度∝组内标签数/最大组,不读数字扫一眼知轻重
    if (maxCount > 1) {
      const bar = document.createElement('span');
      bar.className = 'group-bar';
      bar.style.width = `${Math.max(10, Math.round(count / maxCount * 40))}px`;
      bar.style.background = groupColor;
      bar.style.opacity = '0.55';
      bar.title = `${count} 个标签`;
      header.appendChild(bar);
    }
    if (group && count > 0) {
      const archiveBtn = document.createElement('button');
      archiveBtn.className = 'btn-archive-group';
      archiveBtn.title = `归档「${group.title || '此分组'}」并关闭标签`;
      archiveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 L6 3 H18 L21 11 V20 C21 20.6 20.6 21 20 21 H4 C3.4 21 3 20.6 3 20 Z"/><path d="M3 11 H8.5 L9.5 14 H14.5 L15.5 11 H21"/><line x1="8.5" y1="5.5" x2="15.5" y2="5.5"/><line x1="8" y1="8" x2="16" y2="8"/></svg>';
      archiveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await archiveGroupAction(group);
      });
      header.appendChild(archiveBtn);
    }
    const countEl = document.createElement('span');
    countEl.className = 'group-count';
    countEl.textContent = count;
    if (assets.inkBlot) {
      countEl.style.setProperty('--dot-ink-bg', `url("${buildInkBleedSvg(groupColor)}")`);
    }
    header.appendChild(countEl);
  }
  // 右键菜单: 组级动作(关闭全组 / 归档)的入口。未分组分区同样吃这套(group=null),
  // 它没有组名, 只能靠“本窗口”交代作用域
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openGroupMenu(group, scopeWindowId, e.clientX, e.clientY);
  });

  if (onClick) header.addEventListener('click', () => {
    onClick();
    // 点击后浏览器会把真实焦点给到被点的元素,键盘事件就不再经过 input;
    // 立即抢回焦点,保证 ↑↓/←→/Tab 等快捷键继续工作
    input.focus();
  });

  // 拖拽落点: 分组头作为合法的 Drop 放置目标
  header.addEventListener('dragover', (e) => {
    if (!state.draggedTabInfo || state.draggedTabInfo.tabId <= 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    header.classList.add('drop-target');
  });
  header.addEventListener('dragleave', (e) => {
    if (!header.contains(e.relatedTarget)) {
      header.classList.remove('drop-target');
    }
  });
  header.addEventListener('drop', async (e) => {
    e.preventDefault();
    header.classList.remove('drop-target');
    if (!state.draggedTabInfo || state.draggedTabInfo.tabId <= 0) return;
    await moveTabToGroupAction(state.draggedTabInfo, group);
  });

  return header;
}

// favicon 首字母: 域名/标题首位;中文则取拼音首字母(大小写不敏感转大写)
function faviconLetter(t) {
  const raw = (hostOf(t.url) || t.title || '').trim();
  let first = raw[0] || '';
  if (/[一-鿿]/.test(first)) {
    const py = (typeof textToPinyin === 'function' ? textToPinyin(raw) : '').trim();
    first = py[0] || first;
  }
  return (first || '?').toUpperCase();
}

function buildFaviconEl(t, groupColor) {
  const makeLetter = () => {
    const el = document.createElement('span');
    el.className = 'unf-icon';
    el.textContent = faviconLetter(t);
    // 颜色与所在分组一致: 分组色为底、白字
    el.style.background = groupColor || 'var(--accent)';
    return el;
  };
  const primary = t.favIconUrl;
  const fb = getChromeFaviconUrl(t.url);
  
  if (!primary && !fb) {
    return makeLetter();
  }

  const img = document.createElement('img');
  img.src = primary || fb;
  let triedFb = false;
  img.onerror = () => {
    // favIconUrl 偶尔指向坏图或 403, 失败先尝试 _favicon 一次, 再失败(403/404)换成首字母徽
    if (primary && fb && !triedFb) {
      triedFb = true;
      img.src = fb;
    } else {
      img.replaceWith(makeLetter());
    }
  };
  return img;
}

function buildTabRow(item) {
  const t = item.tab;
  const row = document.createElement('div');
  // /h 历史条目加降级类: 半透明,hover/选中恢复
  row.className = 'tab-item' + (state.currentSourceIsHistory ? ' history-item' : '');
  row.style.animationDelay = staggerDelay();
  row.dataset.tabId = t.id;

  // 窗口归属(仅用于时间 tag 的"当前"判定与 URL 行强制显示,
  // 不再做行首窗口徽/组内序号——实测都是伪需求,行首留白更干净)
  const isVirtualItem = t.id < 0;
  const isOtherWindow = !isVirtualItem
    && state.currentWindowId != null && t.windowId !== state.currentWindowId;

  // 拖拽分两件事:
  //   ① 拖动本身(→ 拖到面板外新建窗口) —— 三个视图、所有真实存活 tab 都支持;
  //   ② 「落到行/组头 = 移入分组」 —— 只在 [分组] 视图成立(平铺视图根本没有分组落点)。
  const canDrag = !isVirtualItem;
  const canGroupDrop = state.view === 'grouped' && !isVirtualItem;
  if (canDrag) {
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', (e) => {
      state.draggedTabInfo = {
        tabId: t.id,
        windowId: t.windowId,
        sourceGroupId: t.groupId && t.groupId !== -1 ? t.groupId : null,
        url: t.url || '', // 落进规则组时要把这个域名并进该组规则
        title: t.title || t.url || '标签页'
      };
      e.dataTransfer.effectAllowed = 'move';
      // 自定义 MIME: 不用 text/plain —— 否则拖到面板外落到网页输入框时会把标签 id 当文字粘进去
      e.dataTransfer.setData('application/x-tgs-tab', String(t.id));
      beginTabDrag(); // 重置"离开窗口/内部落点"信号
      requestAnimationFrame(() => row.classList.add('dragging'));
    });
    row.addEventListener('dragend', async (e) => {
      row.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      const info = state.draggedTabInfo; // finishTabDrag 需要它, 要在清空前交出
      state.draggedTabInfo = null;
      await finishTabDrag(info, e); // 兜底: 面板正常存活时的拖出判定(主路径在 dnd 的 dragleave)
    });
    // 拖拽落点: 目标组内的条目也可作为放置目标 —— 仅分组视图(平铺视图里拖拽只为拖出面板)
    if (canGroupDrop) {
      row.addEventListener('dragover', (e) => {
        if (!state.draggedTabInfo || state.draggedTabInfo.tabId <= 0 || state.draggedTabInfo.tabId === t.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', (e) => {
        if (!row.contains(e.relatedTarget)) {
          row.classList.remove('drop-target');
        }
      });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        if (!state.draggedTabInfo || state.draggedTabInfo.tabId <= 0 || state.draggedTabInfo.tabId === t.id) return;
        await moveTabToGroupAction(state.draggedTabInfo, item.group);
      });
    }
  }

  // favicon + 重复合并角标: 同 URL 多份时 favicon 右上角迷你数字徽(深底白字,
  // 11px 圆点),份数一眼可读;无副本时裸图标
  const iconWrap = document.createElement('span');
  iconWrap.className = 'icon-wrap';
  // 无图标时首字母徽颜色随所在分组
  const groupColor = item.group ? (themeAssets().groupColors[item.group.color] || themeAssets().groupColors.grey) : 'var(--accent)';
  iconWrap.appendChild(buildFaviconEl(t, groupColor));
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
  // 休眠标题前缀(休眠工具/系统往原始标题塞的 💤): 剥离正文并降权为小角标,
  // 搜索高亮偏移随剥离长度前移,避免 emoji 在 13px 字号下挤成噪点
  const rawTitle = t.title || t.url || '';
  title.dataset.fullTitle = rawTitle;
  const sleepPrefix = rawTitle.match(/^[\s\u200B-\u200D\uFEFF]*(?:\u{1F4A4}[\s\u200B-\u200D\uFEFF]*)+/u);
  // 撞车行**标题不动**(用户口径 2026-09-19:「不能直接替换 tab 的名称」):
  // 标题是"这是哪一类页面"的锚点,而且这些平台共用同一个 logo ⇒ 标题再换掉就彻底没锚点了。
  // 区分职责全部交给下面那行 URL(.url.dup)。
  if (sleepPrefix) {
    const off = sleepPrefix[0].length;
    const body = rawTitle.slice(off);
    title.innerHTML = '<span class="sleep-mark" title="标签页已休眠">💤</span>'
      + (body ? markText(body, item.titleHits && item.titleHits.map(i => i - off).filter(i => i >= 0)) : escapeHtml(rawTitle));
  } else {
    title.innerHTML = markText(rawTitle, item.titleHits);
  }
  info.appendChild(title);
  // URL 行:**完全**遵循用户设置(settings.showUrl)。
  // 用户口径(2026-09-19):「如果这个开关是关的,不管什么场景下通通不显示 URL」。
  // 撞车**不是**例外(之前写成 `showUrl || item.dupLabel` 是越权:开关关了还冒出来一行)。
  // 开关打开时,撞车行的文本用"类型 · 服务名"(见 format.distinguishingLabels)替代冗长 URL。
  if (actions.getSettings().showUrl) {
    const url = document.createElement('div');
    url.className = item.dupLabel ? 'url dup' : 'url';
    url.dataset.fullUrl = t.url;   // hover 时展示完整 URL(见 initTitleTooltip)
    if (item.dupLabel) {
      // 标签本身就是"类型 · 服务名"(identityOf 已在里面)⇒ 不再另拼一段身份,否则会重复两遍
      url.innerHTML = `<span class="dup-delta">${escapeHtml(item.dupLabel)}</span>`;
    } else {
      // ① 搜索命中 URL 或 ② 标题重复 ⇒ 完整 URL,其余只给域名
      const showFull = item.urlHits || item.titleDup;
      const shownUrl = showFull ? displayUrl(t.url) : hostOf(t.url);
      // URL 兜底匹配发生在完整 URL 上,但展示的是 host+path,需在展示文本上重算高亮
      const urlHits = item.urlHits
        ? (fuzzyMatch(input.value.trim(), shownUrl) || item.urlHits)
        : null;
      url.innerHTML = markText(shownUrl, urlHits);
    }
    info.appendChild(url);
  }

  row.appendChild(info);

  // 蒙层式媒体控制: audible 管第一帧(探测未返回前即时可用),
  // 探测结果(mediaTabIds)管暂停中的——有 MediaSession 即有恢复入口。
  // buildMediaControls 是模块函数,探测消息异步回调補按钮也要用
  if (t.audible && t.id > 0) mediaTabIds.add(t.id); // 曾播放即记入,暂停/重渲染后仍保留媒体控件
  if ((t.audible || mediaTabIds.has(t.id)) && t.id > 0) {
    row.classList.add('has-media');
    const mediaBtn = buildMediaControls(t);
    mediaBtn.className = 'media-overlay';
    row.appendChild(mediaBtn);
  }

  // 音浪状态指示: 时间戳左侧。
  // 播放时错峰起伏,暂停时静止低位变淡,只对媒体 tab 展示
  if ((t.audible || mediaTabIds.has(t.id)) && t.id > 0) {
    const wave = document.createElement('div');
    wave.className = 'wave-icon ' + (t.audible ? 'is-playing' : 'is-paused');
    wave.innerHTML = '<span></span><span></span><span></span>';
    row.appendChild(wave);
  }

  // 最近使用时间 tag 五档: 当前 > 热门(10分钟,绿) > 今日(蓝) / 近期(灰) > 僵尸(橙/红)
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
  closeBtn.title = `关闭标签页 (${MOD}Backspace)`;
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(t.id);
    // 关闭是 button,点击会拿走键盘焦点,抢回 input 保证快捷键继续工作
    input.focus();
  });
  // 虚拟条目(书签/历史/最近关闭, 负 id)没有关闭语义(与右键菜单同口径),
  // 不挂关闭按钮, 避免点了静默无效
  if (!isVirtualItem) row.appendChild(closeBtn);

  row.addEventListener('click', (e) => {
    // Shift+点击 = 勾选/取消一行(不切走标签)。选择集存代表 tabId, 见 multi-select.js
    if (e.shiftKey) {
      toggleMultiSelection(t.id);
      input.focus(); // 点击会把焦点带到行上, 抢回搜索框保证 ⌘⌫ / Esc 继续可用
      return;
    }
    switchTo(t);
  });

  // 右键菜单: 虚拟条目(书签/历史, 负 id)不是真实标签, 没有关闭语义
  if (!isVirtualItem) {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTabMenu(t.id, e.clientX, e.clientY);
    });
  }
  return row;
}

// 行所属分组(含未分组区)的键;重渲染前查,state.filtered 里没了就返回 null
function rowGroupKey(tabId) {
  const f = state.filtered.find(x => x.tab.id === tabId);
  return f ? groupKey(f.group) : null;
}
// 被关闭行的同组邻居: [组内后继, 组内前驱]。渲染时同组的行必然相邻,
// 所以直接看左右两行的组键是否一致即可,不必回溯分组头。
function groupNeighbours(rows, idx) {
  if (idx < 0) return [null, null];
  const key = rowGroupKey(Number(rows[idx].dataset.tabId));
  if (key == null) return [null, null];
  const twin = r => rowGroupKey(Number(r.dataset.tabId)) === key;
  const next = rows[idx + 1], prev = rows[idx - 1];
  return [next && twin(next) ? Number(next.dataset.tabId) : null,
          prev && twin(prev) ? Number(prev.dataset.tabId) : null];
}

// 收起期间把光标挪到还活着的邻居行。正在收起的行只是"还没演完的残影",
// 不能停光标 —— 连按 ⌘⌫ 落在它身上就是吞键。
// 顺序: 晋升行 → 组内后继 → 组内前驱 → **本组还活着的最近行** → 下方最近活行 → 上方最近活行。
// 第四档(2026-11-12 病例之四): 组内删到边界时, 紧邻的 succ/pred 可能恰好都在收起
// (连删场景), 兜底直接向后找会跳出本组落到下一分组 —— 组明明还剩着行, 光标不该离组。
// closedKey 必须在 tabs.remove 之前算好传进来: focusWhileClosing 运行时那条
// 已从 state.filtered 移除, 现算组键拿不到。
function focusWhileClosing(rowIdx, promotedTabId, succId, predId, closedKey) {
  const rows = [...resultsEl.querySelectorAll('.tab-item')];
  const live = r => !r.classList.contains('closing');
  const idxOf = id => id == null ? -1
    : rows.findIndex(r => Number(r.dataset.tabId) === id && live(r));
  let target = idxOf(promotedTabId);
  if (target < 0) target = idxOf(succId);
  if (target < 0) target = idxOf(predId);
  if (target < 0 && closedKey != null) {
    // 本组还活着的最近行(双向, 离被删行最近者优先; 等距取先出现的)
    let best = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!live(rows[i])) continue;
      if (rowGroupKey(Number(rows[i].dataset.tabId)) !== closedKey) continue;
      if (best < 0 || Math.abs(i - rowIdx) < Math.abs(best - rowIdx)) best = i;
    }
    target = best;
  }
  if (target < 0) target = rows.findIndex((r, i) => i >= rowIdx && live(r));
  if (target < 0) target = rows.map(live).lastIndexOf(true);
  if (target < 0) {
    clearActiveUnit();
    state.activeIndex = -1;
    return;
  }
  setActive(target);
}

// 关闭标签页并从列表中移除该行,焦点迁移到相邻行; 底部提供限时撤销
export async function closeTab(tabId) {
  // 防线: 虚拟条目(书签/历史/最近关闭, 负 id)没有关闭语义;
  // 非整数(重渲染竞态下 dataset 解析出 NaN)也直接忽略,
  // 否则 tabs.remove 参数校验直接扡 "Value did not match any choice"
  if (!Number.isInteger(tabId) || tabId <= 0) {
    console.warn('[TGS] closeTab: 非法 tabId, 已忽略:', tabId);
    return;
  }
  const rows = [...resultsEl.querySelectorAll('.tab-item')];
  const rowIdx = rows.findIndex(r => Number(r.dataset.tabId) === tabId);
  const row = rowIdx >= 0 ? rows[rowIdx] : null; // 要收起的那一行(可能不在当前视图里)
  const closed = state.filtered.find(f => f.tab.id === tabId);
  const closedKey = row ? rowGroupKey(tabId) : null; // remove 前算好: 组内兜底要用
  const [succId, predId] = groupNeighbours(rows, rowIdx);
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.error('关闭标签失败:', err);
    return;
  }
  // 同步本地数据
  mediaTabIds.delete(tabId);
  // 关的是重复合并行的代表且还有副本: 晋升一份副本为新代表,行保留。
  // 整项丢弃的话,存活的副本会从列表消失,1s 复核时又把整行"复活"
  // (带它自己的媒体按钮)——看起来像刚关的标签带着按钮回来了
  const item = tabItemByTabId(tabId);
  const survivors = (item?.duplicates || []).filter(id => id !== tabId);
  let promotedTabId = null;
  if (item && survivors.length) {
    try {
      const promoted = await chrome.tabs.get(survivors[0]); // 副本中最新的一份
      item.tab = promoted;
      item.duplicates = survivors.filter(id => id !== promoted.id);
      promotedTabId = promoted.id;
    } catch (e) {
      state.allTabs = state.allTabs.filter(x => x.tab.id !== tabId);
    }
  } else if (item) {
    state.allTabs = state.allTabs.filter(x => x.tab.id !== tabId);
  }
  search(searchValue()); // 从 state.allTabs 重建 state.filtered(晋升/移除都生效)

  // 行要整条退场才演收起; 晋升副本时行留在原地(只换了代表), 不能收。
  // 注意 remove 已经在上面落地(弹窗被点外面关掉也不会漏关), 动画只决定
  // 节点何时退场 —— 绝不能把关闭动作押在动画后面。
  const willVanish = !!row && !promotedTabId;
  const anim = willVanish ? collapseRows([row]) : Promise.resolve();
  // 这是组里最后一行时, 分组头也一起收 —— 否则行收完后头要等到重渲染才
  // 突然消失, 读成"愣了一拍才没"。头比行晚 70ms 起步, Promise.all 等两边都演完
  const headerAnim = willVanish ? collapseHeaders(vanishingHeaders([row])) : Promise.resolve();
  // 焦点在收起开始前就离开这一行(跳过 .closing), 连按 ⌘⌫ 每下都落到新行
  if (willVanish) focusWhileClosing(rowIdx, promotedTabId, succId, predId, closedKey);
  await Promise.all([anim, headerAnim]); // 收起演完(减弱动态效果时立即 resolve)才重绘
  // 就地重渲染,并让焦点落到被关闭行的相邻行
  render();
  const newRows = [...resultsEl.querySelectorAll('.tab-item')];
  if (newRows.length) {
    // id 统一走 Number(): ghostId 来自 dataset(字符串), succ/pred 是数字,
    // 严格 === 混用会静默失配(2026-11-12 病例之三: ghost 永远不命中, 落到过期的 pred)
    const idxOf = id => id == null ? -1
      : newRows.findIndex(r => Number(r.dataset.tabId) === Number(id));
    // 顺序即优先级: 合并行原地换代表→跟着它走; 否则**保持在光标当前所在的那行**
    // (ghost —— 收起期间 focusWhileClosing 已落位, 连删时后一趟的落点就是最新状态);
    // 只有 ghost 也不在了(它自己也被删)才重算本趟的后继/前驱。
    // 兜底不能用重绘前的旧索引: 整组清空时组头+行一起退场, 后面的行全部上移,
    // 同一个数字现在指向另一行 —— 光标会"没操作自己下移一格"(2026-11-12 病例);
    // succ/pred 也不能排在 ghost 前面: 连删中途停一拍, 早前那趟的收尾会拿
    // 它过期的前驱把光标抢回去(先回上一个再去下一个, 2026-11-12 病例之二)
    const ghostId = document.querySelector('.tab-item.active')?.dataset.tabId;
    let target = idxOf(promotedTabId);
    if (target < 0) target = idxOf(ghostId);
    if (target < 0) target = idxOf(succId);
    if (target < 0) target = idxOf(predId);
    if (target < 0) target = Math.min(rowIdx >= 0 ? rowIdx : 0, newRows.length - 1);
    setActive(target);
  } else {
    resultsEl.innerHTML = `<div class="empty">${emptyMessage()}</div>`;
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


export async function switchTo(tab) {
  // 书签/历史条目(id 为负): 新开标签页,而非切换已有标签
  if (tab.id < 0) {
    await chrome.tabs.create({ url: tab.url, active: true });
    window.close();
    return;
  }
  // 2026-10-14 用户口径: "选中一段时间不打开的 tab, 总是空白, 需要我手动刷新一下" ——
  // 被内存节省程序/休眠插件 discard 的 tab, 仅 activate 有概率落在空白帧上
  // (休眠插件的 discard 尤其如此)。激活前显式 reload 一次, 落地就是加载中的页面。
  try {
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    if (fresh && (fresh.discarded || fresh.status === 'unloaded')) {
      await chrome.tabs.reload(tab.id);
    }
  } catch (e) { /* tab 可能刚被关闭, 走下面的 activate 自然兜底 */ }
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) { /* 标签在切换瞬间被关掉: 静默, 弹窗即将关闭 */ }
  window.close();
}


// ---- ⌘C 复制 URL 的行内浮标 ----
// 回执落在**被复制的那一行**上, 而不是底部 toast: 连续复制多个时每次回执都贴着
// 对应的行, 不用去底部对号。三套主题的样式在 popup.html(.copy-badge)。
// 状态由 render 持有: render() 开头清场, 全量重绘扔掉节点时定时器也一起走。
let copyBadgeTimer = 0;
let copyBadgeNode = null;

export function cancelCopyBadge() {
  if (copyBadgeTimer) { clearTimeout(copyBadgeTimer); copyBadgeTimer = 0; }
  if (copyBadgeNode) { copyBadgeNode.remove(); copyBadgeNode = null; }
}

function showCopyBadge(row) {
  cancelCopyBadge();
  const badge = document.createElement('span');
  badge.className = 'copy-badge';
  // 图标用 currentColor 描边, 主题只改 stroke 色(见 popup.html)
  badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg><span>URL 已复制</span>';
  row.appendChild(badge);
  copyBadgeNode = badge;
  // 强制一次样式结算再挂 .show: 同一任务内写起点+终点没有插值(浮标会直接
  // 出现); 不用 rAF —— 弹窗页的 rAF 会被节流, 回执可能迟迟不出现
  void badge.offsetWidth;
  badge.classList.add('show');
  // 2 秒后撤 .show(220ms 淡出), 再摘节点
  copyBadgeTimer = setTimeout(() => {
    badge.classList.remove('show');
    copyBadgeTimer = setTimeout(() => {
      badge.remove();
      if (copyBadgeNode === badge) copyBadgeNode = null;
    }, 240);
  }, 2000);
}

// 复制 tab 的 URL 到剪贴板。浮标只出现在**选中行**上: 没有选中行 = 用户没指定
// 复制对象, 直接不响应(键也不吞 —— 把 ⌘C 还给浏览器原生复制, 见 main.js)
export async function copyTabUrl(tab) {
  const url = tab.url || '';
  const row = rowByTabId(tab.id);
  if (!row || !row.classList.contains('active')) return;
  try {
    await navigator.clipboard.writeText(url);
    showCopyBadge(row);
  } catch (err) {
    // 失败必须吵, 且不该挂在某一行上
    console.error('复制失败:', err);
    showToast('复制失败,请重试');
  }
}
