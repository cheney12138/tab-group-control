# probes — Playwright 动效/功能回归探针

跑法: `cd probes && node tgs-verify.mjs`(需本机 Chrome for Testing + playwright)。
/tmp 会被系统周期清理, 探针统一存这里。按主题拆文件, 每个文件自包含。

| 探针 | 守什么 | 当前 |
|---|---|---|
| `tgs-verify.mjs` | 入场 row-settle 0.5s / 揭纱 ink-in / ⬇️ 不重启 / 帮助卡键帽 / 设置行键帽组不拆分 / 主题不透明底 / wave-icon | 10/10 |
| `tgs-drop.mjs` | 级联压缩 650ms 上限 / 帧拍 ≥10ms / 单调不倒退 | 5/5 |
| `tgs-flicker.mjs` | ⬇️ 重启后 80/300/600ms 无 row-settle 重播 | 4/4 |
| `tgs-flash.mjs` | 独立窗口开关(setPopup(''))时无弹窗闪帧 | 3/3 |
| `tgs-anchor.mjs` | 独立窗口定位(指针优先 / 居中兜底 / 只记 w·h) | 3/3 |
| `tgs-mouse.mjs` | content.js 鼠标位置跟随 | 3/3 |
| `tgs-blur.mjs` | 独立窗口失焦自关的守卫(设置/分组弹层期间不自关) | 2/2 |
| `tgs-discard.mjs` | 休眠(discarded)tab 被点击 → 显式 reload, 不落空白帧 | 2/2 |
| `tgs-caret.mjs` | 滑行光标: 原生 caret 透明 / 细竖线 2px / 位置=插入点文本宽 / 位移 90ms 补间(中间帧存在非端点 x) / 打字不闪+停手 420ms 慢闪 / blur 隐藏 / 拼音组合交还原生 caret | 15/15 |
