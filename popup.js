// 按分组展示的标签页搜索:
// 读取 chrome.tabGroups 中由 Tabbiy 等插件创建的原生分组,
// 搜索结果按分组分区显示,支持模糊匹配与拼音首字母场景下的子串匹配。

// 性能埋点(无条件输出): 脚本开始执行的时刻。
// 平台适配: Windows 下 UI 文案的修饰键符号用 Ctrl,mac 用 ⌘
const IS_MAC = navigator.userAgent.includes('Mac');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

// Chrome 组色名 → Chrome 原生分组渲染色号(精准提取自附图 Chrome 标签组调色板)
const GROUP_COLORS = {
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
const INK_GROUP_COLORS = {
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

// 调试开关: 在弹窗 DevTools Console 里执行 localStorage.setItem('tgs-debug','1') 开启
const DEBUG = localStorage.getItem('tgs-debug') === '1';

// ---- 设置 ----
const settings = {
  showUrl: localStorage.getItem('tgs-showurl') === '1',  // 显示 URL 行,默认关(需要自己打开)
  // 删除标签的快捷键。历史上默认 ⌘⌫,但 macOS 部分输入法/键盘工具会给
  // 裸退格误置 metaKey,"没按 ⌘ 也删标签"的 bug 反复出现的根源。
  // 判定已改用 e.code(物理键位,不受输入法影响),但仍提供配置:
  //   cmd-bs / ⌘⌫   — 默认,最不容易误触
  //   bs / 裸退格    — 光标在输入框起点时删除选中行(顺手但有误删风险)
  //   dbl-bs / 双击退格 — QuicKey 风格,500ms 内两次裸退格=删除
  deleteKey: localStorage.getItem('tgs-deletekey') || 'cmd-bs',
};
function saveSettings() {
  localStorage.setItem('tgs-showurl', settings.showUrl ? '1' : '0');
  localStorage.setItem('tgs-deletekey', settings.deleteKey);
}

const input = document.getElementById('search');
// HTML 里的修饰键占位符填充(mac: ⌘ / Windows: Ctrl+)
document.querySelectorAll('.k-c, .k-cmd').forEach(el => el.textContent = MOD);
// Windows 下 ⌫/⇧ 等 mac 符号换成文字
if (!IS_MAC) {
  document.querySelectorAll('.shortcut-table td:first-child').forEach(td => {
    td.innerHTML = td.innerHTML
      .replace('⌫', 'Backspace')
      .replace('⇧', 'Shift+');
  });
}
const resultsEl = document.getElementById('results');
let allTabs = [];      // [{tab, group}] group 为 null 表示未分组
let filtered = [];     // 当前展示的 [{tab, group, titleMarks, urlMarks}]
let activeIndex = -1;

// 收起状态持久化: chrome 的 groupId 每次启动会变,用 分组名+颜色 做稳定 key
const COLLAPSE_STORE = 'tgs-collapsed';
function collapsedKeys() {
  try {
    // 过滤历史版本 bug 写入的垃圾 key
    const keys = JSON.parse(localStorage.getItem(COLLAPSE_STORE) || '[]')
      .filter(k => k !== '(未命名)|undefined');
    return new Set(keys);
  } catch { return new Set(); }
}
function groupKey(group) {
  return group ? `${group.title || '(未命名)'}|${group.color}` : '__ungrouped__';
}
let collapsed = collapsedKeys();
function saveCollapsed() {
  localStorage.setItem(COLLAPSE_STORE, JSON.stringify([...collapsed]));
}

// 搜索模式独立的收起状态: 每次开始新搜索时重置为全展开,不持久化
let searchCollapsed = new Set();
// 当前模式生效的收起集合
function activeCollapsed() {
  return searching ? searchCollapsed : collapsed;
}

// ---- 视图: grouped(按分组) / recent(纯最近使用) / current(仅当前窗口) ----
const VIEWS = ['grouped', 'recent', 'current'];
let view = VIEWS.includes(localStorage.getItem('tgs-view')) ? localStorage.getItem('tgs-view') : 'grouped';

// 极简模糊匹配: 返回匹配到的字符下标数组,不匹配返回 null
// 拼音匹配(pinyin-data.js 提供 GB2312 全量汉字→无调拼音,29KB):
// 全拼模式——"dingdan" 匹配「订单管理」;首字母 "dd" 也兼容(前缀命中)。
// 数据表 PINYIN_TABLE(拼音串) + PINYIN_IDX(编码偏移→表索引,0=无拼音)
const pinyinFullCache = new Map(); // 字符 -> 完整拼音
const pinyinAbbrCache = new Map(); // 字符 -> 首字母

function charPinyin(ch) {
  if (pinyinFullCache.has(ch)) return pinyinFullCache.get(ch);
  let py = null;
  const code = ch.codePointAt(0);
  // 码点直查表(之前用 TextEncoder 转 gb2312 查——但 Chrome 的 TextEncoder
  // 不支持 gb2312 标签,构造直接抛 EncodingError,拼音层整体失效过)
  if (code >= 0x4E00 && code <= 0x9FFF && typeof PINYIN_IDX !== 'undefined') {
    const idx = PINYIN_IDX[code - 0x4E00];
    if (idx > 0) py = PINYIN_TABLE[idx - 1];
  }
  pinyinFullCache.set(ch, py);
  return py;
}

function charPinyinInitial(ch) {
  if (pinyinAbbrCache.has(ch)) return pinyinAbbrCache.get(ch);
  const full = charPinyin(ch);
  const abbr = full ? full[0] : null;
  pinyinAbbrCache.set(ch, abbr);
  return abbr;
}

// 文本 → 全拼串 / 首字母串(非汉字原样保留,整体小写)
function textToPinyin(text) {
  let out = '';
  for (const ch of text || '') {
    const p = charPinyin(ch);
    out += p !== null ? p : ch;
  }
  return out.toLowerCase();
}
function textToPinyinInitials(text) {
  let out = '';
  for (const ch of text || '') {
    const p = charPinyinInitial(ch);
    out += p !== null ? p : ch;
  }
  return out.toLowerCase();
}

// 拼音匹配: 查询串(英文)对标题(含汉字)的拼音形态做模糊匹配。
// 两级: 全拼("dingdan"→订单管理) 和 首字母("dd"→订单管理)。
// 无汉字的标题直接 false
function pinyinMatch(query, text) {
  if (!/[一-鿿]/.test(text || '')) return false;
  const q = query.toLowerCase();
  if (!q || !q.match(/^[a-z]+$/)) return false; // 仅纯字母查询走拼音
  return fuzzyMatch(q, textToPinyin(text)) !== null
    || fuzzyMatch(q, textToPinyinInitials(text)) !== null;
}

function fuzzyMatch(query, text) {
  // 固定模糊匹配: 按序散字符命中(子串是其特例)。曾有「模糊匹配」开关
  // 已删——低频配置不值得占设置面板,模糊匹配是更好的默认
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const hits = [];
  let ti = 0;
  for (const qc of q) {
    if (qc === ' ') continue;
    const idx = t.indexOf(qc, ti);
    if (idx === -1) return null;
    hits.push(idx);
    ti = idx + 1;
  }
  return hits;
}

function markText(text, hits) {
  if (!hits || !hits.length) return escapeHtml(text);
  const set = new Set(hits);
  let html = '';
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    html += set.has(i) ? `<mark>${ch}</mark>` : ch;
  }
  return html;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let currentWindowId = null; // 弹窗所属窗口,用于区分"其他窗口"的标签
let windowIds = [];         // 所有含标签的窗口 id,升序;用于把内部 id 映射为可读序号
let currentSourceIsHistory = false; // /h 命令模式下,行渲染加半透明降级
// ---- 媒体 tab 探测 ----
// tab.audible 是瞬时播放状态: 暂停即 false,Chrome API 无从识别"暂停中的
// 媒体页"。打开弹窗时对可注入的页面批量探测一次——页面里有带源的
// <video>/<audio> 即算媒体 tab(与 macOS 控制中心 Now Playing 卡片同语义:
// 暂停了也保留恢复入口)。探测函数在页面里自查,命中才回发消息,
// popup 收集 sender.tab.id,收到即给对应行补按钮(增量 patch,不重渲染)
const mediaTabIds = new Set();
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'media-report' && sender.tab?.id > 0) {
    mediaTabIds.add(sender.tab.id);
    patchMediaBtn(sender.tab.id);
  }
});
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
function applyMediaRowState(tabId, playing) {
  if (tabId <= 0) return;
  if (playing) mediaTabIds.add(tabId);
  const tabItem = allTabs.find(x => x.tab.id === tabId);
  if (tabItem) {
    tabItem.tab.audible = !!playing;
  }
  const row = resultsEl.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
  if (!row) return;

  // 暂停后仍保留媒体控件(有恢复入口): 补 has-media 与 media-overlay
  if (mediaTabIds.has(tabId) && !row.classList.contains('has-media')) {
    row.classList.add('has-media');
  }
  if (tabItem && !row.querySelector('.media-overlay')) {
    const mediaBtn = buildMediaControls(tabItem.tab);
    mediaBtn.className = 'media-overlay';
    row.appendChild(mediaBtn);
  }

  // 状态幂等保护: 若已处于目标状态,绝不重复赋值触发动画重置,
  // 彻底根除 Chrome onUpdated 与多重类名切换导致的二次归位/跳动
  const wave = ensureWaveIcon(row);
  const isCurrentlyPlaying = wave.classList.contains('is-playing');
  const isCurrentlyPaused = wave.classList.contains('is-paused');

  if (playing) {
    if (!isCurrentlyPlaying) {
      wave.className = 'wave-icon is-playing';
    }
  } else {
    if (!isCurrentlyPaused || isCurrentlyPlaying) {
      wave.className = 'wave-icon is-paused';
    }
  }

  // 同步播放/暂停按钮图标与提示
  const playBtn = row.querySelector('.media-btn[data-action="toggle"], .media-btn[title="暂停"], .media-btn[title="恢复播放"]');
  if (playBtn) {
    playBtn.innerHTML = playing ? SVG_PAUSE : SVG_PLAY;
    playBtn.title = playing ? '暂停' : '恢复播放';
  }
}
// 外部变化(页面内直接暂停/播完)的同步路径。注意: 本弹窗按钮点击已由
// applyMediaRowState 乐观更新过,这里到达时状态一致,幂等无害
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.audible !== undefined && tabId > 0) {
    applyMediaRowState(tabId, !!changeInfo.audible);
  }
  if (changeInfo.mutedInfo !== undefined && tabId > 0) {
    const row = resultsEl.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
    if (row) {
      const muteBtn = row.querySelector('.media-btn[data-action="mute"], .media-btn[title="静音"], .media-btn[title="取消静音"]');
      if (muteBtn) {
        const isMuted = !!changeInfo.mutedInfo.muted;
        muteBtn.innerHTML = isMuted ? SVG_UNMUTE : SVG_MUTE;
        muteBtn.title = isMuted ? '取消静音' : '静音';
      }
    }
  }
});
function probeMediaTabs() {
  // 只探测 http(s) 且未被 Chrome discard 的页面(注入 discarded 页会
  // 把它唤醒重载,不可接受);chrome:// 等不可注入页本来就没有媒体
  const ids = allTabs.map(x => x.tab).filter(t =>
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
  const row = resultsEl.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
  if (!row) return;
  const t = allTabs.find(x => x.tab.id === tabId)?.tab;
  if (!t) return;
  if (!row.classList.contains('has-media')) {
    row.classList.add('has-media');
  }
  if (!row.querySelector('.media-overlay')) {
    const mediaBtn = buildMediaControls(t);
    mediaBtn.className = 'media-overlay';
    row.appendChild(mediaBtn);
  }
  // 补齐音浪指示器(播放跳动,暂停静止低位)
  const wave = ensureWaveIcon(row);
  if (!wave.classList.contains('is-playing') && !wave.classList.contains('is-paused')) {
    wave.className = 'wave-icon ' + (t.audible ? 'is-playing' : 'is-paused');
  }
}
const SVG_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>';
const SVG_MUTE = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
const SVG_UNMUTE = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor"/><path d="M16 8a5 5 0 0 1 0 8M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
const SVG_PIP = '<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"><path d="M5 4h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm7 6h6a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 18 18h-6a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 12 10z"/></svg>';

// 媒体控制组(hover 媒体行时浮现的一排小圆钮): 播放/暂停 + 静音 + 小窗播放。
// 判定与 macOS 控制中心同源(见 content.js probe-media),只对可控媒体标签展示。
// 定义在顶层: buildTabRow(首帧渲染)和 patchMediaBtn(探测消息异步回来补按钮)共用。
function buildMediaControls(t) {
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
      muteBtn.innerHTML = nowMuted ? SVG_UNMUTE : SVG_MUTE;
      muteBtn.title = nowMuted ? '取消静音' : '静音';
      muteBtn.classList.toggle('active', nowMuted);
      showToast(nowMuted ? '已静音' : '已取消静音');
    } catch (err2) { showToast('操作失败'); }
  });
  const playBtn = mk('toggle', t.audible ? SVG_PAUSE : SVG_PLAY, t.audible ? '暂停' : '恢复播放');
  playBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const toggle = async () => chrome.tabs.sendMessage(t.id, { type: 'toggle-media' });
    let resp = null;
    try {
      resp = await toggle();
    } catch {
      try {
        if (!chrome.scripting?.executeScript) throw new Error('此浏览器不支持动态注入');
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
        resp = await toggle();
      } catch (err2) {
        showToast('控制失败: ' + (err2.message || String(err2)).slice(0, 60));
        return;
      }
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
    const pip = async () => chrome.tabs.sendMessage(t.id, { type: 'pip' });
    let resp = null;
    try { resp = await pip(); }
    catch {
      try {
        if (!chrome.scripting?.executeScript) throw new Error('不支持');
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
        resp = await pip();
      } catch (err2) { showToast('小窗失败'); return; }
    }
    if (resp?.ok) {
      const entered = resp.action === 'entered';
      pipBtn.classList.toggle('active', entered);
      showToast(entered ? '已开启小窗' : '已退出小窗');
    }
    else showToast('小窗失败: ' + (resp?.reason || ''));
  });
  return wrap;
}

