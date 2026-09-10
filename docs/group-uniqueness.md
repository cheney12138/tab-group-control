# 分组唯一性：现状梳理与修复复盘

> 背景：Chrome 不提供删除分组的 API（空组只能靠移出/关闭成员让 Chrome 自动回收，
> 或用"临时标签法"触发删除）。一旦产生同名重复组，只能靠 tidy 合并兜底，
> 所以**唯一性必须在 save（建组/落库）层面保证**。

## 一、所有会产生/变更 Chrome 组的入口

### background.js（自动分组侧）

| 入口 | 位置 | 唯一性控制 |
|---|---|---|
| `attachTabToGroup` 建组/并入 | background.js:171 | ✅ 同窗口 query 同名 → 并入，无 → 新建 |
| `enqueueGroupOp` 串行队列 | background.js:158 | ✅ background 自身归组操作全部排队 |
| `tidyGroups` 同名合并+空组清理 | background.js:588 | ✅ 兜底，触发点：规则保存链 / popup 唤起消息 |
| 规则删除清理 `cleanupRemovedRules` | background.js:480 | ✅ 走队列迁移，不建组 |

### popup.js（手动操作侧）

| 入口 | 位置 | 唯一性控制 |
|---|---|---|
| `saveRules` 规则落库 | popup.js:3129 | ✅ 唯一落库口，编辑器/导入/添加域名汇聚于此 |
| `restoreArchivedGroupAction` 恢复归档 | popup.js:2385 | ❌ **口子 1**：无条件新建组，不查同名 |
| `regroupRestored` 撤销关闭恢复 | popup.js:1429 | ✅ 只并入不新建（但跨窗口查找，见"遗留观察"） |
| `moveTabToGroupAction` 拖拽移动 | popup.js:2506 | ✅ 目标是已有组 id，不建组 |
| 规则编辑器同名组 | popup.js:2988 | ❌ **口子 2**：对象 key 覆盖，域名静默丢失 |
| JSON 导入 name 未 trim | popup.js:3017 | ❌ **口子 4**：与编辑器 trim 后 key 撞车 |
| popup 建组不进 bg 队列 | — | ❌ **口子 3**：与 autoGroupTab 并发可双建（低概率，tidy 兜底） |

### content.js
不涉及分组操作。✅

## 二、修复记录（逐条确认后勾选）

### 口子 1：恢复归档无条件新建重复组
- **现象**：归档「工作」→ 标签栏又手动建了「工作」→ 恢复存档 → 窗口里两个「工作」。
- **根因**：`restoreArchivedGroupAction` 直接 `chrome.tabs.group({tabIds})` + `update({title})`，从不 query 同名组。同文件 `regroupRestored` 有正确的"找同名并入"写法，这条路径没用。
- **修法**：建组前 `tabGroups.query({title: item.title, windowId})`，有则并入 newTabIds（并同步颜色），无则新建。
- **状态**：✅ 已修复（popup.js:2383-2408）——同窗口 query 同名组，有则并入（保留现有组颜色，多个重复取第一个交 tidy），无则新建；`item.title` 空值兜底「未命名分组」与建组名一致。验证：`node --check` 通过。
- **待确认**：用户确认后方可进行下一任务

### 口子 2：规则编辑器允许同名组，保存时域名静默丢失
- **现象**：编辑器里手输两个同名组（改名撞车/新增同名），无校验；保存时 `collectRulesFromEditor` 对象 key 覆盖，先写的组域名全丢，toast 还报"已保存(N 组)"。
- **连带**：`addHostToRuleGroup` 的 `groups.find` 只命中第一个同名组；弹层"加入已有组"列表列重复名。
- **修法**：① 组名输入失焦时检测同名 → 闪烁+toast 拦截；② `collectRulesFromEditor` 遇重名合并域名而非覆盖（双保险）。
- **状态**：✅ 已修复，四处分改动——
  1. 组名框 blur 重名检测（popup.js buildRuleGroup）：撞名闪烁+toast「保存时将合并为一组」，不打断编辑；
  2. `collectRulesFromEditor` 同名合并域名（去重）替代对象 key 覆盖，`lastDupMerged` 记录合并数；
  3. `saveRules` 区分"无效组"（无名/无域名，被忽略）与"同名合并"，toast 分别提示；合并发生后 `renderRulesEditor` 重渲染对齐落库状态；
  4. 「添加当前域名」弹层组名列表 `Set` 去重，不列重复按钮。
  CSS：`invalid-flash` 红边动画复用到组名框（popup.html，补 transparent border 占位 + reduced-motion 保留）。验证：`node --check` 通过。
