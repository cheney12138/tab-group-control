// 首绘前定主题 —— 消灭独立窗口"先闪 linear(系统深色下是黑框)再切主题"的
// 两次跳变(2026-10-14 用户录屏)。
// 病根: popup.html 的 <html data-theme="linear"> 是硬编码, localStorage 里
// 的真实主题要等 settings.js 异步读完才换属性 —— 窗口先按 linear 画一帧。
// 本脚本以同步外链方式在 <head> 里(样式表解析前)先换属性: CSP 禁内联脚本,
// 同步外链脚本会阻塞首绘, 保证首帧就是目标主题。主题集合与设置面板一致。
try {
  var t = localStorage.getItem('tgs-theme');
  if (t === 'ink' || t === 'sky') document.documentElement.setAttribute('data-theme', t);
  // linear 是 HTML 硬编码默认值, 无需处理
} catch (e) { /* 拿不到 localStorage 就维持 linear */ }
