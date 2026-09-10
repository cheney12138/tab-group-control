# popup.js 组件化拆分：方案与迁移记录

> 起因：popup.js 涨到 3500+ 行，15 个功能域混在一个文件。
> 目标：按前端"组件"概念拆成 ES Modules，**零构建、零依赖、逻辑零改动纯搬家**。

## 技术路线（已确认）

- popup.html：`<script type="module" src="src/main.js">`（MV3 CSP `script-src 'self'` 原生支持）
- **pinyin-data.js / rules-match.js 不动**：classic 脚本顶层 `const`/`function` 声明进入全局词法环境/window，module 可直接读取；background.js 的 `importScripts('rules-match.js')` 不受影响
- module 默认严格模式 + defer 加载：已排查无隐式全局、无 `with`/`arguments.callee` 等禁项；defer 与原 body 末尾加载行为一致

## 目标结构

```
src/
  main.js            入口编排：初始化顺序、全局快捷键
  core/
    store.js         共享状态(allTabs/filtered/activeIndex/collapsed/view/settings…)+订阅
    dom.js           showToast、confirmInPanel、pushBanner、escapeHtml
    format.js        relativeTime、timeTier、displayUrl、hostOf、cleanTitle、isBadTitle
    pinyin.js        拼音匹配(包 pinyin-data 全局表)
  features/
    search.js  render.js  media.js  undo.js  clean.js
    commands.js  views.js  nav.js  dnd.js
    settings.js  archive.js  rules.js
```

**依赖规则**：`features/*` 只依赖 `core/*`；feature 之间不互相 import，经 store 共享状态——杜绝循环依赖。

**语法检查**（node v18 的 `--check` 不认 .js 里的 ESM）：
`cp src/xxx.js /tmp/check.mjs && node --check /tmp/check.mjs`

## 迁移进度（每步需用户重载扩展冒烟确认）

| # | 任务 | 状态 |
|---|---|---|
| 5 | 骨架：module 入口 + main.js 原样接管 | ✅ 完成（git mv popup.js→src/main.js，popup.html 改 type=module；双模式语法检查通过）——待用户冒烟 |
| 6 | core：format / dom / pinyin / store | ✅ 完成（format/dom/pinyin 三模块切出，main.js 3509→3274 行；**store 推迟**：各 feature 切出时按需带入，避免一次性几百处机械替换；faviconLetter/buildFaviconEl 因依赖 textToPinyin 留 render 域防循环 import）——待用户冒烟 |
| 7 | features/rules.js 规则编辑器 | ✅ 完成（646 行切出，main.js 3274→2641；对外接口仅 `loadRulesForEdit`；边界切割发现键盘路由 ESC 分支引用 `groupPop`/`closeGroupPop`——export `isGroupPopOpen()` 查询函数而非可变变量本身）——待用户冒烟 |
| 8 | features/archive.js + settings.js | ✅ 完成（**合并为 settings.js**，560 行：共面板、互调密集——openSettingsPanel→renderArchivedList、restore→closeSettingsPanel。main.js 2660→2085）——待用户冒烟 |

### 任务 8 落地记录

- **新增 core/colors.js**（两个色板，render 域与归档卡片共享）、**core/store.js**（首个居民 `recentlyRestoredTabs`——Map 只增删不重新赋值，共享实例安全；会重新赋值的标量仍走注入）
- **core/dom.js 增补** `positionTabSlider`（纯 DOM，settings/views 共用）
- **时序陷阱**：模块顶层在 import 阶段执行、actions 未注入——元素引用与监听注册全部收进 `initSettings(actions)`，顶层只留纯函数；`updateSettingsBadge` 等加 `if (!settingsBtn) return` 防呆
- **注入清单**：refreshData / render / focusInput / getAllTabs / getSettings / saveSettings / cleanStale / afterRestore
- **export**：initSettings / archiveGroupAction / updateSettingsBadge / isSettingsOpen / closeSettingsPanel / toggleSettingsPane
- **键盘路由**：`settingsPanel.classList` 4 处 → `isSettingsOpen()`（`closing` 类全项目无生产者，死检查随之消除）；`closest('#settingsPanel')` 是字符串选择器不动
- **教训**：sed 按行号删除前必须数清函数体行数——误删 `function setView(v) {` 函数头一行，node --check 立即发现并补回
- **python 断言保护**：8 个替换块全部 `assert in/count`，缩进差异用正则保留缩进替换
- **事故与修复**：`buildInkBleedSvg` 被 settings（归档卡片）和 main render 域（水墨分组头 countEl）**共用**，搬进 settings.js 后 render 域 ReferenceError、列表空白。修复：移至 core/colors.js（主题视觉素材的正确归属），两侧 import。**教训：残留扫描必须双向**——搬走函数的"定义"要扫，"调用点"也要扫（本次只扫了定义）；验证清单应列出搬走函数的完整调用方清单逐一确认 import 覆盖
| 9 | features/media.js + undo.js + clean.js | ✅ 完成（media 220 / undo 137 / clean 109 行，main.js 2085→1656）——待用户冒烟 |

