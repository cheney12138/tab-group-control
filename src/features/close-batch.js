// features/close-batch.js: 批量关闭的靶子计算与执行(组件)
//
// 靶子定义见 docs/adr/0005-batch-close-target-set.md,三条轴:
//   ① 取数据源(chrome.tabs.query),不取当前过滤视图 —— 数量预告与真的被关的标签
//      必须是同一份数据源,所以菜单算数量和最终执行都走同一个 scope
//   ② 作用域 = 运行时分组实例(windowId + groupId);未分组 = 本窗口内未分组标签。
//      故意不用 groupKey(组名+颜色): 搜索模式的分区是按身份合并的,跟着它走会跨窗口关闭
//   ③ 有序动作(下方)的序 = 组内 lastAccessed 倒序(同刻用 tab.index 兜底),
//      与面板默认视图(render.js 的组内排序)同一把尺子
//
// 计数单位是标签,但**定界单位是行**: 同 URL 的多副本聚合成一行且副本对用户隐形,
// 行要么整体留下要么整体关掉(ADR-0005 轴一推论 2)。所以「其余」和「下方」都先把
// 该行的成员(代表 + 同组副本)摘出去,再取剩下的。
//
// 关闭次序: **先把快照写进 session,最后才 remove** —— 靶子含激活标签时
// Chrome 会当场杀掉 popup(settings.js 的归档路径同款前车之鉴),慢一步就没撤销了。

import { tabItemByTabId } from '../core/store.js';
import { pushUndo, renderUndoBanner, persistUndoBatch } from './undo.js';

let actions = null; // initCloseBatch 注入: { refreshData, render, dropTabs }
export function initCloseBatch(injected) { actions = injected; }

const GROUP_NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

// 按 (窗口, 分组) 取权威成员表 —— 这就是 ADR-0005 轴二的"运行时分组实例"。
// 传 GROUP_NONE 即"本窗口内未分组"。任何一步查不到就返回 null,菜单不弹:
// 宁可不给入口,也不给一个数量算错的破坏性入口。
export async function loadScopeByKey(windowId, groupId, anchor = null) {
  if (windowId == null) return null;
  const [members, group] = await Promise.all([
    chrome.tabs.query({ windowId, groupId }).catch(() => null),
    groupId === GROUP_NONE
      ? Promise.resolve(null)
      : chrome.tabGroups.get(groupId).catch(() => null),
  ]);
  if (!members || !members.length) return null;
  const order = [...members].sort(
    (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || (a.index || 0) - (b.index || 0)
  );
  return { anchor, windowId, groupId, group, members, order, ids: new Set(members.map(t => t.id)) };
}

// 锚点标签所在的作用域(行菜单用)
export async function loadCloseScope(anchorTabId) {
  let anchor;
  try {
    anchor = await chrome.tabs.get(anchorTabId);
  } catch {
    return null;
  }
  return loadScopeByKey(anchor.windowId, anchor.groupId ?? GROUP_NONE, anchor);
}

// 该行(代表 + 同组副本)的成员 id。duplicates 是"同窗口同 URL"口径的, 可能落在
// 别的组里, 必须与作用域求交 —— 否则「其余」会把别的组的同 URL 标签也算进靶子
export function rowMemberIds(anchorTabId, scope) {
  const item = tabItemByTabId(anchorTabId);
  const candidates = [anchorTabId, ...(item?.duplicates || [])];
  return new Set(candidates.filter(id => scope.ids.has(id)));
}

// kind: 'rest'(本组其余) | 'below'(本组下方) | 'all'(本组全部)
// 返回 { ids, count }, count 是**标签**数 —— 它就是菜单里那个 (n), 也是唯一的预告
export function computeTargets(scope, kind, anchorTabId) {
  if (!scope) return { ids: [], count: 0 };
  if (kind === 'all') {
    return { ids: scope.members.map(t => t.id), count: scope.members.length };
  }
  // 锚点必须真的在这个作用域里, 否则「其余」「下方」会退化成「全部」:
  // 菜单项拿到 (0) 被禁用置灰 —— 宁可不给入口, 也不给一个和文案不符的靶子
  if (anchorTabId == null || !scope.ids.has(anchorTabId)) return { ids: [], count: 0 };
  const rowIds = rowMemberIds(anchorTabId, scope);
  if (kind === 'rest') {
    const ids = scope.members.filter(t => !rowIds.has(t.id)).map(t => t.id);
    return { ids, count: ids.length };
  }
  // below: 该行整体是一个单位 —— 以代表在组内时间序里的位置为界, 取它下面的标签,
  // 并摘掉该行自己的成员(否则同一 URL 更旧的副本会被"下方"顺手带走)
  const pos = scope.order.findIndex(t => t.id === anchorTabId);
  if (pos < 0) return { ids: [], count: 0 };
  const ids = scope.order.slice(pos + 1).filter(t => !rowIds.has(t.id)).map(t => t.id);
  return { ids, count: ids.length };
}

// 执行。返回真正下手的标签数(0 = 没动)
export async function runCloseBatch(scope, targetIds) {
  if (!scope || !targetIds.length) return 0;
  const wanted = new Set(targetIds);
  const targets = scope.members.filter(t => wanted.has(t.id));
  if (!targets.length) return 0;

  const snapshots = targets.map(t => ({
    tab: t,
    groupTitle: scope.group?.title || null,
    groupColor: scope.group?.color || null,
    windowId: t.windowId,
  }));
  for (const snap of snapshots) pushUndo(snap);
  // 落凭证必须在 remove 之前: 靶子含激活标签时 popup 会被当场杀掉,
  // 这一步之后本函数剩下的代码可能一行都不会执行
  await persistUndoBatch(snapshots);

  const ids = targets.map(t => t.id);
  try {
    await chrome.tabs.remove(ids);
  } catch (e) {
    // 常见于"标签在本函数执行期间已被关掉"。不回收已入栈的快照 —— 宁可让 ⌘Z 多恢复
    // 几个还活着的标签(用户看得见、可再关), 也不要让真被关掉的标签失去撤销
    console.error('批量关闭失败(部分标签可能已不存在):', e);
  }

  if (actions) {
    actions.dropTabs?.(new Set(ids));
    renderUndoBanner();
    await actions.refreshData({ forceFresh: true });
    actions.render();
  }
  return ids.length;
}
