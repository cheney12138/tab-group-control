// features/undo.js: 撤销关闭(组件)
// 单关路径 showUndo 入栈+渲染;批量清理 pushUndo 逐个入栈后 renderUndoBanner。
import { pushBanner, dismissBanner, pushStack } from '../core/dom.js';
import { MOD } from '../core/platform.js';

let actions = null; // initUndo 注入: { refreshData, render }
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

// 撤销: 从 sessions.getRecentlyClosed 里按 URL 匹配找回真实的 sessionId,
// 恢复后把标签移回原分组(sessions.restore 不触发 onCreated,Tabbiy 感知不到,
// 由我们按关闭时记录的分组名补归组)。sessions 的 sessionId 并非 tab id
export async function doUndo() {
  if (!undoStack.length) return;
  let recent = [];
  try {
    recent = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  } catch (err) {
    console.error('查询最近关闭失败:', err);
  }
  const restoredTabIds = [];
  for (const snap of undoStack) {
    const t = snap?.tab;
    if (!t) continue; // 防御:跳过任何脏/残缺快照,避免一条坏数据打断整批撤销
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
  clearPushBanners(); // 通知条主动关闭(不等动画)
  // 补归组: 找同名分组,把恢复的标签移回去
  await regroupRestored(restoredTabIds);
  await actions.refreshData();
  actions.render();
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

// 关闭栈里全部条目(撤销执行后/清理类操作切换提示时)
export function clearPushBanners() {
  for (const b of [...pushStack.children]) dismissBanner(b);
  clearTimeout(undoTimer);
}