### 任务 9 落地记录

- **新增 core/platform.js**（IS_MAC/MOD）；**core/dom.js 增补** `resultsEl`（全局单例容器，与 pushStack 同款）+ `rowByTabId`/`indexOfRow`（纯 DOM 行查询）；`tabItemByTabId` 依赖 allTabs 留 main
- **注入**：media `{getAllTabs, getTabItem}`；undo `{refreshData, render}`；clean `{getAllTabs, dropTabs, refreshData, render}`——`dropTabs` 解决 cleanStaleTabs 对 `allTabs` 的**重新赋值**（getter 注入覆盖不了的形态）
- **undo.js 新增 `pushUndo`**：cleanStaleTabs 循环直接入栈不走 showUndo（防重复渲染），undoStack 会被重新赋值故不能共享实例
- **clean → undo 单向 import**（pushUndo/renderUndoBanner）：feature 间依赖规则从"不互相 import"明确为"**禁止循环，允许单向**"（settings→rules 已是先例）
- **cleanEmptyGroups 全项目无调用方**（入口按钮早已不存在）：保留搬运并标注，删除决策留给专门清理
- **事故与修复**：media 域切割区间（121-353）误包了 main 的 `tabs.onUpdated` listener + `scheduleGroupRefresh`（groupId 刷新修复）——media.js 里出现未定义引用、main.js 里功能丢失。修复：media.js 删混入段、main.js 补回 listener 路由。**教训：切割区间含"域边界模糊带"（listener/路由）时必须先确认归属再切**
- **事故与修复 2**：`mediaTabIds`（模块级 Set 状态）被 media.js 和 main render 域（buildTabRow 首帧判断）共享，封进 media.js 自含后 render ReferenceError、列表空白。修复：升入 core/store.js 做第二个居民。**教训：残留扫描对象不只函数——模块级状态/常量同样要做"调用方清单逐一确认"**；共享容器（Set/Map 只增删）一律上 store，不封进单个 feature
| 10 | ~~commands/views~~ nav + dnd（边界调整） | ✅ 完成（nav 71 / dnd 75 行，main.js 1656→1524）——待用户冒烟 |

### 任务 10 落地记录

- **边界调整（重要）**：反向引用枚举发现 `activeCmd`（27 处）、`view`（17 处）与任务 11 的 search/render 域深度纠缠，现在切要改 40+ 处中间态引用——**commands/views 并入任务 11** 与 search/render 一起切（状态大迁移一次完成），本任务只切 nav + dnd
- **store.js 引入 `state` 对象**：`{activeIndex, draggedTabInfo}`——多写点标量（activeIndex 写入点分散在 5 个函数）不适合 get/set 封装，经对象属性读写是全项目统一形态，任务 11 的 activeCmd/view/searching 顺势并入
- **groupKey 移至 core/format.js**（纯函数）
- **locateCurrentTab 留 main**：依赖 11 个 main 状态（搜索复位/折叠管理/定位的复合动作），注入不合理；focusGroupHeader 确认死函数（无调用方），搬 nav.js 标注保留
- **流程修正生效**：切割前先跑反向引用枚举（域内每个标识符 → main 全局使用点），本任务零事故
| 11 | render+search+views，main 瘦身 | ✅ 完成（render 577 / search 395 / views 38，main.js 1524→**534**）——待用户冒烟 |

### 任务 11 落地记录

