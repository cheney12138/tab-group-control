// features/undo.js: 撤销关闭(组件)
// 单关路径 showUndo 入栈+渲染;批量清理 pushUndo 逐个入栈后 renderUndoBanner。
import { pushBanner, dismissBanner, pushStack } from '../core/dom.js';
import { MOD } from '../core/platform.js';
import { recentlyRestoredTabs, collapsed, saveCollapsed, searchCollapsed, state } from '../core/store.js';

let actions = null; // initUndo 注入: { refreshData, render, focusCurrentTab }
export function initUndo(injected) { actions = injected; }

// ---- 撤销关闭 ----
let undoTimer = null;
let undoStack = []; // 最近关闭的标签快照,支持连续撤销

// 批量路径入栈(cleanStaleTabs 循环里逐个入栈后统一 renderUndoBanner)
export function pushUndo(snapshot) {
  undoStack.push(snapshot);
}

export function showUndo(snapshot) {
  undoStack.push(snapshot);
  renderUndoBanner();
}

// 渲染撤销通知条 + 启动 6s 倒计时。undoStack 由调用方维护:
// 单关路径 showUndo 已 push;批量清理(cleanStaleTabs)在循环里已 push
// 全部快照,直接调用本函数即可——之前 cleanStaleTabs 误调
// showUndo(targets[last].tab)(传了裸 Tab 而非快照对象),既重复 push
// 又因 snapshot.tab 为 undefined 抛 TypeError,导致清理后不刷新/不提示/
// 不能撤销。拆出本函数后批量路径只渲染不重复入栈
export function renderUndoBanner() {
  const count = undoStack.length;
  if (!count) return;
  const tab = undoStack[count - 1]?.tab;
  const title = (tab?.title || tab?.url || '').toString().slice(0, 30);
  pushBanner((banner) => {
    const msg = document.createElement('span');
    msg.className = 'push-msg';
    msg.textContent = count > 1
      ? `已关闭 ${count} 个标签页(含「${title}」)`
      : `已关闭「${title}」`;
    const btn = document.createElement('button');
    btn.className = 'push-action';
    btn.textContent = '撤销';
    btn.title = `恢复刚关闭的标签 (${MOD}Z)`;
    btn.addEventListener('click', doUndo);
    banner.appendChild(msg);
    banner.appendChild(btn);
    // 倒计时进度条: 剩余可撤销时间(条目相对定位收窄置底)
    banner.style.position = 'relative';
    const progress = document.createElement('span');
    progress.className = 'push-progress';
    banner.appendChild(progress);
  }, { autoDismiss: 6000 });
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoStack = [];
  }, 6000);
}

// ⌘Z / Ctrl+Z 撤销最近关闭(等价于点击撤销按钮)
export function isUndoAvailable() {
  return undoStack.length > 0;
}