// ---- 命令模式数据源: /b 书签 /h 历史 ----
// 结构与 allTabs 同构([{tab, group}]),tab.id 用负数避免与真实 tabId 冲突
let bookmarkItems = [];
let historyItems = [];
let bookmarksLoaded = false;
let historyLoaded = false;

async function loadBookmarks() {
  if (bookmarksLoaded) return;
  try {
    const tree = await chrome.bookmarks.getTree();
    bookmarkItems = [];
    let id = -1;
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.url) {
          bookmarkItems.push({
            tab: { id: id--, title: n.title || n.url, url: n.url,
                   favIconUrl: '', active: false, windowId: -1, lastAccessed: 0 },
            group: null,
          });
        }
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    bookmarksLoaded = bookmarkItems.length > 0; // 空结果(权限失败等)允许下次重试
  } catch (e) {
    console.error('加载书签失败(权限?):', e);
    bookmarksLoaded = false; // 失败不锁死,下次输入重试
  }
}

async function loadHistory() {
  if (historyLoaded) return;
  try {
    const items = await chrome.history.search({ text: '', maxResults: 1000 });
    // Chrome 真实顺序: 按最近访问倒排(API 返回顺序未定义,chrome://history 即此序)
    const sorted = [...items].sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
    // 当前打开的标签 URL 集合: /h 的目的是找回"没开着的"页面,
    // 已开着的(尤其当前标签,它必然是最新历史)从结果中排除
    const openUrls = new Set(allTabs.map(x => x.tab.url).filter(Boolean));
    // 同 URL 折叠(chrome://history 同款): 每个 URL 只保留最近访问的一条,
    // 平铺会把同一页面的历史多次访问全部列出,不像真实历史
    const seen = new Set();
    historyItems = [];
    for (const h of sorted) {
      if (seen.has(h.url)) continue;
      if (openUrls.has(h.url)) continue; // 已开着的页面不进历史列表
      seen.add(h.url);
      historyItems.push({
        tab: { id: -10000 - historyItems.length, title: h.title || h.url, url: h.url,
               favIconUrl: '', active: false, windowId: -1,
               lastAccessed: h.lastVisitTime || 0 },
        group: null,
      });
    }
    historyLoaded = historyItems.length > 0; // 失败/空结果允许重试
  } catch (e) {
    console.error('加载历史失败(权限?):', e);
    historyLoaded = false;
  }
}

// 把 Chrome 内部窗口 id 映射为从 1 开始的序号,比裸 id 可读
function windowOrdinal(windowId) {
  const idx = windowIds.indexOf(windowId);
  return idx === -1 ? windowId : idx + 1;
}

async function loadTabs() {
  const t0 = performance.now();
  // 优先用 background 维护的快照(worker 常驻,数据即时)——省掉三连查询。
  // 快照陈旧/不可用时回退直接查询。
  // currentWindowId 无论走哪条路径都要拿: 它是"弹窗从哪个窗口唤起"的视角,
  // 快照无法预存(每次唤起可能不同),且它决定窗口前缀的显示
  let tabs, groups;
  let fromSnapshot = false;
  const currentWinPromise = chrome.windows.getCurrent().catch(() => null);
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-snapshot' });
    if (resp?.snapshot) {
      tabs = resp.snapshot.tabs;
      groups = resp.snapshot.groups || [];
      fromSnapshot = true;
    }
  } catch (e) { /* worker 未就绪等,走正常查询 */ }
  if (!fromSnapshot) {
    // 分组查询失败不应拖垮整个列表(例如权限缺失时仍可搜索,只是无分组头)
    [tabs, groups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({}).catch(err => {
        console.error('查询分组失败:', err);
        return [];
      }),
    ]);
  }
  currentWindowId = (await currentWinPromise)?.id ?? null;
  if (DEBUG) console.log(`[TGS] loadTabs 耗时: ${(performance.now() - t0).toFixed(1)}ms, 标签数: ${tabs.length}${fromSnapshot ? '(快照)' : '(直查)'}`);
  const groupById = new Map(groups.map(g => [g.id, g]));
  // 收集窗口序号映射(过滤发生在收集之后,保证编号连续且与实际窗口一致)
  windowIds = [...new Set(tabs.map(t => t.windowId))].sort((a, b) => a - b);
  // 按最近使用时间倒排: 分组区顺序由组内最新标签决定,组内同样按最近使用排序
  const sorted = tabs
    .filter(t => !t.url.startsWith('chrome-extension://'))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .map(t => ({ tab: t, group: groupById.get(t.groupId) || null }));
  // 重复合并(QuicKey 同款): 同 URL 多个标签合成一条,保留最近使用的代表,
  // duplicates 记全部副本 id(右上角角标显示份数)。tabs 已按 lastAccessed
  // 倒排,先见的即代表。
  // 合并限定同一窗口内: 跨窗口的同 URL 各自保留——窗口是独立工作区,
  // 跨窗口合并会让另一窗口的标签"消失"(只归属到代表所在的窗口)
  allTabs = [];
  const byUrl = new Map();
  for (const item of sorted) {
    const key = `${item.tab.windowId}|${item.tab.url}`;
    const prev = byUrl.get(key);
    if (prev) {
      prev.duplicates.push(item.tab.id);
      if (item.tab.audible) prev.tab.audible = true;
    } else {
      item.duplicates = []; // 初始化副本数组
      byUrl.set(key, item);
      allTabs.push(item);
    }
  }
}

function search(query) {
  const q = query.trim();
  // 命令模式(QuicKey 同款): /b 书签 /h 历史(含已关标签)
  // 前缀命中即进入命令模式,switchTo 对负 id 条目走"新开标签"
  const isBookmarksCmd = q === '/b' || q.startsWith('/b ');
  const isHistoryCmd = q === '/h' || q.startsWith('/h ');
  const inCommandMode = isBookmarksCmd || isHistoryCmd;
  let source = inCommandMode
    ? (isBookmarksCmd ? bookmarkItems : historyItems)
    : (view === 'current' && currentWindowId != null
        ? allTabs.filter(x => x.tab.windowId === currentWindowId)
        : allTabs);
  // 命令模式剥掉前缀再匹配;裸命令(如"/b")无关键词 → 浏览全量
  const matchQ = inCommandMode
    ? (q.split(/^\/[bh] ?/)[1] || '') : q;
  // 供行渲染区分: /h 的条目加半透明降级(历史非活标签)
  currentSourceIsHistory = isHistoryCmd;
  if (!q || (inCommandMode && !matchQ)) {
    // 空查询/裸命令:展示该数据源全部条目,便于浏览
    filtered = source.map(x => ({ ...x, titleHits: null, urlHits: null }));
    return;
  }
  filtered = [];
  if (inCommandMode) {
    // 书签/历史模式: 按 标题>host 过滤,但保持数据源原序
    // (/h 即 chrome 历史的真实时间序,/b 即书签树序),不按匹配级别重排、不分组
    for (const x of source) {
      const title = x.tab.title || '';
      const titleHits = fuzzyMatch(matchQ, title);
      const host = hostOf(x.tab.url);
      const hostHits = titleHits ? null : (matchQ ? fuzzyMatch(matchQ, host) : null);
      if (titleHits || hostHits || !matchQ) {
        filtered.push({ ...x, titleHits, urlHits: null, matchedOn: titleHits ? 'title' : 'host', exact: false, groupNameExact: false });
      }
    }
    return; // source 顺序即展示顺序
  }
  for (const x of source) {
    // 匹配优先级: 标题 > 拼音首字母 > 分组名 > 域名(host) > 完整 URL
    const title = x.tab.title || '';
    const titleHits = fuzzyMatch(q, title);
    const pinyinHit = !titleHits && pinyinMatch(q, title);
    let urlHits = null;
    let matchedOn = null; // 'title' | 'pinyin' | 'group' | 'host' | 'url'
    let groupHits = null;
    if (titleHits) {
      matchedOn = 'title';
    } else if (pinyinHit) {
      // 拼音首字母命中: "dd"匹配「订单管理」。无高亮(字符不对应),参与排序
      matchedOn = 'pinyin';
    } else if (x.group && x.group.title && (groupHits = fuzzyMatch(q, x.group.title))) {
      // 分组名命中: 搜"订单"能召回分组叫"订单系统"里所有标签
      matchedOn = 'group';
      // 分组名召回的条目同时检测 URL/标题命中,仅为高亮显示(不改变匹配级别):
      // 搜"arena"时能看到具体哪个路径也含这个词
      urlHits = fuzzyMatch(q, x.tab.url || '') || null;
    } else {
      const host = hostOf(x.tab.url);
      const hostHits = host ? fuzzyMatch(q, host) : null;
      if (hostHits) {
        matchedOn = 'host';
      } else {
        urlHits = fuzzyMatch(q, x.tab.url || '');
        if (urlHits) matchedOn = 'url';
      }
    }
    if (matchedOn) {
      // 记录匹配质量: exact = 查询串整体作为连续子串出现(含首字对齐),否则为 fuzzy
      const exactText = matchedOn === 'title' ? title
        : matchedOn === 'pinyin' ? textToPinyin(title)
        : matchedOn === 'group' ? (x.group?.title || '')
        : matchedOn === 'host' ? hostOf(x.tab.url) : (x.tab.url || '');
      const isExact = exactText.toLowerCase().includes(q.toLowerCase());
      // 分组名全等(组名就是查询词)是最强意图信号: 搜"arena"就是想找 arena 组,
      // 排在一切模糊命中的标题之前
      const groupNameExact = matchedOn === 'group'
        && (x.group?.title || '').toLowerCase() === q.toLowerCase();
      filtered.push({ ...x, titleHits, urlHits, groupHits, matchedOn, exact: isExact, groupNameExact });
    }
  }
  // 排序优先级:
  // 0. 分组名全等查询词 > 一切
  // 1. 匹配级别: 标题 > 分组名 > 域名 > 完整 URL
  // 2. 匹配质量: 精确连续子串 > 模糊匹配;同级内首字命中的位置越靠前越优
  // 3. 分组视图按组内排序(组是稳定容器,同组条目永远相邻,
  //    不被其他组的强匹配打散);recent/current 视图按最近使用
  const rank = { title: 0, pinyin: 1, group: 2, host: 3, url: 4 };
  const firstHit = f => f.titleHits?.[0] ?? f.urlHits?.[0] ?? 9999;
  // 单条匹配质量分: 组名全等 0;否则 级别值(精确)/级别值+10(模糊)
  const matchQuality = f => {
    if (f.groupNameExact) return 0;
    return rank[f.matchedOn] + (f.exact ? 0 : 10);
  };
  if (view === 'grouped') {
    // 分组视图: 先分桶,桶内按质量排,桶间按桶内最佳排
    const buckets = new Map(); // groupKey -> { best, items }
    for (const f of filtered) {
      const key = groupKey(f.group);
      if (!buckets.has(key)) buckets.set(key, { best: Infinity, items: [] });
      const b = buckets.get(key);
      const q = matchQuality(f);
      if (q < b.best) b.best = q;
      b.items.push({ ...f, _q: q });
    }
    for (const b of buckets.values()) {
      b.items.sort((x, y) => {
        if (x._q !== y._q) return x._q - y._q;
        const h = firstHit(x) - firstHit(y);
        if (h !== 0) return h;
        return (x.tab.index || 0) - (y.tab.index || 0);
      });
    }
    filtered = [...buckets.values()]
      .sort((a, b) => a.best - b.best)
      .flatMap(b => b.items)
      .map(({ _q, ...f }) => f); // 剥掉临时排序字段
  } else {
    filtered.sort((a, b) => {
      if (a.groupNameExact !== b.groupNameExact) return a.groupNameExact ? -1 : 1;
      const r = rank[a.matchedOn] - rank[b.matchedOn];
      if (r !== 0) return r;
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      const h = firstHit(a) - firstHit(b);
      if (h !== 0) return h;
      return (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0);
    });
  }

  if (DEBUG) {
    console.group(`[TGS] 搜索 "${q}" — 共 ${filtered.length} 条`);
    console.table(filtered.slice(0, 15).map(f => ({
      匹配级别: f.matchedOn,
      精确: f.exact,
      分组: f.group?.title || '',
      标题: (f.tab.title || '').slice(0, 30),
      host: hostOf(f.tab.url),
      lastAccessed: new Date(f.tab.lastAccessed || 0).toLocaleTimeString(),
    })));
    console.log('排序后顺序(渲染前):', filtered.map(f =>
      `${f.matchedOn}:${(f.tab.title || f.tab.url).slice(0, 20)}`));
    console.groupEnd();
  }
}

