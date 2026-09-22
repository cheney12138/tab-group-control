# 新主题开工检查表

加新主题时按此表逐项勾(契约原文见 `docs/adr/0003-theming-protocol.md`)。
已落地: linear(默认) / ink(水墨) / herdr(终端蓝) / sky(蓝天颗粒)。

## 必做(强制义务)

- [ ] **挑主题名**(短 kebab,如 `ink`),声明 `color-scheme`(亮/亮暗双 facet——暗色变体务必做 `data-theme` 内部 media 分支,不开新主题名;固定亮色主题如 ink/herdr/sky 声明 `light` 即可)
- [ ] **全量视觉系统 token 赋值**:`--bg --surface --fill --fill-2 --text --text-2 --text-3 --placeholder --hairline --header-line --hover --accent --accent-hi --tint --tint-2 --ring --danger --danger-solid --danger-bg --amber --seg-active --seg-shadow --header-bg --header-hover --pop-bg --shadow-pop --dot-ring --btn-2 --media-btn-bg --media-btn-shadow --push-shadow --search-bg --search-bg-focus --plate-bg --tag-*-c/--tag-*-bg(5 组) --card-shadow --card-shadow-hover`
- [ ] **5 个 accent 变体值**(变体仍须全量定义 —— 契约要求; 但按现行产品策略**只有 linear 在设置页暴露可选项**, 其余主题在 `settings.js` 的 `FIXED_ACCENT` 里锁一个设计色并隐藏整行):`[data-accent="blue|cyan|green|orange|rose"]` 下各自的 `--accent/--accent-hi`(及暗色 facet 的对应值)
- [ ] **9 色 Chrome 组色映射**:`grey blue red yellow green pink purple cyan orange` 各配一个主题内色号,加进 `src/core/colors.js`
- [ ] **THEME_ASSETS 加一行**:`<name>: { groupColors, ...视觉资产开关 }`,JS 侧即自动接管,不许加 `dataset.theme ===` 比较
- [ ] **设置页主题下拉加 option**(`optTheme`)
- [ ] **固定亮色主题**:若该主题不跟随系统深色,须把自己加进顶部 `@media (prefers-color-scheme: dark)` 图标反色规则的 `:not([data-theme="..."])` 排除链(否则系统深色下彩色 PNG 图标会被反色)

## 可做(主题资产,须块级注释说明动机 + 在此处登记)

默认可覆盖装饰类属性(颜色/字体/背景/边框/遮罩),禁动布局骨架;动骨架的算特例资产,登记于此:

共享纹理资产(基座 `:root` 中的非度量项, 需在此登记): `--grain` —— 主题无关的中立灰胶片噪点, sky/ink 共用; 放基座单点定义, 删任一主题都不影响其他(不构成"白嫖")。铺法按底色亮度定: 中深底(sky 天空带)用 `background-blend-mode: overlay` 直接叠在天色上; 亮底(ink 纸)用 `mix-blend-mode: hard-light`(亮端增益≈1, 不压暗); pure multiply 只适合本就想要变深的场景。

| 资产 | 主题 | 位置 | 为什么需要动骨架 |
|---|---|---|---|
| 晕染墨团计数角标 | ink | `colors.js buildInkBleedSvg` + `.group-count::before` | 墨团需超出徽标本体的溢出画布 |
| 笔锋渐隐分组竖线 | ink | `.group-dot` mask-image | 笔锋渐隐靠 mask 裁切 |
| 媒体蒙层整行宣纸羽化 | ink | `.tab-item.has-media .media-overlay` | linear 是中央浮钮,水墨是整行右起蒙层,定位模型不同 |
| 顶部 Tab 滑块挑出 | ink | `tabSliderExtra`(dom.js) | 两端挑出文字营造舒展留白 |
| 搜索框毛笔长横 | ink | `.search-ink-stroke` SVG | 主题独有装饰件,linear 无对应物 |
| 天空顶栏带(渐变+颗粒+反白) | sky | `.search-plate` 背景 + `.view-tab`/`.view-tabs .tab-slider` 反白 | 顶栏要读成「天空」,文字/图标须在天空层局部反白;这是与另四主题的骨架级分野,不是配色差异 |
| 天空自溶(色层 mask) | sky | `.search-plate`(透明底 + `padding-bottom:34px` 天际线余量) / `::before`(颗粒+柔光+渐变, 自身 mask 溶底) | 只有独立元素能单独上 mask(直接 mask 容器会把搜索框/Tab 一起淡掉);天空要在**没有分割线**的前提下溶进云里 |
| 列表上提(收留白不收云) | sky | `#results { margin-top: -18px }` | 天际线留白要收, 但云层厚度不能减 —— 只能把列表拽进天空尾部; 天空带 z-index(6) 高于 sticky 组头(5), 但该高度已被 mask 成全透明, 不遮内容 |
| 胶片噪点(共享 `--grain`) | ink | `body::before`(hard-light 0.5) | 纸底很亮, overlay/multiply 在亮端增益极低(overlay 在 0.92 底上仅 0.16), 颗粒几乎看不出; hard-light 亮底增益≈1, 实测 std 2.4→6.8 且均值不被压暗(238→235)。**原 3px 纸纹点阵已删** —— 规则点阵会把细颗粒藏掉, 两层叠一起读成布纹 |
| 手绘云缘分隔线 | sky | `.group-header::before` | linear 是 1px 两端渐隐直线,本主题是 2px 圆头手绘曲线,高度 +1px(绝对定位,不动布局) |
| 胶片颗粒底纹 | sky | `body::before`(feTurbulence + overlay) | 颗粒是本主题签名资产;ink 已有 `body::before` 纹理先例 |

