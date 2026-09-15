// 按分组展示的标签页搜索:
// 读取 chrome.tabGroups 中由 Tabbiy 等插件创建的原生分组,
// 搜索结果按分组分区显示,支持模糊匹配与拼音首字母场景下的子串匹配。

// core 层
import { groupKey } from './core/format.js';
import { showToast, resultsEl, rowByTabId, indexOfRow, input } from './core/dom.js';
import { recentlyRestoredTabs, mediaTabIds, state, collapsed, searchCollapsed, saveCollapsed, activeCollapsed, tabItemByTabId } from './core/store.js';
import { IS_MAC, MOD, DEBUG } from './core/platform.js';
// features
import { loadRulesForEdit, isGroupPopOpen, closeGroupPop } from './features/rules.js';
import { initSettings, updateSettingsBadge, isSettingsOpen, closeSettingsPanel, toggleSettingsPane } from './features/settings.js';
import { initMedia, applyMediaRowState, setMediaBtnState, SVG_MUTE, SVG_UNMUTE, probeMediaTabs } from './features/media.js';
import { initUndo, isUndoAvailable, doUndo } from './features/undo.js';
import { initClean, cleanStaleTabs } from './features/clean.js';
import { initNav, setActive, focusCurrentTab, navUnits, clearActiveUnit, scrollPastSticky, findGroupOfTab } from './features/nav.js';
import { initDnd, moveTabToGroupAction } from './features/dnd.js';
import { initSearch, search, searchValue, closeOneDuplicate, resetCmd } from './features/search.js';
import { initRender, render, closeTab, switchTo, copyTabUrl } from './features/render.js';
import { VIEWS, setView } from './features/views.js';

// 性能埋点(无条件输出): 脚本开始执行的时刻。

// ---- 设置 ----
const settings = {
  showUrl: localStorage.getItem('tgs-showurl') === '1',  // 显示 URL 行,默认关(需要自己打开)
  // 删除标签的快捷键。历史上默认 ⌘⌫,但 macOS 部分输入法/键盘工具会给
  // 裸退格误置 metaKey,"没按 ⌘ 也删标签"的 bug 反复出现的根源。
  // 判定已改用 e.code(物理键位,不受输入法影响),但仍提供配置:
  //   cmd-bs / ⌘⌫   — 默认,最不容易误触
  //   bs / 裸退格    — 光标在输入框起点时删除选中行(顺手但有误删风险)
  //   dbl-bs / 双击退格 — QuicKey 风格,500ms 内两次裸退格=删除
  deleteKey: localStorage.getItem('tgs-deletekey') || 'cmd-bs',
};
function saveSettings() {
  localStorage.setItem('tgs-showurl', settings.showUrl ? '1' : '0');
  localStorage.setItem('tgs-deletekey', settings.deleteKey);
}

// HTML 里的修饰键占位符填充(mac: ⌘ / Windows: Ctrl+)
document.querySelectorAll('.k-c, .k-cmd').forEach(el => el.textContent = MOD);
// Windows 下 ⌫/⇧ 等 mac 符号换成文字
if (!IS_MAC) {
  document.querySelectorAll('.shortcut-table td:first-child').forEach(td => {
    td.innerHTML = td.innerHTML
      .replace('⌫', 'Backspace')
      .replace('⇧', 'Shift+');
  });
}

