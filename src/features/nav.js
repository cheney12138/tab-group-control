// features/nav.js: 键盘光标与滚动原语(组件)
// setActive/navUnits/clearActiveUnit 统一编址(仅标签行),←→/↑↓/Enter 共用。
import { resultsEl } from '../core/dom.js';
import { groupKey } from '../core/format.js';
import { state } from '../core/store.js';

let actions = null; // initNav 注入: { getFiltered, getCurrentWindowId }
export function initNav(injected) { actions = injected; }

// 根据 tabId 找到其所在分组的对象及组内第一个可见标签的 id(展开后定位用)
export function findGroupOfTab(tabId) {
  const item = actions.getFiltered().find(f => f.tab.id === tabId);
  if (!item || !item.group) return null;
  // 未分组的标签没有可收起的分组头
  const sameGroup = actions.getFiltered().filter(f => f.group && groupKey(f.group) === groupKey(item.group));
  if (!sameGroup.length) return null;
  return { group: item.group, firstTabId: sameGroup[0].tab.id };
}

// 滚入可视区,自动避开吸顶分组头: scrollIntoView({block:'nearest'})
// 只保证进入容器视口,元素可能停在 sticky 组头底下被盖住——
// 手动计算: 目标行顶部距容器顶部不足组头高度(~23px)时额外下滚
export function scrollPastSticky(el) {
  el.scrollIntoView({ block: 'nearest' });
  const container = resultsEl;
  const stickyH = 30; // 分组头: 8px+6px padding + 16px 内容行高
  // scrollIntoView 后二次校正: 若行顶落在吸顶组头底下,补滚 stickyH
  const above = (el.offsetTop - container.offsetTop) - container.scrollTop;
  if (above < stickyH) {
    container.scrollTop -= (stickyH - above);
  }
}

export function setActive(idx) {
  const rows = resultsEl.querySelectorAll('.tab-item');
  if (!rows.length) return;
  clearActiveUnit();
  state.activeIndex = Math.max(0, Math.min(idx, rows.length - 1));
  const el = rows[state.activeIndex];
  if (el) {
    el.classList.add('active');
    scrollPastSticky(el);
  }
}

// 定位当前标签: 只认 active 且属于弹窗所在窗口的行。
// 多窗口时每个窗口各有一个 active 标签,不加窗口条件会定位到别的窗口去
export function focusCurrentTab() {
  const rows = [...resultsEl.querySelectorAll('.tab-item')];
  const currentRow = rows.find(r => {
    const f = actions.getFiltered().find(x => x.tab.id === Number(r.dataset.tabId));
    return f && f.tab.active
      && (actions.getCurrentWindowId() == null || f.tab.windowId === actions.getCurrentWindowId());
  });
  setActive(currentRow ? rows.indexOf(currentRow) : 0);
}

// 可聚焦单元 = 仅标签行,统一编址,上下移动/Enter/快捷键共用,越过分组头
export function navUnits() {
  return [...resultsEl.querySelectorAll('.tab-item')];
}
export function clearActiveUnit() {
  resultsEl.querySelectorAll('.tab-item, .group-header').forEach(u => u.classList.remove('active'));
}
