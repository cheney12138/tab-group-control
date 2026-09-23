// core/colors.js: 分组色板 + 主题资产表(纯常量,render 域与设置面板归档卡片共享)
// 从 main.js 切出,零改动

// Chrome 组色名 → Chrome 原生分组渲染色号(精准提取自附图 Chrome 标签组调色板)
export const GROUP_COLORS = {
  grey:   '#BDC1C6', // 浅冷灰
  blue:   '#8AB4F8', // Chrome 蓝
  red:    '#F28B82', // Chrome 珊瑚红 (附图第1项)
  yellow: '#FDD663', // Chrome 暖黄 (附图第5项)
  green:  '#81C995', // Chrome 草绿 (附图第3项)
  pink:   '#FF8BCB', // Chrome 洋红粉 (附图第6项)
  purple: '#C58AF9', // Chrome 浅紫 (附图第8项)
  cyan:   '#78D9EC', // Chrome 天青蓝 (附图第2项)
  orange: '#FCAD70', // Chrome 暖橙 (附图第9项)
};

// Chrome 组色名 → 中国水墨矿物色(用于 ink 主题,温润内敛)
export const INK_GROUP_COLORS = {
  grey: '#A79E92',   // 淡墨
  blue: '#3F5164',   // 藏青
  red: '#B0503C',    // 绯红
  yellow: '#C08A4E', // 赭石
  green: '#5C7A5E',  // 松绿
  pink: '#93697A',   // 藕荷
  purple: '#84697E', // 黛紫
  cyan: '#7A9E9F',   // 天青
  orange: '#C08A4E', // 赭石
};

// Chrome 组色名 → 云天低饱和色(用于 sky 主题)
// 参考图是「蓝天+白云」的双色世界,但组色是功能性信号必须可分辨 —— 于是九色整体降饱和、偏冷,
// 落进云天世界(云层上可辨)而不跳戏。色相仍沿用 Chrome 九色,只压饱和与明度。
export const SKY_GROUP_COLORS = {
  grey: '#8E9AB8',   // 云影灰蓝
  blue: '#3D63BE',   // 天空蓝
  red: '#C4565A',    // 暮云红
  yellow: '#C9A24B', // 晚照金
  green: '#4E8C6A',  // 雨后青
  pink: '#C4708F',   // 霞粉
  purple: '#7A6BB5', // 暮紫
  cyan: '#3E93B8',   // 晴空青
  orange: '#C97F45', // 夕照橙
};

// 构造水墨风 100% 同款晕染墨团 SVG (支持按分组色动态渲染)
export function buildInkBleedSvg(hex) {
  const c = encodeURIComponent(hex || '#2B2622');
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' width='100' height='100'><defs><filter id='bleedFilter' x='-20%' y='-20%' width='140%' height='140%'><feTurbulence type='fractalNoise' baseFrequency='0.09' numOctaves='3' result='noise'/><feDisplacementMap in='SourceGraphic' in2='noise' scale='7' xChannelSelector='R' yChannelSelector='G'/></filter><radialGradient id='inkWashGrad' cx='56%' cy='42%' r='55%'><stop offset='0%' stop-color='${c}' stop-opacity='0.42'/><stop offset='55%' stop-color='${c}' stop-opacity='0.20'/><stop offset='85%' stop-color='${c}' stop-opacity='0.06'/><stop offset='100%' stop-color='${c}' stop-opacity='0'/></radialGradient><radialGradient id='inkCoreGrad' cx='46%' cy='48%' r='50%'><stop offset='0%' stop-color='${c}'/><stop offset='65%' stop-color='${c}'/><stop offset='85%' stop-color='${c}' stop-opacity='0.95'/><stop offset='100%' stop-color='${c}' stop-opacity='0.55'/></radialGradient></defs><path d='M48 10 C72 6, 90 20, 88 44 C86 68, 70 86, 46 85 C24 84, 8 70, 10 46 C12 22, 26 13, 48 10 Z' fill='url(%23inkWashGrad)' filter='url(%23bleedFilter)'/><path d='M48 16 C68 14, 82 25, 80 48 C78 70, 68 81, 48 80 C28 79, 15 68, 17 48 C19 28, 30 18, 48 16 Z' fill='url(%23inkCoreGrad)' filter='url(%23bleedFilter)'/><ellipse cx='47' cy='48' rx='25' ry='24' fill='${c}' opacity='0.96'/><circle cx='75' cy='78' r='4' fill='${c}'/><circle cx='85' cy='72' r='2' fill='${c}' opacity='0.85'/><circle cx='76' cy='89' r='1.5' fill='${c}' opacity='0.75'/><circle cx='18' cy='28' r='1.8' fill='${c}' opacity='0.45'/></svg>`;
}

