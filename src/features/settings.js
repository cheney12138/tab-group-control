// features/settings.js: 设置面板组件(面板骨架 + 主题/开关 + 归档 pane)
// 与 main 的边界: 通过 initSettings(actions) 注入运行期依赖(render/refreshData/
// focusInput/getSettings/saveSettings/cleanStale/getAllTabs/afterRestore)——
// 模块 import 阶段 main 的函数尚未就位,所以元素引用与监听注册全部收进
// initSettings,顶层只留纯函数定义
import { showToast, positionTabSlider } from '../core/dom.js';
import { relativeTime } from '../core/format.js';
import { buildInkBleedSvg, themeAssets } from '../core/colors.js';
import { recentlyRestoredTabs } from '../core/store.js';
import { loadRulesForEdit } from './rules.js';

let actions = null;          // initSettings 注入的 main 侧能力
let settingsBtn = null;      // 以下元素引用在 initSettings 内赋值
let settingsPanel = null;
let optAutoGroup = null;
let optOthersGroup = null;

export function isSettingsOpen() {
  return !!(settingsPanel && settingsPanel.classList.contains('open'));
}

function openSettingsPanel() {
  if (settingsPanel.classList.contains('open')) return;
  settingsPanel.classList.add('open');
  // 打开过一次设置面板后，齿轮小圆点立即消失，持久化已读，不常驻
  clearArchiveUnread();
  loadRulesForEdit();
  loadAutoGroupSwitch();
  loadOthersGroupSwitch();
  renderArchivedList();
  requestAnimationFrame(() => positionTabSlider(document.querySelector('.settings-tabs')));
}

export function closeSettingsPanel() {
  if (!settingsPanel.classList.contains('open')) return;
  settingsPanel.classList.remove('open');
  actions.focusInput();
}

function toggleSettingsPanel() {
  if (settingsPanel.classList.contains('open')) {
    closeSettingsPanel();
  } else {
    openSettingsPanel();
  }
}

// 设置面板选择 Tab: 分组(规则编辑) / 已归档 / 功能(偏好+快捷键+清理)。
function setSettingsPane(pane) {
  const groupPane = document.getElementById('pane-group');
  const archivePane = document.getElementById('pane-archive');
  const funcPane = document.getElementById('pane-func');
  const settingsActions = document.querySelector('.settings-actions');
  const isGroup = pane === 'group';
  document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.pane === pane));
  if (groupPane) groupPane.classList.toggle('active', isGroup);
  if (archivePane) archivePane.classList.toggle('active', pane === 'archive');
  if (funcPane) funcPane.classList.toggle('active', pane === 'func');
  if (settingsActions) settingsActions.style.display = isGroup ? 'flex' : 'none';
  if (pane === 'archive') renderArchivedList();
  positionTabSlider(document.querySelector('.settings-tabs'));
}

export function toggleSettingsPane() {
  const panes = ['group', 'archive', 'func'];
  const activeTab = document.querySelector('.settings-tab.active');
  const cur = activeTab?.dataset.pane || 'group';
  const idx = panes.indexOf(cur);
  const next = panes[(idx + 1) % panes.length];
  setSettingsPane(next);
}

// 突出色: 每个主题独立维护突出色,切换主题时两套主色互不干扰
function markActiveSwatch(el) {
  document.querySelectorAll('.accent-swatch').forEach(x => x.classList.toggle('active', x === el));
}

function applyThemeAccent(theme) {
  const isInk = theme === 'ink';
  const savedAccent = localStorage.getItem(isInk ? 'tgs-accent-ink' : 'tgs-accent-linear') ||
                      (isInk ? '' : (localStorage.getItem('tgs-accent') || 'blue'));
  if (savedAccent) {
    document.documentElement.dataset.accent = savedAccent;
    const sw = [...document.querySelectorAll('.accent-swatch')].find(x => x.dataset.accent === savedAccent);
    if (sw) markActiveSwatch(sw);
  } else {
    // 水墨风默认使用水墨朱砂红(--seal: #B23A2E), 不设 data-accent 避免覆盖
    delete document.documentElement.dataset.accent;
    markActiveSwatch(null);
  }
}

