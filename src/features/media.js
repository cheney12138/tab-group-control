// features/media.js: 媒体标签控制(组件)
// 探测(popup 唤起时批量注入自查) + 行内按钮(播放/暂停/静音/PiP) + 状态同步。
// 与 content.js 配对: 页面侧实现 toggle-media/pip/probe-media。
import { showToast, resultsEl, rowByTabId } from '../core/dom.js';
import { mediaTabIds } from '../core/store.js';

let actions = null; // initMedia 注入: { getAllTabs, getTabItem }
export function initMedia(injected) { actions = injected; }

// ---- 媒体 tab 探测 ----
// tab.audible 是瞬时播放状态: 暂停即 false,Chrome API 无从识别"暂停中的
// 媒体页"。打开弹窗时对可注入的页面批量探测一次——页面里有带源的
// <video>/<audio> 即算媒体 tab(与 macOS 控制中心 Now Playing 卡片同语义:
// 暂停了也保留恢复入口)。探测函数在页面里自查,命中才回发消息,
// popup 收集 sender.tab.id,收到即给对应行补按钮(增量 patch,不重渲染)
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'media-report' && sender.tab?.id > 0) {
    mediaTabIds.add(sender.tab.id);
    patchMediaBtn(sender.tab.id);
  }
});

export function setMediaBtnState(btn, icon, title) {
  btn.innerHTML = icon;
  btn.title = title;
}
// 行内事后补装媒体蒙层: has-media 管样式钩子(hover 置灰/让位),
// media-overlay 是按钮本体。首帧渲染由 buildTabRow 直接构建,
// 这里只服务探测/状态变化异步到达时的补装
function ensureMediaOverlay(row, tab) {
  if (!row.classList.contains('has-media')) {
    row.classList.add('has-media');
  }
  if (!row.querySelector('.media-overlay')) {
    const mediaBtn = buildMediaControls(tab);
    mediaBtn.className = 'media-overlay';
    row.appendChild(mediaBtn);
  }
}
// 带 content.js 注入兜底的 tabs.sendMessage: 扩展重载前就开着的页面
// 没有 content script(消息直接抛错),注入文件后重试一次。
// 动态注入不可用时抛错,由调用方决定提示文案
async function sendWithInject(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    if (!chrome.scripting?.executeScript) throw new Error('此浏览器不支持动态注入');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}
// 音浪指示器辅助: 确保 row 内有 .wave-icon
function ensureWaveIcon(row) {
  let wave = row.querySelector('.wave-icon');
  if (!wave) {
    wave = document.createElement('div');
    wave.innerHTML = '<span></span><span></span><span></span>';
    const ref = row.querySelector('.last-used, .close-btn');
    if (ref) row.insertBefore(wave, ref);
    else row.appendChild(wave);
  }
  return wave;
}

// 音浪/媒体按钮的行内状态同步(播放↔暂停)。两条路径共用:
//   1. 本弹窗内的媒体按钮点击(乐观更新): resp.action 返回即调用——
//      chrome 上报 audible 有 ~1s 节流,等 onUpdated 会让音浪迟钝一拍
//   2. chrome.tabs.onUpdated 兜底: 用户在页面里直接暂停/播完等外部变化
export function applyMediaRowState(tabId, playing) {
  if (tabId <= 0) return;
  if (playing) mediaTabIds.add(tabId);
  const tabItem = actions.getTabItem(tabId);
  if (tabItem) {
    tabItem.tab.audible = !!playing;
  }
  const row = rowByTabId(tabId);
  if (!row) return;

  // 暂停后仍保留媒体控件(有恢复入口): 补 has-media 与 media-overlay
  if (tabItem) ensureMediaOverlay(row, tabItem.tab);

  // 状态幂等保护: 已处于目标状态则不重复赋值,避免触发动画重置
  // (Chrome onUpdated 与乐观更新双路径到达时的二次归位/跳动)
  const wave = ensureWaveIcon(row);
  const target = playing ? 'is-playing' : 'is-paused';
  const current = wave.classList.contains('is-playing') ? 'is-playing'
    : wave.classList.contains('is-paused') ? 'is-paused' : '';
  if (current !== target) wave.className = 'wave-icon ' + target;

  // 同步播放/暂停按钮图标与提示
  const playBtn = row.querySelector('.media-btn[data-action="toggle"], .media-btn[title="暂停"], .media-btn[title="恢复播放"]');
  if (playBtn) {
    setMediaBtnState(playBtn, playing ? SVG_PAUSE : SVG_PLAY, playing ? '暂停' : '恢复播放');
  }
}
export function probeMediaTabs() {
  // 只探测 http(s) 且未被 Chrome discard 的页面(注入 discarded 页会
  // 把它唤醒重载,不可接受);chrome:// 等不可注入页本来就没有媒体
  const ids = actions.getAllTabs().map(x => x.tab).filter(t =>
    t.id > 0 && !t.discarded &&
    (t.url?.startsWith('http://') || t.url?.startsWith('https://'))
  ).map(t => t.id);
  if (!ids.length) return;
  // 优先走 manifest content_scripts 已注入的 content.js——sendMessage
  // 成本远低于 executeScript(无新注入开销、不占注入配额)。失败
  // (扩展装/重载前就开着的页面没有 content script)再 executeScript 兜底
  for (const id of ids) {
    chrome.tabs.sendMessage(id, { type: 'probe-media' }, () => {
      if (chrome.runtime.lastError) probeMediaViaScripting(id);
    });
  }
}