// 搜索模式下强制全部展开,只有空查询浏览时才应用收起状态
let searching = false;

let staggerIdx = 0; // stagger 入场: render 内每行取号
function staggerDelay() {
  const i = Math.min(staggerIdx++, 12); // 封顶 12 行,后面同时入场
  return `${i * 8}ms`;
}

// 空态文案按数据源区分(纯机器文案的认知成本小优化)
function emptyMessage() {
  if (activeCmd === '/b') return '书签里没有匹配项';
  if (activeCmd === '/h') return '历史里没找到这条记录';
  if (searching) return '没有匹配的标签页,试试拼音首字母?';
  return '没有打开的标签页';
}

function cleanTitle(str) {
  if (!str) return '';
  return str
    .replace(/^[\s\u200B-\u200D\uFEFF\u{1F4A4}💤zZ\[\]\-—·]+/u, '')
    .replace(/[\s\u200B-\u200D\uFEFF\u{1F4A4}💤zZ\[\]\-—·]+$/u, '')
    .trim()
    .toLowerCase();
}

function render() {
  const t0 = performance.now();
  // 记住重渲染前的焦点,重建后尽量恢复
  const prevUnit = navUnits().find(u => u.classList.contains('active'));
  const prevKey = prevUnit?.dataset.groupKey;
  const prevTabId = prevUnit?.dataset.tabId;
  resultsEl.innerHTML = '';
  staggerIdx = 0; // stagger 入场计数器,每行取号后递增(封顶 12 防长列表拖尾)
  if (!filtered.length) {
    resultsEl.innerHTML = `<div class="empty">${emptyMessage()}</div>`;
    return;
  }

  // 标题去重统计: 在渲染任何视图/搜索前全局统一计算,供 URL 展示策略使用。
  // 过滤休眠标记(💤、zzz、零宽空格等),确保休眠 tab 与正常 tab 能准确匹配出标题重复
  const titleCount = new Map();
  for (const it of filtered) {
    const k = cleanTitle(it.tab.title || it.tab.url);
    if (k) titleCount.set(k, (titleCount.get(k) || 0) + 1);
  }
  for (const it of filtered) {
    const k = cleanTitle(it.tab.title || it.tab.url);
    it.titleDup = (titleCount.get(k) || 0) > 1;
  }
  // 离屏构建再一次性挂载: 逐行 append 到已挂载的容器会引发增量布局,
  // 长列表(几百行)时白白多算多次;fragment 只触发一次挂载级布局
  const frag = document.createDocumentFragment();

  // recent / current / 命令模式(/b /h): 不分组平铺。
  // 命令模式直接按数据源原序展示(历史=chrome 真实时间序,书签=书签树序),
  // 无分组头——与 chrome://history 的观感一致
  if (view === 'recent' || view === 'current' || activeCmd) {
    for (const item of filtered) {
      frag.appendChild(buildTabRow(item));
    }
    resultsEl.appendChild(frag);
    return;
  }

  if (searching) {
    // 搜索模式: 先按分组聚合再渲染,每个分组只出现一个头。
    // 排序把同组条目打散在列表各处时,若按"连续出现"切段会导致同一组
    // 出现多个分组头(结果看起来重复),故先聚合:
    //   组间顺序 = 该组内最佳匹配的排名; 组内顺序 = 匹配排序
    const sections = new Map(); // groupKey -> { group, items }
    for (const item of filtered) {
      const key = groupKey(item.group);
      if (!sections.has(key)) sections.set(key, { group: item.group, items: [] });
      sections.get(key).items.push(item);
    }
    // Map 迭代序 = 首次插入序 = filtered 的排序序(组内最佳排名靠前的组先出现)
    const maxCount = Math.max(...[...sections.values()].map(s => s.items.length));
    for (const { group, items } of sections.values()) {
      const key = groupKey(group);
      const isCollapsed = searchCollapsed.has(key);
      frag.appendChild(buildGroupHeader(group, items.length, isCollapsed, () => {
        if (searchCollapsed.has(key)) searchCollapsed.delete(key);
        else searchCollapsed.add(key);
        render();
      }, maxCount));
      if (!isCollapsed) {
        for (const item of items) {
          const row = buildTabRow(item);
          row.classList.add('nested'); // 树状: 子项缩进在分组头下
          frag.appendChild(row);
        }
      }
    }
    resultsEl.appendChild(frag);
    restoreFocus(prevKey, prevTabId);
    if (DEBUG) console.log(`[TGS] render(搜索) 耗时: ${(performance.now() - t0).toFixed(1)}ms, 行数: ${filtered.length}`);
    return;
  }

  // 浏览模式: 按 (窗口, 分组) 分区,保持最近使用顺序
  const sections = [];
  const sectionIndex = new Map(); // key -> section
  for (const item of filtered) {
    const t = item.tab;
    const key = `${t.windowId}:${item.group ? item.group.id : -1}:${item.group ? item.group.windowId : ''}`;
    if (!sectionIndex.has(key)) {
      const section = { group: item.group, windowId: t.windowId, items: [] };
      sectionIndex.set(key, section);
      sections.push(section);
    }
    sectionIndex.get(key).items.push(item);
  }

  // 分区只包含 filtered 里实际有标签的分组: 组内最后一个标签被关掉后,
  // 该组不会出现在 sections,分组头自然消失
  const maxCount = sections.reduce((m, s) => Math.max(m, s.items.length), 0);
  sections.forEach(section => {
    const key = groupKey(section.group);
    const isCollapsed = collapsed.has(key);
    frag.appendChild(buildGroupHeader(section.group, section.items.length, isCollapsed, () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      saveCollapsed();
      render();
    }, maxCount));

    if (!isCollapsed) {
      section.items.forEach(item => {
        const row = buildTabRow(item);
        row.classList.add('nested'); // 树状: 子项缩进在分组头下
        frag.appendChild(row);
      });
    }
  });
  resultsEl.appendChild(frag);
  // 清理收起记忆里已不存在的分组(组被删掉/改名后,残留的 key 会让同名的组莫名收起)
  const liveKeys = new Set(sections.map(s => groupKey(s.group)));
  const staleKeys = [...collapsed].filter(k => !liveKeys.has(k) && k !== '__ungrouped__');
  if (staleKeys.length) {
    staleKeys.forEach(k => collapsed.delete(k));
    saveCollapsed();
  }
  restoreFocus(prevKey, prevTabId);
  if (DEBUG) console.log(`[TGS] render 耗时: ${(performance.now() - t0).toFixed(1)}ms, 行数: ${filtered.length}`);
}

// 重渲染后恢复焦点: 优先同 tabId 的行,其次同 key 的分组头,找不到则不聚焦
function restoreFocus(prevKey, prevTabId) {
  if (!prevKey && !prevTabId) return;
  const units = navUnits();
  let target = null;
  if (prevTabId) {
    target = units.find(u => u.classList.contains('tab-item') && Number(u.dataset.tabId) === Number(prevTabId));
  }
  if (!target && prevKey) {
    target = units.find(u => u.classList.contains('group-header') && u.dataset.groupKey === prevKey);
  }
  if (target) {
    target.classList.add('active');
    if (target.classList.contains('tab-item')) {
      activeIndex = [...resultsEl.querySelectorAll('.tab-item')].indexOf(target);
    } else {
      activeIndex = -2;
    }
  }
}

// 分组头: group 为 null 表示未分组; onClick 为空时不可点击(搜索模式的分隔条)
// maxCount: 本次渲染中最大的组内条目数(迷你条形图的分母),空则不画条
function buildGroupHeader(group, count, isCollapsed, onClick, maxCount) {
  const header = document.createElement('div');
  header.className = 'group-header' + (isCollapsed ? ' collapsed' : '');
  header.style.animationDelay = staggerDelay();
  header.dataset.groupKey = groupKey(group);
  const isInk = document.documentElement.dataset.theme === 'ink';
  const colorMap = isInk ? INK_GROUP_COLORS : GROUP_COLORS;
  const groupColor = group
    ? (colorMap[group.color] || (isInk ? '#A79E92' : '#BDC1C6'))
    : (isInk ? '#A79E92' : '#BDC1C6');
  header.style.setProperty('--group-c', groupColor);

  // 1. 分组竖线: 统一挪到展开/收起箭头的前面 (两主题均生效)
  const dot = document.createElement('span');
  dot.className = 'group-dot';
  dot.style.background = groupColor;
  header.appendChild(dot);

  // 2. 展开/收起箭头
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.innerHTML = '<svg viewBox="0 0 12 12"><path d="M1 3.5l5 5 5-5"/></svg>';
  header.appendChild(caret);

  // 3. 分组名称
  const name = document.createElement('span');
  name.className = 'group-title';
  if (group) {
    // 搜索时分组名也参与高亮,直观看到是分组名命中的召回
    const q = input.value.trim();
    name.innerHTML = q
      ? markText(group.title || '(未命名分组)', fuzzyMatch(q, group.title || ''))
      : escapeHtml(group.title || '(未命名分组)');
  } else {
    name.textContent = '未分组';
  }
  header.appendChild(name);
  if (count != null) {
    // 迷你条形图: 长度∝组内标签数/最大组,不读数字扫一眼知轻重
    if (maxCount > 1) {
      const bar = document.createElement('span');
      bar.className = 'group-bar';
      bar.style.width = `${Math.max(10, Math.round(count / maxCount * 40))}px`;
      bar.style.background = group
        ? (GROUP_COLORS[group.color] || '#8e8e93')
        : '#8e8e93';
      bar.style.opacity = '0.55';
      bar.title = `${count} 个标签`;
      header.appendChild(bar);
    }
    const countEl = document.createElement('span');
    countEl.className = 'group-count';
    countEl.textContent = count;
    header.appendChild(countEl);
  }
  if (onClick) header.addEventListener('click', () => {
    onClick();
    // 点击后浏览器会把真实焦点给到被点的元素,键盘事件就不再经过 input;
    // 立即抢回焦点,保证 ↑↓/←→/Tab 等快捷键继续工作
    input.focus();
  });
  return header;
}

