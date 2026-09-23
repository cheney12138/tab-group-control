// features/contextmenu.js: 标签行 / 分组头的右键菜单(组件)
//
// 为什么自绘: chrome.contextMenus 的 contexts 只覆盖网页 / 选区 / 工具栏图标,
// 扩展弹窗内部没有注册入口 —— 原生 API 到不了这儿。这是约束,不是口味。
//
// 菜单只放"用户真要从这里取用"的动作,不为对称 / 锚点 / 习惯凑项:
//   不放「关闭此标签页」—— ✕ 就在同一行右手边
//   不放「折叠 / 展开本组」—— 左键点组头就是它
// 唯一的例外是「归档此分组」: 它另有入口(组头 hover 浮现的归档按钮),但那个入口
// 太隐秘 —— 留它反而是为了把"暂存"摆到"丢弃"旁边。行菜单与组头菜单都放它:
// 标签行的关闭类动作旁边就是最自然的取用处,不该逼用户先找到组头再右键。
// 归档是**组级管理动作**(需要分组身份, CONTEXT.md): 行没有所属组(未分组散标签)
// 就不给这一项, 与组头菜单的"未分组分区没有归档"同一条边界。
//
// 防呆(全部来自 docs/adr/0005): 数量按数据源算并内嵌进文案; 靶子为空则禁用置灰
// 而不是隐藏(菜单结构不随上下文变形); 危险项排最下、隔一条分隔线、走各主题自己的
// --danger 系色 —— 红不只要看得见, 还要是这套主题的红。
//
// 键盘边界: 菜单**不夺焦点**(mousedown 上 preventDefault), 搜索框始终持焦, 关掉
// 菜单可以直接继续打字; 只响应 Esc, 菜单内的方向键选择与快捷键一律不做。

import { state } from '../core/store.js';
import { loadCloseScope, loadScopeByKey, computeTargets, runCloseBatch } from './close-batch.js';
import { archiveGroupAction } from './settings.js';

// 菜单自己不碰数据: 靶子算完直接交给 close-batch 的 runCloseBatch(它负责撤销条与刷新)。
// 所以本模块**没有 initX 接线**, 不存在"忘了初始化"这种失灵模式。
const GROUP_NONE = -1;
let menuEl = null;
let openToken = 0; // 异步取 scope 期间用户又右键了别处 → 旧的那次作废

function onDocMouseDown(e) {
  if (menuEl && !menuEl.contains(e.target)) closeContextMenu();
}
function onKeyDown(e) {
  if (e.key !== 'Escape') return;
  // 先于 main 的全局 Esc 路由关掉菜单(否则会顺手把设置面板也关了)
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();
}

export function closeContextMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.removeEventListener('mousedown', onDocMouseDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('scroll', closeContextMenu, true);
  window.removeEventListener('resize', closeContextMenu);
  window.removeEventListener('blur', closeContextMenu);
}

export function isContextMenuOpen() { return !!menuEl; }

// spec: [{ label, run, danger?, disabled? } | { sep: true }]
function renderMenu(spec, x, y) {
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');
  // 不夺焦点: 面板的架构是"搜索框恒持焦点", 点菜单不该把它抢走
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });

  for (const item of spec) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      el.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '');
    row.setAttribute('role', 'menuitem');
    row.textContent = item.label;
    if (item.disabled) {
      row.setAttribute('aria-disabled', 'true');
    } else {
      row.addEventListener('click', () => {
        closeContextMenu();
        item.run();
      });
    }
    el.appendChild(row);
  }

  document.body.appendChild(el);
  place(el, x, y);
  menuEl = el;
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('scroll', closeContextMenu, true); // 列表一滚, 菜单锚点就失效了
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);
}

// 贴边翻转。菜单挂 body + fixed 定位, 所以不会被 #results 的滚动容器裁掉
function place(el, x, y) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + r.width > vw - 4) left = vw - r.width - 4;
  if (top + r.height > vh - 4) top = y - r.height;
  el.style.left = `${Math.round(Math.max(4, left))}px`;
  el.style.top = `${Math.round(Math.max(4, top))}px`;
}

function displayName(scope) {
  return scope.group?.title || '(未命名分组)';
}

// 行菜单。tabId 必须是真实存活标签的行(虚拟条目在 render 侧就不会挂上来)
export async function openTabMenu(tabId, x, y) {
  closeContextMenu();
  const token = ++openToken;
  const scope = await loadCloseScope(tabId);
  if (token !== openToken || !scope) return;

  const ungrouped = scope.groupId === GROUP_NONE;
  const allLabel = ungrouped
    ? '关闭本窗口未分组标签'
    : `关闭「${displayName(scope)}」全部标签`;

  const spec = [];
  // 文案口径: 「其余」= 本组除本行外的全部;「下方」= **本组里、本行之后**的标签
  // (不是"组下面那一组", 也不是跨组的下方) —— 靶子见 ADR-0005 轴三
  for (const [kind, label] of [['rest', '关闭本组其余标签'], ['below', '关闭本组此标签下方标签']]) {
    const { ids, count } = computeTargets(scope, kind, tabId);
    spec.push({
      label: `${label} (${count})`,
      disabled: count === 0, // 禁用而不是隐藏: 让"这里本来有这个能力"可见
      run: () => runCloseBatch(scope, ids),
    });
  }
  spec.push({ sep: true });
  const all = computeTargets(scope, 'all', tabId);
  spec.push({
    label: `${allLabel} (${all.count})`,
    danger: true,
    run: () => runCloseBatch(scope, all.ids),
  });
  // 组级管理动作: 行有分组身份才给。靶子是该行所属的**整组**(运行时实例),
  // 与组头菜单/hover 按钮是同一个 archiveGroupAction —— 不分叉、不新增逻辑。
  // 排最下: 归档顺带关闭标签, 但承诺是"留存", 不与上面的"丢弃"混色
  if (scope.group) {
    spec.push({ sep: true });
    spec.push({ label: `归档「${displayName(scope)}」分组`, run: () => archiveGroupAction(scope.group) });
  }
  renderMenu(spec, x, y);
}

// 组头菜单。group 为 null = 未分组分区(它没有组名, 只能靠"本窗口"交代作用域)。
// scopeWindowId 由 render 传下来: 未分组分区必须知道自己属于哪个窗口,
// 否则多窗口下右键任一未分组分区都会去关当前窗口那一堆。
export async function openGroupMenu(group, scopeWindowId, x, y) {
  closeContextMenu();
  const token = ++openToken;
  const windowId = group ? group.windowId : (scopeWindowId ?? state.currentWindowId);
  const scope = await loadScopeByKey(windowId, group ? group.id : GROUP_NONE);
  if (token !== openToken || !scope) return;

  const all = computeTargets(scope, 'all', null);
  const label = group
    ? `关闭「${displayName(scope)}」全部标签 (${all.count})`
    : `关闭本窗口未分组标签 (${all.count})`;
  const spec = [{ label, danger: true, run: () => runCloseBatch(scope, all.ids) }];
  if (group) {
    spec.push({ sep: true });
    // 与组头 hover 浮现的归档按钮是**同一个** archiveGroupAction: 不分叉、不新增逻辑
    // (归档 = 拍归档卡 + 关闭组内全部标签, 它是"暂存", 与上面的"丢弃"成对出现)
    spec.push({ label: '归档此分组', run: () => archiveGroupAction(group) });
  }
  renderMenu(spec, x, y);
}
