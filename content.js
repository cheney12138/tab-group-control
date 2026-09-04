// media 控制 content script: 响应 popup 的 播放/暂停 请求。
// 页面里可能有多个 media 元素(主视频+预览视频等),只动"正在播放"的那个;
// 都没在播时动第一个(恢复播放场景)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // media 控制: 响应 popup 的 播放/暂停 请求。
  // 页面里可能有多个 media 元素(主视频+预览视频等),只动"正在播放"的那个;
  // 都没在播时动第一个(恢复播放场景)
  if (msg?.type === 'toggle-media') {
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
    return;
  }

  // 媒体 tab 探测(popup 唤起时批量探,命中即回发 media-report 给 popup
  // 补按钮)。判定与 macOS 控制中心同源: 只认 MediaSession——播放器页面
  // 才会注册 metadata(暂停后依然保留),首页预览小视频/广告位不注册,
  // 避免信息流误报。兜底: 正在播放且未静音的元素(个别站点不注册
  // MediaSession,但播放中本就该可控)
  if (msg?.type === 'probe-media') {
    let hit = false;
    if (navigator.mediaSession?.metadata) {
      hit = true;
    } else {
      hit = [...document.querySelectorAll('video, audio')].some(m =>
        !m.paused && !m.ended && !m.muted && (m.src || m.currentSrc));
    }
    if (hit) chrome.runtime.sendMessage({ type: 'media-report' }).catch(() => {});
    sendResponse({ ok: hit });
    return;
  }
});
