# probes — Playwright 动效/功能回归探针

跑法: `cd probes && node tgs-verify.mjs`(需本机 Chrome for Testing + playwright)。
/tmp 会被系统周期清理, 探针统一存这里。按主题拆文件, 每个文件自包含。

| 探针 | 守什么 | 当前 |
|---|---|---|
| `tgs-verify.mjs` | 入场 row-settle 0.5s / 揭纱 ink-in / ⬇️ 不重启 / 帮助卡键帽 / 设置行键帽组不拆分 / 快捷键命令只剩 2 个 / 主题不透明底 / wave-icon | 11/11 |
| `tgs-drop.mjs` | 级联压缩 650ms 上限 / 帧拍 ≥10ms / 单调不倒退 | 5/5 |
| `tgs-flicker.mjs` | ⬇️ 重启后 80/300/600ms 无 row-settle 重播 | 4/4 |
| `tgs-flash.mjs` | 独立窗口开关(setPopup(''))时无弹窗闪帧 | 3/3 |
| `tgs-anchor.mjs` | 独立窗口定位(指针优先 / 居中兜底 / 只记 w·h) | 3/3 |
| `tgs-mouse.mjs` | content.js 鼠标位置跟随 | 3/3 |
| `tgs-blur.mjs` | 独立窗口失焦自关的守卫(设置/分组弹层期间不自关) | 2/2 |
| `tgs-discard.mjs` | 休眠(discarded)tab 被点击 → 显式 reload, 不落空白帧 | 2/2 |
| `tgs-close-copy.mjs` | 删除收起动画(height 340ms 过渡 / 焦点先换行 / 连按不吞键 / 批量 70ms 错峰 / reduced-motion 退化) + ⌘C 行内浮标(三主题 token: ink 墨点底 / sky 徽章 12px 圆角且**无**云朵底图 / **浮标是遮罩不是让位**(文字零位移 + mask 渐隐 + 无 padding 过渡) / 2s 自动消失 / **无选中行时不复制不弹浮标也不吞键**) | 76/76 |
| `tgs-multiselect.mjs` | Shift 多选删除: ⇧点击勾选/取消 + ⇧↑↓ 区间(可扩可收) + ⌘⌫ 批量关闭(70ms 错峰、副本同行一起关、撤销条) + Esc 取消 + 单行删除不变 + 三主题底色走 token | 39/39 |
| `tgs-caret.mjs` | 滑行光标: 原生 caret 透明 / 细竖线 2px / 位置=插入点文本宽 / 位移 90ms 补间(中间帧存在非端点 x) / 打字不闪+停手 420ms 慢闪 / blur 隐藏 / 拼音组合交还原生 caret | 15/15 |
| `tgs-undo-expand.mjs` | 撤销删除(⌘Z)的展开动画: 行以 `.expanding` 从 0 高展开(340ms, 与收起同参) + 淡入 + 从右侧滑回 / 批量 70ms 错峰且 ≤420ms / 演完摘类 + 抹干净内联样式 / reduced-motion 不演 | 15/15 |
| `tgs-group-order.mjs` | 删除 / 撤销后**分组排序**: 删组内非最新一条不动组序 / 删整组后撤销回原位 / 删组内最新一条(组时间戳降级)后撤销回到删除前的名次 / 撤销的行回到组内原位 | 5/5 |
| `tgs-multiselect-order.mjs` | 跨分组多选关闭的排序: 剩下的组相对次序不变 / 撤销后每一行回到原位(整组清空也回原座) / 撤销的展开动画在恢复行上演 / 换激活标签不把组钉到第一位 / 记账本随撤销凭证跨 popup 恢复 | 19/19 |
| `tgs-dup-groups.mjs` | 同窗口同名组(异常态)的可见与可合: 两个同名组头都带「重名」徽章 + title 提示 / 跨窗口同名**不**标记且菜单无合并项 / 右键「合并同名分组」→ 标签并进第一组、空组消失、徽章消失、toast 回报 | 18/18 |
| `tgs-group-header-collapse.mjs` | 组里最后一个标签被删时分组头跟着行一起收: 头挂 `.closing` + height 340ms 过渡(不再"愣一拍才消失") / 组里还有别的行头不动 / ⌘⌫ 多选整组清空头跟着收 / 重绘后头消失行数正确 / reduced-motion 直接重绘 | 15/15 |
| `tgs-focus-settle.mjs` | 删除后选中态**暂停之后**才落到上一行: 收起期间 body.cursor-muted 静音(键盘落点已在上一行但不亮) / 收起演完静音摘除、上一行亮起 / 连按 ⌘⌫ 每次操作都不亮、向上扫除不吞键、暂停后落到最后删的那行的前驱 / 剩余行正确 | 6/6 |
| `tgs-archive-restore.mjs` | 归档「重新打开」的收场: 落点窗口 = 最后聚焦的普通窗口(独立窗口里不能用面板自己) / 回到分组窗口且弹窗不关 / 恢复的分组已展开 + 归档卡焚毁 / 先刷列表后收面板 | 12/12 |
| `tgs-archive-live.mjs` | 归档「重新打开」在**真实扩展环境**里(不 stub chrome.*): 面板窗口不失焦自关 / 恢复的标签真的进了同名原生组 / 归档卡焚毁 / 面板收起且列表里有恢复的分组 / **恢复期间失焦后把面板窗口提回前台**(`windows.update({focused:true})`) / 收场宽限期内 blur 不调 `window.close` | 12/12 |
| `tgs-archive-popup.mjs` | 弹窗模式的「重新打开」(真 popup, CDP 直连 Target): 弹窗在动作途中被关掉(模拟失焦自关)也**不半途而废** —— 标签建齐归组 / 归档卡焚毁 / worker 把弹窗**唤回来**(`action.openPopup`)且落在恢复的分组上(分组照样展开, 不被旧的收起记忆压回去) + 补「已重新打开」回报 / 弹窗活着时不许多开一个 | 15/15 |
