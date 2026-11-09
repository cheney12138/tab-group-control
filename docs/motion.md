# 动效规格

只记录**已经被用户认可、要在真实插件里复用**的动效参数。演示页 `site/demo.html` 是这些参数的实现基准。

## 行删除 / 清理时的「收起」

场景:⌘⌫ 关闭选中标签、⌘⇧K 清理无效标签、一键清理条。

demo 实现:`site/demo.html` 的 `collapseCmdRows()`。

| 维度 | 参数 |
| --- | --- |
| 高度 | `height` 当前 px → `0` |
| 内边距 | `padding-top` / `padding-bottom` → `0` |
| 透明度 | `opacity` → `0` |
| 位移 | `translateX(16px)`(往右滑走,与行尾关闭按钮方向一致) |
| 时长 | height / padding / transform `340ms`,opacity `300ms` |
| 缓动 | `ease-out`(收尾不弹) |
| 多行级联 | 逐行 `+70ms` 延迟 |

实现要点:

1. **先量后收**:先把当前 `offsetHeight` 写成内联 `height`,再在下一帧(`requestAnimationFrame`)把它改成 `0`;直接改 `0` 没有插值起点,行会瞬间消失。
2. **要连 padding 一起收**:只收 height 会在行里留下内边距形成的空白带。
3. **收完再摘节点**:保留一个 0 高的行,会在 `:hover`、焦点顺序、以及后续 `offsetHeight` 量算里变成幽灵。
4. **同步改计数**:分组头的数量徽标与标签栏的组计数要跟着变,并给一次 `bump`(scale 1.35 / 360ms)让「少了一条」有回执。

真实插件侧的改动另做——那边是 `render()` 全量重绘的模型,不能照搬 DOM 内联样式,需要把它落到一条重绘前后的 FLIP 或离场类上。

### 插件侧落地(features/row-anim.js + render.js / close-batch.js)

插件是 `render()` 全量重绘的模型,不能照搬 demo 的 DOM 内联样式循环,落法如下:

| 环节 | 实现 |
| --- | --- |
| 离场类 | `popup.html` 的 `.tab-item.closing` 承载过渡(height / padding / margin 340ms、opacity 300ms、transform 340ms `cubic-bezier(.4,0,.2,1)`) |
| 量高 | `features/row-anim.js` `collapseRows()`:先批量读 `offsetHeight`,再统一写起点 |
| 起跳 | **一次强制样式结算**(`void document.body.offsetHeight`)代替 rAF —— 同一任务内即可开播,少一帧延迟,也不用担心 rAF 被节流时动画不启动 |
| 收尾 | 过渡结束(定时器兜底 `spread + 340 + 40ms`)后才 `render()`,行节点随重绘一起退场 |
| 单行 | `render.js` `closeTab()`:`chrome.tabs.remove` 仍在**第一步**(弹窗被点外面关掉也不会漏关),随后收起 → 延后重渲染 |
| 连按 | 焦点在收起开始前就移到相邻行(跳过 `.closing`),连按 ⌘⌫ 每次都落到新行;重绘合并成一次 |
| 批量 | `close-batch.js` `runCloseBatch()`:逐行 `+70ms`(`maxSpread` 420ms)、最多演 14 行 |

`prefers-reduced-motion: reduce` 时整套跳过,走原来的"立即重渲染"路径(不演、不卡行)。

## 行撤销(⌘Z)时的「展开」

删除的逆动作。恢复的标签行不是"啪"地冒出来,而是从 0 高展开回自然高度 —— 同一行
「删掉再撤销」读成同一段动作倒放。实现:`features/row-anim.js` 的 `expandRows()`,
调用方 `features/undo.js` 的 `doUndo()`。

| 维度 | 参数 |
| --- | --- |
| 高度 | `0` → 渲染出来的自然 px(`offsetHeight`) |
| 内边距 / 外边距 | `0` → 自然值(与收起同一对属性) |
| 透明度 | `0` → 自然值 |
| 位移 | `translateX(16px)` → 自然值(从右边滑回来) |
| 时长 | 与收起**共用同一条过渡声明**(`.tab-item.closing, .tab-item.expanding`):height / padding / margin / transform `340ms`,opacity `300ms` |
| 缓动 | `cubic-bezier(.4, 0, .2, 1)`(收尾不弹) |
| 多行级联 | 逐行 `+70ms`,`maxSpread` 420ms,最多演 14 行(其余直接落位) |

实现要点(与收起的不同之处):

1. **顺序反过来**:收起先挂类再写起点;展开必须**先写起点(含 `transition: none`)→ 强制样式结算 → 再挂类并写终点**。类一挂过渡就生效,起点会被当成"从自然值出发的过渡",随后的终点写入变成反向并当场结束 —— 表现是高度在长、淡入和位移完全没动。(实测病例:只有 `height` 过渡在跑。)
2. **在 `render()` 之后演**:撤销时行是重绘才建出来的,所以起点/终点必须在同一任务内写完,浏览器不会画出"满高闪一下"的中间帧。
3. **演完要清场**:收起的节点随重绘退场,展开的节点留下 —— 摘 `.expanding` 的同时抹掉全部内联样式,残留的固定 `height` 会把这行钉死,之后主题/密度变化都不再跟。
4. **入场窗口内不演**:`body.entrance` 期间行上有 `row-settle` 动画(animation 覆盖内联 opacity/transform),此时一律直接落位 —— 与"用户介入动效让路"同一口径。