- **状态大迁移**：`store.state` 扩展（allTabs/filtered/searching/activeCmd/view/currentWindowId/currentSourceIsHistory），main 全文 ~120 处机械改名；`collapsed/searchCollapsed/saveCollapsed/activeCollapsed` 以独立容器迁 store（Set 共享安全，引用零改动）
- **view 改名的误伤防御**：负后瞻正则 `(?<![.\w'-])view(?!\w)` 排除 `'view-tabs'` 字符串、`dataset.view` 属性、`tgs-view` 键名——17 处中仅 12 处真状态被改
- **searchCollapsed 陷阱**：search() 里 `searchCollapsed = new Set()` 对 import 绑定赋值会炸——改 `searchCollapsed.clear()`（原地清空，语义等价）
- **view 初始化丢失**：`let view = ...localStorage...` 定义被 state 化吞掉，views.js 顶层补启动校正
- **loadTabs 函数头被误切**（windowOrdinal 区间多算一行）：node --check 秒级发现，main 补头、render.js 删断头
- **cmdChip 越界引用**：main 的 locateCurrentTab/ESC 分支直接操作 search.js 的元素——search.js export `resetCmd()` 封装，main 改调
- **依赖图无环**：nav → search → render → views；rules → settings → render；undo → clean；media/dnd 独立
- **main.js 终态（534 行）**：import 编排 + settings 本地偏好 + onUpdated 事件路由 + loadTabs 数据层 + locateCurrentTab + 键盘路由 + init 注入 + 启动 IIFE——"入口编排"职责

## 最终结构（拆分完成）

```
popup.html ── pinyin-data.js / rules-match.js(classic,未动)
└─ src/main.js (534)            入口编排: 事件路由 + 键盘路由 + 启动序列
   ├─ core/
   │  ├─ format.js (91)         纯展示格式化 + groupKey
   │  ├─ pinyin.js (98)         拼音/模糊匹配 + 高亮
   │  ├─ dom.js (107)           pushStack/resultsEl/input 单例 + 通知 + 行查询 + 滑块
   │  ├─ colors.js (34)         色板 + 水墨墨团 SVG
   │  ├─ platform.js (6)        IS_MAC/MOD/DEBUG
   │  └─ store.js (50)          state 标量状态 + collapsed 系列 + 共享容器
   └─ features/
      ├─ rules.js (646)         规则编辑器
      ├─ settings.js (554)      设置面板(含归档)
      ├─ search.js (395)        搜索与 slash 命令
      ├─ render.js (577)        列表渲染与行动作
      ├─ views.js (38)          视图切换(纯模块)
      ├─ nav.js (71)            光标与滚动原语
      ├─ media.js (220)         媒体控制
      ├─ undo.js (137)          撤销关闭
      ├─ clean.js (109)         清理工具
      └─ dnd.js (75)            跨组拖拽
```

main.js 3509 → 534（-85%），逻辑零改动（除已记录的修复点）。
popup.html 的 CSS（~2000 行）未拆，稳定后可另立任务。

## 防回归：import 完整性机器校验

任务 11 冒烟抓到 `timeTier` 漏 import 后，补跑了全量机器校验（core/features 全部
export × 每个文件的"使用 vs import vs 本地定义"），又抓出 4 处真问题
（render.js 的 indexOfRow；search.js 的 textToPinyin/mediaTabIds/rowByTabId/groupKey），
全部修复。误报模式已识别：`actions.render()` 属性调用、事件名/类名字符串
（'input'、'rule-name-input'）、注释字样。**后续再动模块边界时先跑此校验**
（脚本逻辑：正则提取各模块 export → 逐文件比对自由标识符覆盖）。
**校验盲区补记**：main.js 本地函数（tabItemByTabId 等）不在任何模块 export
清单里，机器校验覆盖不到——render.js closeTab 引用后 ReferenceError。
修复：tabItemByTabId 移 store.js（state 衍生查询）。规则：**main 本地函数
被 feature 引用时，必须升入 core 或经注入，不留"隐式通道"**；校验清单
= 模块 export ∪ main 本地函数全量。

## 注意事项

- **不拆 CSS**（popup.html ~2000 行样式）：JS 稳定后另立任务
- background.js（691 行）、content.js（72 行）规模健康，不动
- 每个任务 = 纯行区间搬家 + 补 import/export，不改任何逻辑；搬完即 `node --check`（.mjs 模式）
