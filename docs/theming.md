# 新主题开工检查表

加第三套主题时按此表逐项勾(契约原文见 `docs/adr/0003-theming-protocol.md`)。

## 必做(强制义务)

- [ ] **挑主题名**(短 kebab,如 `ink`),声明 `color-scheme`(亮/亮暗双 facet——暗色变体务必做 `data-theme` 内部 media 分支,不开新主题名)
- [ ] **全量视觉系统 token 赋值**:`--bg --surface --fill --fill-2 --text --text-2 --text-3 --placeholder --hairline --header-line --hover --accent --accent-hi --tint --tint-2 --ring --danger --danger-solid --danger-bg --amber --seg-active --seg-shadow --header-bg --header-hover --pop-bg --shadow-pop --dot-ring --btn-2 --media-btn-bg --media-btn-shadow --push-shadow --search-bg --search-bg-focus --plate-bg --tag-*-c/--tag-*-bg(5 组) --card-shadow --card-shadow-hover`
- [ ] **5 个 accent 变体值**:`[data-accent="blue|cyan|green|orange|rose"]` 下各自的 `--accent/--accent-hi`(及暗色 facet 的对应值)
- [ ] **9 色 Chrome 组色映射**:`grey blue red yellow green pink purple cyan orange` 各配一个主题内色号,加进 `src/core/colors.js`
- [ ] **THEME_ASSETS 加一行**:`<name>: { groupColors, ...视觉资产开关 }`,JS 侧即自动接管,不许加 `dataset.theme ===` 比较
- [ ] **设置页主题下拉加 option**(`optTheme`)

## 可做(主题资产,须块级注释说明动机 + 在此处登记)

默认可覆盖装饰类属性(颜色/字体/背景/边框/遮罩),禁动布局骨架;动骨架的算特例资产,登记于此:

| 资产 | 主题 | 位置 | 为什么需要动骨架 |
|---|---|---|---|
| 晕染墨团计数角标 | ink | `colors.js buildInkBleedSvg` + `.group-count::before` | 墨团需超出徽标本体的溢出画布 |
| 笔锋渐隐分组竖线 | ink | `.group-dot` mask-image | 笔锋渐隐靠 mask 裁切 |
| 媒体蒙层整行宣纸羽化 | ink | `.tab-item.has-media .media-overlay` | linear 是中央浮钮,水墨是整行右起蒙层,定位模型不同 |
| 顶部 Tab 滑块挑出 | ink | `tabSliderExtra`(dom.js) | 两端挑出文字营造舒展留白 |
| 搜索框毛笔长横 | ink | `.search-ink-stroke` SVG | 主题独有装饰件,linear 无对应物 |

## 禁止

- 组件层(主题块之外)写死色值 / 出现主题判断
- 覆盖层里 `!important` 压别的覆盖(只准压基础层)
- 向 `:root` 共享基座加视觉 token(基座只放度量)
- 禁用公共交互层:`.tab-item.active` 的上浮效果(渐变高亮 + scale + 弹性过冲 + 投影)是全主题共享件,任何主题(含未来新增)不得在其命名空间内覆盖 `transform`/`box-shadow`/`transition` 将其关闭;主题只准通过 `--accent` 等 token 影响其配色