// 兜底:content.js 不在的页面(扩展安装/重载前就开着的)动态注入探测。
// API 守卫: chrome.scripting 只在 manifest 声明 scripting 权限且
// Chrome >= 88 时存在;旧版/老 Chrome 上整个对象是 undefined,
// 直接调用会在 .catch 挂上之前同步抛 TypeError——守卫后安静降级
function probeMediaViaScripting(id) {
  if (!chrome.scripting?.executeScript) return;
  chrome.scripting.executeScript({
    target: { tabId: id },
    func: () => {
      // 判定与 macOS 控制中心同源: 只认 MediaSession——播放器页面才会
      // 注册 metadata(暂停后依然保留),首页预览小视频/广告位不注册,
      // 避免信息流页面误报。兜底: 正在播放且未静音的元素(个别站点
      // 不注册 MediaSession,但播放中本就该可控)
      if (navigator.mediaSession?.metadata) {
        chrome.runtime.sendMessage({ type: 'media-report' }).catch(() => {});
        return;
      }
      const playing = [...document.querySelectorAll('video, audio')].some(m =>
        !m.paused && !m.ended && !m.muted && (m.src || m.currentSrc));
      if (playing) chrome.runtime.sendMessage({ type: 'media-report' }).catch(() => {});
    },
  }).catch(() => {}); // 个别页面注入失败(受保护页面等),跳过即可
}
function patchMediaBtn(tabId) {
  const row = rowByTabId(tabId);
  if (!row) return;
  const t = actions.getTabItem(tabId)?.tab;
  if (!t) return;
  ensureMediaOverlay(row, t);
  // 补齐音浪指示器(播放跳动,暂停静止低位);已带状态类的不动(幂等)
  const wave = ensureWaveIcon(row);
  if (!wave.classList.contains('is-playing') && !wave.classList.contains('is-paused')) {
    wave.className = 'wave-icon ' + (t.audible ? 'is-playing' : 'is-paused');
  }
}
const SVG_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>';
export const SVG_MUTE = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
export const SVG_UNMUTE = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor"/><path d="M16 8a5 5 0 0 1 0 8M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
const SVG_PIP = '<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"><path d="M5 4h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm7 6h6a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 18 18h-6a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 12 10z"/></svg>';

// 媒体控制组(hover 媒体行时浮现的一排小圆钮): 播放/暂停 + 静音 + 小窗播放。
// 判定与 macOS 控制中心同源(见 content.js probe-media),只对可控媒体标签展示。
// 定义在顶层: buildTabRow(首帧渲染)和 patchMediaBtn(探测消息异步回来补按钮)共用。
export function buildMediaControls(t) {
  const wrap = document.createElement('div');
  wrap.className = 'media-overlay';
  const mk = (act, icon, title) => {
    const b = document.createElement('button');
    b.className = 'media-btn';
    b.dataset.action = act;
    b.title = title;
    b.innerHTML = icon;
    wrap.appendChild(b);
    return b;
  };
  const initiallyMuted = !!t.mutedInfo?.muted;
  const muteBtn = mk('mute', initiallyMuted ? SVG_UNMUTE : SVG_MUTE, initiallyMuted ? '取消静音' : '静音');
  if (initiallyMuted) muteBtn.classList.add('active');
  muteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const live = await chrome.tabs.get(t.id);
      const wasMuted = live.mutedInfo?.muted;
      await chrome.tabs.update(t.id, { muted: !wasMuted });
      const nowMuted = !wasMuted; // 用切换后的状态设置图标/文案,避免取反错位
      setMediaBtnState(muteBtn, nowMuted ? SVG_UNMUTE : SVG_MUTE, nowMuted ? '取消静音' : '静音');
      muteBtn.classList.toggle('active', nowMuted);
      showToast(nowMuted ? '已静音' : '已取消静音');
    } catch (err2) { showToast('操作失败'); }
  });
  const playBtn = mk('toggle', t.audible ? SVG_PAUSE : SVG_PLAY, t.audible ? '暂停' : '恢复播放');
  playBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    let resp;
    try {
      resp = await sendWithInject(t.id, { type: 'toggle-media' });
    } catch (err2) {
      showToast('控制失败: ' + (err2.message || String(err2)).slice(0, 60));
      return;
    }
    if (resp?.action === 'paused') {
      applyMediaRowState(t.id, false);
      chrome.runtime.sendMessage({ type: 'set-tab-audible', tabId: t.id, audible: false }).catch(() => {});
      showToast('已暂停');
    } else if (resp?.action === 'playing') {
      applyMediaRowState(t.id, true);
      chrome.runtime.sendMessage({ type: 'set-tab-audible', tabId: t.id, audible: true }).catch(() => {});
      showToast('已恢复播放');
    }
    else showToast('该页面没有可控的媒体');
  });
  const pipBtn = mk('pip', SVG_PIP, '小窗播放');
  pipBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    let resp;
    try { resp = await sendWithInject(t.id, { type: 'pip' }); }
    catch { showToast('小窗失败'); return; }
    if (resp?.ok) {
      const entered = resp.action === 'entered';
      pipBtn.classList.toggle('active', entered);
      showToast(entered ? '已开启小窗' : '已退出小窗');
    }
    else showToast('小窗失败: ' + (resp?.reason || ''));
  });
  return wrap;
}
