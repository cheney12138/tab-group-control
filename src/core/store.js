// core/store.js: 跨模块共享状态(逐步收纳,只放"共享实例安全"的可变容器——
// 即只增删改不整体重新赋值的状态;会重新赋值的标量仍留在 main,经注入访问)

// 记录刚刚从归档恢复出的新标签元数据 (解决新开 tab loading 期间 title 和
// url 缺失导致被误判合并且标题空白的问题)。
// 居民: main.js(loadTabs 读取修补) / features/settings.js(恢复时写入,8s 后清理)
export const recentlyRestoredTabs = new Map(); // tabId -> { title, url, favIconUrl }

// 媒体 tab 探测结果: tab.audible 是瞬时状态(暂停即 false),探测补按钮的依据。
// 居民: features/media.js(探测回发记入/patch 查询) / main.js(buildTabRow
// 首帧判断 has-media 并记入曾播放)
export const mediaTabIds = new Set();

// 跨域共享的标量状态(会被重新赋值,只能经对象属性读写):
// activeIndex — 键盘光标位置(main 渲染域/键盘路由 与 features/nav 共享)
// draggedTabInfo — 当前拖拽中的标签(main 渲染域的 dragstart/drop 与 features/dnd 共享)
export const state = {
  activeIndex: -1,
  draggedTabInfo: null,
  // —— 任务 11 状态大迁移: 搜索/渲染/命令/视图的核心状态 ——
  allTabs: [],                 // 全量标签条目(loadTabs 重建)
  filtered: [],                // 当前展示条目(search 重建)
  searching: false,            // 是否搜索态(折叠集合选择/渲染排布依据)
  activeCmd: null,             // slash 命令: null | '/b' | '/h' | '/r'
  view: 'grouped',             // 视图: grouped | recent | current
  currentWindowId: null,       // 弹窗所属窗口
  currentSourceIsHistory: false, // /h 命令模式下行渲染加半透明降级
};

// ---- 折叠状态(从 main.js 迁入,Set 容器共享安全) ----
// chrome 的 groupId 每次启动会变,用 分组名+颜色 做稳定 key
const COLLAPSE_STORE = 'tgs-collapsed';
function collapsedKeys() {
  try {
    // 过滤历史版本 bug 写入的垃圾 key
    const keys = JSON.parse(localStorage.getItem(COLLAPSE_STORE) || '[]')
      .filter(k => k !== '(未命名)|undefined');
    return new Set(keys);
  } catch { return new Set(); }
}
export const collapsed = collapsedKeys();
export function saveCollapsed() {
  localStorage.setItem(COLLAPSE_STORE, JSON.stringify([...collapsed]));
}
// 搜索模式独立的收起状态: 每次开始新搜索时重置为全展开,不持久化
export const searchCollapsed = new Set();
// 当前模式生效的收起集合
export function activeCollapsed() {
  return state.searching ? searchCollapsed : collapsed;
}

// 按 tabId 找 state.allTabs 条目(书签/历史虚拟条目是负 id,天然查不中)。
// state 的衍生查询: render(closeTab 副本晋升) / main(initMedia 注入) 共用
export function tabItemByTabId(tabId) {
  return state.allTabs.find(x => x.tab.id === tabId);
}
