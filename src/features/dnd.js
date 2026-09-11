// features/dnd.js: 跨组拖拽移动(组件)
// 拖拽状态在 core/store.state.draggedTabInfo(render 域的 dragstart/drop 写入,
// 本模块边缘滚动监听读取)。
// 落进规则组时让该组规则收下这个标签的域名(原本在别组则从旧组摘掉、改隶过来),
// 见 addDraggedTabHostToRule:只挪标签不改规则的话,自动引擎下一轮就按旧规则
// 把它拉回去,这次拖拽当场被回滚。落点是自定义组/未分组时不碰规则。
import { showToast, resultsEl } from '../core/dom.js';
import { state } from '../core/store.js';
import { addDraggedTabHostToRule } from './rules.js';

let actions = null; // initDnd 注入: { refreshData, render, isGroupedView }
export function initDnd(injected) { actions = injected; }

// 跨组拖拽移动标签。
// 同组落点不搬标签,但规则同步照跑——标签已经在组里而域名还没进规则时,
// 拖一下就是让规则收下它的机会(否则这种不一致只能靠拖出去再拖回来修)
export async function moveTabToGroupAction(draggedInfo, targetGroup) {
  if (!draggedInfo || !draggedInfo.tabId) return;
  const tabId = draggedInfo.tabId;
  const sourceGroupId = draggedInfo.sourceGroupId;
  const targetGroupId = targetGroup && targetGroup.id ? targetGroup.id : null;
  const sameGroup = sourceGroupId === targetGroupId;
  const label = (draggedInfo.title || '标签页').slice(0, 14);

  let ruleNote = '';      // 规则同步结果的说明文案
  let ruleChanged = false; // 本次是否真的改写了规则(纯同组空拖不该有提示噪音)
  try {
    // 物理移动;同组落点跳过——标签本来就在那
    if (!sameGroup) {
      if (targetGroupId) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: targetGroupId });
      } else {
        await chrome.tabs.ungroup([tabId]);
      }
    }

    // 检查目标分组是否为已有规则的分组
    const storedRules = await chrome.storage.local.get('groupRules');
    const rules = (storedRules?.groupRules && typeof storedRules.groupRules === 'object') ? storedRules.groupRules : {};
    const isRuleGroup = !!(targetGroupId && targetGroup?.title
      && Object.prototype.hasOwnProperty.call(rules, targetGroup.title));

    const stored = await chrome.storage.local.get('manualTabIds');
    const set = new Set(Array.isArray(stored?.manualTabIds) ? stored.manualTabIds : []);
    const wasManual = set.has(tabId);

    if (targetGroupId && isRuleGroup) {
      // 规则组: 让规则真正接管这个域名(已在别组则改隶过来)
      const res = await addDraggedTabHostToRule(draggedInfo.url, targetGroup.title, { silent: true });
      if (res.status === 'invalid') {
        // 取不到域名(非 http(s)): 规则管不了这个标签 → 保留人工保护
        set.add(tabId);
        ruleNote = '没识别出这个标签的域名,规则未改动';
      } else {
        // 规则已接管 → 交还自动引擎
        set.delete(tabId);
        if (res.status === 'added') { ruleNote = '域名已加入本组规则'; ruleChanged = true; }
        else if (res.status === 'moved') { ruleNote = `域名已从「${res.from}」改隶本组规则`; ruleChanged = true; }
        else ruleNote = '域名已在本组规则内';
      }
    } else {
      // 自定义项目组 / 未分组: 不碰规则, 只计入白名单保护, 绝不撕裂强拆
      set.add(tabId);
    }
    if (set.has(tabId) !== wasManual) {
      await chrome.storage.local.set({ manualTabIds: [...set] });
    }

    if (!sameGroup) {
      showToast(targetGroupId
        ? `已将「${label}」移入「${targetGroup.title || '分组'}」${ruleNote ? ',' + ruleNote : ''}`
        : `已将「${label}」移出到「未分组」`);
    } else if (ruleChanged) {
      // 同组落点: 标签没动,唯一有意义的产出就是规则同步
      showToast(`已把「${label}」的域名并入「${targetGroup?.title || '本组'}」规则`);
    }
  } catch (err) {
    console.error('拖拽移动标签失败:', err);
  }

  // 规则变动会让 background 重新归组(可能搬动同域名的其他标签),直查刷新
  if (!sameGroup || ruleChanged) {
    await actions.refreshData({ forceFresh: true });
    actions.render();
  }
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