`prefers-reduced-motion: reduce` 时 `expandRows()` 直接返回,行按渲染出来的样子落位。

## ⌘C 复制 URL 的行内浮标

demo 基准:`.cmd-copy`(`site/demo.html`)。插件侧落在 `render.js` 的 `copyTabUrl()`,替换原来的底部 toast。

| 维度 | 参数 |
| --- | --- |
| 位置 | 行内 absolute,`right: 36px`(让开行尾 8px 起的关闭按钮,留 8px 呼吸);**盖在文字上**,不给文字让位 |
| 遮罩 | `.tab-item:has(.copy-badge) .tab-info` 的 `mask-image` 在浮标左缘前 22px 渐隐(三主题 `--copy-mask-end` 各给值);同时 `.last-used` 收掉,遮罩右缘才对得上行右缘 |
| 样式 · linear | `--surface` 底 + `--hairline` 描边 + 9px 圆角,10.5px/600,`--text-2` 文字,图标 `--accent`(保持原样) |
| 样式 · ink | 无底色/无描边,`::before` 铺墨点底图(SVG 240×80,外扩 7/9px);6px 13px 内边距 + 28px 最小高;宋体 11px/600、`#FBF3E7` 白字 |
| 样式 · sky | 徽章(不画云):`--surface` 云白底 + `--hairline` 描边 + **12px 圆角**;`4px 12px` 内边距,10.5px/600,`--text-2` 文字;阴影走云层深蓝墨 `rgba(31,52,110,…)` + 1px 内顶光 |
| 形状底 | 仅 ink:墨点 = 淡墨晕 + 手绘墨块/湿边 + 飞溅墨点(三层),`preserveAspectRatio=none`,底图永远比文字盒大一圈 |
| 入场 | `opacity 0→1` 220ms + `translateY(+4px) scale(.97) → 0/1` 300ms `cubic-bezier(.22,1,.36,1)` |
| 时长 | 2s 后撤 `.show`,220ms 淡出,再摘节点 |
| 失败 | 不显示浮标,仍走底部 toast(失败必须吵,且不该挂在某一行上) |

实现要点:

1. **浮标是遮罩,不是邻居**:文字**位置分毫不动**,浮标直接盖在上面(绝对定位 + 不透明底)。曾经用 `.tab-item:has(.copy-badge) .tab-info { padding-right: 92px }` 让位 —— 长标题会在浮标出现的 200ms 里被“挤短”一次、收起时又长回来,读成一段莫名的收缩动画(用户口径:“URL 被挤过去,有一个缩短的动画”)。现在让位规则已删,`.tab-info` 上也没有 `padding-right` 过渡。
   - 光让浮标不透明还不够:浮标(24~30px 高)比一行字(17.5px)高,居中时上下各压住半行,被压住那行的**字头/字尾会从浮标边缘探出来**。所以文字自身用 `mask-image` 在浮标左缘之前淡出(22px 渐隐),位置不变、只是隐掉 —— 没有重排,也就没有动画。
   - `--copy-mask-end` = 行右缘 → 文字完全消失处 = `36px(关闭按钮) + 浮标宽 - 行右内边距`;linear 117px / sky 126px / ink 139px(墨晕比盒缘还外扩,多躲 4px)。改浮标宽度或字体记着重算这三个值。
   - 遮罩百分比是按 `.tab-info` 自己的右缘算的,而 `.last-used` 还占着 40~55px,所以浮标在场时把它 `display: none`(选中行的时间戳本来就 `opacity: 0`,收掉看不见),遮罩右缘才能和行的右缘对齐。
   - 代价:浮标在场时 `.tab-info` 会宽 40~55px(标题的省略号推远),但那 40px 全在遮罩区内,逐像素对比遮罩区左侧文字零位移(pngdiff: maxdiff ≤ 1/255)。
3. **浮标摆在时间戳槽位上**:绝对定位 `right: 36px`(让开关闭按钮),选中行的时间戳本来就 `opacity: 0`,所以摆位不会挤走任何东西。
4. **重绘即清场**:`render()` 开头 `cancelCopyBadge()`,全量重绘扔掉节点时不留悬空定时器。
5. **文字不露头**:ink 不用 `border-radius` 做底(圆角矩形再调也读成胶囊,且文字一旦贴边就"露")。形状底走 `::before` 底图 + 负 inset,本体只负责文字/图标;6px 内边距保证字与图标离形状边缘至少一圈。sky 是徽章,靠 `4px 12px` 内边距(横向 12px 才装得下"URL 已复制"不贴边)。`popup.html` 里两段 SVG 的中央实心区在拉伸后必须完整覆盖文字盒(改形状时先量 span 的 rect)。
6. **浮标上不画云**(2026-10 收敛):100×27 的小尺寸画不出自然的云 —— 等大圆瓣读成简笔画、单轮廓读成卡通、风扫尾巴读成彗星,四版都被否。sky 浮标改用徽章(见上表),云"柔"的感觉只由圆角 + 蓝调阴影 + 云白面承载。云形只保留在归档点那一处(14px,`colors.js buildSkyBleedSvg`)。
7. **⌘C 只认选中行**:`copyTabUrl()` 先查 `rowByTabId(tab.id)` 且该行带 `.active`,否则直接 return —— 不复制、不弹浮标;`main.js` 的键处理也不再用"当前窗口的 active 标签"兜底,没有选中行时连 `preventDefault` 都不做(把 ⌘C 还给浏览器原生复制)。
