// features/multi-select.js: 多选(Shift 点选 / ⇧↑↓ 区间)与批量关闭(组件)
//
// 选择集存**行的代表 tabId**, 不是 DOM 序号: 重渲染/搜索都不该改变身份。
// 删除的单位是「行」: 同 URL 副本跟着它所在的行一起关(ADR-0005 轴一推论 2 ——
// 行要么整体留下, 要么整体关掉)。所以计数是行数, 真正关掉的标签数可能更多。
//
// 区间选择(⇧↑↓)用「锚点 + 基准集」两件东西算: 每次移动都从基准重算 [锚点, 光标],
// 所以往回走区间会**收窄**, 而不是一路叠加(手感同文件管理器)。基准集 = 开始区间
// 选择之前的选中集 —— 让 Shift 点选出来的零散行不被区间动作整个吞掉。
//
// 选择集只在 render 收尾时对着 state.filtered 剪枝(见 syncMultiSelectionUI):
// 不剪的后果是「搜索缩小范围后按 ⌘⌫, 把看不见的行一起关了」。
import { resultsEl, input, indexOfRow } from '../core/dom.js';
import { state, multiSelected, tabItemByTabId } from '../core/store.js';
import { clearActiveUnit, setActive, scrollPastSticky } from './nav.js';
import { closeTabsByIds } from './close-batch.js';
import { renderEpoch } from './render.js';

let rangeBase = null; // 区间选择开始前的选中快照; null = 当前没有在演区间
const hintEl = document.getElementById('multiHint');
const hintCountEl = document.getElementById('multiHintCount');

export function hasMultiSelection() {
  return multiSelected.size > 0;
}

// 退出多选态(不关标签): Esc / 普通点击 / 批量关闭的前置清理
export function clearMultiSelection() {
  rangeBase = null;
  state.multiAnchor = null;
  multiSelected.clear();
  syncMultiSelectionUI();
}

// Shift+点击: 勾选 / 取消一行
export function toggleMultiSelection(tabId) {
  // 虚拟条目(书签/历史/最近关闭, 负 id)没有关闭语义, 不进选择集
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  rangeBase = null;
  if (multiSelected.has(tabId)) multiSelected.delete(tabId);
  else multiSelected.add(tabId);
  state.multiAnchor = tabId;
  syncMultiSelectionUI();
}

// ⇧↑↓: 光标移到相邻**行**(折叠的分组头不是选择对象, 跳过), 区间从锚点重算。
// 返回是否处理了这次按键
export function extendMultiSelection(dir) {
  const rows = [...resultsEl.querySelectorAll('.tab-item')]
    .filter(r => !r.classList.contains('closing'));
  if (!rows.length) return false;
  const curRow = rows.find(r => r.classList.contains('active')) || rows[0];
  const curIdx = rows.indexOf(curRow);
  const nextIdx = Math.max(0, Math.min(curIdx + dir, rows.length - 1));
  const nextRow = rows[nextIdx];

  // 锚点: 第一次 ⇧↑↓ 就落在"当前停留的那一行"上(还没有选择时, 当前行本身就是第一格)
  const anchorId = state.multiAnchor ?? Number(curRow.dataset.tabId);
  let anchorIdx = rows.findIndex(r => Number(r.dataset.tabId) === anchorId);
  if (anchorIdx < 0) anchorIdx = curIdx; // 锚点行已不在列表里(搜索/收起变化) ⇒ 就地从当前行重锚
  state.multiAnchor = Number(rows[anchorIdx].dataset.tabId);
  if (!rangeBase) rangeBase = new Set(multiSelected);

  // 光标跟着区间端点走。这里不走 nav 的单元序: 单元序里还有"折叠的分组头",
  // 它在选择语义里不是一格 —— ⇧↑↓ 只认标签行
  if (nextRow !== curRow) {
    clearActiveUnit();
    nextRow.classList.add('active');
    scrollPastSticky(nextRow);
    state.activeIndex = indexOfRow(nextRow);
  }
  input.focus();

  const lo = Math.min(anchorIdx, nextIdx);
  const hi = Math.max(anchorIdx, nextIdx);
  multiSelected.clear();
  for (const id of rangeBase) multiSelected.add(id);
  for (let i = lo; i <= hi; i++) {
    const id = Number(rows[i].dataset.tabId);
    if (Number.isInteger(id) && id > 0) multiSelected.add(id);
  }
  syncMultiSelectionUI();
  return true;
}

