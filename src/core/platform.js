// core/platform.js: 平台适配常量(纯,无依赖)
export const IS_MAC = navigator.userAgent.includes('Mac');
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';

// 调试开关: 在弹窗 DevTools Console 里执行 localStorage.setItem('tgs-debug','1') 开启
export const DEBUG = localStorage.getItem('tgs-debug') === '1';