- **待确认**：用户确认后方可进行下一任务

### 口子 4：JSON 导入组名不 trim
- **现象**：对象格式 `{" 工作 ": [...]}` 与 `"工作"` 导入后成两条规则；保存时编辑器 trim 后 key 撞车 → 触发口子 2 的覆盖丢失。数组格式分支已 trim。
- **修法**：对象格式分支 `k.trim()` 对齐，空 key 跳过。
- **状态**：✅ 已修复（popup.js parseRulesJson）——对象格式 key trim 归一、空 key 跳过；两个分支（对象/数组格式）同名 key 撞车时改为**合并域名**而非覆盖，与口子 2"不静默丢数据"同一原则（后续清洗循环组内去重）。验证：`node --check` 通过。
- **待确认**：用户确认后方可进行下一任务

### 口子 3：popup 建组动作不走 background 串行队列（竞态）
- **现象**：恢复归档建组「P」的 query→group 间隙，background 正好把命中标签归向同名规则组「P」——双 query 双 miss → 各建一个。低概率且 tidy 下次唤起可合并，属自愈合。
- **修法**：popup 发消息（如 `restore-group`），由 background 在 `enqueueGroupOp` 里排队执行建组/归组。
- **依赖**：口子 1 先完成（同一函数）。
- **状态**：✅ 已修复——
  1. background 新增 `restore-group` 消息（background.js onMessage）：`enqueueGroupOp` 排队执行"同窗口查同名 → 并入/新建上色"，与 `autoGroupTab` 的 `attachTabToGroup` 互斥；异步 `sendResponse`（`return true` 保持通道），结果带 `merged` 标记；
  2. popup `restoreArchivedGroupAction` 建组段改为发消息（popup.js:2392），成功时按 `merged` 在 toast 追加「已并入现有同名组」；消息失败兜底直调（原口子 1 的并入逻辑），保证恢复出的标签不散着；
  3. background 侧颜色二次校验（`GROUP_COLORS.includes`），不信 popup 传值。
  说明：`moveTabToGroupAction`（拖拽）目标是已有组 id 不建组，无重复组风险，未纳入队列。验证：双文件 `node --check` 通过。
- **待确认**：用户确认

## 三、遗留观察（本次不修，记录备查）

1. **恢复归档标签可能被自动分组抢走**：tabs.create 触发 background `onCreated → autoGroupTab` 时 `manualTabIds` 尚未写入；且归档组名恰好是规则组名时不写白名单——若归档标签 url 不命中该规则，恢复后被 `doAutoGroupTab` 判"在规则组但 url 不命中"→ 迁去 Others，恢复组瞬间被拆空。
2. **`regroupRestored` 跨窗口并组**（popup.js:1426）：`query({})` 全局找同名+同色，可能把恢复的标签拉进另一个窗口的组；background 侧处处按窗口隔离，这里没隔离。
3. **tidy keeper 颜色漂移**：`tidyGroups` 按 query 顺序取第一个同名组为 keeper，合并后颜色未必是 `colorForGroup` 的规则色。
4. **大小写敏感**：`tabGroups.query({title})` 精确匹配区分大小写，「Work」/「work」会并存成两个组，编辑器无感知。如需视为同组，去重时做大小写折叠。