// 折叠状态已迁至 core/store.js(collapsed/searchCollapsed/saveCollapsed/activeCollapsed)
// 极简模糊匹配: 返回匹配到的字符下标数组,不匹配返回 null
// 拼音匹配(pinyin-data.js 提供 GB2312 全量汉字→无调拼音,29KB):
// 全拼模式——"dingdan" 匹配「订单管理」;首字母 "dd" 也兼容(前缀命中)。
// ---- tabs.onUpdated 事件路由(main 侧) ----
// 媒体状态分支委托 features/media;归组分支做列表新鲜度刷新
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 外部变化(页面内直接暂停/播完)的同步路径。注意: 弹窗按钮点击已由
  // applyMediaRowState 乐观更新过,这里到达时状态一致,幂等无害
  if (changeInfo.audible !== undefined && tabId > 0) {
    applyMediaRowState(tabId, !!changeInfo.audible);
  }
  if (changeInfo.mutedInfo !== undefined && tabId > 0) {
    const row = rowByTabId(tabId);
    const muteBtn = row?.querySelector('.media-btn[data-action="mute"], .media-btn[title="静音"], .media-btn[title="取消静音"]');
    if (muteBtn) {
      const isMuted = !!changeInfo.mutedInfo.muted;
      setMediaBtnState(muteBtn, isMuted ? SVG_UNMUTE : SVG_MUTE, isMuted ? '取消静音' : '静音');
    }
  }
  // 归组变化(规则保存后的存量迁移/新标签自动归组/标签栏手动拖拽)即时反映。
  // 每个被迁标签一条事件,归组风暴时成串到达——防抖合并成一次刷新;
  // background 快照不含 groupId 变化(它只刷 title/url/audible/muted),
  // 必须 forceFresh 直查;签名比对无变化不渲染,不打断用户正在进行的操作
  if (changeInfo.groupId !== undefined) scheduleGroupRefresh();
});
let groupRefreshTimer = null;
function scheduleGroupRefresh() {
  clearTimeout(groupRefreshTimer);
  groupRefreshTimer = setTimeout(async () => {
    const sig = (list) => JSON.stringify(list.map(x =>
      [x.tab.id, x.tab.url, x.duplicates?.length || 0, x.group?.title || '', !!x.tab.audible]));
    const before = sig(state.allTabs);
    await loadTabs({ forceFresh: true });
    if (sig(state.allTabs) !== before) {
      search(searchValue());
      render();
    }
  }, 400);
}

async function loadTabs(opts = {}) {
  const t0 = performance.now();
  // 优先用 background 维护的快照(worker 常驻,数据即时)——省掉三连查询。
  // 快照陈旧/不可用时回退直接查询。
  // opts.forceFresh: 标签增删/归档/恢复后强制实时直查, 绝不读旧快照缓存
  let tabs, groups;
  let fromSnapshot = false;
  const currentWinPromise = chrome.windows.getCurrent().catch(() => null);
  if (!opts.forceFresh) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get-snapshot' });
      if (resp?.snapshot) {
        tabs = resp.snapshot.tabs;
        groups = resp.snapshot.groups || [];
        fromSnapshot = true;
      }
    } catch (e) { /* worker 未就绪等,走正常查询 */ }
  }
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
  state.currentWindowId = (await currentWinPromise)?.id ?? null;
  if (DEBUG) console.log(`[TGS] loadTabs 耗时: ${(performance.now() - t0).toFixed(1)}ms, 标签数: ${tabs.length}${fromSnapshot ? '(快照)' : '(直查)'}`);
  const groupById = new Map(groups.map(g => [g.id, g]));
  // 收集窗口序号映射(过滤发生在收集之后,保证编号连续且与实际窗口一致)
  state.windowIds = [...new Set(tabs.map(t => t.windowId))].sort((a, b) => a - b);
  // 按最近使用时间倒排: 分组区顺序由组内最新标签决定,组内同样按最近使用排序
  const sorted = tabs
    .map(t => {
      if (!t.url && t.pendingUrl) t.url = t.pendingUrl;
      const restored = recentlyRestoredTabs.get(t.id);
      if (restored) {
        if (!t.url || t.url === 'about:blank') t.url = restored.url;
        if (!t.title || t.title === 'Loading...' || t.title === t.url) t.title = restored.title;
        if (!t.favIconUrl && restored.favIconUrl) t.favIconUrl = restored.favIconUrl;
        if (restored.lastAccessed != null) t.lastAccessed = restored.lastAccessed;
      }
      return t;
    })
    .filter(t => t.url && !t.url.startsWith('chrome-extension://'))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .map(t => ({ tab: t, group: groupById.get(t.groupId) || null }));
  // 重复合并(QuicKey 同款): 同 URL 多个标签合成一条,保留最近使用的代表,
  // duplicates 记全部副本 id(右上角角标显示份数)。tabs 已按 lastAccessed
  // 倒排,先见的即代表。
  // 合并限定同一窗口内: 跨窗口的同 URL 各自保留——窗口是独立工作区,
  // 跨窗口合并会让另一窗口的标签"消失"(只归属到代表所在的窗口)
  state.allTabs = [];
  const byUrl = new Map();
  for (const item of sorted) {
    const key = `${item.tab.windowId}|${item.tab.url}`;
    const prev = byUrl.get(key);
    if (prev) {
      prev.duplicates.push(item.tab.id);
      if (item.tab.audible) prev.tab.audible = true;
    } else {
      item.duplicates = []; // 初始化副本数组
      byUrl.set(key, item);
      state.allTabs.push(item);
    }
  }
}