// favicon: 直接用 tab 快照自带的 URL,失败隐藏图标位,保持简单
// favicon 策略(QuicKey 同款):
// ① tab 自带 favIconUrl 优先; ② 没有则拼 _favicon 服务 URL——它读的是
// Chrome 浏览器自己的 favicon 数据库(标签栏图标的同一份缓存),不向网站发请求,
// 内网坏 favicon 的站点也能出图。manifest 已声明 favicon 权限 + _favicon 资源
const FAVICON_PREFIX = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=`;
function faviconUrlFor(t) {
  return t.favIconUrl || (FAVICON_PREFIX + encodeURIComponent(t.url));
}

function buildFaviconEl(t) {
  const img = document.createElement('img');
  img.src = faviconUrlFor(t);
  img.onerror = () => { img.style.visibility = 'hidden'; };
  return img;
}

function buildTabRow(item) {
  const t = item.tab;
  const row = document.createElement('div');
  // /h 历史条目加降级类: 半透明,hover/选中恢复
  row.className = 'tab-item' + (currentSourceIsHistory ? ' history-item' : '');
  row.style.animationDelay = staggerDelay();
  row.dataset.tabId = t.id;

  // 窗口归属(仅用于时间 tag 的"当前"判定与 URL 行强制显示,
  // 不再做行首窗口徽/组内序号——实测都是伪需求,行首留白更干净)
  const isVirtualItem = t.id < 0;
  const isOtherWindow = !isVirtualItem
    && currentWindowId != null && t.windowId !== currentWindowId;

  // favicon + 重复合并角标: 同 URL 多份时 favicon 右上角迷你数字徽(深底白字,
  // 11px 圆点),份数一眼可读;无副本时裸图标
  const iconWrap = document.createElement('span');
  iconWrap.className = 'icon-wrap';
  iconWrap.appendChild(buildFaviconEl(t));
  if (item.duplicates && item.duplicates.length > 0) {
    const dupBadge = document.createElement('span');
    dupBadge.className = 'dup-badge';
    const count = item.duplicates.length + 1;
    dupBadge.textContent = count > 9 ? '9+' : String(count);
    iconWrap.title = `相同页面打开了 ${count} 份(回车切换到最近使用的)`;
    iconWrap.appendChild(dupBadge);
  }
  row.appendChild(iconWrap);

  const info = document.createElement('div');
  info.className = 'tab-info';
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = markText(t.title || t.url, item.titleHits);
  info.appendChild(title);
  // URL 行: 严格遵循用户设置(settings.showUrl)。未开启时绝不擅自展示,保持列表单行高度纯净整齐
  if (settings.showUrl) {
    const url = document.createElement('div');
    url.className = 'url';
    // 只显示域名,除非: ① 搜索命中了 URL, 或 ② 标题完全重复(同名 tab 需展示完整 URL 才能区分)
    const showFull = item.urlHits || item.titleDup;
    const shownUrl = showFull ? displayUrl(t.url) : hostOf(t.url);
    // URL 兜底匹配发生在完整 URL 上,但展示的是 host+path,需在展示文本上重算高亮
    const urlHits = item.urlHits
      ? (fuzzyMatch(input.value.trim(), shownUrl) || item.urlHits)
      : null;
    url.innerHTML = markText(shownUrl, urlHits);
    info.appendChild(url);
  }

  row.appendChild(info);

  // 蒙层式媒体控制: audible 管第一帧(探测未返回前即时可用),
  // 探测结果(mediaTabIds)管暂停中的——有 MediaSession 即有恢复入口。
  // buildMediaControls 是顶层函数,探测消息回调(patchMediaBtn)也要用
  if (t.audible && t.id > 0) mediaTabIds.add(t.id); // 曾播放即记入,暂停/重渲染后仍保留媒体控件
  if ((t.audible || mediaTabIds.has(t.id)) && t.id > 0) {
    row.classList.add('has-media');
    const mediaBtn = buildMediaControls(t);
    mediaBtn.className = 'media-overlay';
    row.appendChild(mediaBtn);
  }

  // 音浪状态指示: 时间戳左侧。
  // 播放时错峰起伏,暂停时静止低位变淡,只对媒体 tab 展示
  if ((t.audible || mediaTabIds.has(t.id)) && t.id > 0) {
    const wave = document.createElement('div');
    wave.className = 'wave-icon ' + (t.audible ? 'is-playing' : 'is-paused');
    wave.innerHTML = '<span></span><span></span><span></span>';
    row.appendChild(wave);
  }

  // 最近使用时间 tag 五档: 当前 > 热门(10分钟,绿) > 今日(蓝) / 近期(灰) > 僵尸(橙/红)
  // 颜色由冷暖渐进,僵尸标签一眼可辨,便于顺手清理
  const tag = document.createElement('span');
  tag.className = 'last-used';
  if (t.active && !isOtherWindow) {
    tag.classList.add('current');
    tag.textContent = '当前';
  } else {
    const label = relativeTime(t.lastAccessed);
    if (label) {
      tag.classList.add(timeTier(t.lastAccessed));
      tag.textContent = label;
    }
  }
  if (tag.textContent) row.appendChild(tag);

  // 关闭按钮: 与时间 tag 同位置,hover/选中该行时才出现(时间 tag 同步淡出)
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  closeBtn.title = `关闭标签页 (${MOD}Backspace)`;
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(t.id);
    // 关闭是 button,点击会拿走键盘焦点,抢回 input 保证快捷键继续工作
    input.focus();
  });
  row.appendChild(closeBtn);

  row.addEventListener('click', () => switchTo(t));
  return row;
}

// 关闭标签页并从列表中移除该行,焦点迁移到相邻行; 底部提供限时撤销
async function closeTab(tabId) {
  const rows = [...resultsEl.querySelectorAll('.tab-item')];
  const rowIdx = rows.findIndex(r => Number(r.dataset.tabId) === tabId);
  const closed = filtered.find(f => f.tab.id === tabId);
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.error('关闭标签失败:', err);
    return;
  }
  // 同步本地数据
  mediaTabIds.delete(tabId);
  // 关的是重复合并行的代表且还有副本: 晋升一份副本为新代表,行保留。
  // 整项丢弃的话,存活的副本会从列表消失,1s 复核时又把整行"复活"
  // (带它自己的媒体按钮)——看起来像刚关的标签带着按钮回来了
  const item = allTabs.find(x => x.tab.id === tabId);
  const survivors = (item?.duplicates || []).filter(id => id !== tabId);
  if (item && survivors.length) {
    try {
      const promoted = await chrome.tabs.get(survivors[0]); // 副本中最新的一份
      item.tab = promoted;
      item.duplicates = survivors.filter(id => id !== promoted.id);
    } catch (e) {
      allTabs = allTabs.filter(x => x.tab.id !== tabId);
    }
  } else if (item) {
    allTabs = allTabs.filter(x => x.tab.id !== tabId);
  }
  search(searchValue()); // 从 allTabs 重建 filtered(晋升/移除都生效)
  // 就地重渲染,并让焦点落到被关闭行的相邻行
  render();
  const newRows = [...resultsEl.querySelectorAll('.tab-item')];
  if (newRows.length) {
    setActive(Math.min(rowIdx >= 0 ? rowIdx : 0, newRows.length - 1));
  } else {
    resultsEl.innerHTML = `<div class="empty">${emptyMessage()}</div>`;
  }
  // 撤销快照带上原分组信息,恢复后用于归组(sessions.restore 不触发 onCreated,
  // Tabbiy 等自动分组插件感知不到恢复的标签,需要我们主动移回原组)
  if (closed) {
    showUndo({
      tab: closed.tab,
      groupTitle: closed.group?.title || null,
      groupColor: closed.group?.color || null,
      windowId: closed.tab.windowId,
    });
  }
}

// ---- 推送式通知(iOS push 同款) ----
// 三种形态共用一个栈容器: toast(纯文字)/undo(带撤销)/confirm(确认+取消)。
// 出现=顶部滑入回弹,消失=下滑淡出,连续 push 旧的先上滑让位。
const pushStack = document.getElementById('pushStack');

// 通用条目工厂: 内容元素自由组装,自动处理入场/让位/定时消失。
// opts.autoDismiss: 自动消失延迟(ms),0 = 不自动消失(confirm 由按钮/超时控制)
function pushBanner(build, opts = {}) {
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
function dismissBanner(banner) {
  if (!banner.isConnected) return;
  banner.classList.remove('push-away');
  banner.classList.add('push-gone');
  banner.addEventListener('animationend', () => banner.remove(), { once: true });
}

// ---- 撤销关闭 ----
let undoTimer = null;
let undoStack = []; // 最近关闭的标签快照,支持连续撤销

function showUndo(snapshot) {
  undoStack.push(snapshot);
  renderUndoBanner();
}

// 渲染撤销通知条 + 启动 6s 倒计时。undoStack 由调用方维护:
// 单关路径 showUndo 已 push;批量清理(cleanStaleTabs)在循环里已 push
// 全部快照,直接调用本函数即可——之前 cleanStaleTabs 误调
// showUndo(targets[last].tab)(传了裸 Tab 而非快照对象),既重复 push
// 又因 snapshot.tab 为 undefined 抛 TypeError,导致清理后不刷新/不提示/
// 不能撤销。拆出本函数后批量路径只渲染不重复入栈
function renderUndoBanner() {
  const count = undoStack.length;
  if (!count) return;
  const tab = undoStack[count - 1]?.tab;
  const title = (tab?.title || tab?.url || '').toString().slice(0, 30);
  pushBanner((banner) => {
    const msg = document.createElement('span');
    msg.className = 'push-msg';
    msg.textContent = count > 1
      ? `已关闭 ${count} 个标签页(含「${title}」)`
      : `已关闭「${title}」`;
    const btn = document.createElement('button');
    btn.className = 'push-action';
    btn.textContent = '撤销';
    btn.title = `恢复刚关闭的标签 (${MOD}Z)`;
    btn.addEventListener('click', doUndo);
    banner.appendChild(msg);
    banner.appendChild(btn);
    // 倒计时进度条: 剩余可撤销时间(条目相对定位收窄置底)
    banner.style.position = 'relative';
    const progress = document.createElement('span');
    progress.className = 'push-progress';
    banner.appendChild(progress);
  }, { autoDismiss: 6000 });
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoStack = [];
  }, 6000);
}

// ⌘Z / Ctrl+Z 撤销最近关闭(等价于点击撤销按钮)
function isUndoAvailable() {
  return undoStack.length > 0;
}

// 撤销: 从 sessions.getRecentlyClosed 里按 URL 匹配找回真实的 sessionId,
// 恢复后把标签移回原分组(sessions.restore 不触发 onCreated,Tabbiy 感知不到,
// 由我们按关闭时记录的分组名补归组)。sessions 的 sessionId 并非 tab id
async function doUndo() {
  if (!undoStack.length) return;
  let recent = [];
  try {
    recent = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  } catch (err) {
    console.error('查询最近关闭失败:', err);
  }
  const restoredTabIds = [];
  for (const snap of undoStack) {
    const t = snap?.tab;
    if (!t) continue; // 防御:跳过任何脏/残缺快照,避免一条坏数据打断整批撤销
    // 关闭时间最新的排在最前;按 URL 匹配(标题可能被页面动态改掉,不作首选条件)
    const match = recent.find(s => s.tab && s.tab.url === t.url)
      || recent.find(s => s.tab && s.tab.title === t.title && s.tab.url === t.url);
    if (match) {
      try {
        const [restored] = await chrome.sessions.restore(match.sessionId);
        // 已恢复的会话从候选里移除,避免连续撤销时重复匹配同一条
        recent = recent.filter(s => s.sessionId !== match.sessionId);
        if (restored?.tab?.id) restoredTabIds.push({ tabId: restored.tab.id, snap });
        continue;
      } catch (err) {
        console.error('恢复会话失败:', err);
      }
    }
    // 兜底: 直接重开 URL(回到原窗口)
    try {
      const created = await chrome.tabs.create({
        url: t.url, active: false, windowId: snap.windowId,
      });
      restoredTabIds.push({ tabId: created.id, snap });
    } catch {
      try {
        const created = await chrome.tabs.create({ url: t.url, active: false });
        restoredTabIds.push({ tabId: created.id, snap });
      } catch {}
    }
  }
  undoStack = [];
  clearPushBanners(); // 通知条主动关闭(不等动画)
  // 补归组: 找同名分组,把恢复的标签移回去
  await regroupRestored(restoredTabIds);
  await loadTabs();
  search(searchValue());
  render();
}

// 把恢复的标签移回原分组: 按 分组名+颜色 在当前所有分组里找同名组。
// 找不到(组已删/改名)则保持未分组,交还给 Tabbiy 的规则或其他手动整理
async function regroupRestored(restored) {
  if (!restored.length) return;
  try {
    const groups = await chrome.tabGroups.query({});
    for (const { tabId, snap } of restored) {
      if (!snap.groupTitle) continue; // 原本就未分组
      const target = groups.find(g =>
        (g.title || '') === snap.groupTitle && g.color === snap.groupColor);
      if (target) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: target.id });
      }
    }
  } catch (err) {
    console.error('补归组失败:', err);
  }
}

// 关闭栈里全部条目(撤销执行后/清理类操作切换提示时)
function clearPushBanners() {
  for (const b of [...pushStack.children]) dismissBanner(b);
  clearTimeout(undoTimer);
}

// ---- 清理空分组 ----
// Chrome 原生没有任何入口删除"组内标签已全部关闭"的空分组,
// Tabbiy 等自动分组插件会积累空壳。直接 query 全量分组,
// 逐个检查组内标签数,为 0 则 ungroup 不了(空组没有成员)——
// chrome.tabGroups 没有删除 API,空组的清除靠把"组"本身释放:
// 组内无成员时 Chrome 会在最后标签关闭时自动删组,但跨窗口残留的
// 空组(标签被移走而非关闭)只能通过 query 拿到后用 move 0 个标签触发——
// 实际可行解: 空组直接被 Chrome 在 tabs.onRemoved 后异步清理,
// 我们要做的是发现并报告仍存在的空组(极少),不误删有内容的组
async function cleanEmptyGroups() {
  try {
    const [groups, tabs] = await Promise.all([
      chrome.tabGroups.query({}),
      chrome.tabs.query({}),
    ]);
    const tabsByGroup = new Map();
    for (const t of tabs) {
      if (t.groupId && t.groupId !== -1) {
        tabsByGroup.set(t.groupId, (tabsByGroup.get(t.groupId) || 0) + 1);
      }
    }
    const empty = groups.filter(g => !tabsByGroup.get(g.id));
    if (!empty.length) {
      showToast('没有空分组');
      return;
    }
    // 空组移除: 把一个临时标签移入该组再移出会触发组删除,但更直接的是
    // chrome.tabs.ungroup 需要成员——空组无成员。Chrome 116+ 提供了
    // 通过 chrome.tabGroups.update 无法删除的事实,唯一可靠 API 路径:
    // 创建一个 about:blank 标签放入该组,再关闭它,组随之消亡
    const ok = confirm(`发现 ${empty.length} 个空分组(组内无标签),通过临时标签触发删除。继续?`);
    if (!ok) return;
    let cleaned = 0;
    for (const g of empty) {
      try {
        const [tmp] = await chrome.tabs.create({
          url: 'about:blank', active: false, windowId: g.windowId,
        });
        await chrome.tabs.group({ tabIds: [tmp.id], groupId: g.id });
        await chrome.tabs.remove(tmp.id);
        cleaned += 1;
      } catch (e) {
        console.error(`清理分组 ${g.title} 失败:`, e);
      }
    }
    showToast(`已清理 ${cleaned} 个空分组`);
    await loadTabs();
    search(searchValue());
    render();
  } catch (e) {
    console.error('清理空分组失败:', e);
  }
}

// ---- 清理僵尸标签 ----
// 批量关闭 stale(7~30天) + zombie(30天+) 档位的标签。
// 排除当前激活标签(正在用的不杀);全部进入撤销栈,可 ⌘Z 整批救回
// 确认用面板内提示条(系统 confirm 会被设置的覆盖层遮挡,曾导致无声卡死)
async function cleanStaleTabs() {
  const targets = allTabs.filter(x => {
    if (!x.tab.lastAccessed) return false;
    const tier = timeTier(x.tab.lastAccessed);
    return (tier === 'stale' || tier === 'zombie') && !x.tab.active;
  });
  if (!targets.length) {
    showToast('没有 7 天以上未使用的标签');
    return;
  }
  // 面板内确认条: 扫描完成先报数量,用户点确认才执行
  const confirmed = await confirmInPanel(
    `发现 ${targets.length} 个 7 天以上未使用的标签,关闭?(${MOD}Z 可撤销)`);
  if (!confirmed) {
    showToast('已取消清理');
    return;
  }
  let closedCount = 0;
  for (const x of targets) {
    try {
      await chrome.tabs.remove(x.tab.id);
      closedCount += 1;
      // 逐个进撤销栈(与单关路径一致,撤销时整批恢复)
      undoStack.push({
        tab: x.tab,
        groupTitle: x.group?.title || null,
        groupColor: x.group?.color || null,
        windowId: x.tab.windowId,
      });
    } catch {}
  }
  // 同步本地数据并刷新
  const closedIds = new Set(targets.map(x => x.tab.id));
  allTabs = allTabs.filter(x => !closedIds.has(x.tab.id));
  // 循环里已把每个目标快照 push 进 undoStack,这里只渲染撤销条,
  // 不再调 showUndo(它会重复 push 且需要快照对象——之前传裸 Tab 导致崩溃)
  renderUndoBanner();
  await loadTabs();
  search(searchValue());
  render();
  if (closedCount > 0) showToast(`已清理 ${closedCount} 个标签,${MOD}Z 可撤销`);
}

// 轻量提示: 推送条目,2 秒自动滑走
function showToast(text) {
  pushBanner((banner) => {
    const msg = document.createElement('span');
    msg.className = 'push-msg';
    msg.textContent = text;
    banner.appendChild(msg);
  });
}

// 面板内确认条: 系统确认(confirm)会被设置的覆盖层遮挡,导致流程无声卡死。
// 推送形态的确认/取消条,返回 Promise<boolean>,8s 超时视为取消
function confirmInPanel(text) {
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

// 相对时间: 刚刚 / N 分钟 / 1小时内 / N 小时 / 昨天 / N 天前 / N 周
function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 10 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟`;
  if (diff < 60 * 60 * 1000) return '1 小时内';
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时`;
  if (diff < 48 * 60 * 60 * 1000) return '昨天';
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return `${Math.floor(diff / (7 * 86400000))} 周前`;
}

// 时间档位: hot(10分钟) / today(24小时) / recent(7天) / stale(30天) / zombie(更久)
function timeTier(ts) {
  if (!ts) return 'recent';
  const diff = Date.now() - ts;
  if (diff < 10 * 60 * 1000) return 'hot';
  if (diff < 24 * 60 * 60 * 1000) return 'today';
  if (diff < 7 * 24 * 60 * 60 * 1000) return 'recent';
  if (diff < 30 * 24 * 60 * 60 * 1000) return 'stale';
  return 'zombie';
}

// URL 展示: 提取 host + path + search + hash; 内部页面(chrome://等)保留完整路径
function displayUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'edge:') {
      return url;
    }
    return u.host + (u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname + u.search + u.hash);
  } catch {
    return url;
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// 标题是否为“占位/错误”(无标题、标题=URL、标题本身是 URL、New Tab 等)。
// 这类标题没有辨识度,配合“标题完全重复”才值得展示完整 URL;否则只给域名。
function isBadTitle(title, url) {
  const t = (title || '').trim();
  if (!t) return true;
  if (t === url) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^about:/i.test(t) || /^chrome:\/\//i.test(t)) return true;
  if (/^New Tab$/i.test(t) || / - Google Chrome$/.test(t)) return true;
  return false;
}

// 根据 tabId 找到其所在分组的对象及组内第一个可见标签的 id(展开后定位用)
function findGroupOfTab(tabId) {
  const item = filtered.find(f => f.tab.id === tabId);
  if (!item || !item.group) return null;
  // 未分组的标签没有可收起的分组头
  const sameGroup = filtered.filter(f => f.group && groupKey(f.group) === groupKey(item.group));
  if (!sameGroup.length) return null;
  return { group: item.group, firstTabId: sameGroup[0].tab.id };
}

async function switchTo(tab) {
  // 书签/历史条目(id 为负): 新开标签页,而非切换已有标签
  if (tab.id < 0) {
    await chrome.tabs.create({ url: tab.url, active: true });
    window.close();
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

// 滚入可视区,自动避开吸顶分组头: scrollIntoView({block:'nearest'})
// 只保证进入容器视口,元素可能停在 sticky 组头底下被盖住——
// 手动计算: 目标行顶部距容器顶部不足组头高度(~23px)时额外下滚
function scrollPastSticky(el) {
  el.scrollIntoView({ block: 'nearest' });
  const container = resultsEl;
  const stickyH = 30; // 分组头: 8px+6px padding + 16px 内容行高
  // scrollIntoView 后二次校正: 若行顶落在吸顶组头底下,补滚 stickyH
  const above = (el.offsetTop - container.offsetTop) - container.scrollTop;
  if (above < stickyH) {
    container.scrollTop -= (stickyH - above);
  }
}

function setActive(idx) {
  const rows = resultsEl.querySelectorAll('.tab-item');
  if (!rows.length) return;
  clearActiveUnit();
  activeIndex = Math.max(0, Math.min(idx, rows.length - 1));
  const el = rows[activeIndex];
  if (el) {
    el.classList.add('active');
    scrollPastSticky(el);
  }
}

// 定位当前标签: 只认 active 且属于弹窗所在窗口的行。
// 多窗口时每个窗口各有一个 active 标签,不加窗口条件会定位到别的窗口去
function focusCurrentTab() {
  const rows = [...resultsEl.querySelectorAll('.tab-item')];
  const currentRow = rows.find(r => {
    const f = filtered.find(x => x.tab.id === Number(r.dataset.tabId));
    return f && f.tab.active
      && (currentWindowId == null || f.tab.windowId === currentWindowId);
  });
  setActive(currentRow ? rows.indexOf(currentRow) : 0);
}

// 定位当前标签: 清空搜索回到全量视图,展开其所在分组,平滑滚到该行并闪烁高亮
let locateTimer = null;
function locateCurrentTab() {
  // 搜索/命令态会过滤掉当前标签,先复位到全量分组视图
  if (searching || input.value.trim()) {
    input.value = '';
    activeCmd = null;
    cmdChip.style.display = 'none';
    searching = false;
    search('');
  }
  const cur = filtered.find(f => f.tab.active
    && (currentWindowId == null || f.tab.windowId === currentWindowId));
  if (!cur) { showToast('当前标签不在视图中'); return; }

  // 所在分组折叠则展开
  const gk = cur.group ? groupKey(cur.group) : '__ungrouped__';
  if (cur.group && collapsed.has(gk)) {
    collapsed.delete(gk);
    saveCollapsed();
    render();
  }
  // render 后 DOM 重建,重新找行
  const row = resultsEl.querySelector(`.tab-item[data-tab-id="${cur.tab.id}"]`);
  if (!row) { showToast('找不到该标签行'); return; }

  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('locating');
  void row.offsetWidth; // 强制 reflow,重启动画
  row.classList.add('locating');
  clearTimeout(locateTimer);
  locateTimer = setTimeout(() => row.classList.remove('locating'), 1400);
}

document.getElementById('locateBtn').addEventListener('click', locateCurrentTab);

// 可聚焦单元 = 分组头 + 标签行,统一编址,←→/↑↓/Enter 都基于它工作
function navUnits() {
  return [...resultsEl.querySelectorAll('.group-header, .tab-item')];
}
function clearActiveUnit() {
  navUnits().forEach(u => u.classList.remove('active'));
}
// 分组头的选中态
function focusGroupHeader(header) {
  clearActiveUnit();
  header.classList.add('active');
  activeIndex = -2; // 标记当前焦点在分组头上,不在标签行序列里
}

// ---- 视图切换 ----
// 语义: 两个视图是对同一结果集的不同排布,搜索词跨视图保留并立即按新视图重排
const viewTabs = [...document.querySelectorAll('.view-tab')];
function setView(v) {
  if (v === view) return;
  view = v;
  localStorage.setItem('tgs-view', v);
  viewTabs.forEach(b => b.classList.toggle('active', b.dataset.view === v));
  activeIndex = -1;
  search(searchValue());
  render();
  // 空查询时定位当前标签,搜索时选第一条
  if (filtered.length) {
    if (searching) setActive(0);
    else focusCurrentTab();
  }
}
viewTabs.forEach(b => b.addEventListener('click', () => {
  setView(b.dataset.view);
  input.focus();
}));
// 初始化时应用已保存的视图
viewTabs.forEach(b => b.classList.toggle('active', b.dataset.view === view));

let debounceTimer = null;
// 命令模式数据源异步加载完成后的补渲染(加载耗时通常 <50ms,
// 若用户已继续输入,render 用的是当前输入框内容,不冲突)。
// 判断依据是胶囊状态 activeCmd——前缀已被从输入框剥离,
// 检查 input.value.startsWith('/h') 会永远 false,裸命令就永远空白
function refreshIfCmdMode() {
  if (activeCmd === '/b' || activeCmd === '/h') {
    search(searchValue());
    render();
    if (filtered.length) setActive(0);
  }
}

// ---- slash 命令胶囊 ----
// 输入 /b /h 打全后,前缀从输入框"提取"为高亮胶囊(等宽字体标签);
// 输入框只留关键词部分。退格(光标在关键词最前/输入框空)删除整个胶囊
const cmdChip = document.getElementById('cmdChip');
const cmdChipText = document.getElementById('cmdChipText');
let activeCmd = null; // null | '/b' | '/h'

// 完整搜索值 = 激活的命令前缀 + 输入框关键词(胶囊是视觉层,search 需要完整值)
function searchValue() {
  return activeCmd ? activeCmd + ' ' + input.value : input.value;
}

// ⌘⌫ 逐个清理重复副本: 关闭该行副本中的一份,按一次删一份,
// 直到只剩代表(最近使用的那份)。副本按合并时的入序删(后入 = 较旧)。
// 注意: 删完后必须同步 allTabs 源头的 duplicates(而非 pop 局部引用)——
// search() 会从 allTabs 重建 filtered,旧引用的修改会丢,导致
// 角标不减且第二次删除时 victimId 重复(删已关的标签,静默失败)
async function closeOneDuplicate(target) {
  if (!target || !target.duplicates || !target.duplicates.length) return;
  const victimId = target.duplicates[target.duplicates.length - 1];
  try {
    await chrome.tabs.remove(victimId);
    mediaTabIds.delete(victimId); // 探测缓存同步清理,防幽灵按钮
    // 从 allTabs 源头移除该副本(重建后的 filtered 才能拿到正确状态)
    const src = allTabs.find(x => x.tab.url === target.tab.url);
    if (src && src.duplicates) {
      src.duplicates = src.duplicates.filter(id => id !== victimId);
    }
    search(searchValue());
    render();
    // render 的自动焦点恢复在 async 路径上不可靠(捕获时机早于 DOM 重建),
    // 显式把焦点设回代表行(行还在,代表未删),支持连续 ⌘⌫
    const row = [...resultsEl.querySelectorAll('.tab-item')]
      .find(r => Number(r.dataset.tabId) === target.tab.id);
    if (row) {
      clearActiveUnit();
      row.classList.add('active');
      activeIndex = [...resultsEl.querySelectorAll('.tab-item')].indexOf(row);
    }
    const remaining = (src?.duplicates?.length ?? target.duplicates.length - 1) + 1;
    showToast(`已关闭一份副本,剩余 ${remaining} 份`);
  } catch (e) {
    console.error('关闭副本失败:', e);
  }
}

function syncCmdChip() {
  // 状态机: 胶囊未激活时,检测输入是否以 /b /h 开头(可激活);
  // 已激活后 input.value 只存纯关键词,不再重新检测(否则剥掉前缀后
  // 下次 input 事件匹配不到命令,胶囊会误消失)
  if (!activeCmd) {
    const m = input.value.match(/^(\/[bh])\s?/);
    if (m) {
      activeCmd = m[1];
      const kw = input.value.replace(/^\/[bh]\s?/, '');
      input.value = kw; // 剥掉前缀只留关键词
    }
  }
  // 渲染胶囊 + 数据源按钮高亮
  if (activeCmd) {
    cmdChipText.textContent = activeCmd;
    cmdChip.style.display = 'inline-flex';
  } else {
    cmdChip.style.display = 'none';
  }
  syncSrcButtons();
}
// 胶囊上的 × 点击移除
cmdChip.querySelector('.cmd-chip-x').addEventListener('click', () => {
  activeCmd = null;
  cmdChip.style.display = 'none';
  input.value = '';
  input.dispatchEvent(new Event('input'));
});

// ---- 数据源按钮: 点击 = 激活/取消对应命令(等价输入 /b /h) ----
const bmBtn = document.getElementById('bmBtn');
const histBtn = document.getElementById('histBtn');
function setCmd(cmd) {
  // toggle 语义: 再点同一个取消;点另一个切换
  activeCmd = (activeCmd === cmd) ? null : cmd;
  cmdChipText.textContent = activeCmd || '';
  cmdChip.style.display = activeCmd ? 'inline-flex' : 'none';
  syncSrcButtons();
  input.value = ''; // 切换数据源时清空关键词,从头搜
  input.focus();
  input.dispatchEvent(new Event('input'));
}
bmBtn.addEventListener('click', () => setCmd('/b'));
histBtn.addEventListener('click', () => setCmd('/h'));
// 按钮高亮与 activeCmd 同步(在 syncCmdChip 渲染胶囊处一并维护)
function syncSrcButtons() {
  bmBtn.classList.toggle('active', activeCmd === '/b');
  histBtn.classList.toggle('active', activeCmd === '/h');
}

// 输入法拼音直搜: 中文输入法未上屏的拼音串(composing 状态)直接参与搜索——
// 输入法忘了切英文时,拼音打一半列表已在实时过滤,无需上屏或切输入法。
// 原理: composition 期间 input 事件里输入框的值就是拼音字母本身,
// 常规搜索链路天然可用;唯一要处理的是上屏汉字后别把拼音残留当查询词
input.addEventListener('compositionend', () => {
  // 上屏完成: 值已变成汉字,触发一次常规 input 流程即可(汉字会被拼音匹配兜住)
  input.dispatchEvent(new Event('input'));
});

input.addEventListener('input', () => {
  // 先同步命令胶囊(可能修改 input.value 剥离前缀),再做常规搜索流
  syncCmdChip();
  // 防抖: 大标签量时每个字符全量重建 DOM 会有卡顿感
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    activeIndex = -1;
    const wasSearching = searching;
    // 搜索态判定: 命令胶囊激活时即使关键词空也算搜索态(显示命令结果)
    searching = input.value.trim().length > 0 || activeCmd !== null;
    // 开始一次新搜索(从空查询进入)时,搜索模式的分组全部重置为展开
    if (searching && !wasSearching) searchCollapsed = new Set();
    // 命令模式触发对应数据源的按需加载(书签/历史,弹窗存活期内缓存)
    if (activeCmd === '/b') loadBookmarks().then(refreshIfCmdMode);
    else if (activeCmd === '/h') loadHistory().then(refreshIfCmdMode);
    // search() 需要完整值(含前缀)判定命令模式——胶囊只是视觉层
    search(activeCmd ? activeCmd + ' ' + input.value : input.value);
    render();
    // 空查询时光标落在当前激活标签(打开弹窗最常见意图:回到刚离开的 tab)
    // 搜索时落在第一条结果
    if (filtered.length) {
      if (searching) setActive(0);
      else focusCurrentTab();
    }
  }, 30);
});

// 退格整删胶囊: 光标在起点(或空输入)按 Backspace,清除整个命令而非逐字
input.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' && activeCmd
    && (input.value === '' || input.selectionStart === 0 && input.selectionEnd === 0)) {
    e.preventDefault();
    activeCmd = null;
    cmdChip.style.display = 'none';
    input.value = '';
    input.dispatchEvent(new Event('input'));
  }
});

// ---- 设置面板 ----
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const optShowUrl = document.getElementById('optShowUrl');

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('open');
  // 展开时加载分组规则(storage 读取 <5ms,每次展开刷新保持与 background 同步)
  if (settingsPanel.classList.contains('open')) {
    loadRulesForEdit();
    loadAutoGroupSwitch();
    loadOthersGroupSwitch();
  }
});
// 覆盖层的关闭按钮
document.getElementById('settingsCloseBtn').addEventListener('click', () => {
  settingsPanel.classList.remove('open');
});

// 设置面板两个选择 Tab: 分组(规则编辑) / 功能(偏好+快捷键+清理)。
function setSettingsPane(pane) {
  const groupPane = document.getElementById('pane-group');
  const funcPane = document.getElementById('pane-func');
  const settingsActions = document.querySelector('.settings-actions');
  const isGroup = pane === 'group';
  document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.pane === pane));
  if (groupPane) groupPane.classList.toggle('active', isGroup);
  if (funcPane) funcPane.classList.toggle('active', !isGroup);
  if (settingsActions) settingsActions.style.display = isGroup ? 'flex' : 'none';
}

function toggleSettingsPane() {
  const groupPane = document.getElementById('pane-group');
  const isGroup = groupPane?.classList.contains('active');
  setSettingsPane(isGroup ? 'func' : 'group');
}

try {
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      setSettingsPane(btn.dataset.pane);
    });
  });
} catch (e) { console.error('设置 Tab 初始化失败', e); }

// 突出色: 每个主题独立维护突出色,切换主题时两套主色互不干扰
function markActiveSwatch(el) {
  document.querySelectorAll('.accent-swatch').forEach(x => x.classList.toggle('active', x === el));
}

function applyThemeAccent(theme) {
  const isInk = theme === 'ink';
  const savedAccent = localStorage.getItem(isInk ? 'tgs-accent-ink' : 'tgs-accent-linear') ||
                      (isInk ? '' : (localStorage.getItem('tgs-accent') || 'blue'));
  if (savedAccent) {
    document.documentElement.dataset.accent = savedAccent;
    const sw = [...document.querySelectorAll('.accent-swatch')].find(x => x.dataset.accent === savedAccent);
    if (sw) markActiveSwatch(sw);
  } else {
    // 水墨风默认使用水墨朱砂红(--seal: #B23A2E), 不设 data-accent 避免覆盖
    delete document.documentElement.dataset.accent;
    markActiveSwatch(null);
  }
}

try {
  document.querySelectorAll('.accent-swatch').forEach(b => {
    b.addEventListener('click', () => {
      const currentTheme = document.documentElement.dataset.theme || 'linear';
      document.documentElement.dataset.accent = b.dataset.accent;
      markActiveSwatch(b);
      try {
        localStorage.setItem(currentTheme === 'ink' ? 'tgs-accent-ink' : 'tgs-accent-linear', b.dataset.accent);
        localStorage.setItem('tgs-accent', b.dataset.accent);
      } catch (e) {}
      render();
    });
  });
} catch (e) { console.error('突出色初始化失败', e); }

// 多主题风格切换: 原有 Linear(极简现代) / 新增 ink(水墨古风新中式)
const optTheme = document.getElementById('optTheme');
try {
  const currentTheme = localStorage.getItem('tgs-theme') || document.documentElement.dataset.theme || 'linear';
  document.documentElement.dataset.theme = currentTheme;
  if (optTheme) {
    optTheme.value = currentTheme;
    optTheme.addEventListener('change', () => {
      const selected = optTheme.value;
      document.documentElement.dataset.theme = selected;
      try {
        localStorage.setItem('tgs-theme', selected);
      } catch (e) {}
      applyThemeAccent(selected);
      render(); // 重新渲染列表, 使新主题分组色号与竖线样式即刻生效
    });
  }
  applyThemeAccent(currentTheme);
} catch (e) {
  console.error('主题切换初始化失败', e);
}

// 自动分组总开关: 存 chrome.storage.local(background 读同一 key 判定是否归组)。
// Tabbiy 的痛点之一是自动分组"用着用着就关了"——我们显式开关 + 显式状态,
// 行为可预测
const optAutoGroup = document.getElementById('optAutoGroup');
async function loadAutoGroupSwitch() {
  try {
    const stored = await chrome.storage.local.get('autoGroupEnabled');
    // 默认开启(undefined = 未设置过)
    optAutoGroup.checked = stored?.autoGroupEnabled !== false;
  } catch (e) {
    optAutoGroup.checked = true;
  }
}
optAutoGroup.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoGroupEnabled: optAutoGroup.checked });
  if (optAutoGroup.checked) {
    // 开启时立即触发存量归组(散标签按规则+Others兜底收组),归完顺带整理
    showToast('自动分组已开启,正在归组存量标签…');
    try {
      await chrome.runtime.sendMessage({ type: 'group-existing' });
      setTimeout(async () => {
        await loadTabs();
        search(searchValue());
        render();
      }, 1500);
    } catch (e) { /* worker 未就绪时静默,规则已在 worker 生效 */ }
  } else {
    showToast('自动分组已关闭');
  }
});
// Others 兜底开关: 未命中规则的散标签是否归入 Others 组。
// 关闭时"未分组保持散着"——规则只管命中的域名,清空规则 + 关兜底
// 即完全不做任何归组。存量迁移(开→收散标签 / 关→解散 Others 组)
// 由 background 的 storage.onChanged 驱动(浏览器投递必达),这里只写状态
const optOthersGroup = document.getElementById('optOthersGroup');
async function loadOthersGroupSwitch() {
  try {
    const stored = await chrome.storage.local.get('othersGroupEnabled');
    // 默认开启(undefined = 未设置过),保持旧行为
    optOthersGroup.checked = stored?.othersGroupEnabled !== false;
  } catch (e) {
    optOthersGroup.checked = true;
  }
}
optOthersGroup.addEventListener('change', async () => {
  await chrome.storage.local.set({ othersGroupEnabled: optOthersGroup.checked });
  showToast(optOthersGroup.checked
    ? '未分组标签将归入 Others'
    : 'Others 组已解散,未分组标签保持散着');
  // 存量迁移在后台异步跑,稍后刷新列表显示新分组状态
  setTimeout(async () => {
    await loadTabs();
    search(searchValue());
    render();
  }, 1500);
});
// 快捷键速查已改为 hover 气泡(纯 CSS),无需 JS
// (模糊匹配开关已删: 功能保留、永远开启,不再暴露配置)
optShowUrl.checked = settings.showUrl;
optShowUrl.addEventListener('change', () => {
  settings.showUrl = optShowUrl.checked;
  saveSettings();
  render();
});
// 删除键位配置(见 settings.deleteKey 注释)
const optDeleteKey = document.getElementById('optDeleteKey');
optDeleteKey.value = settings.deleteKey;
optDeleteKey.addEventListener('change', () => {
  settings.deleteKey = optDeleteKey.value;
  saveSettings();
  showToast('删除键已切换为: ' + optDeleteKey.selectedOptions[0].textContent);
});
// chrome:// 链接在扩展弹窗里不能直接打开,交由后台页处理
document.getElementById('shortcutLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// 清理僵尸标签按钮
document.getElementById('cleanBtn').addEventListener('click', () => {
  input.focus();
  cleanStaleTabs();
});

// ---- 自动分组规则编辑器 ----
// 规则存 chrome.storage.local(background 同源读取,storage.onChanged 即时生效)。
// UI: 每组一个"组名输入框 + 域名芯片流",增删组,保存。
// 脏状态: 任何编辑 → 保存按钮变琥珀+脉动,标题旁圆点;保存/重载后清除
const rulesListEl = document.getElementById('rulesList');
const saveRulesBtn = document.getElementById('saveRulesBtn');
const rulesDirtyDot = document.getElementById('rulesDirtyDot');

function markRulesDirty() {
  saveRulesBtn.classList.add('dirty');
  saveRulesBtn.textContent = '保存规则 •';
  rulesDirtyDot.classList.add('show');
}
function clearRulesDirty() {
  saveRulesBtn.classList.remove('dirty');
  saveRulesBtn.textContent = '保存规则';
  rulesDirtyDot.classList.remove('show');
}
// 事件委托: 规则区内所有输入/键入都算编辑(input 覆盖打字/粘贴/删除,
// click 覆盖 chip × 删除和组删除按钮——这些不触发 input)
rulesListEl.addEventListener('input', markRulesDirty);
rulesListEl.addEventListener('click', (e) => {
  // 只有点删除类按钮才算编辑(点 chip 文本等不算)
  if (e.target.closest('.rule-del-btn') || e.target.closest('.host-chip button')) {
    markRulesDirty();
  }
});
// 增删组直接标脏(发生在 rulesListEl 之外)
async function loadRulesForEdit() {
  try {
    const stored = await chrome.storage.local.get('groupRules');
    if (stored?.groupRules && Object.keys(stored.groupRules).length) {
      renderRulesEditor(stored.groupRules);
      clearRulesDirty(); // 重载 = 回到已保存状态
      return;
    }
    // storage 为空(background 首次写入还没跑): 给空态提示,
    // 用户保存任意规则后即建立 storage 数据流
    renderRulesEditor({});
  } catch (e) {
    console.error('读取规则失败:', e);
    renderRulesEditor({});
  }
}

function renderRulesEditor(rules) {
  rulesListEl.innerHTML = '';
  const entries = Object.entries(rules);
  if (!entries.length) {
    rulesListEl.innerHTML = '<div style="padding:8px 0;color:var(--text-3);font-size:11px">暂无规则,点击下方新增组</div>';
    return;
  }
  for (const [name, hosts] of entries) {
    rulesListEl.appendChild(buildRuleGroup(name, hosts || []));
  }
}

// 单个规则组的编辑行: 组名输入 + 域名芯片流(每枚可删) + 内联追加输入
function buildRuleGroup(name, hosts) {
  const groupDiv = document.createElement('div');
  groupDiv.className = 'rule-group';

  // 组名行
  const nameRow = document.createElement('div');
  nameRow.className = 'rule-group-name';
  const nameInput = document.createElement('input');
  nameInput.value = name;
  nameInput.placeholder = '组名';
  nameInput.className = 'rule-name-input';
  const delBtn = document.createElement('button');
  delBtn.className = 'rule-del-btn';
  delBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
  delBtn.title = '删除该组规则';
  delBtn.addEventListener('click', () => groupDiv.remove());
  nameRow.appendChild(nameInput);
  nameRow.appendChild(delBtn);
  groupDiv.appendChild(nameRow);

  // 域名芯片流
  const chipFlow = document.createElement('div');
  chipFlow.className = 'rule-hosts';
  const addHostChip = (host) => {
    const chip = document.createElement('span');
    chip.className = 'host-chip';
    const label = document.createElement('span');
    label.textContent = host;
    label.title = host;
    const chipDel = document.createElement('button');
    chipDel.textContent = '×';
    chipDel.title = '移除该域名';
    chipDel.addEventListener('click', () => chip.remove());
    chip.appendChild(label);
    chip.appendChild(chipDel);
    chipFlow.insertBefore(chip, addInput);
  };
  // 内联追加输入: 回车/失焦确认(逗号分隔可批量)
  const addInput = document.createElement('input');
  addInput.className = 'host-add-input';
  addInput.placeholder = '添加域名…';
  const commit = () => {
    const parts = addInput.value.split(/[,，\n]/)
      .map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    parts.forEach(addHostChip);
    addInput.value = '';
  };
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') addInput.blur();
    e.stopPropagation(); // 不触发全局快捷键
  });
  addInput.addEventListener('blur', commit);
  chipFlow.appendChild(addInput);

  hosts.forEach(addHostChip);
  groupDiv.appendChild(chipFlow);
  return groupDiv;
}

document.getElementById('addRuleBtn').addEventListener('click', () => {
  // 追加一个空模板组(不动已有内容)
  rulesListEl.appendChild(buildRuleGroup('', []));
  rulesListEl.scrollTop = rulesListEl.scrollHeight;
  markRulesDirty();
  // 聚焦新组的组名输入
  const groups = rulesListEl.querySelectorAll('.rule-group');
  groups[groups.length - 1]?.querySelector('.rule-name-input')?.focus();
});

// ---- 把当前标签页域名添加到分组(弹层: 新建 或 选已有) ----
const currentHostBtn = document.getElementById('addCurrentHostBtn');
let groupPop = null;
function closeGroupPop() { if (groupPop) { groupPop.remove(); groupPop = null; } }
async function addHostToRuleGroup(host, groupName) {
  const { groupRules } = await chrome.storage.local.get('groupRules');
  const rules = groupRules || {};
  const arr = rules[groupName] || (rules[groupName] = []);
  if (!arr.includes(host)) arr.push(host);
  await chrome.storage.local.set({ groupRules: rules });
  closeGroupPop();
  showToast(`已将 ${host} 加入「${groupName}」`);
  loadRulesForEdit();
}
try {
currentHostBtn.addEventListener('click', async () => {
  closeGroupPop();
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [null]);
  const host = active ? hostOf(active.url) : '';
  if (!host) { showToast('未获取到当前标签域名'); return; }
  const { groupRules } = await chrome.storage.local.get('groupRules');
  const groups = Object.keys(groupRules || {});
  const pop = document.createElement('div');
  pop.className = 'group-pop';
  const rect = currentHostBtn.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right - 240, document.body.clientWidth - 250));
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 240)}px`;
  const head = document.createElement('div');
  head.className = 'group-pop-head';
  const tt = document.createElement('div');
  tt.className = 'group-pop-title';
  tt.textContent = `添加 ${host}`;
  const x = document.createElement('button');
  x.className = 'group-pop-close';
  x.textContent = '✕';
  head.appendChild(tt);
  head.appendChild(x);
  pop.appendChild(head);
  const list = document.createElement('div');
  list.className = 'group-pop-list';
  if (groups.length) {
    groups.forEach(g => {
      const b = document.createElement('button');
      b.className = 'group-pop-item';
      b.textContent = g;
      b.addEventListener('click', () => addHostToRuleGroup(host, g));
      list.appendChild(b);
    });
  } else {
    const empty = document.createElement('div');
    empty.className = 'group-pop-empty';
    empty.textContent = '还没有分组规则';
    list.appendChild(empty);
  }
  pop.appendChild(list);
  const newRow = document.createElement('div');
  newRow.className = 'group-pop-new';
  const inp = document.createElement('input');
  inp.placeholder = '新建分组名';
  inp.value = host;
  const add = document.createElement('button');
  add.className = 'group-pop-add';
  add.textContent = '添加';
  add.addEventListener('click', () => { const name = inp.value.trim(); if (name) addHostToRuleGroup(host, name); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const n = inp.value.trim(); if (n) addHostToRuleGroup(host, n); } });
  newRow.appendChild(inp);
  newRow.appendChild(add);
  pop.appendChild(newRow);
  document.body.appendChild(pop);
  groupPop = pop;
  inp.focus();
  const remove = () => { closeGroupPop(); document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  const onDoc = (e) => { if (!pop.contains(e.target)) remove(); };
  const onEsc = (e) => { if (e.key === 'Escape') remove(); };
  x.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
  document.addEventListener('mousedown', onDoc);
  document.addEventListener('keydown', onEsc);
});
} catch (e) { console.error('添加域名弹层初始化失败', e); }

