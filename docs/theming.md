# 新主题开工检查表

加新主题时按此表逐项勾(契约原文见 `docs/adr/0003-theming-protocol.md`)。
已落地: linear(默认) / ink(水墨) / herdr(终端蓝) / sky(蓝天颗粒)。

## 必做(强制义务)

- [ ] **挑主题名**(短 kebab,如 `ink`),声明 `color-scheme`(亮/亮暗双 facet——暗色变体务必做 `data-theme` 内部 media 分支,不开新主题名;固定亮色主题如 ink/herdr/sky 声明 `light` 即可)
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
| 天空顶栏带(渐变+颗粒+反白) | sky | `.search-plate` 背景 + `.view-tab`/`.view-tabs .tab-slider` 反白 | 顶栏要读成「天空」,文字/图标须在天空层局部反白;这是与另四主题的骨架级分野,不是配色差异 |
| 云缘剪影 | sky | `.search-plate::after` | 天空带底部一排云朵鼓包,负 bottom 溢出到列表,复刻「天空压着云海」的交界 |
| 手绘云缘分隔线 | sky | `.group-header::before` | linear 是 1px 两端渐隐直线,本主题是 2px 圆头手绘曲线,高度 +1px(绝对定位,不动布局) |
| 胶片颗粒底纹 | sky | `body::before`(feTurbulence + overlay) | 颗粒是本主题签名资产;ink 已有 `body::before` 纹理先例 |

### sky 设计纪律(改这个主题前先读)

sky 的色值全部由参考图(蓝天+白云+白线稿+重颗粒,2432×1018)逐像素取样得到,不是凭印象调的:

1. **双色纪律** —— 全图只有天蓝与云白两个色相。禁止出现第二个彩色面;彩色只准以组色点/强调色/状态标签的小面积出现。
2. **天空带明度纪律** —— `#2B50A5`(深端)~ `#688AD3`(浅端)。更深会读成「夜晚/终端蓝」,更浅会与云白撞失去层次。
3. **颗粒纪律** —— 颗粒是签名,但只准在天空带加重(`background-blend-mode: overlay`);文字所在云面的全局 `body::before` 叠加不得超过 `opacity: 0.15`。禁止用 `filter: blur()` / 发光替代颗粒。
4. **云白纪律** —— 云面一律蓝调白(`#E4EAF7` / `#F2F5FC`,B 通道最高);禁中性白、禁纯白。
5. **纯白纪律** —— `#FFFFFF` 只给线稿与天空层上的文字/图标;云面与正文禁用纯白。
6. **线稿纪律** —— 装饰线 1–2px、圆头(`stroke-linecap: round`)、允许曲率不完美;禁直线硬边与工业等宽硬角。
7. **留白纪律** —— 不叠纹理图案(区别于 ink 宣纸点阵/y2k 织纹)、不给云面加边框盒,层级只用极淡蓝调阴影。

结构约定: **天空只给顶栏这一条带,页面/列表/设置面板都是云**。`--bg` 是云层底 —— 直接把 `--bg` 刷成天空蓝会让设置面板与列表文字(深蓝墨)全部失效,天空只能由 `.search-plate` 资产局部承载。

## 禁止

- 组件层(主题块之外)写死色值 / 出现主题判断
- 覆盖层里 `!important` 压别的覆盖(只准压基础层)
- 向 `:root` 共享基座加视觉 token(基座只放度量)
- 禁用公共交互层:`.tab-item.active` 的上浮效果(渐变高亮 + scale + 弹性过冲 + 投影)是全主题共享件,任何主题(含未来新增)不得在其命名空间内覆盖 `transform`/`box-shadow`/`transition` 将其关闭;主题只准通过 `--accent` 等 token 影响其配色
