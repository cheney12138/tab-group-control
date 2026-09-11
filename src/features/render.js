// features/render.js: 列表渲染与行动作(组件)
// render() 全量重绘 + 分组头/标签行构建 + closeTab/switchTo/copyTabUrl。
// 单向依赖: → search(刷新 filtered) / nav(光标) / settings(归档) / dnd(拖拽) /
// media(媒体按钮) / undo(撤销) / core 各层;不依赖 main。
import { escapeHtml, relativeTime, timeTier, displayUrl, hostOf, isBadTitle, cleanTitle, getChromeFaviconUrl, groupKey } from '../core/format.js';
import { textToPinyin, fuzzyMatch, markText } from '../core/pinyin.js';
import { resultsEl, input, showToast, rowByTabId, indexOfRow } from '../core/dom.js';
import { GROUP_COLORS, INK_GROUP_COLORS, buildInkBleedSvg } from '../core/colors.js';
import { state, collapsed, searchCollapsed, saveCollapsed, activeCollapsed, mediaTabIds, tabItemByTabId } from '../core/store.js';
import { MOD, DEBUG } from '../core/platform.js';
import { search, searchValue } from './search.js';
import { setActive, navUnits, scrollPastSticky } from './nav.js';
import { buildMediaControls } from './media.js';
import { showUndo } from './undo.js';
import { archiveGroupAction } from './settings.js';
import { moveTabToGroupAction } from './dnd.js';

let actions = null; // initRender 注入: { refreshData, getSettings }
export function initRender(injected) { actions = injected; }

// 把 Chrome 内部窗口 id 映射为从 1 开始的序号,比裸 id 可读
function windowOrdinal(windowId) {
  const idx = state.windowIds.indexOf(windowId);
  return idx === -1 ? windowId : idx + 1;
}

let staggerIdx = 0; // stagger 入场: render 内每行取号
function staggerDelay() {
  const i = Math.min(staggerIdx++, 12); // 封顶 12 行,后面同时入场
  return `${i * 8}ms`;
}

// 空态文案按数据源区分(纯机器文案的认知成本小优化)
function emptyMessage() {
  if (state.activeCmd === '/b') return '书签里没有匹配项';
  if (state.activeCmd === '/h') return '历史里没找到这条记录';
  if (state.searching) return '没有匹配的标签页,试试拼音首字母?';
  return '没有打开的标签页';
}

export function render() {
  const t0 = performance.now();
  // 记住重渲染前的焦点,重建后尽量恢复
  const prevUnit = navUnits().find(u => u.classList.contains('active'));
  const prevKey = prevUnit?.dataset.groupKey;
  const prevTabId = prevUnit?.dataset.tabId;
  resultsEl.innerHTML = '';
  staggerIdx = 0; // stagger 入场计数器,每行取号后递增(封顶 12 防长列表拖尾)
  if (!state.filtered.length) {
    resultsEl.innerHTML = `<div class="empty">${emptyMessage()}</div>`;
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
      }, maxCount));
      if (!isCollapsed) {
        for (const item of items) {
          const row = buildTabRow(item);
          row.classList.add('nested'); // 树状: 子项缩进在分组头下
          frag.appendChild(row);
        }
      }
    }
    resultsEl.appendChild(frag);
    restoreFocus(prevKey, prevTabId);
    if (DEBUG) console.log(`[TGS] render(搜索) 耗时: ${(performance.now() - t0).toFixed(1)}ms, 行数: ${state.filtered.length}`);
    return;
  }

  // 浏览模式: 按 (窗口, 分组) 分区,保持最近使用顺序
  const sections = [];
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

  // 分区只包含 state.filtered 里实际有标签的分组: 组内最后一个标签被关掉后,
  // 该组不会出现在 sections,分组头自然消失
  const maxCount = sections.reduce((m, s) => Math.max(m, s.items.length), 0);
  sections.forEach(section => {
    // 组内排序: 严格按最近使用时间倒排(相对时间显示为升序: 4小时 -> 7小时 -> 9小时)
    section.items.sort((a, b) => (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0));
    const key = groupKey(section.group);
    // 搜索模式下强制全部展开,只有空查询浏览时才应用收起状态
    const isCollapsed = collapsed.has(key);
    frag.appendChild(buildGroupHeader(section.group, section.items.length, isCollapsed, () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      saveCollapsed();
      render();
    }, maxCount));

    if (!isCollapsed) {
      section.items.forEach(item => {
        const row = buildTabRow(item);
        row.classList.add('nested'); // 树状: 子项缩进在分组头下
        frag.appendChild(row);
      });
    }
  });
  resultsEl.appendChild(frag);
  // 清理收起记忆里已不存在的分组(组被删掉/改名后,残留的 key 会让同名的组莫名收起)
  const liveKeys = new Set(sections.map(s => groupKey(s.group)));
  const staleKeys = [...collapsed].filter(k => !liveKeys.has(k) && k !== '__ungrouped__');
  if (staleKeys.length) {
    staleKeys.forEach(k => collapsed.delete(k));
    saveCollapsed();
  }
  restoreFocus(prevKey, prevTabId);
  if (DEBUG) console.log(`[TGS] render 耗时: ${(performance.now() - t0).toFixed(1)}ms, 行数: ${state.filtered.length}`);
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
      state.activeIndex = indexOfRow(target);
    } else {
      state.activeIndex = -2;
    }
  }
}