// 构造 sky 主题的「云朵群」归档点 SVG(按分组色动态渲染)。
// 参考用户给的实拍(标准积云群): 很多圆瓣叠成一团, **顶面被阳光照亮近乎白, 云底沉蓝灰影**。
// 形状不再是单轮廓, 而是"五瓣"积云: 下层三瓣拼底 + 上层两瓣出峰(叠圆自然出圆瓣边缘)。
// 体积感的做法(不是画渐变块):
//   ① 云体填分组色; ② 逐瓣打一层径向高光(每个瓣的顶部受光)→ 瓣与瓣之间自然留出暗缝;
//   ③ 整体再叠一层纵向"顶亮"渐变(太阳在上); ④ 底部一层蓝灰影(云底自遮);
//   ⑤ 最后扫一层极淡云白, 把整体压轻(用户反馈"有点厚重"→ 要更轻盈)。
// **轻盈度是一组可调旋钮**: 体不透明度 0.92 / 云白罩 0.18 / 云底影 0.16(原先 0.30)/
// 受光渐变淡到 58%(比原来铺得开)/ blur 1.15 + 柔霾 0.22(边缘更软)。
// 云体不靠 ink 的 multiply 渗透, 而是上面直接画 —— 落在云面亮底上色是"轻"的。
// 注: 这是对 sky 设计纪律第 8 条"云只准在天空带"的**例外**, 由用户拍板(归档点用云形),
// 已登记于 docs/theming.md 资产表与 docs/theme-sky-design.md。
export function buildSkyBleedSvg(hex) {
  const c = encodeURIComponent(hex || '#3D63BE');
  const light = encodeURIComponent('#EDF3FE'); // 受光面(比云面白一级, 不给纯白)
  const dark = encodeURIComponent('#16224A');  // 云底影: 用云层深蓝墨, 不用中性黑
  // 云身: 下层三瓣拼底(28/48/68) + 上层两瓣出峰(37/58) —— 叠圆自然出圆瓣边缘
  const body = "<rect x='14' y='60' width='72' height='16' rx='8'/><circle cx='28' cy='58' r='15'/><circle cx='48' cy='54' r='18'/><circle cx='68' cy='57' r='14'/><circle cx='37' cy='43' r='12'/><circle cx='58' cy='40' r='14'/>";
  // 打进体内的逐瓣高光: 每个受光瓣顶部亮一颗, 瓣间于是留出暗缝(积云的"花椰菜"感)
  const glow = "<circle cx='37' cy='43' r='12'/><circle cx='58' cy='40' r='14'/><circle cx='28' cy='58' r='15'/><circle cx='48' cy='54' r='18'/>";
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' width='100' height='100'><defs><linearGradient id='skyLight' x1='0' y1='0' x2='0' y2='1'><stop offset='0%' stop-color='${light}'/><stop offset='58%' stop-color='${light}' stop-opacity='0'/></linearGradient><linearGradient id='skyShade' x1='0' y1='0' x2='0' y2='1'><stop offset='52%' stop-color='${dark}' stop-opacity='0'/><stop offset='100%' stop-color='${dark}' stop-opacity='0.16'/></linearGradient><radialGradient id='skyPuff' cx='50%' cy='24%' r='78%'><stop offset='0%' stop-color='${light}' stop-opacity='0.5'/><stop offset='72%' stop-color='${light}' stop-opacity='0'/></radialGradient><clipPath id='skyClip'>${body}</clipPath><filter id='skySoft' x='-40%' y='-40%' width='180%' height='180%'><feGaussianBlur stdDeviation='1.15'/></filter><filter id='skyHaze' x='-40%' y='-40%' width='180%' height='180%'><feGaussianBlur stdDeviation='5'/></filter></defs><g filter='url(%23skyHaze)' opacity='0.22' fill='${c}'>${body}</g><g filter='url(%23skySoft)' opacity='0.92'><g clip-path='url(%23skyClip)'><rect x='0' y='0' width='100' height='100' fill='${c}'/><g fill='url(%23skyPuff)'>${glow}</g><rect x='0' y='0' width='100' height='100' fill='url(%23skyLight)'/><rect x='0' y='0' width='100' height='100' fill='url(%23skyShade)'/><rect x='0' y='0' width='100' height='100' fill='${light}' opacity='0.18'/></g></g></svg>`;
}

// ---- 主题资产表(ADR-0003 Q6: 表驱动单点化) ----
// JS 一律经 themeAssets() 取当前主题资产,禁止再出现 dataset.theme === '...'
// 的散点比较(主题加载/持久化层 settings.js 的裸读取除外——那是挂载点本身)。
// 新主题 = 表里加一行,不是各调用点加 if:
//   groupColors      9 色组色映射(强制)
//   inkBlot          计数角标使用晕染墨团(可选视觉资产; render 域)
//   blotSvg          归档卡片左侧点的晕染图构造器(主题自备, 可选): 入参分组色, 返回 data-URI
//   tabSliderExtra   顶部 Tab 滑块左右挑出量 px(可选视觉资产)
export const THEME_ASSETS = {
  linear: { groupColors: GROUP_COLORS },
  ink: { groupColors: INK_GROUP_COLORS, inkBlot: true, blotSvg: buildInkBleedSvg, tabSliderExtra: 6 },
  sky: { groupColors: SKY_GROUP_COLORS, blotSvg: buildSkyBleedSvg },
};
export function themeAssets() {
  const t = document.documentElement.dataset.theme;
  return THEME_ASSETS[t] || THEME_ASSETS.linear; // 契约: 缺省/未知一律按 linear
}
