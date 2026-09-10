// features/clean.js: 清理工具(组件)
// cleanStaleTabs: 批量关闭 stale/zombie 档标签(可撤销);cleanEmptyGroups:
// 清理空壳分组(当前无调用方——入口按钮已不在,功能保留备查)。
import { confirmInPanel, showToast } from '../core/dom.js';
import { timeTier } from '../core/format.js';
import { MOD } from '../core/platform.js';
import { pushUndo, renderUndoBanner } from './undo.js';

let actions = null; // initClean 注入: { getAllTabs, dropTabs, refreshData, render }
export function initClean(injected) { actions = injected; }

// ---- 清理空分组 ----
// Chrome 原生没有任何入口删除"组内标签已全部关闭"的空分组,
// Tabbiy 等自动分组插件会积累空壳。直接 query 全量分组,
// 逐个检查组内标签数,为 0 则 ungroup 不了(空组没有成员)——
// chrome.tabGroups 没有删除 API,空组的清除靠把"组"本身释放:
// 组内无成员时 Chrome 会在最后标签关闭时自动删组,但跨窗口残留的
// 空组(标签被移走而非关闭)只能通过 query 拿到后用 move 0 个标签触发——
// 实际可行解: 空组直接被 Chrome 在 tabs.onRemoved 后异步清理,
// 我们要做的是发现并报告仍存在的空组(极少),不误删有内容的组
export async function cleanEmptyGroups() {
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
    await actions.refreshData();
    actions.render();
  } catch (e) {
    console.error('清理空分组失败:', e);
  }
}

// ---- 清理僵尸标签 ----
// 批量关闭 stale(7~30天) + zombie(30天+) 档位的标签。
// 排除当前激活标签(正在用的不杀);全部进入撤销栈,可 ⌘Z 整批救回
// 确认用面板内提示条(系统 confirm 会被设置的覆盖层遮挡,曾导致无声卡死)
export async function cleanStaleTabs() {
  const targets = actions.getAllTabs().filter(x => {
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
    `发现 ${targets.length} 个 7 天以上未使用的标签,关闭?(${MOD}Z 可撤销)`);
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
      pushUndo({
        tab: x.tab,
        groupTitle: x.group?.title || null,
        groupColor: x.group?.color || null,
        windowId: x.tab.windowId,
      });
    } catch {}
  }
  // 同步本地数据并刷新
  const closedIds = new Set(targets.map(x => x.tab.id));
  actions.dropTabs(closedIds);
  // 循环里已把每个目标快照 push 进 undoStack,这里只渲染撤销条,
  // 不再调 showUndo(它会重复 push 且需要快照对象——之前传裸 Tab 导致崩溃)
  renderUndoBanner();
  await actions.refreshData();
  actions.render();
  if (closedCount > 0) showToast(`已清理 ${closedCount} 个标签,${MOD}Z 可撤销`);
}