async function loadAutoGroupSwitch() {
  try {
    const stored = await chrome.storage.local.get('autoGroupEnabled');
    // 默认开启(undefined = 未设置过)
    optAutoGroup.checked = stored?.autoGroupEnabled !== false;
  } catch (e) {
    optAutoGroup.checked = true;
  }
}
async function loadOthersGroupSwitch() {
  try {
    const stored = await chrome.storage.local.get('othersGroupEnabled');
    // 默认开启(undefined = 未设置过),保持旧行为
    optOthersGroup.checked = stored?.othersGroupEnabled !== false;
  } catch (e) {
    optOthersGroup.checked = true;
  }
}
// ---- 分组归档 (Stash & Restore) 数据模型 ----
// 存储于 chrome.storage.local: archivedGroups 数组
// 结构: [{ id, title, color, archivedAt, tabs: [{ title, url, favIconUrl }] }]
export function updateSettingsBadge(count, showDot = null) {
  if (!settingsBtn) return; // initSettings 前的早到调用防御
  if (showDot !== null) {
    settingsBtn.classList.toggle('has-archive', !!showDot);
  }
  const pill = document.getElementById('archivePill');
  if (pill) {
    pill.textContent = count;
    pill.style.display = count > 0 ? 'inline-block' : 'none';
  }
}

async function markArchiveUnread() {
  if (!settingsBtn) return;
  settingsBtn.classList.add('has-archive');
  await chrome.storage.local.set({ hasArchiveUnread: true }).catch(() => {});
}

async function clearArchiveUnread() {
  if (!settingsBtn) return;
  settingsBtn.classList.remove('has-archive');
  await chrome.storage.local.set({ hasArchiveUnread: false }).catch(() => {});
}

async function getArchivedGroups() {
  try {
    const data = await chrome.storage.local.get('archivedGroups');
    return Array.isArray(data?.archivedGroups) ? data.archivedGroups : [];
  } catch (e) {
    console.error('读取归档数据失败:', e);
    return [];
  }
}

async function setArchivedGroups(list) {
  try {
    await chrome.storage.local.set({ archivedGroups: list });
    updateSettingsBadge(list.length);
  } catch (e) {
    console.error('保存归档数据失败:', e);
  }
}

