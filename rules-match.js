// 分组规则的域名归一化 + 匹配 —— popup(规则编辑器)与 background(自动归组)
// 共用的唯一实现。加载方式两边不同: background 是 classic service worker 用
// importScripts,popup 用 <script src>。逻辑只能有一份。
//
// 通配语义: 显式声明,不做自动推断。
//   - 用户写 "bilibili.com"(开关关): 只精确匹配该主机(含 www 别名)
//   - 用户写 "*.bilibili.com"(开关开): 连同其所有子域(search/live/space/...)一起归组

// 多租户/公共后缀: 这些域名下面的每个子域属于不同主体,整站通配会误伤别人的站点
// (oymel.github.io 不是我的 github.io)。单标签(localhost、com)和 IP 也在此列。
const SHARED_RULE_SUFFIXES = new Set([
  // ccTLD 二级域: 子域分给不同注册者
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk', 'mod.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'com.tw', 'org.tw', 'com.mo',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'com.sg', 'com.my', 'net.my', 'com.au', 'net.au', 'org.au',
  'co.in', 'net.in', 'org.in', 'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.ru',
  'com.ua', 'com.pl', 'co.za', 'com.vn', 'com.ph', 'com.id', 'co.il', 'com.sa',
  'com.pk', 'com.ng', 'co.nz', 'com.pe', 'com.co',
  // 免费托管 / 平台域: 一段子域 = 一个租户
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'appspot.com', 'web.app', 'firebaseapp.com', 'vercel.app', 'netlify.app',
  'cloudfront.net', 'azurewebsites.net', 'sharepoint.com', 'myshopify.com',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'squarespace.com', 'wixsite.com',
  'medium.com', 'readthedocs.io', 'glitch.me', 'repl.co', 'ngrok.io', 'ngrok.app',
  'ngrok-free.app', 'fastly.net', 'deviantart.com', 'business.site', 'withgoogle.com',
  // 存储桶 / PaaS: 一个子域 = 一个账号的资源
  'amazonaws.com', 's3.amazonaws.com', 'storage.googleapis.com', 'cloudfunctions.net',
  'run.app', 'firebaseio.com', 'supabase.co', 'fly.dev', 'onrender.com',
  'railway.app', 'deno.dev', 'codepen.io',
]);

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// 主机名"形状"校验: 每个标签要么字母开头(可含数字/连字符),要么是
// 数字片段(IP 的组成部分)。但整串只有一个纯数字标签的(1234 / 123.456)
// 不是任何真实主机——浏览器会把它当搜索词,规则永远匹配不上,当场拒收。
// 数字子域(2.baidu.com)合法,点分四段 IPv4 合法
const HOST_LABEL_RE = /^(?:[a-z][a-z0-9-]*|\d+)$/;
function looksLikeHost(host) {
  const h = String(host || '');
  if (!h) return false;
  if (h.startsWith('[')) return h.includes(']'); // IPv6 字面量
  const labels = h.split('.');
  if (!labels.every(label => HOST_LABEL_RE.test(label) && label.length <= 63)) return false;
  // 全数字标签串 = 只能是 IPv4: 恰好四段(过宽的 123.456 也拒——它既不是
  // IP 也不是域名,匹配不上任何真实站点)
  if (labels.every(l => /^\d+$/.test(l))) return labels.length === 4;
  return true;
}

// 判断域名是否允许通配(IP/单标签/公共平台后缀即使写 *. 也不展开)
function wildcardAllowed(host) {
  const h = String(host || '');
  if (!h.includes('.')) return false;
  if (h.startsWith('[')) return false; // IPv6
  if (IP_RE.test(h)) return false;
  if (SHARED_RULE_SUFFIXES.has(h)) return false;
  const tld = h.slice(h.lastIndexOf('.') + 1);
  return /^[a-z-]{2,}$/.test(tld);
}

// 规则条目解析: 统一收成 { host: 裸主机名, zone: 是否通配 }
//   "bilibili.com"    → { host: 'bilibili.com', zone: false }  只匹配这一台主机
//   "*.bilibili.com"  → { host: 'bilibili.com', zone: true }   连同所有子域
// www.bilibili.com 收成 bilibili.com 精确匹配(www 只是主站别名)
function parseRuleEntry(input) {
  if (input && typeof input === 'object' && input.host) {
    return {
      host: input.host,
      zone: !!input.zone && wildcardAllowed(input.host),
    };
  }
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(SCHEME_RE, '');
  if (s.startsWith('//')) s = s.slice(2);
  s = s.split('/')[0].split('?')[0].split('#')[0];
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);

  let zone = false;
  if (s === '*' || s === '*.') return null;
  if (s.startsWith('*.')) {
    zone = true;
    s = s.slice(2);
  }
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    s = close < 0 ? s : s.slice(0, close + 1);
  } else {
    s = s.split(':')[0];
  }
  s = s.replace(/\.+$/, '');
  if (!s || /\s/.test(s) || !looksLikeHost(s)) return null;
  if (s.startsWith('www.')) {
    const rest = s.slice(4);
    if (rest.includes('.')) s = rest;
  }
  return { host: s, zone: zone && wildcardAllowed(s) };
}

// 只取裸主机名(URL 归一 / 去重 key 用)
function normalizeRuleHost(input) {
  const entry = parseRuleEntry(input);
  return entry ? entry.host : '';
}

// URL → 裸主机名。非 http(s)(chrome:// / file:// / about:)没有"域名"可归组, 一律空串
function ruleHostOfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return normalizeRuleHost(u.hostname);
  } catch (e) {
    return '';
  }
}

// 当前站点根: 把 search.bilibili.com 收成 bilibili.com(供整站通配开关使用)
function siteRootOf(host) {
  const h = normalizeRuleHost(host);
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const two = labels.slice(-2).join('.');
  return wildcardAllowed(two) ? two : h;
}

// 芯片/导出展示文本: 显式通配加 "*." 前缀,精确的原样
function ruleChipLabel(entry) {
  if (typeof entry === 'string') entry = parseRuleEntry(entry);
  return entry && entry.host ? (entry.zone ? `*.${entry.host}` : entry.host) : '';
}

// { 组名: [域名字符串...] } → 匹配器
// 域名字符串 "*.host" = 整站通配, "host" = 精确单机匹配。
// 匹配: 沿标签链向上做后缀匹配,天然最长优先:
//   - 第一跳(完整主机名)允许命中精确或通配规则;
//   - 往上的每一跳必须是 zone 通配规则.
function createRuleMatcher(rules) {
  const index = new Map(); // host → { group, zone }
  for (const [group, list] of Object.entries(rules || {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const entry = parseRuleEntry(item);
      if (!entry) continue;
      // 一个域名只能归属一个分组: 首见为准
      if (!index.has(entry.host)) index.set(entry.host, { group, zone: entry.zone });
    }
  }
  return {
    index,
    // 入参可以是裸主机名也可以是完整 URL
    match(input) {
      const first = parseRuleEntry(input);
      if (!first) return null;
      let p = first.host;
      let full = true;
      for (;;) {
        const hit = index.get(p);
        if (hit && (full || hit.zone)) return hit.group;
        const i = p.indexOf('.');
        if (i < 0) return null;
        p = p.slice(i + 1);
        full = false;
      }
    },
  };
}
