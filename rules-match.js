// 分组规则的域名归一化 + 通配匹配 —— popup(规则编辑器)与 background(自动归组)
// 共用的唯一实现。加载方式两边不同: background 是 classic service worker 用
// importScripts,popup 用 <script src>。逻辑只能有一份——编辑器里显示的
// "*.bilibili.com" 和 background 实际命中的规则不一致,比不做通配更糟。

// 多租户/公共后缀: 这些域名下面的每个子域属于不同主体,整站通配会误伤别人的站点
// (oymel.github.io 不是我的 github.io)。只列"两标签"的坑——单标签(com / net / io)
// 由下面的标签数下限自动降级成精确匹配,不必进名单。
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

// 规则里的"域名"写法很杂: www.bilibili.com、https://bilibili.com/、*.bilibili.com、
// 127.0.0.1:8080。统一收成裸主机名(小写、去协议/路径/查询/端口/尾点、认 "*." 前缀),
// 顺带把 www 归一: 规则里的 www. 从来不是用户的本意("加了 www.bilibili.com 结果
// 主页不归组"是这类规则最典型的坑),且归一后正好落进整站通配。
// 注意去端口: 主机名带端口(:host)匹配不上 chrome 的 URL.host,老规则里
// 127.0.0.1:8080 永远不命中就是这么来的。
function normalizeRuleHost(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return '';
  if (s === '*' || s === '*.') return '';
  if (s.startsWith('*.')) s = s.slice(2);
  s = s.replace(SCHEME_RE, '');
  if (s.startsWith('//')) s = s.slice(2);
  s = s.split('/')[0].split('?')[0].split('#')[0];
  const at = s.lastIndexOf('@'); // userinfo 不是主机名
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith('[')) {
    const close = s.indexOf(']'); // IPv6: [::1]:8080
    s = close < 0 ? s : s.slice(0, close + 1);
  } else {
    s = s.split(':')[0];
  }
  s = s.replace(/\.+$/, '');
  if (!s || /\s/.test(s)) return '';
  if (s.startsWith('www.')) {
    const rest = s.slice(4);
    if (rest.includes('.')) s = rest; // 裸 www 主机不动
  }
  return s;
}

// URL → 规则主机名。非 http(s)(chrome:// / file:// / about:)没有"域名"可归组,
// 一律空串: normalizeRuleHost 直接吃 URL 会把 chrome://new-tab-page/ 认成主机名。
function ruleHostOfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return normalizeRuleHost(u.hostname);
  } catch (e) {
    return '';
  }
}

// 规则作用域: 'zone' = 连同所有子域一起匹配; 'exact' = 只匹配这一个主机名。
// 单标签(localhost、com)、IP、公共后缀都只能精确——否则规则 "com" 会把全网
// 每个 .com 站点吸进分组,精确降级比直接拒收友好: 用户仍然可以照写,只是不展开。
function ruleScopeOf(host) {
  const h = String(host || '');
  if (!h.includes('.')) return 'exact';
  if (h.startsWith('[')) return 'exact'; // IPv6
  if (IP_RE.test(h)) return 'exact';
  if (SHARED_RULE_SUFFIXES.has(h)) return 'exact';
  const tld = h.slice(h.lastIndexOf('.') + 1);
  if (!/^[a-z-]{2,}$/.test(tld)) return 'exact'; // 末段是数字 → 不是可通配的域
  return 'zone';
}

// 当前站点根: 把 search.bilibili.com / room.live.bilibili.com 收成 bilibili.com。
// "＋ 添加域名"从任何子页都能一次收整站——用户加的是"这个网站",不是这一台主机。
// 收成两标签的前提是这两标签本身可通配: co.uk / github.io / IP 这类降级的
// 就停手,再往上一步会踩到别人的站点,宁可规则窄一点。
function siteRootOf(host) {
  const h = normalizeRuleHost(host);
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const two = labels.slice(-2).join('.');
  if (ruleScopeOf(two) === 'zone') return two;
  return h;
}

// 芯片/导出里怎么展示一条规则: 通配的加 "*." 前缀,精确的原样。
// 存储里永远只放裸主机名,"*." 只是这层显示(见 popup.js 的 dataset.host)。
function ruleChipLabel(host) {
  const h = normalizeRuleHost(host);
  if (!h) return '';
  return ruleScopeOf(h) === 'zone' ? `*.${h}` : h;
}

// { 组名: [域名...] } → 匹配器。
// 匹配 = 沿标签链向上做后缀匹配(www.bilibili.com → bilibili.com),天然最长优先:
// 同时有 *.bilibili.com 和 live.bilibili.com 两条规则时,直播页走更具体的那条。
// 只有第一跳(完整主机名)允许命中精确规则,往上的每一跳必须是 zone 规则——
// 这一条就是"通配不误伤"的开关。
function createRuleMatcher(rules) {
  const index = new Map(); // host → { group, zone }
  for (const [group, list] of Object.entries(rules || {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const host = normalizeRuleHost(item);
      if (!host) continue;
      // 一个域名只能归属一个分组: 首见为准,规则顺序变化不会让同一站点换组
      if (!index.has(host)) index.set(host, { group, zone: ruleScopeOf(host) === 'zone' });
    }
  }
  return {
    index,
    // 入参可以是裸主机名也可以是完整 URL(normalizeRuleHost 两种都吃)
    match(input) {
      let p = normalizeRuleHost(input);
      if (!p) return null;
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
