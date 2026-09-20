# 新主题开工检查表

加新主题时按此表逐项勾(契约原文见 `docs/adr/0003-theming-protocol.md`)。
已落地: linear(默认) / ink(水墨) / herdr(终端蓝) / y2k(千禧复古)。

## 必做(强制义务)

- [ ] **挑主题名**(短 kebab,如 `ink`),声明 `color-scheme`(亮/亮暗双 facet——暗色变体务必做 `data-theme` 内部 media 分支,不开新主题名;固定亮色主题如 ink/herdr/y2k 声明 `light` 即可)
- [ ] **全量视觉系统 token 赋值**:`--bg --surface --fill --fill-2 --text --text-2 --text-3 --placeholder --hairline --header-line --hover --accent --accent-hi --tint --tint-2 --ring --danger --danger-solid --danger-bg --amber --seg-active --seg-shadow --header-bg --header-hover --pop-bg --shadow-pop --dot-ring --btn-2 --media-btn-bg --media-btn-shadow --push-shadow --search-bg --search-bg-focus --plate-bg --tag-*-c/--tag-*-bg(5 组) --card-shadow --card-shadow-hover`
- [ ] **5 个 accent 变体值**:`[data-accent="blue|cyan|green|orange|rose"]` 下各自的 `--accent/--accent-hi`(及暗色 facet 的对应值)
- [ ] **9 色 Chrome 组色映射**:`grey blue red yellow green pink purple cyan orange` 各配一个主题内色号,加进 `src/core/colors.js`
- [ ] **THEME_ASSETS 加一行**:`<name>: { groupColors, ...视觉资产开关 }`,JS 侧即自动接管,不许加 `dataset.theme ===` 比较
- [ ] **设置页主题下拉加 option**(`optTheme`)
- [ ] **固定亮色主题**:若该主题不跟随系统深色,须把自己加进顶部 `@media (prefers-color-scheme: dark)` 图标反色规则的 `:not([data-theme="..."])` 排除链(否则系统深色下彩色 PNG 图标会被反色)

## 可做(主题资产,须块级注释说明动机 + 在此处登记)

默认可覆盖装饰类属性(颜色/字体/背景/边框/遮罩),禁动布局骨架;动骨架的算特例资产,登记于此:

| 资产 | 主题 | 位置 | 为什么需要动骨架 |
|---|---|---|---|
| 晕染墨团计数角标 | ink | `colors.js buildInkBleedSvg` + `.group-count::before` | 墨团需超出徽标本体的溢出画布 |
| 笔锋渐隐分组竖线 | ink | `.group-dot` mask-image | 笔锋渐隐靠 mask 裁切 |
| 媒体蒙层整行宣纸羽化 | ink | `.tab-item.has-media .media-overlay` | linear 是中央浮钮,水墨是整行右起蒙层,定位模型不同 |
| 顶部 Tab 滑块挑出 | ink | `tabSliderExtra`(dom.js) | 两端挑出文字营造舒展留白 |
| 搜索框毛笔长横 | ink | `.search-ink-stroke` SVG | 主题独有装饰件,linear 无对应物 |
| 弹窗 1px 窗口外框 | y2k | `body` border | 窗口外框必须贴死弹窗边缘才算"一块窗口";内容区收窄 2px |
| 标题条满幅出血 | y2k | `.view-tabs` 负 margin + 左右 padding | 蓝色标题条不贯穿左右就不成立(负 margin 抵消 `.search-plate` 的 `--gutter`,总高不变,不影响滑块量取) |
| 开关改内凹勾选框 | y2k | `.srow ... + .toggle-track` / `.zone-switch-knob` | 经典勾选框是 13×13 直角凹格,滑块胶囊的 34×20 尺寸必须改 |
| 按钮 padding 边框补偿 | y2k | `.rules-add-btn` / `.rules-save-btn` | 凸起斜面需要 1px 边框,各减 1px padding 保持外框尺寸与另三主题一致 |

### y2k 取色纪律(改这个主题前先读)

y2k 的色值**全部由参考截图逐像素取样得到**,不是凭印象调的。第一版凭"win98 印象"写,结果色值普遍比原图亮 2~3 档、边框粗一倍、还凭空加了硬投影,视觉上"很重,不如参考图自然"。三条硬约束:

1. **低饱和** —— 约 90% 面积是中性冷灰(`#B6`~`#D4` 之间,彩度近 0),彩色只给蓝条 + 几个小色点。任何"再加一个彩色面"的改动都算违规。
2. **低对比** —— 相邻表面亮度差只有 8~20 级,层级靠 1px 细线划分,不靠明暗拉开。
3. **零投影** —— 参考图全图找不到一处投影。立体感只由 1px 斜面提供(`--y2k-hi` 上左 / `--y2k-lo` 下右)。**禁止**给 y2k 加零模糊硬投影(`Npx Npx 0 ...`),那是"重"的最大来源。

底纹同理:参考图是 ~3px 周期的斜织十字布纹,不是圆点。y2k 用 `--y2k-weave`(两组 45°/-45° 1px 暗线,alpha 0.038)实现,换回 `radial-gradient` 圆点会立刻读出"波点图案"而不是"织物"。

## 禁止

- 组件层(主题块之外)写死色值 / 出现主题判断
- 覆盖层里 `!important` 压别的覆盖(只准压基础层)
- 向 `:root` 共享基座加视觉 token(基座只放度量)
- 禁用公共交互层:`.tab-item.active` 的上浮效果(渐变高亮 + scale + 弹性过冲 + 投影)是全主题共享件,任何主题(含未来新增)不得在其命名空间内覆盖 `transform`/`box-shadow`/`transition` 将其关闭;主题只准通过 `--accent` 等 token 影响其配色