// ---- 规则 JSON 导入/导出 ----
// 从当前编辑器 DOM 收集规则(与保存共用同一收集逻辑,导入合并以此为基底)
function collectRulesFromEditor() {
  const rules = {};
  rulesListEl.querySelectorAll('.rule-group').forEach(g => {
    const name = g.querySelector('.rule-name-input')?.value.trim();
    const hosts = [...g.querySelectorAll('.host-chip > span')]
      .map(el => el.textContent.trim()).filter(Boolean);
    if (name && hosts.length) rules[name] = hosts;
  });
  return rules;
}

// 解析导入 JSON → { 组名: [域名] }。容忍两类格式:
// 1. 本插件/Tabbiy 导出的扁平格式 { "组名": ["域名", ...] }
// 2. [{ name/group, domains/hosts: [...] }] 数组格式(手写常见)
// 域名归一化: 去协议/路径/尾斜杠(粘贴完整 URL 也能用),空项丢弃
function parseRulesJson(text) {
  const data = JSON.parse(text);
  const raw = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const name = (item.name ?? item.group ?? item.title ?? '').toString().trim();
      const list = item.domains ?? item.hosts ?? item.urls ?? [];
      if (name && Array.isArray(list)) raw[name] = list;
    }
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    // 包一层 key 的导出({ rules: {...} })也解包
    const obj = (data.rules && typeof data.rules === 'object' && !Array.isArray(data.rules))
      ? data.rules : data;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) raw[k] = v;
    }
  } else {
    throw new Error('JSON 顶层须是对象或数组');
  }
  const rules = {};
  let hosts = 0;
  for (const [name, list] of Object.entries(raw)) {
    if (!name) continue;
    const cleaned = [...new Set(list.map(x => {
      if (typeof x !== 'string') return '';
      return x.trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // 去协议
        .replace(/^www\./, '')                    // www 归一(匹配用 host)
        .split('/')[0].split('?')[0]              // 去路径/查询
        .replace(/\/+$/, '');
    }).filter(Boolean))];
    if (cleaned.length) { rules[name] = cleaned; hosts += cleaned.length; }
  }
  return { rules, hosts };
}