// 把 .multi-selected / 底部计数条对齐到当前列表与选择集。
// 每次选择变化和每次 render 收尾都调(重渲染会扔掉所有行节点, 类必须重贴)
export function syncMultiSelectionUI() {
  const liveIds = new Set();
  for (const item of state.filtered) if (item.tab.id > 0) liveIds.add(item.tab.id);
  let pruned = false;
  for (const id of [...multiSelected]) {
    if (!liveIds.has(id)) { multiSelected.delete(id); pruned = true; }
  }
  if (pruned && rangeBase) {
    for (const id of [...rangeBase]) if (!liveIds.has(id)) rangeBase.delete(id);
  }
  if (state.multiAnchor != null && !multiSelected.size) state.multiAnchor = null;

  for (const row of resultsEl.querySelectorAll('.tab-item')) {
    row.classList.toggle('multi-selected', multiSelected.has(Number(row.dataset.tabId)));
  }

  const count = multiSelected.size;
  if (hintCountEl) hintCountEl.textContent = String(count);
  if (hintEl) hintEl.setAttribute('aria-hidden', count ? 'false' : 'true');
  document.body.classList.toggle('multi-mode', count > 0);
}

// ⌘⌫: 关掉所有选中行(带动画 + 撤销)。返回真正关掉的标签数
export async function closeMultiSelection() {
  const rows = [...resultsEl.querySelectorAll('.tab-item')]
    .filter(r => !r.classList.contains('closing'));
  const selectedIdx = [];
  rows.forEach((r, i) => { if (multiSelected.has(Number(r.dataset.tabId))) selectedIdx.push(i); });
  if (!selectedIdx.length) return 0;

  // 靶子 = 行成员(代表 + 同 URL 副本)。副本在列表里没有自己的行,
  // 但行的删除语义是"整体关掉" —— 逐份删除是单行 ⌘⌫ 的语义, 不是多选
  const ids = new Set();
  for (const id of multiSelected) {
    ids.add(id);
    for (const dup of tabItemByTabId(id)?.duplicates || []) ids.add(dup);
  }

  // 焦点落点: 选区之后的第一行, 没有就回退到选区之前的第一行
  const isSelected = r => multiSelected.has(Number(r.dataset.tabId));
  const after = rows.slice(selectedIdx[selectedIdx.length - 1] + 1).find(r => !isSelected(r));
  const before = rows.slice(0, selectedIdx[0]).reverse().find(r => !isSelected(r));
  const focusId = after ? Number(after.dataset.tabId)
    : (before ? Number(before.dataset.tabId) : null);
  const fallbackIdx = selectedIdx[0];

  // 先清选择态: 收起动画自己负责退场, 选中色不该跟着演一遍
  clearMultiSelection();

  const epochAtClose = renderEpoch; // 关闭开始前采样(⚠️ closeTabsByIds 自身会 render, 见下)
  const count = await closeTabsByIds([...ids]);

  // 纪元护栏(2026-11-14 review P2-3): closeTabsByIds 正常收尾自己 render ⇒ 纪元必然
  // 变化 ⇒ 这里的 setActive 属于"动画窗口内的晚到焦点", 会让路; 但它的落点(focusId
  // 按**行身份**算)不受重绘影响 —— 只在别人插队(⌘Z/搜索)时让, 自己的收尾不算插队。
  const superseded = renderEpoch !== epochAtClose + 1; // +1 = 只有本趟的收尾重绘
  // 重渲染之后才落焦点(closeTabsByIds 内部已 await 收起动画 + render)
  const newRows = [...resultsEl.querySelectorAll('.tab-item')];
  if (!newRows.length) return count;
  if (superseded) return count; // 别人插队: 焦点归那一次所有
  const target = focusId == null ? -1
    : newRows.findIndex(r => Number(r.dataset.tabId) === focusId);
  setActive(target >= 0 ? target : Math.min(fallbackIdx, newRows.length - 1));
  return count;
}