// 定位当前标签: 清空搜索回到全量视图,展开其所在分组,平滑滚到该行并闪烁高亮
let locateTimer = null;
function locateCurrentTab() {
  // 搜索/命令态会过滤掉当前标签,先复位到全量分组视图
  if (state.searching || input.value.trim()) {
    input.value = '';
    resetCmd();
    state.searching = false;
    search('');
  }
  const cur = state.filtered.find(f => f.tab.active
    && (state.currentWindowId == null || f.tab.windowId === state.currentWindowId));
  if (!cur) { showToast('当前标签不在视图中'); return; }

  // 所在分组折叠则展开
  const gk = cur.group ? groupKey(cur.group) : '__ungrouped__';
  if (cur.group && collapsed.has(gk)) {
    collapsed.delete(gk);
    saveCollapsed();
    render();
  }
  // render 后 DOM 重建,重新找行
  const row = rowByTabId(cur.tab.id);
  if (!row) { showToast('找不到该标签行'); return; }

  // 显式定位操作: 键盘光标同步移到当前 tab(随后 Enter 即切回、↑↓ 从它
  // 开始导航)——归档恢复后光标曾在恢复组首个 tab 上,定位应把它带回来,
  // 而不是只播放一次性脉冲后光标留在原地
  const idx = indexOfRow(row);
  if (idx !== -1) setActive(idx);

  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('locating');
  void row.offsetWidth; // 强制 reflow,重启动画
  row.classList.add('locating');
  clearTimeout(locateTimer);
  locateTimer = setTimeout(() => row.classList.remove('locating'), 1400);
}

document.getElementById('locateBtn').addEventListener('click', locateCurrentTab);




// (规则加载已合并进上方 settingsBtn 主监听器——展开即刷新,
// 独立监听器的时序判断曾与主监听器的 toggle 竞态导致永远不加载)

