// media 控制 content script: 响应 popup 的 播放/暂停 请求。
// 页面里可能有多个 media 元素(主视频+预览视频等),只动"正在播放"的那个;
// 都没在播时动第一个(恢复播放场景)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'toggle-media') return;
  const medias = [...document.querySelectorAll('video, audio')];
  if (!medias.length) {
    sendResponse({ ok: false, reason: 'no-media' });
    return;
  }
  const playing = medias.filter(m => !m.paused && !m.ended);
  if (playing.length) {
    playing.forEach(m => m.pause());
    sendResponse({ ok: true, action: 'paused', count: playing.length });
  } else {
    // 恢复播放: 只播第一个(同时播多个会是灾难)
    const target = medias.find(m => m.src || m.currentSrc) || medias[0];
    target.play().then(
      () => sendResponse({ ok: true, action: 'playing' }),
      err => sendResponse({ ok: false, reason: String(err) })
    );
    return true; // play() 是 Promise,异步 sendResponse
  }
});
