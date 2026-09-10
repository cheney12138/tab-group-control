// features/views.js: 视图切换(组件) grouped / recent / current
// 纯模块(依赖全部可 import,无需注入): state.view 共享于 core/store.state
import { positionTabSlider, input } from '../core/dom.js';
import { state } from '../core/store.js';
import { search, searchValue } from './search.js';
import { render } from './render.js';
import { setActive, focusCurrentTab } from './nav.js';

export const VIEWS = ['grouped', 'recent', 'current'];
// state.view 启动校正: 读 localStorage 恢复用户视图偏好
state.view = VIEWS.includes(localStorage.getItem('tgs-view')) ? localStorage.getItem('tgs-view') : 'grouped';

const viewTabs = [...document.querySelectorAll('.view-tab')];
// 滑块定位: 让共享指示条平滑滑到当前激活 tab 的位置(两种 Tab 栏共用)。
export function setView(v) {
  if (v === state.view) return;
  state.view = v;
  localStorage.setItem('tgs-view', v);
  viewTabs.forEach(b => b.classList.toggle('active', b.dataset.view === v));
  state.activeIndex = -1;
  search(searchValue());
  render();
  // 延后一帧再量算: 避免在 render() 重建列表的同一任务里强制同步布局,
  // 那会把长任务压在滑块过渡起始帧上(表现为开头顿一下)
  requestAnimationFrame(() => positionTabSlider(document.querySelector('.view-tabs')));
  // 空查询时定位当前标签,搜索时选第一条
  if (state.filtered.length) {
    if (state.searching) setActive(0);
    else focusCurrentTab();
  }
}
viewTabs.forEach(b => b.addEventListener('click', () => {
  setView(b.dataset.view);
  input.focus();
}));
// 初始化时应用已保存的视图
viewTabs.forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
positionTabSlider(document.querySelector('.view-tabs'));