// 全局键盘路由: 监听 document 而非 input,任何元素拿走焦点后快捷键依然有效。
// 仅当焦点在其他真实输入控件(设置面板的 checkbox 等)时放行原生行为
document.addEventListener('keydown', (e) => {
  // 中文输入法组合输入(拼音未上屏)期间,按键全部让位给输入法:
  // composing 中按回车是"确认拼音串上屏",不是"选中结果"——不拦的话
  // 拼音打一半回车,标签瞬间被切走,输入内容全丢。上下键同理(选候选词),
  // 退格是删拼音字母。e.isComposing 是标准属性;keyCode 229 是 Safari
  // 及部分输入法 composition 期间 keydown 的通用标记,双保险
  if (e.isComposing || e.keyCode === 229) return;
  // 诊断: 所有退格按键的真实修饰键状态(排查"没按 cmd 却触发关闭"的键位映射问题)
  // 仅 DEBUG 下输出——生产里这是每次退格都打的高频日志
  if (DEBUG && e.key === 'Backspace') {
    console.log('[TGS] Backspace 按下:', {
      meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
      key: e.key, code: e.code,
      focusIn: document.activeElement === input,
    });
  }
  // ⌘C 复制 URL: 提到 isOtherInput 之前,保证在设置面板(焦点在控件上)也能用。
  // 若输入框里有选中文本则放行原生复制。
  if ((e.key === 'c' || e.key === 'C') && (e.metaKey || e.ctrlKey)) {
    const sel = window.getSelection();
    if (!(sel && sel.toString())) {
      let target = null;
      // focusedUnit 是 handleShortcuts 内部变量,这里用 navUnits() 找 active 行
      const anyActiveUnit = navUnits().find(u => u.classList.contains('active'));
      if (anyActiveUnit && anyActiveUnit.classList.contains('tab-item')) {
        target = state.filtered.find(f => f.tab.id === Number(anyActiveUnit.dataset.tabId));
      }
      if (!target) {
        target = state.filtered.find(f => f.tab.active
          && (state.currentWindowId == null || f.tab.windowId === state.currentWindowId));
      }
      if (target) { e.preventDefault(); copyTabUrl(target.tab); }
    }
  }
  // ESC: 提前到 isOtherInput 之前处理, 否则焦点在设置控件(select 等)上时,
  // 浏览器默认行为会把 popup 窗口关掉。设置打开→关设置;分组弹层打开→关弹层。
  if (e.key === 'Escape') {
    if (isGroupPopOpen()) {
      e.preventDefault();
      closeGroupPop();
      return;
    }
    if (isSettingsOpen()) {
      e.preventDefault();
      closeSettingsPanel();
      return;
    }
  }
  // 设置面板快捷键: 当设置面板打开时, 按 Tab 键绑死在「分组」与「功能」两个 Tab 之间切换 (两主题通用)
  if (e.key === 'Tab' && isSettingsOpen()) {
    const activeEl = document.activeElement;
    const isEditingText = activeEl && (
      (activeEl.tagName === 'INPUT' && activeEl.type === 'text') ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.isContentEditable
    );
    if (!isEditingText) {
      e.preventDefault();
      toggleSettingsPane();
      return;
    }
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
  // 导入 JSON 弹层同理(textarea 要能正常点击定位/输入,
  // 弹层挂在 body 下不在 #settingsPanel 内,须单独豁免)
  if (e.target.closest('.rules-import-layer')) return;
  // 添加域名弹层: 新建分组输入框需要保持焦点,否则点击就丢焦点无法输入
  if (e.target.closest('.group-pop')) return;
  input.focus();
});

// 双击退格删除模式的上次按下时间(顶层: 跨按键持久,函数内声明会每次清零)
let lastBsTime = 0;
function handleShortcuts(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (isSettingsOpen()) {
      closeSettingsPanel();
      return;
    }
    if (input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    } else if (state.activeCmd) {
      resetCmd();
      input.dispatchEvent(new Event('input'));
    } else {
      window.close();
    }
    return;
  }
  // Tab / Shift+Tab: 设置面板打开时切换设置Tab, 否则在 分组 → 最近使用 → 当前窗口 三个视图间循环切换
  if (e.key === 'Tab') {
    e.preventDefault();
    if (isSettingsOpen()) {
      toggleSettingsPane();
      return;
    }
    const idx = VIEWS.indexOf(state.view);
    const next = e.shiftKey
      ? VIEWS[(idx - 1 + VIEWS.length) % VIEWS.length]
      : VIEWS[(idx + 1) % VIEWS.length];
    setView(next);
    return;
  }
  const units = navUnits();
  if (!units.length) return;
  // 当前焦点单元: 优先取带 active 的标签行(分组头不参与焦点)
  const focusedUnit = units.find(u => u.classList.contains('active')) || units[0];
  const focusIdx = units.indexOf(focusedUnit);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = focusIdx + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= units.length) return;
    const el = units[next];
    clearActiveUnit();
    el.classList.add('active');
    scrollPastSticky(el);
    state.activeIndex = indexOfRow(el);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // → 收起 / ← 展开焦点所在的分组; 焦点在标签行上时取该行所属分组
    // recent / current 视图没有分组头,收起无处展示,不响应
    if (state.view !== 'grouped') return;
    const found = findGroupOfTab(Number(focusedUnit.dataset.tabId));
    if (!found) return; // 未分组的标签,无组可收
    const key = groupKey(found.group);
    const set = activeCollapsed();
    if (DEBUG) console.log('[TGS] 分组键:', key, '已收起:', set.has(key));
    if (e.key === 'ArrowRight' && !set.has(key)) {
      set.add(key);
      if (!state.searching) saveCollapsed();
      render();
      // 收起后保持在就近的可见标签行上，不再选中分组头
      const remainingRows = [...resultsEl.querySelectorAll('.tab-item')];
      if (remainingRows.length) {
        const targetIdx = Math.min(focusIdx, remainingRows.length - 1);
        setActive(targetIdx);
      } else {
        clearActiveUnit();
        state.activeIndex = -1;
      }
    } else if (e.key === 'ArrowLeft' && set.has(key)) {
      set.delete(key);
      if (!state.searching) saveCollapsed();
      render();
      // 展开后选中该分组下第一行
      const rows = [...resultsEl.querySelectorAll('.tab-item')];
      const firstRow = rows.find(r => {
        const f = findGroupOfTab(Number(r.dataset.tabId));
        return f && groupKey(f.group) === key;
      });
      if (firstRow) {
        setActive(rows.indexOf(firstRow));
      }
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (focusedUnit && focusedUnit.classList.contains('tab-item')) {
      const tabId = Number(focusedUnit.dataset.tabId);
      const target = state.filtered.find(f => f.tab.id === tabId);
      if (target) switchTo(target.tab);
    }
  } else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    // ⌘⇧K / Ctrl+Shift+K 清理 7 天以上未使用的标签
    e.preventDefault();
    cleanStaleTabs();
  } else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
    // ⌘Z / Ctrl+Z 撤销最近关闭的标签
    e.preventDefault();
    if (isUndoAvailable()) {
      doUndo();
    }
  } else if (e.code === 'Backspace') {
    // 删除当前选中行,键位由设置决定(见 settings.deleteKey 注释)。
    // 判定用 e.code(物理键位)+ 修饰键,不受输入法给 e.key/metaKey
    // 塞脏值影响——"裸退格误删"反复出现的根因
    // 有重复副本 → 只删一份副本(逐个清理,代表永不动,按一次少一份);
    // 无副本 → 删除标签本身。
    const inDeleteTarget = focusedUnit && focusedUnit.classList.contains('tab-item');
    const withCmd = e.metaKey || e.ctrlKey;
    let shouldDelete = false;
    if (settings.deleteKey === 'cmd-bs') {
      // ⌘⌫ / Ctrl+Backspace: 显式修饰键才删(alt/shift 排除,防组合冲突)
      shouldDelete = withCmd && !e.altKey && !e.shiftKey;
    } else if (settings.deleteKey === 'bs') {
      // 裸退格: 仅当光标在输入框起点(或输入框空)时删——否则是删字
      shouldDelete = !withCmd && !e.altKey && !e.shiftKey
        && (input.value === '' || (input.selectionStart === 0 && input.selectionEnd === 0));
    } else if (settings.deleteKey === 'dbl-bs') {
      // 双击裸退格(500ms 内两次): 第一次不动作,第二次删
      shouldDelete = !withCmd && !e.altKey && !e.shiftKey;
      if (shouldDelete) {
        const now = Date.now();
        if (now - lastBsTime > 500) {
          lastBsTime = now;
          shouldDelete = false; // 第一次,只记时间
        } else {
          lastBsTime = 0;
        }
      }
    }
    if (shouldDelete && inDeleteTarget) {
      e.preventDefault();
      const target = state.filtered.find(f => f.tab.id === Number(focusedUnit.dataset.tabId));
      if (target && target.duplicates && target.duplicates.length) {
        closeOneDuplicate(target);
      } else {
        closeTab(Number(focusedUnit.dataset.tabId));
      }
    }
  }
  // ⌘C 复制 URL 已在顶层 keydown 处理(设置面板内也可用)
}

