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

// ---- 拖到面板外 = 新建窗口(等价 Chrome 把标签页拖出来) ----
// 这是**唯一**的"拖出面板"动作: 拖出面板只做"移到新窗口", 不附送关闭/归档/建组等其他语义。
//
// 为什么在**离开窗口的那一刻**就动手, 而不是等 dragend:
//   ① 拖到面板外的 drop 发生在文档之外, 面板里根本收不到(浏览器约束, 不是选择);
//   ② 更要命的是: 指针一离开面板, 这个 action popup 会被 Chrome 关掉 —— 文档连同 JS 一起销毁,
//      后面根本不会有 dragend 送到。等 dragend = 等一个永远不来的事件(实测踩坑: 拖出去没反应)。
//   所以用 document dragleave(relatedTarget === null = 离开窗口, 此时 popup 还活着)当**扳机**,
//   把标签交给 chrome.windows.create({ tabId })。内部 drop 仍然优先:
//   真在面板里落过就不建窗口(drop 会冒到 document, 置 droppedInside)。
//
// 两道防误触阈值(都要过):
//   ① **离面板边缘的距离** DRAG_OUT_EDGE_MARGIN —— 离开窗口的那个 dragleave 事件带的是越界后的
//      坐标, 用它量越界量: 只出界一点点(拖到靠边的分组/行时蹭出去)不算数, 要真拖出去;
//   ② **在面板外停留的时长** DRAG_OUT_DWELL_MS —— 蹭一下就回来(dragenter)会取消计时。
const DRAG_OUT_DWELL_MS = 200;
const DRAG_OUT_EDGE_MARGIN = 50;
let dragLeftWindow = false;
let droppedInside = false;
let externalHandled = false;
let dwellTimer = null;

function cancelDwell() {
  if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
}

export function beginTabDrag() {
  dragLeftWindow = false;
  droppedInside = false;
  externalHandled = false;
  cancelDwell();
  edgeRect = null; // 重新量一次列表矩形(拖拽期间不再量)
  edgeDir = 0;
  // 提示条按当前视图换文案: 平铺视图(最近使用/当前窗口)没有分组落点, 只说拖出去
  const hint = document.getElementById('dragHint');
  if (hint) {
    hint.textContent = (actions && actions.isGroupedView())
      ? '拖到分组上移动 · 拖到面板外新建窗口'
      : '拖到面板外新建窗口';
  }
  document.body.classList.add('dragging'); // 拖拽提示条 / 行样式靠它
}

// 指针是否离面板边缘**足够远**(越过四边各 DRAG_OUT_EDGE_MARGIN px 以上才算拖出去)。
// 只贴边蹭出去(出界 1~2px)不算 —— popup 很小, 拖到靠边的分组/行极易发生。
function beyondEdge(x, y, m = DRAG_OUT_EDGE_MARGIN) {
  return x <= -m || y <= -m || x >= window.innerWidth + m || y >= window.innerHeight + m;
}

document.addEventListener('dragleave', (e) => {
  // relatedTarget === null = 离开窗口; 再要求越界够远(内部元素间切换 relatedTarget 非 null, 不会误判)
  if (!e.relatedTarget && beyondEdge(e.clientX, e.clientY)) {
    dragLeftWindow = true;
    armDragOut(e.clientX, e.clientY); // 离开窗口 → 开始计时(popup 可能很快被关, 所以不能等 dragend)
  }
}, true);
document.addEventListener('dragenter', (e) => {
  if (!e.relatedTarget) { dragLeftWindow = false; cancelDwell(); } // 蹭回面板里 → 取消, 不算拖出去
}, true);
document.addEventListener('drop', () => { droppedInside = true; cancelDwell(); }, true);

// 在面板外待够 DRAG_OUT_DWELL_MS 才动手; 没待够就回来 = 误触, 自然被 cancelDwell 取消
function armDragOut(x, y) {
  if (externalHandled || droppedInside) return;
  const info = state.draggedTabInfo;
  if (!info || !(info.tabId > 0)) return;
  if (!beyondEdge(x, y)) return; // 越界够远才算拖出去
  cancelDwell();
  dwellTimer = setTimeout(() => {
    dwellTimer = null;
    if (externalHandled || droppedInside) return;
    externalHandled = true;
    moveTabToNewWindow(info); // 不 await: popup 可能马上被关
  }, DRAG_OUT_DWELL_MS);
}

// dragend 时调用(在 draggedTabInfo 被清掉前传入)。返回是否新建了窗口(便于回报/测试)
export async function finishTabDrag(draggedInfo, endEvent) {
  document.body.classList.remove('dragging');
  cancelDwell();
  const handled = externalHandled;
  const evtOutside = endEvent && typeof endEvent.clientX === 'number'
    && beyondEdge(endEvent.clientX, endEvent.clientY);
  const external = !droppedInside && (dragLeftWindow || evtOutside);
  dragLeftWindow = false;
  droppedInside = false;
  externalHandled = false;
  if (handled || !external || !draggedInfo || !(draggedInfo.tabId > 0)) return false;
  await moveTabToNewWindow(draggedInfo);
  return true;
}

// 与 Chrome 原生"把标签拖出来"同一个动作: chrome.windows.create 传 tabId = 把该标签搬进新窗口
async function moveTabToNewWindow(draggedInfo) {
  try {
    await chrome.windows.create({ tabId: draggedInfo.tabId, focused: true });
  } catch (err) {
    console.error('拖到面板外新建窗口失败:', err);
    return;
  }
  // 标签已不在本窗口, 刷新列表。新窗口聚焦会让 popup 失焦关闭, 这里是尽力而为
  await actions.refreshData({ forceFresh: true });
  actions.render();
}

// 拖拽边缘自动滚动: 拖拽标签靠近列表上下边缘时自动滚动(仅分组视图)。
// 两个性能点 —— 这是拖拽掉帧的真凶之一:
//   ① 绝不在 dragover 里调 getBoundingClientRect(): dragover 每秒几十次, 每次都强制同步布局;
//      而拖拽期间 DOM 一直在变(drop-target 增删), 于是每帧一次全量 reflow。矩形是滚动容器相对
//      视口的, 拖拽期间不变 —— 缓一次就够。
//   ② 滚动交给 rAF 驱动, 不跟着 dragover 的事件频率走(事件密得离谱时滚得也更匀)
let edgeRect = null;
let edgeDir = 0;     // -1 上 / 1 下 / 0 停
let edgeRaf = null;

function edgeTick() {
  if (!state.draggedTabInfo) { edgeRaf = null; edgeDir = 0; return; } // 拖拽结束自停
  if (edgeDir) resultsEl.scrollTop += edgeDir * 14;
  edgeRaf = requestAnimationFrame(edgeTick);
}

resultsEl.addEventListener('dragover', (e) => {
  if (!state.draggedTabInfo || !actions.isGroupedView()) { edgeDir = 0; return; }
  if (!edgeRect) edgeRect = resultsEl.getBoundingClientRect();
  const threshold = 45;
  if (e.clientY < edgeRect.top + threshold) edgeDir = -1;
  else if (e.clientY > edgeRect.bottom - threshold) edgeDir = 1;
  else edgeDir = 0;
  if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeTick);
});