### sky 设计纪律(改这个主题前先读)

sky 的色值全部由参考图(蓝天+白云+白线稿+重颗粒,2432×1018)逐像素取样得到,不是凭印象调的:

1. **双色纪律** —— 全图只有天蓝与云白两个色相。禁止出现第二个彩色面;彩色只准以组色点/强调色/状态标签的小面积出现。
2. **天空带明度纪律** —— `#2B50A5`(深端)~ `#688AD3`(浅端)。更深会读成「夜晚/终端蓝」,更浅会与云白撞失去层次。
3. **颗粒纪律** —— 颗粒是签名: 噪点作为 `.search-plate::before` 的**首层背景**用 `background-blend-mode: overlay` 叠在天色上(没有 opacity 乘法器, 强度由 `feComponentTransfer` 的 slope 标定);文字所在云面的全局 `body::before` 只能是 multiply `opacity 0.16`。禁止用 `filter: blur()` / 发光替代颗粒。
4. **云白纪律** —— 云面一律蓝调白(`#E4EAF7` / `#F2F5FC`,B 通道最高);禁中性白、禁纯白。
5. **纯白纪律** —— `#FFFFFF` 只给线稿与天空层上的文字/图标;云面与正文禁用纯白。
6. **线稿纪律** —— 装饰线 1–2px、圆头(`stroke-linecap: round`)、允许曲率不完美;禁直线硬边与工业等宽硬角。
7. **留白纪律** —— 不叠纹理图案(区别于 ink 宣纸点阵/y2k 织纹)、不给云面加边框盒,层级只用极淡蓝调阴影。
8. **反简笔纪律** —— 云/光等自然元素一律「大尺度 + 不对称 + 模糊化开」;禁止任何等距重复的几何小图形(小扇贝、小圆点边框、等宽波浪)当装饰 —— 那是简笔画,不是天气。云只准出现在天空带,不准下到列表。
9. **自溶纪律(最重要的过渡规则)** —— 天空与云的交界**只准由天空层自己 mask 溶解**(`.search-plate::before` 上“上实下虚 + 湍流破形”的 mask),**禁止“先铺蓝、再在上面盖一层白云形状”** —— 后者不管形状多柔,都会留下那道云团的边 = 用户眼里的“底线”。判定方法: 把截面灰度曲线画出来, 只要中间出现一个“平台/拐点”(而不是单调下降), 就是盖子不是溶解。
   - **mask 的 shape 必须外扩到 viewBox 之外**(`x`/`y` 取负、`width`/`height` 超出): mask 会铺满元素, 若 shape 边缘与元素边缘重合, 湍流位移会把 shape 的**四条边**全抖出缺口, 顶部/左右于是漏出容器底色(实测踩坑: 天空像被咬了一圈, 只剩底部该有的不规则)。外扩后可视区四边都落在 shape 内部, 只有底部那条渐变边界被破形。
   - **透明端要比元素底边高出 ≥ 位移量**(本例 viewBox 160 高、`scale=20`, 透明端放在 140): 否则被位移顶上来的蓝色会在元素底边被硬裁成一条直线。

结构约定: **天空只给顶栏这一条带,页面/列表/设置面板都是云**。`--bg` 是云层底 —— 直接把 `--bg` 刷成天空蓝会让设置面板与列表文字(深蓝墨)全部失效,天空只能由 `.search-plate` 资产局部承载。

## 禁止

- 组件层(主题块之外)写死色值 / 出现主题判断
- 覆盖层里 `!important` 压别的覆盖(只准压基础层)
- 向 `:root` 共享基座加视觉 token(基座只放度量)
- 禁用公共交互层:`.tab-item.active` 的上浮效果(渐变高亮 + scale + 弹性过冲 + 投影)是全主题共享件,任何主题(含未来新增)不得在其命名空间内覆盖 `transform`/`box-shadow`/`transition` 将其关闭;主题只准通过 `--accent` 等 token 影响其配色