// 恢复归档后的收尾(折叠状态/列表光标是 main 侧状态,由 settings.js 注入回调):
// 展开目标分组 → 渲染 → 定位高亮第一个恢复的标签
function afterRestore(group, tabIds) {
  if (group) {
    const rKey = groupKey(group);
    if (collapsed.has(rKey)) {
      collapsed.delete(rKey);
      saveCollapsed();
    }
    if (searchCollapsed.has(rKey)) searchCollapsed.delete(rKey);
  }
  render();
  if (tabIds.length) {
    const rows = [...resultsEl.querySelectorAll('.tab-item')];
    const firstRowIndex = rows.findIndex(r => tabIds.includes(Number(r.dataset.tabId)));
    if (firstRowIndex !== -1) setActive(firstRowIndex);
  }
}

// 设置面板组件初始化: 注入 main 侧能力(refreshData=数据层刷新,render=渲染层)
initSettings({
  refreshData: async (opts) => { await loadTabs(opts); search(searchValue()); },
  render,
  focusInput: () => input.focus(),
  getAllTabs: () => state.allTabs,
  getSettings: () => settings,
  saveSettings,
  cleanStale: cleanStaleTabs,
  afterRestore,
});

// 媒体/撤销/清理组件初始化(同一组注入件,各取所需)
const refreshData = async (opts) => { await loadTabs(opts); search(searchValue()); };
initMedia({ getAllTabs: () => state.allTabs, getTabItem: tabItemByTabId });
initUndo({ refreshData, render, focusCurrentTab });
initClean({
  getAllTabs: () => state.allTabs,
  dropTabs: (ids) => { state.allTabs = state.allTabs.filter(x => !ids.has(x.tab.id)); },
  refreshData,
  render,
});
initNav({ getFiltered: () => state.filtered, getCurrentWindowId: () => state.currentWindowId });
initDnd({ refreshData, render, isGroupedView: () => state.view === 'grouped' });
initSearch({ render });
initRender({ refreshData, getSettings: () => settings });

