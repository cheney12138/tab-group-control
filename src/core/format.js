// core/format.js: 纯展示格式化工具(无 DOM、无 Chrome API、无共享状态)
// 从 main.js 切出,函数体零改动

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 相对时间: 刚刚 / N 分钟 / 1小时内 / N 小时 / 昨天 / N 天前 / N 周
export function relativeTime(ts) {
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
export function timeTier(ts) {
  if (!ts) return 'recent';
  const diff = Date.now() - ts;
  if (diff < 10 * 60 * 1000) return 'hot';
  if (diff < 24 * 60 * 60 * 1000) return 'today';
  if (diff < 7 * 24 * 60 * 60 * 1000) return 'recent';
  if (diff < 30 * 24 * 60 * 60 * 1000) return 'stale';
  return 'zombie';
}

// URL 展示: 提取 host + path + search + hash; 内部页面(chrome://等)保留完整路径
export function displayUrl(url) {
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

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// 标题是否为“占位/错误”(无标题、标题=URL、标题本身是 URL、New Tab 等)。
// 这类标题没有辨识度,配合“标题完全重复”才值得展示完整 URL;否则只给域名。
export function isBadTitle(title, url) {
  const t = (title || '').trim();
  if (!t) return true;
  if (t === url) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^about:/i.test(t) || /^chrome:\/\//i.test(t)) return true;
  if (/^New Tab$/i.test(t) || / - Google Chrome$/.test(t)) return true;
  return false;
}

export function cleanTitle(str) {
  if (!str) return '';
  return str
    .replace(/^[\s\u200B-\u200D\uFEFF\u{1F4A4}💤zZ\[\]\-—·]+/u, '')
    .replace(/[\s\u200B-\u200D\uFEFF\u{1F4A4}💤zZ\[\]\-—·]+$/u, '')
    .trim()
    .toLowerCase();
}

// favicon: 直接用 tab 快照自带的 URL,失败隐藏图标位,保持简单
// Chrome 官方标准 Favicon 构造方式 (带 size=32, 且仅在 http/https 下有效)
export function getChromeFaviconUrl(url) {
  try {
    if (!url || typeof url !== 'string') return null;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
  } catch {
    return null;
  }
}

export function faviconUrlFor(t) {
  return t.favIconUrl || getChromeFaviconUrl(t.url) || '';
}

// 收起状态持久化用的稳定 key: chrome 的 groupId 每次启动会变,用 分组名+颜色
export function groupKey(group) {
  return group ? `${group.title || '(未命名)'}|${group.color}` : '__ungrouped__';
}
