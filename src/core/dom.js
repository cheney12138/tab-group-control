// core/dom.js: 推送式通知(iOS push 同款)——toast / confirm 的基础设施
// 三种形态共用一个栈容器: toast(纯文字)/undo(带撤销)/confirm(确认+取消)。
// 出现=顶部滑入回弹,消失=下滑淡出,连续 push 旧的先上滑让位。
// 从 main.js 切出,函数体零改动(undo 的 renderUndoBanner 留在 undo 域)
export const pushStack = document.getElementById('pushStack');

// 结果列表容器(全局单例,与 pushStack 同款): main 渲染域与各 feature 共享
export const resultsEl = document.getElementById('results');

// 搜索输入框(全局单例): 键盘路由/search 组件/settings focusInput 共用
export const input = document.getElementById('search');

// 按 tabId 找当前渲染中的行(重渲染会重建 DOM,每次都要现查,不能缓存)
export function rowByTabId(tabId) {
  return resultsEl.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
}

// 行在标签行序列中的序号(键盘导航的 activeIndex 语义)
export function indexOfRow(row) {
  return [...resultsEl.querySelectorAll('.tab-item')].indexOf(row);
}

// 通用条目工厂: 内容元素自由组装,自动处理入场/让位/定时消失。
// opts.autoDismiss: 自动消失延迟(ms),0 = 不自动消失(confirm 由按钮/超时控制)
export function pushBanner(build, opts = {}) {
  const autoDismiss = opts.autoDismiss ?? 2000;
  // 连续 push 时: 现存条目先上滑让位(iOS 通知堆叠的观感)
  for (const old of pushStack.children) {
    old.classList.remove('push-gone');
    old.classList.add('push-away');
    old.addEventListener('animationend', () => old.remove(), { once: true });
  }
  const banner = document.createElement('div');
  banner.className = 'push-banner';
  build(banner);
  pushStack.appendChild(banner);
  // 自动消失: 播放下滑淡出后再移除;确认条手动关闭时同样走 dismissBanner
  if (autoDismiss > 0) {
    setTimeout(() => dismissBanner(banner), autoDismiss);
  }
  return banner;
}

// 优雅退场: 下滑+淡出动画结束后移除节点
export function dismissBanner(banner) {
  if (!banner.isConnected) return;
  banner.classList.remove('push-away');
  banner.classList.add('push-gone');
  banner.addEventListener('animationend', () => banner.remove(), { once: true });
}

// 轻量提示: 推送条目,2 秒自动滑走
export function showToast(text) {
  pushBanner((banner) => {
    const msg = document.createElement('span');
    msg.className = 'push-msg';
    msg.textContent = text;
    banner.appendChild(msg);
  });
}

// 面板内确认条: 系统确认(confirm)会被设置的覆盖层遮挡,导致流程无声卡死。
// 推送形态的确认/取消条,返回 Promise<boolean>,8s 超时视为取消
export function confirmInPanel(text) {
  return new Promise((resolve) => {
    let banner;
    const settle = (val) => {
      clearTimeout(timer);
      dismissBanner(banner);
      resolve(val);
    };
    banner = pushBanner((b) => {
      const msg = document.createElement('span');
      msg.className = 'push-msg';
      msg.textContent = text;
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'push-action secondary';
      cancelBtn.textContent = '取消';
      const okBtn = document.createElement('button');
      okBtn.className = 'push-action';
      okBtn.textContent = '确认清理';
      cancelBtn.addEventListener('click', () => settle(false));
      okBtn.addEventListener('click', () => settle(true));
      b.appendChild(msg);
      b.appendChild(cancelBtn);
      b.appendChild(okBtn);
    }, { autoDismiss: 0 });
    const timer = setTimeout(() => settle(false), 8000);
  });
}

// Tab 滑块位置量算(纯 DOM,视图切换与设置面板共用):
// 量取激活 tab 的几何,把 slider 平移缩放到其正下方。
// 只写 transform: 元素宽度恒为 CSS 里的 38px 设计基准,长度用 scaleX 承载,
// 这样水墨笔触的 mask 只烘焙一次、粗细恒定,过渡全程走合成不动布局。
export const SLIDER_BASE_W = 38;
export function positionTabSlider(container) {
  const slider = container?.querySelector('.tab-slider');
  const active = container?.querySelector('.view-tab.active, .settings-tab.active');
  if (!slider || !active) return;
  const isInk = document.documentElement.dataset.theme === 'ink';
  // 水墨风顶部 Tab: 左右各比文字微挑出 3px(两端留白舒展)
  const waveExtra = isInk && container.classList.contains('view-tabs') ? 6 : 0;
  const w = Math.max(1, Math.round(active.offsetWidth + waveExtra));
  slider.style.transform =
    `translateX(${active.offsetLeft - waveExtra / 2}px) scaleX(${(w / SLIDER_BASE_W).toFixed(4)})`;
}