// 分组头: group 为 null 表示未分组; onClick 为空时不可点击(搜索模式的分隔条)
// maxCount: 本次渲染中最大的组内条目数(迷你条形图的分母),空则不画条
function buildGroupHeader(group, count, isCollapsed, onClick, maxCount) {
  const header = document.createElement('div');
  header.className = 'group-header' + (isCollapsed ? ' collapsed' : '');
  header.style.animationDelay = staggerDelay();
  header.dataset.groupKey = groupKey(group);
  const isInk = document.documentElement.dataset.theme === 'ink';
  const colorMap = isInk ? INK_GROUP_COLORS : GROUP_COLORS;
  const groupColor = group
    ? (colorMap[group.color] || (isInk ? '#A79E92' : '#BDC1C6'))
    : (isInk ? '#A79E92' : '#BDC1C6');
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
    name.innerHTML = q
      ? markText(group.title || '(未命名分组)', fuzzyMatch(q, group.title || ''))
      : escapeHtml(group.title || '(未命名分组)');
  } else {
    name.textContent = '未分组';
  }
  header.appendChild(name);
  if (count != null) {
    // 迷你条形图: 长度∝组内标签数/最大组,不读数字扫一眼知轻重
    if (maxCount > 1) {
      const bar = document.createElement('span');
      bar.className = 'group-bar';
      bar.style.width = `${Math.max(10, Math.round(count / maxCount * 40))}px`;
      bar.style.background = group
        ? (GROUP_COLORS[group.color] || '#8e8e93')
        : '#8e8e93';
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
    if (isInk) {
      countEl.style.setProperty('--dot-ink-bg', `url("${buildInkBleedSvg(groupColor)}")`);
    }
    header.appendChild(countEl);
  }
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

  // 拖拽移动支持: 严格仅在 [分组] 视图下且针对真实存活 tab 开启 (最近使用与当前窗口窗口不支持)
  const canDrag = state.view === 'grouped' && !isVirtualItem;
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
      e.dataTransfer.setData('text/plain', String(t.id));
      requestAnimationFrame(() => row.classList.add('dragging'));
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      state.draggedTabInfo = null;
    });
    // 拖拽落点: 目标组内的条目也可作为放置目标
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

  // favicon + 重复合并角标: 同 URL 多份时 favicon 右上角迷你数字徽(深底白字,
  // 11px 圆点),份数一眼可读;无副本时裸图标
  const iconWrap = document.createElement('span');
  iconWrap.className = 'icon-wrap';
  // 无图标时首字母徽颜色随所在分组
  const groupColor = item.group ? (GROUP_COLORS[item.group.color] || '#8e8e93') : 'var(--accent)';
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
  title.innerHTML = markText(t.title || t.url, item.titleHits);
  info.appendChild(title);
  // URL 行: 严格遵循用户设置(settings.showUrl)。未开启时绝不擅自展示,保持列表单行高度纯净整齐
  if (actions.getSettings().showUrl) {
    const url = document.createElement('div');
    url.className = 'url';
    // 只显示域名,除非: ① 搜索命中了 URL, 或 ② 标题完全重复(同名 tab 需展示完整 URL 才能区分)
    const showFull = item.urlHits || item.titleDup;
    const shownUrl = showFull ? displayUrl(t.url) : hostOf(t.url);
    // URL 兜底匹配发生在完整 URL 上,但展示的是 host+path,需在展示文本上重算高亮
    const urlHits = item.urlHits
      ? (fuzzyMatch(input.value.trim(), shownUrl) || item.urlHits)
      : null;
    url.innerHTML = markText(shownUrl, urlHits);
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
  row.appendChild(closeBtn);

  row.addEventListener('click', () => switchTo(t));
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

// 关闭标签页并从列表中移除该行,焦点迁移到相邻行; 底部提供限时撤销
export async function closeTab(tabId) {
  const rows = [...resultsEl.querySelectorAll('.tab-item')];
  const rowIdx = rows.findIndex(r => Number(r.dataset.tabId) === tabId);
  const closed = state.filtered.find(f => f.tab.id === tabId);
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
  // 就地重渲染,并让焦点落到被关闭行的相邻行
  render();
  const newRows = [...resultsEl.querySelectorAll('.tab-item')];
  if (newRows.length) {
    const idxOf = id => id == null ? -1
      : newRows.findIndex(r => Number(r.dataset.tabId) === id);
    // 顺序即优先级: 合并行原地换代表→跟着它走; 否则留在本组内的后继;
    // 关到组尾则回退到组内前驱; 整组被清空才让位给原来的位置(下一个分组首行)
    let target = idxOf(promotedTabId);
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
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}


// 复制 tab 的 URL 到剪贴板,轻提示确认(不关弹窗,可连续复制多个)
export async function copyTabUrl(tab) {
  const url = tab.url || '';
  try {
    await navigator.clipboard.writeText(url);
    showToast(`已复制: ${displayUrl(url).slice(0, 40)}`);
  } catch (err) {
    console.error('复制失败:', err);
    showToast('复制失败,请重试');
  }
}