async function addArchivedGroup({ title, color, tabs }) {
  const list = await getArchivedGroups();
  const newArchive = {
    id: `arch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: title || '未命名分组',
    color: color || 'grey',
    archivedAt: Date.now(),
    tabs: (tabs || []).map(t => ({
      title: t.title || t.url || '未命名页面',
      url: t.url,
      favIconUrl: t.favIconUrl || ''
    }))
  };
  const updated = [newArchive, ...list];
  await setArchivedGroups(updated);
  return newArchive;
}

async function deleteArchivedGroup(id) {
  const list = await getArchivedGroups();
  const updated = list.filter(item => item.id !== id);
  await setArchivedGroups(updated);
  return updated;
}

// 渲染设置面板中的归档卡列表
async function renderArchivedList() {
  const container = document.getElementById('archivedList');
  if (!container) return;
  const list = await getArchivedGroups();
  container.innerHTML = '';
  if (!list.length) {
    container.innerHTML = '<div style="padding:24px 0;text-align:center;font-size:12px;color:var(--text-3)">暂无已归档分组</div>';
    return;
  }

  const assets = themeAssets();

  list.forEach(item => {
    const card = document.createElement('div');
    card.className = 'archive-card';
    card.dataset.id = item.id;

    const groupColor = assets.groupColors[item.color] || assets.groupColors.grey;

    // 头部行
    const header = document.createElement('div');
    header.className = 'archive-card-header';
    header.title = '点击展开/折叠标签详情';

    const left = document.createElement('div');
    left.className = 'archive-card-left';

    const dot = document.createElement('span');
    dot.className = 'archive-dot';
    if (assets.inkBlot) {
      dot.style.setProperty('--dot-ink-bg', `url("${buildInkBleedSvg(groupColor)}")`);
    } else {
      dot.style.background = groupColor;
    }

    const name = document.createElement('span');
    name.className = 'archive-card-name';
    name.textContent = item.title;

    const meta = document.createElement('span');
    meta.className = 'archive-card-meta';
    const timeStr = relativeTime(item.archivedAt) || '刚刚';
    meta.textContent = `${item.tabs?.length || 0} 个标签 · ${timeStr}归档`;

    left.appendChild(dot);
    left.appendChild(name);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'archive-card-actions';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-archive-del';
    delBtn.title = '删除此存档';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteArchivedGroup(item.id);
      showToast(`已删除归档「${item.title}」`);
      renderArchivedList();
    });

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn-restore-archive';
    restoreBtn.textContent = '重新打开';
    restoreBtn.title = `重新打开「${item.title}」的标签并归组`;
    restoreBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await restoreArchivedGroupAction(item);
    });

    actions.appendChild(restoreBtn);
    actions.appendChild(delBtn);
    header.appendChild(left);
    header.appendChild(actions);

    // 展开预览区
    const preview = document.createElement('div');
    preview.className = 'archive-tabs-preview';
    (item.tabs || []).forEach(t => {
      const line = document.createElement('div');
      line.className = 'archive-tab-line';
      line.title = `${t.title}\n${t.url}`;
      line.textContent = t.title || t.url;
      preview.appendChild(line);
    });

    header.addEventListener('click', () => {
      card.classList.toggle('expanded');
    });

    card.appendChild(header);
    card.appendChild(preview);
    container.appendChild(card);
  });
}

// 重新打开归档卡: 批量创建标签 -> 归入原生分组 -> 核销/焚卡 -> 关闭设置面板 -> 刷新列表
async function restoreArchivedGroupAction(item) {
  if (!item || !Array.isArray(item.tabs) || !item.tabs.length) {
    showToast('该归档卡没有可打开的标签');
    return;
  }

  const win = await chrome.windows.getCurrent().catch(() => null);
  const windowId = win?.id;
  const newTabIds = [];
  const failedTabs = [];

  for (const t of item.tabs) {
    if (!t.url) continue;
    try {
      const newTab = await chrome.tabs.create({
        url: t.url,
        active: false,
        ...(windowId ? { windowId } : {})
      });
      if (newTab && newTab.id) {
        newTabIds.push(newTab.id);
        recentlyRestoredTabs.set(newTab.id, {
          title: t.title || t.url,
          url: t.url,
          favIconUrl: t.favIconUrl || ''
        });
      }
    } catch (err) {
      console.error('重新打开标签创建失败:', err); failedTabs.push(t);
    }
  }

  let mergedIntoExisting = false;
  if (newTabIds.length) {
    try {
      const validColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
      const safeColor = validColors.includes(item.color) ? item.color : 'grey';
      const title = item.title || '未命名分组';
      // 建组走 background 串行队列: popup 直调 API 时 query→group 间隙
      // autoGroupTab 可能也在为同名组建组,双 miss 各建一个(重复组)。
      // 同窗口已有同名组则由队列并入,不再新建
      const resp = await chrome.runtime.sendMessage({
        type: 'restore-group', title, color: safeColor, tabIds: newTabIds, windowId,
      }).catch(() => null);
      if (resp?.ok) {
        mergedIntoExisting = !!resp.merged;
      } else {
        // worker 异常兜底: 直调建组(竞态概率低,总好过打开的标签散着)
        if (resp && !resp.ok) console.error('队列建组失败,转直调:', resp.error);
        const dupQuery = { title };
        if (windowId) dupQuery.windowId = windowId;
        const dupGroups = await chrome.tabGroups.query(dupQuery).catch(() => []);
        if (dupGroups.length) {
          mergedIntoExisting = true;
          await chrome.tabs.group({ tabIds: newTabIds, groupId: dupGroups[0].id });
        } else {
          const gid = await chrome.tabs.group({
            tabIds: newTabIds,
            ...(windowId ? { createProperties: { windowId } } : {})
          });
          await chrome.tabGroups.update(gid, { title, color: safeColor });
        }
      }
      // 仅对非规则组(如自定义项目组)写入人工干预标记: 重新打开且落在已有规则组下的标签不计入白名单
      const storedRules = await chrome.storage.local.get('groupRules');
      const rules = (storedRules?.groupRules && typeof storedRules.groupRules === 'object') ? storedRules.groupRules : {};
      const isRuleGroup = item.title && Object.prototype.hasOwnProperty.call(rules, item.title);
      if (!isRuleGroup) {
        const stored = await chrome.storage.local.get('manualTabIds');
        const set = new Set(Array.isArray(stored?.manualTabIds) ? stored.manualTabIds : []);
        for (const id of newTabIds) set.add(id);
        await chrome.storage.local.set({ manualTabIds: [...set] });
      }
    } catch (err) {
      console.error('重新打开归组失败:', err);
    }
  }

  // 焚卡前提 = 全部重新打开成功(ADR-0001): 部分失败只核销已打开的标签,
  // 失败的留在卡里可随时再来——无条件焚卡等于把失败部分静默销毁
  const failedSet = new Set(failedTabs);
  const remainingTabs = item.tabs.filter(t => t.url && failedSet.has(t));
  if (remainingTabs.length) {
    const list = await getArchivedGroups();
    await setArchivedGroups(list.map(x => x.id === item.id ? { ...x, tabs: remainingTabs } : x));
  } else {
    await deleteArchivedGroup(item.id);
  }

  // 关闭设置面板
  closeSettingsPanel();

  showToast(failedTabs.length
    ? `已重新打开 ${newTabIds.length} 个标签,${failedTabs.length} 个失败保留在归档卡中`
    : `已重新打开「${item.title}」(${newTabIds.length} 个标签)${mergedIntoExisting ? ',已并入现有同名组' : ''}`);
  await actions.refreshData({ forceFresh: true });

  // 展开目标分组 + 渲染 + 定位高亮(折叠状态/列表光标是 main 侧状态,交回 main)
  const restoredGroup = actions.getAllTabs().find(x => newTabIds.includes(x.tab.id))?.group;
  actions.afterRestore(restoredGroup, newTabIds);

  // 页面加载定型后清理临时内存映射
  setTimeout(() => {
    for (const id of newTabIds) recentlyRestoredTabs.delete(id);
  }, 8000);
}

// 触发归档动作: 存入 storage -> 关闭标签栏中的对应标签 -> 提示并刷新列表
export async function archiveGroupAction(group) {
  if (!group || !group.id) return;
  const targetTabs = actions.getAllTabs().filter(x => x.group && x.group.id === group.id);
  if (!targetTabs.length) return;

  const tabsToSave = targetTabs.map(x => ({
    title: x.tab.title || x.tab.url || '未命名页面',
    url: x.tab.url,
    favIconUrl: x.tab.favIconUrl || ''
  }));

  await addArchivedGroup({
    title: group.title || '未命名分组',
    color: group.color || 'grey',
    tabs: tabsToSave
  });

  const tabIdsToRemove = [];
  for (const x of targetTabs) {
    if (x.tab && x.tab.id > 0) tabIdsToRemove.push(x.tab.id);
    if (x.duplicates && x.duplicates.length) {
      tabIdsToRemove.push(...x.duplicates.filter(id => id > 0));
    }
  }

  // 必须在关闭标签之前写入未读标记: 若当前激活标签在被关列表中,
  // chrome.tabs.remove 会导致 Chrome 瞬间关闭 popup 进程, 延后写入会导致未读标记丢失
  await markArchiveUnread();

  if (tabIdsToRemove.length) {
    await chrome.tabs.remove(tabIdsToRemove).catch(e => console.error('关闭已归档标签失败:', e));
    const stored = await chrome.storage.local.get('manualTabIds');
    if (Array.isArray(stored?.manualTabIds)) {
      const set = new Set(stored.manualTabIds);
      for (const id of tabIdsToRemove) set.delete(id);
      await chrome.storage.local.set({ manualTabIds: [...set] });
    }
  }

  showToast(`已归档「${group.title || '分组'}」(${tabsToSave.length} 个标签)，已归档进设置 ⚙️ 面板`);
  await actions.refreshData({ forceFresh: true });
  actions.render();
}
// ---- 初始化: 元素引用 + 全部监听注册(main 启动时调用一次) ----
export function initSettings(injected) {
  actions = injected;
  settingsBtn = document.getElementById('settingsBtn');
  settingsPanel = document.getElementById('settingsPanel');
// 同步 body.settings-open: 设置面板打开时把 toast 定位到设置空白区(顶部),
// 主视图(分组窗口)保持从底部弹起。
new MutationObserver(() => {
  document.body.classList.toggle('settings-open', settingsPanel.classList.contains('open'));
}).observe(settingsPanel, { attributes: true, attributeFilter: ['class'] });
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSettingsPanel();
});
// 覆盖层的关闭按钮
document.getElementById('settingsCloseBtn').addEventListener('click', () => {
  closeSettingsPanel();
});

try {
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      setSettingsPane(btn.dataset.pane);
    });
  });
} catch (e) { console.error('设置 Tab 初始化失败', e); }
positionTabSlider(document.querySelector('.settings-tabs'));
try {
  document.querySelectorAll('.accent-swatch').forEach(b => {
    b.addEventListener('click', () => {
      const currentTheme = document.documentElement.dataset.theme || 'linear';
      document.documentElement.dataset.accent = b.dataset.accent;
      markActiveSwatch(b);
      try {
        localStorage.setItem(currentTheme === 'ink' ? 'tgs-accent-ink' : 'tgs-accent-linear', b.dataset.accent);
        localStorage.setItem('tgs-accent', b.dataset.accent);
      } catch (e) {}
      actions.render();
    });
  });
} catch (e) { console.error('突出色初始化失败', e); }
// 多主题风格切换: 原有 Linear(极简现代) / 新增 ink(水墨古风新中式)
const optTheme = document.getElementById('optTheme');
try {
  const currentTheme = localStorage.getItem('tgs-theme') || document.documentElement.dataset.theme || 'linear';
  document.documentElement.dataset.theme = currentTheme;
  if (optTheme) {
    optTheme.value = currentTheme;
    optTheme.addEventListener('change', () => {
      const selected = optTheme.value;
      document.documentElement.dataset.theme = selected;
      try {
        localStorage.setItem('tgs-theme', selected);
      } catch (e) {}
      applyThemeAccent(selected);
      actions.render(); // 重新渲染列表, 使新主题分组色号与竖线样式即刻生效
      // 切换主题改动字体/间距, 等布局稳定后重算滑块位置
      requestAnimationFrame(() => {
        positionTabSlider(document.querySelector('.view-tabs'));
        positionTabSlider(document.querySelector('.settings-tabs'));
      });
    });
  }
  applyThemeAccent(currentTheme);
  // 初始化量取滑块用的是旧主题几何(此时 data-theme 尚为 linear),
  // 主题真正应用后再重算一次,否则保存的 ink 主题会因字体/间距不同而错位
  requestAnimationFrame(() => positionTabSlider(document.querySelector('.view-tabs')));
} catch (e) {
  console.error('主题切换初始化失败', e);
}

// 自动分组总开关: 存 chrome.storage.local(background 读同一 key 判定是否归组)。
  optAutoGroup = document.getElementById('optAutoGroup');
optAutoGroup.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoGroupEnabled: optAutoGroup.checked });
  if (optAutoGroup.checked) {
    // 开启时立即触发存量归组(散标签按规则+Others兜底收组),归完顺带整理
    showToast('自动分组已开启,正在归组存量标签…');
    try {
      await chrome.runtime.sendMessage({ type: 'group-existing' });
      setTimeout(async () => {
        await actions.refreshData();
        actions.render();
      }, 1500);
    } catch (e) { /* worker 未就绪时静默,规则已在 worker 生效 */ }
  } else {
    showToast('自动分组已关闭');
  }
});
// Others 兜底开关: 未命中规则的散标签是否归入 Others 组。
// 关闭时"未分组保持散着"——规则只管命中的域名,清空规则 + 关兜底
// 即完全不做任何归组。存量迁移(开→收散标签 / 关→解散 Others 组)
  optOthersGroup = document.getElementById('optOthersGroup');
optOthersGroup.addEventListener('change', async () => {
  await chrome.storage.local.set({ othersGroupEnabled: optOthersGroup.checked });
  showToast(optOthersGroup.checked
    ? '未分组标签将归入 Others'
    : 'Others 组已解散,未分组标签保持散着');
  // 存量迁移在后台异步跑,稍后刷新列表显示新分组状态
  setTimeout(async () => {
    await actions.refreshData();
    actions.render();
  }, 1500);
});
// 快捷键速查已改为 hover 气泡(纯 CSS),无需 JS
const optShowUrl = document.getElementById('optShowUrl');
// (模糊匹配开关已删: 功能保留、永远开启,不再暴露配置)
optShowUrl.checked = actions.getSettings().showUrl;
optShowUrl.addEventListener('change', () => {
  actions.getSettings().showUrl = optShowUrl.checked;
  actions.saveSettings();
  actions.render();
});
// 删除键位配置(见 settings.deleteKey 注释)
const optDeleteKey = document.getElementById('optDeleteKey');
optDeleteKey.value = actions.getSettings().deleteKey;
optDeleteKey.addEventListener('change', () => {
  actions.getSettings().deleteKey = optDeleteKey.value;
  actions.saveSettings();
  showToast('删除键已切换为: ' + optDeleteKey.selectedOptions[0].textContent);
});
// chrome:// 链接在扩展弹窗里不能直接打开,交由后台页处理
document.getElementById('shortcutLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// 清理僵尸标签按钮
document.getElementById('cleanBtn').addEventListener('click', () => {
  actions.focusInput();
  actions.cleanStale();
});
}