(async () => {
  const bootT0 = performance.now();
  await loadTabs();
  search('');
  render();
  // 初始光标落在当前激活标签,Enter 直接回去
  focusCurrentTab();
  input.focus();
  console.log(`[TGS] 首帧完成, JS 侧总耗时 ${(performance.now() - bootT0).toFixed(1)}ms`);
  console.log('[TGS] BUILD 2026-09-03 v4 (fade-band) — 看不到这行=Chrome 缓存了旧 popup');
  // 首帧不阻塞: 媒体 tab 探测异步跑,命中一个补一个按钮
  probeMediaTabs();
  // 快照追帧: 首帧可能拿到 Tabbiy 归组/新标签 URL 定型前的中间态
  // (新开标签暂在未分组、重复未合并),1s 后静默复核,有变化才重渲染
  setTimeout(async () => {
    const sig = (list) => JSON.stringify(list.map(x =>
      [x.tab.id, x.tab.url, x.duplicates?.length || 0, x.group?.title || '', !!x.tab.audible]));
    const before = sig(state.allTabs);
    await loadTabs();
    if (sig(state.allTabs) !== before) {
      search(searchValue());
      render();
      if (!state.searching) focusCurrentTab();
    }
  }, 1000);
  // 唤起时异步触发分组整理(同名合并+空组清理),在 background 静默执行,
  // 不阻塞弹窗;整理结果由下一次唤起自然看到
  chrome.runtime.sendMessage({ type: 'tidy-groups' }).catch(() => {});
  // 初始化设置按钮的归档未读小圆点(仅在有未读时亮起, 不常驻)
  chrome.storage.local.get(['archivedGroups', 'hasArchiveUnread']).then(s => {
    const count = Array.isArray(s?.archivedGroups) ? s.archivedGroups.length : 0;
    updateSettingsBadge(count, !!s?.hasArchiveUnread && count > 0);
  }).catch(() => {});

})();