// 撤销: 使用 active: false 在后台静默恢复被关闭的标签页,
// 坚决不使用 chrome.sessions.restore (后者会强制激活新标签并导致弹窗失焦关闭/页面跳走)。
// 恢复后把标签移回原分组并直查实时数据刷新分组视图。
export async function doUndo() {
  if (!undoStack.length) return;

  const restoredTabIds = [];
  const newlyCreatedIds = [];
  const groupsToExpand = new Set();

  // 获取撤销前当前列表中排在第一位的最新时间
  const topAccessed = state.allTabs[0]?.tab?.lastAccessed || (Date.now() - 1000);

  // 预先收集当前窗口中各分组已有标签的最大 lastAccessed
  const groupMaxTimeMap = new Map();
  for (const item of state.allTabs) {
    const wId = item.tab?.windowId;
    const gTitle = item.group?.title || '';
    const gColor = item.group?.color || '';
    const key = `${wId}|${gTitle}|${gColor}`;
    const acc = item.tab?.lastAccessed || 0;
    if (!groupMaxTimeMap.has(key) || acc > groupMaxTimeMap.get(key)) {
      groupMaxTimeMap.set(key, acc);
    }
  }

  for (const snap of undoStack) {
    const t = snap?.tab;
    if (!t?.url) continue; // 防御: 跳过脏/残缺快照

    const createProps = {
      url: t.url,
      active: false,
    };
    if (snap.windowId) createProps.windowId = snap.windowId;
    if (typeof t.index === 'number') createProps.index = t.index;
    if (typeof t.pinned === 'boolean') createProps.pinned = t.pinned;

    let created = null;
    try {
      created = await chrome.tabs.create(createProps);
    } catch {
      // 容错兜底: 若指定 windowId/index 失败(例如原窗口已关或 index 越界), 在当前窗口创建
      try {
        created = await chrome.tabs.create({ url: t.url, active: false });
      } catch (err) {
        console.error('撤销创建标签页失败:', err);
      }
    }

    if (created?.id) {
      restoredTabIds.push({ tabId: created.id, snap });
      newlyCreatedIds.push(created.id);

      // 计算安全的 lastAccessed:
      // 若该组已有其他标签，其时间绝不超过已有标签的最大值，分组在全列表中的相对排位完全保持不变；
      // 若该组无其他标签（整组被关），时间绝不超过全场第一位，绝不顶到第一位。
      const gKey = `${snap.windowId}|${snap.groupTitle || ''}|${snap.groupColor || ''}`;
      let safeLastAccessed = snap.tab?.lastAccessed || 1;
      if (groupMaxTimeMap.has(gKey)) {
        const groupMax = groupMaxTimeMap.get(gKey);
        safeLastAccessed = Math.min(safeLastAccessed, groupMax > 1 ? groupMax - 1 : groupMax);
      } else {
        safeLastAccessed = Math.min(safeLastAccessed, topAccessed > 1 ? topAccessed - 1000 : 1);
      }

      recentlyRestoredTabs.set(created.id, {
        title: t.title || t.url,
        url: t.url,
        favIconUrl: t.favIconUrl || '',
        lastAccessed: safeLastAccessed,
      });
      if (snap.groupTitle) {
        groupsToExpand.add(`${snap.groupTitle}|${snap.groupColor || 'grey'}`);
      }
    }
  }

  // 10s 后清理临时快照, 防内存泄漏
  if (newlyCreatedIds.length) {
    setTimeout(() => {
      for (const id of newlyCreatedIds) recentlyRestoredTabs.delete(id);
    }, 10000);
  }

  undoStack = [];
  clearPushBanners(); // 通知条主动关闭(不等动画)

  // 补归组: 优先找同名同色组; 若原分组因标签清空已销毁则重建
  await regroupRestored(restoredTabIds);

  // 自动展开目标分组, 避免恢复的标签被原收起状态遮挡
  let collapseChanged = false;
  for (const gKey of groupsToExpand) {
    if (collapsed.has(gKey)) {
      collapsed.delete(gKey);
      collapseChanged = true;
    }
    if (searchCollapsed.has(gKey)) {
      searchCollapsed.delete(gKey);
    }
  }
  if (collapseChanged) saveCollapsed();

  // 强制 forceFresh 直查最新标签/分组, 绕过 background 2s 旧快照缓存
  await actions.refreshData({ forceFresh: true });
  actions.render();

  // 保持高亮停留在 [当前tab] (当前激活的标签页), 绝不定位到刚刚 undo 恢复出来的标签
  if (actions.focusCurrentTab) {
    actions.focusCurrentTab();
  }
}

// 把恢复的标签移回原分组: 优先在同窗口找同名同色组; 找不到(组已随关闭销毁)则重建原分组
async function regroupRestored(restored) {
  if (!restored.length) return;
  try {
    const groups = await chrome.tabGroups.query({});
    for (const { tabId, snap } of restored) {
      if (!snap.groupTitle) continue; // 原本就未分组
      let target = groups.find(g =>
        g.windowId === snap.windowId &&
        (g.title || '') === snap.groupTitle &&
        g.color === snap.groupColor
      ) || groups.find(g =>
        (g.title || '') === snap.groupTitle &&
        g.color === snap.groupColor
      );

      if (target) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: target.id }).catch(() => {});
      } else {
        // 原分组已随最后一条标签关闭而自动销毁, 重建同名同色分组
        try {
          const newGroupId = await chrome.tabs.group({
            tabIds: [tabId],
            ...(snap.windowId ? { createProperties: { windowId: snap.windowId } } : {}),
          });
          const updateProps = { title: snap.groupTitle };
          if (snap.groupColor) updateProps.color = snap.groupColor;
          await chrome.tabGroups.update(newGroupId, updateProps);
          groups.push({
            id: newGroupId,
            title: snap.groupTitle,
            color: snap.groupColor,
            windowId: snap.windowId,
          });
        } catch (e) {
          console.error('重建原分组失败:', e);
        }
      }
    }
  } catch (err) {
    console.error('补归组失败:', err);
  }
}

// 关闭栈里全部条目(撤销执行后/清理类操作切换提示时)
export function clearPushBanners() {
  for (const b of [...pushStack.children]) dismissBanner(b);
  clearTimeout(undoTimer);
}
