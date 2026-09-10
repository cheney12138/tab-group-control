// features/dnd.js: 跨组拖拽移动(组件)
// 拖拽状态在 core/store.state.draggedTabInfo(render 域的 dragstart/drop 写入,
// 本模块边缘滚动监听读取)。
import { showToast, resultsEl } from '../core/dom.js';
import { state } from '../core/store.js';

let actions = null; // initDnd 注入: { refreshData, render, isGroupedView }
export function initDnd(injected) { actions = injected; }

// 跨组拖拽移动标签
export async function moveTabToGroupAction(draggedInfo, targetGroup) {
  if (!draggedInfo || !draggedInfo.tabId) return;
  const sourceGroupId = draggedInfo.sourceGroupId;
  const targetGroupId = targetGroup && targetGroup.id ? targetGroup.id : null;
  // 同组移动直接忽略
  if (sourceGroupId === targetGroupId) return;

  try {
    if (targetGroupId) {
      await chrome.tabs.group({
        tabIds: [draggedInfo.tabId],
        groupId: targetGroupId
      });
      // 检查目标分组是否为已有规则的分组
      const storedRules = await chrome.storage.local.get('groupRules');
      const rules = (storedRules?.groupRules && typeof storedRules.groupRules === 'object') ? storedRules.groupRules : {};
      const isRuleGroup = targetGroup && targetGroup.title && Object.prototype.hasOwnProperty.call(rules, targetGroup.title);

      const stored = await chrome.storage.local.get('manualTabIds');
      const set = new Set(Array.isArray(stored?.manualTabIds) ? stored.manualTabIds : []);

      if (isRuleGroup) {
        // 移动之后在已有规则的分组下: 不计入白名单; 若此前在白名单中则解除保护, 自动分组照常操作
        if (set.has(draggedInfo.tabId)) {
          set.delete(draggedInfo.tabId);
          await chrome.storage.local.set({ manualTabIds: [...set] });
        }
      } else {
        // 移动之后在非规则分组下(如自定义项目组): 计入白名单保护, 绝不撕裂强拆
        set.add(draggedInfo.tabId);
        await chrome.storage.local.set({ manualTabIds: [...set] });
      }

      showToast(`已将「${draggedInfo.title.slice(0, 14)}」移入「${targetGroup.title || '分组'}」`);
    } else {
      await chrome.tabs.ungroup([draggedInfo.tabId]);
      // 移出到未分组: 计入白名单保护
      const stored = await chrome.storage.local.get('manualTabIds');
      const set = new Set(Array.isArray(stored?.manualTabIds) ? stored.manualTabIds : []);
      set.add(draggedInfo.tabId);
      await chrome.storage.local.set({ manualTabIds: [...set] });

      showToast(`已将「${draggedInfo.title.slice(0, 14)}」移出到「未分组」`);
    }
  } catch (err) {
    console.error('拖拽移动标签失败:', err);
  }

  await actions.refreshData({ forceFresh: true });
  actions.render();
}

// 拖拽边缘自动滚动: 拖拽标签靠近列表上下边缘时, 自动平滑向上或向下滑动 (仅在分组视图下生效)
resultsEl.addEventListener('dragover', (e) => {
  if (!state.draggedTabInfo || !actions.isGroupedView()) return;
  const rect = resultsEl.getBoundingClientRect();
  const threshold = 45;
  const speed = 12;
  if (e.clientY < rect.top + threshold) {
    resultsEl.scrollTop -= speed;
  } else if (e.clientY > rect.bottom - threshold) {
    resultsEl.scrollTop += speed;
  }
});