document.getElementById('importRulesBtn').addEventListener('click', () => {
  // 轻量弹层: 文本域粘贴 JSON → 解析合并进编辑器(不直接写 storage,
  // 用户可在保存前检查/修改,保存动作与手工编辑完全一致)。
  // 类名 rules-import-layer 供全局焦点兜底监听器豁免(见文件末尾),
  // 否则点击弹层内任何位置焦点都会被抢回搜索框,textarea 打不了字
  const layer = document.createElement('div');
  layer.className = 'rules-import-layer';
  layer.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'width:min(420px,92vw);background:var(--surface);border:1px solid var(--hairline);border-radius:12px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:12px';
  box.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px">导入规则 JSON</div>
    <div style="color:var(--text-3);margin-bottom:8px;line-height:1.5">
      粘贴 <code>{ "组名": ["域名", …] }</code> 格式(Tabbiy 导出兼容),
      与当前编辑器内容<b>同名组合并域名、新组追加</b>,导入后仍需点「保存规则」。
    </div>
    <textarea class="import-json-area" style="width:100%;height:180px;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;padding:8px;border:1px solid var(--hairline);border-radius:8px;background:var(--bg);color:var(--text);resize:vertical;outline:none"></textarea>
    <div class="import-json-error" style="color:var(--danger,#e0457b);font-size:11px;margin-top:6px;min-height:14px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="io-cancel" style="padding:5px 14px;border:1px solid var(--hairline);background:var(--surface);color:var(--text);border-radius:6px;cursor:pointer;font-size:11.5px">取消</button>
      <button class="io-confirm" style="padding:5px 14px;border:none;background:var(--accent);color:#fff;border-radius:6px;cursor:pointer;font-size:11.5px;font-weight:600">导入</button>
    </div>`;
  layer.appendChild(box);
  document.body.appendChild(layer);
  const area = box.querySelector('.import-json-area');
  const errEl = box.querySelector('.import-json-error');
  area.focus();
  const close = () => layer.remove();
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
  box.querySelector('.io-cancel').addEventListener('click', close);
  area.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 不触发全局快捷键
    if (e.key === 'Escape') close();
  });
  box.querySelector('.io-confirm').addEventListener('click', () => {
    let parsed;
    try {
      parsed = parseRulesJson(area.value);
    } catch (e) {
      errEl.textContent = '解析失败: ' + (e.message || '不是合法 JSON');
      return;
    }
    if (!Object.keys(parsed.rules).length) {
      errEl.textContent = '没解析到任何有效规则(需要 { "组名": ["域名"] } 结构)';
      return;
    }
    // 合并: 同名组域名并入(去重),新组按现有渲染顺序追加
    const existing = collectRulesFromEditor();
    const merged = { ...existing };
    let addedGroups = 0, addedHosts = 0;
    for (const [name, hosts] of Object.entries(parsed.rules)) {
      if (merged[name]) {
        const set = new Set(merged[name]);
        for (const h of hosts) if (!set.has(h)) { set.add(h); addedHosts += 1; }
        merged[name] = [...set];
      } else {
        merged[name] = hosts;
        addedGroups += 1;
        addedHosts += hosts.length;
      }
    }
    renderRulesEditor(merged);
    markRulesDirty();
    close();
    showToast(`已导入: 新增 ${addedGroups} 组${addedHosts ? `,共 ${addedHosts} 个域名` : ''},记得保存`);
  });
});

document.getElementById('exportRulesBtn').addEventListener('click', () => {
  const rules = collectRulesFromEditor();
  if (!Object.keys(rules).length) {
    showToast('当前没有可导出的规则');
    return;
  }
  // 导出编辑器当前内容(含未保存修改),扁平 Tabbiy 兼容格式,键排序便于 diff
  const ordered = {};
  for (const k of Object.keys(rules).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    ordered[k] = rules[k];
  }
  const blob = new Blob([JSON.stringify(ordered, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tab-group-rules.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('saveRulesBtn').addEventListener('click', async () => {
  const rules = collectRulesFromEditor();
  const invalid = rulesListEl.querySelectorAll('.rule-group').length - Object.keys(rules).length;
  if (!Object.keys(rules).length) {
    // 空集是合法状态(用户删光了所有规则)——存 {},让 storage.onChanged
    // 走清理路径解散旧组。background 以 groupRules 键的存在性区分
    // "从没设置过"和"刻意为空",不会回填默认规则
    await chrome.storage.local.set({ groupRules: {} });
    clearRulesDirty();
    showToast('已清空全部规则');
    chrome.runtime.sendMessage({ type: 'group-existing' }).catch(() => {});
    return;
  }
  try {
    await chrome.storage.local.set({ groupRules: rules });
    clearRulesDirty();
    showToast(`规则已保存(${Object.keys(rules).length} 组)${invalid ? `,${invalid} 个无效组被忽略` : ''}`);
    chrome.runtime.sendMessage({ type: 'group-existing' }).catch(() => {});
  } catch (e) {
    showToast('保存失败:' + e.message);
  }
});

// (规则加载已合并进上方 settingsBtn 主监听器——展开即刷新,
// 独立监听器的时序判断曾与主监听器的 toggle 竞态导致永远不加载)

// 全局键盘路由: 监听 document 而非 input,任何元素拿走焦点后快捷键依然有效。
// 仅当焦点在其他真实输入控件(设置面板的 checkbox 等)时放行原生行为
document.addEventListener('keydown', (e) => {
  // 诊断: 所有退格按键的真实修饰键状态(排查"没按 cmd 却触发关闭"的键位映射问题)
  // 仅 DEBUG 下输出——生产里这是每次退格都打的高频日志
  if (DEBUG && e.key === 'Backspace') {
    console.log('[TGS] Backspace 按下:', {
      meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
      key: e.key, code: e.code,
      focusIn: document.activeElement === input,
    });
  }
  // ⌘C 复制 URL: 提到 isOtherInput 之前,保证在设置面板(焦点在控件上)也能用。
  // 若输入框里有选中文本则放行原生复制。
  if ((e.key === 'c' || e.key === 'C') && (e.metaKey || e.ctrlKey)) {
    const sel = window.getSelection();
    if (!(sel && sel.toString())) {
      let target = null;
      // focusedUnit 是 handleShortcuts 内部变量,这里用 navUnits() 找 active 行
      const anyActiveUnit = navUnits().find(u => u.classList.contains('active'));
      if (anyActiveUnit && anyActiveUnit.classList.contains('tab-item')) {
        target = filtered.find(f => f.tab.id === Number(anyActiveUnit.dataset.tabId));
      }
      if (!target) {
        target = filtered.find(f => f.tab.active
          && (currentWindowId == null || f.tab.windowId === currentWindowId));
      }
      if (target) { e.preventDefault(); copyTabUrl(target.tab); }
    }
  }
  // 设置面板快捷键: 当设置面板打开时, 按 Tab 键绑死在「分组」与「功能」两个 Tab 之间切换 (两主题通用)
  if (e.key === 'Tab' && settingsPanel?.classList.contains('open')) {
    const activeEl = document.activeElement;
    const isEditingText = activeEl && (
      (activeEl.tagName === 'INPUT' && activeEl.type === 'text') ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.isContentEditable
    );
    if (!isEditingText) {
      e.preventDefault();
      toggleSettingsPane();
      return;
    }
  }
  const activeEl = document.activeElement;
  const isOtherInput = activeEl && activeEl !== input
    && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT'
      || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
  if (isOtherInput) return;
  handleShortcuts(e);
});

// 点击文档任意位置后焦点还给搜索框(行/气泡/空白处的点击都会把焦点带走,
// 带 shortcode 的按钮各自已 focus(),这里兜住其余所有情况)
document.addEventListener('click', (e) => {
  // 设置面板内的交互(checkbox/链接)保持自身焦点
  if (e.target.closest('#settingsPanel')) return;
  // 导入 JSON 弹层同理(textarea 要能正常点击定位/输入,
  // 弹层挂在 body 下不在 #settingsPanel 内,须单独豁免)
  if (e.target.closest('.rules-import-layer')) return;
  input.focus();
});

// 双击退格删除模式的上次按下时间(顶层: 跨按键持久,函数内声明会每次清零)
let lastBsTime = 0;
function handleShortcuts(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (settingsPanel.classList.contains('open')) {
      settingsPanel.classList.remove('open');
      return;
    }
    if (input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    } else if (activeCmd) {
      activeCmd = null;
      cmdChip.style.display = 'none';
      input.dispatchEvent(new Event('input'));
    } else {
      window.close();
    }
    return;
  }
  // Tab / Shift+Tab: 设置面板打开时切换设置Tab, 否则在 分组 → 最近使用 → 当前窗口 三个视图间循环切换
  if (e.key === 'Tab') {
    e.preventDefault();
    if (settingsPanel?.classList.contains('open')) {
      toggleSettingsPane();
      return;
    }
    const idx = VIEWS.indexOf(view);
    const next = e.shiftKey
      ? VIEWS[(idx - 1 + VIEWS.length) % VIEWS.length]
      : VIEWS[(idx + 1) % VIEWS.length];
    setView(next);
    return;
  }
  const units = navUnits();
  if (!units.length) return;
  // 当前焦点单元: 优先取带 active 的单元(可能是分组头或行)
  const focusedUnit = units.find(u => u.classList.contains('active')) || units[0];
  const focusIdx = units.indexOf(focusedUnit);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = focusIdx + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= units.length) return;
    const el = units[next];
    clearActiveUnit();
    el.classList.add('active');
    scrollPastSticky(el);
    if (el.classList.contains('tab-item')) {
      activeIndex = [...resultsEl.querySelectorAll('.tab-item')].indexOf(el);
    } else {
      activeIndex = -2; // 焦点在分组头
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // → 收起 / ← 展开焦点所在的分组; 焦点在标签行上时取该行所属分组
    // recent / current 视图没有分组头,收起无处展示,不响应
    if (view !== 'grouped') return;
    let key;
    if (focusedUnit.classList.contains('group-header')) {
      key = focusedUnit.dataset.groupKey;
    } else {
      const found = findGroupOfTab(Number(focusedUnit.dataset.tabId));
      if (!found) return; // 未分组的标签,无组可收
      key = groupKey(found.group);
    }
    const set = activeCollapsed();
    if (DEBUG) console.log('[TGS] 分组键:', key, '已收起:', set.has(key));
    if (e.key === 'ArrowRight' && !set.has(key)) {
      set.add(key);
      if (!searching) saveCollapsed();
      render();
      // 收起后光标落在该分组头上,再按 ← 可原地展开
      const header = navUnits().find(u => u.classList.contains('group-header') && u.dataset.groupKey === key);
      if (header) {
        header.classList.add('active');
        header.scrollIntoView({ block: 'nearest' });
        activeIndex = -2;
      }
    } else if (e.key === 'ArrowLeft' && set.has(key)) {
      set.delete(key);
      if (!searching) saveCollapsed();
      render();
      // 展开后选中该分组下第一行
      const rows = [...resultsEl.querySelectorAll('.tab-item')];
      const firstRow = rows.find(r => {
        const found = findGroupOfTab(Number(r.dataset.tabId));
        return found && groupKey(found.group) === key;
      });
      if (firstRow) {
        setActive(rows.indexOf(firstRow));
      } else {
        // 组内无可见行(如未分组区),光标留在分组头
        const header = navUnits().find(u => u.classList.contains('group-header') && u.dataset.groupKey === key);
        if (header) { header.classList.add('active'); activeIndex = -2; }
      }
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (focusedUnit.classList.contains('tab-item')) {
      const tabId = Number(focusedUnit.dataset.tabId);
      const target = filtered.find(f => f.tab.id === tabId);
      if (target) switchTo(target.tab);
    }
    // 焦点在分组头上时回车不做操作
  } else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    // ⌘⇧K / Ctrl+Shift+K 清理 7 天以上未使用的标签
    e.preventDefault();
    cleanStaleTabs();
  } else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
    // ⌘Z / Ctrl+Z 撤销最近关闭的标签
    e.preventDefault();
    if (isUndoAvailable()) {
      doUndo();
    }
  } else if (e.code === 'Backspace') {
    // 删除当前选中行,键位由设置决定(见 settings.deleteKey 注释)。
    // 判定用 e.code(物理键位)+ 修饰键,不受输入法给 e.key/metaKey
    // 塞脏值影响——"裸退格误删"反复出现的根因
    // 有重复副本 → 只删一份副本(逐个清理,代表永不动,按一次少一份);
    // 无副本 → 删除标签本身。
    const inDeleteTarget = focusedUnit && focusedUnit.classList.contains('tab-item');
    const withCmd = e.metaKey || e.ctrlKey;
    let shouldDelete = false;
    if (settings.deleteKey === 'cmd-bs') {
      // ⌘⌫ / Ctrl+Backspace: 显式修饰键才删(alt/shift 排除,防组合冲突)
      shouldDelete = withCmd && !e.altKey && !e.shiftKey;
    } else if (settings.deleteKey === 'bs') {
      // 裸退格: 仅当光标在输入框起点(或输入框空)时删——否则是删字
      shouldDelete = !withCmd && !e.altKey && !e.shiftKey
        && (input.value === '' || (input.selectionStart === 0 && input.selectionEnd === 0));
    } else if (settings.deleteKey === 'dbl-bs') {
      // 双击裸退格(500ms 内两次): 第一次不动作,第二次删
      shouldDelete = !withCmd && !e.altKey && !e.shiftKey;
      if (shouldDelete) {
        const now = Date.now();
        if (now - lastBsTime > 500) {
          lastBsTime = now;
          shouldDelete = false; // 第一次,只记时间
        } else {
          lastBsTime = 0;
        }
      }
    }
    if (shouldDelete && inDeleteTarget) {
      e.preventDefault();
      const target = filtered.find(f => f.tab.id === Number(focusedUnit.dataset.tabId));
      if (target && target.duplicates && target.duplicates.length) {
        closeOneDuplicate(target);
      } else {
        closeTab(Number(focusedUnit.dataset.tabId));
      }
    }
  }
  // ⌘C 复制 URL 已在顶层 keydown 处理(设置面板内也可用)
}

// 复制 tab 的 URL 到剪贴板,轻提示确认(不关弹窗,可连续复制多个)
async function copyTabUrl(tab) {
  const url = tab.url || '';
  try {
    await navigator.clipboard.writeText(url);
    showToast(`已复制: ${displayUrl(url).slice(0, 40)}`);
  } catch (err) {
    console.error('复制失败:', err);
    showToast('复制失败,请重试');
  }
}

(async () => {
  const bootT0 = performance.now();
  await loadTabs();
  search('');
  render();
  // 初始光标落在当前激活标签,Enter 直接回去
  focusCurrentTab();
  input.focus();
  console.log(`[TGS] 首帧完成, JS 侧总耗时 ${(performance.now() - bootT0).toFixed(1)}ms`);
  console.log('[TGS] BUILD 2026-09-03 v4 (fade-band) — 看不到这行=Chrome 缓存了旧 popup');
  // 首帧不阻塞: 媒体 tab 探测异步跑,命中一个补一个按钮
  probeMediaTabs();
  // 快照追帧: 首帧可能拿到 Tabbiy 归组/新标签 URL 定型前的中间态
  // (新开标签暂在未分组、重复未合并),1s 后静默复核,有变化才重渲染
  setTimeout(async () => {
    const sig = (list) => JSON.stringify(list.map(x =>
      [x.tab.id, x.tab.url, x.duplicates?.length || 0, x.group?.title || '', !!x.tab.audible]));
    const before = sig(allTabs);
    await loadTabs();
    if (sig(allTabs) !== before) {
      search(searchValue());
      render();
      if (!searching) focusCurrentTab();
    }
  }, 1000);
  // 唤起时异步触发分组整理(同名合并+空组清理),在 background 静默执行,
  // 不阻塞弹窗;整理结果由下一次唤起自然看到
  chrome.runtime.sendMessage({ type: 'tidy-groups' }).catch(() => {});

})();
