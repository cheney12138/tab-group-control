# 快捷键弹窗偶发数秒延迟：诊断与修复

## 症状

按下 ⌘E（`_execute_action`）后，工具栏图标已激活（命令已派发），但弹窗**本身**延迟数秒才出现。偶发，非每次。

## 根因

1. MV3 background 是 service worker，**闲置 30s 被 Chrome 回收**。
   保活依赖 tabs/windows 事件重置计时器（QuicKey 原理）——但用户一段时间
   不操作浏览器时没有任何事件，worker 必被回收。
2. `_execute_action` 触发时 Chrome 要**先拉起 worker 才打开 popup**
   （Chromium 对 action 命令的已知实现行为）。冷启动 = 建进程 + 加载
   background.js + importScripts + 磁盘 I/O，系统繁忙时达数秒。
3. 因此"偶发"：worker 醒着时秒开；只有恰好闲置超时 worker 被杀后才延迟。

**与弹窗内渲染无关**——不是 loadTabs/快照等待（弹窗框架都没出现）。

## 修复（2026-09-09）

content script 心跳保活（Tabbiy 同款）：

- `content.js`：每 25s 发 `{type:'keepalive'}`——消息本身就是 activity，
  收到即重置 worker 的 30s 休眠计时器。**仅页面可见时发**（后台/冻结标签
  不发；浏览器整体闲置时允许 worker 正常休眠，省电）；发送失败静默
  （worker 重启/扩展重载间隙，下一轮自然恢复）。
- `background.js`：onMessage 显式应答 `keepalive`（放 listener 首位，
  高频消息先匹配；不应答会让 content 侧 promise 悬挂）。

附带收益：worker 常醒 → 标签快照/MRU 栈/规则索引常热，弹窗数据加载也更快。

覆盖边界：chrome:// 内置页、Chrome Web Store、内置新标签页不注入
content script——长时间停留在这些页面后首次快捷键仍可能冷启动，主流场景已覆盖。

## 踩坑：Extension context invalidated（2026-09-09 补）

扩展**重载/更新**后，旧页面里已注入的 content script 还活着，但扩展上下文
已销毁。此时 `chrome.runtime.sendMessage` 不是返回 rejected promise，而是
**同步 throw** `Extension context invalidated`——`.catch()` 接不住同步异常，
心跳每 25s 抛一次刷爆错误面板。

修复（content.js）：调用前预检 `chrome.runtime?.id`（上下文失效后变
undefined）+ try-catch 兜底竞态；命中即 `clearInterval`——失效不可逆，
等页面刷新重新注入新 content script 即可。

## 验证

1. 重载扩展（background.js / content.js 都改了，**已打开的页面需要刷新**才会注入新 content.js）
2. chrome://extensions → 本扩展 → "Service Worker" 应持续显示活跃，不再变"不活跃"
3. 静置 5 分钟不操作浏览器 → 按 ⌘E 应秒开
