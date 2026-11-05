// 幽灵媒体控件修复：
// ingee.meituan.com 页面会创建无真实媒体流的隐藏 <video>（src 为空，被解析成页面 URL）
// 并对其调用 play()，导致 Chrome 注册媒体会话、工具栏出现全局媒体控件（静音/播放/画中画）。
// 此脚本在主世界、页面代码运行前打补丁：
//   1. 劫持 HTMLMediaElement.prototype.play —— 空源元素直接返回 resolved promise，
//      不触发原生播放，媒体会话不会被激活；
//   2. MutationObserver 兜底 —— 对已存在的空源媒体元素 teardown
//      （pause + 移除 src + load()），销毁媒体会话；后续动态插入的同样清扫。
// 有真实 src/srcObject 的媒体元素不受影响，正常播放。
(() => {
  'use strict';

  const hasRealSource = (el) =>
    Boolean(el.srcObject) ||
    Boolean(el.currentSrc) ||
    Boolean(el.getAttribute('src')); // src="" 会被解析成页面 URL，必须看 attribute

  const teardown = (el) => {
    try {
      el.pause();
      el.removeAttribute('src');
      el.removeAttribute('srcObject');
      el.load(); // 释放资源并销毁媒体会话
    } catch (_) { /* noop */ }
  };

  // ---- 1. 劫持 play()：空源元素不进入激活状态 ----
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!hasRealSource(this)) {
      // 返回 resolved promise，避免页面代码因 rejection 报错或无限重试
      return Promise.resolve();
    }
    return nativePlay.call(this);
  };

  // ---- 2. 兜底清扫 ----
  const handled = new WeakSet();

  const fixElement = (el) => {
    if (handled.has(el) || hasRealSource(el)) return;
    handled.add(el);
    teardown(el);
  };

  const sweep = (root) => {
    root.querySelectorAll?.('video, audio').forEach(fixElement);
  };

  sweep(document);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches?.('video, audio')) {
            fixElement(n);
          } else {
            sweep(n);
          }
        });
      } else if (m.type === 'attributes' && m.target) {
        // src 被移除/清空后再次 teardown
        if (!hasRealSource(m.target)) teardown(m.target);
      }
    }
  });

  const observe = () => {
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  };

  if (document.documentElement) {
    observe();
  } else {
    document.addEventListener('readystatechange', observe, { once: true });
  }
})();
