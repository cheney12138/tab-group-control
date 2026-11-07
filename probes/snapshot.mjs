// snapshot.mjs — 从真实扩展导出渲染后的 DOM 快照(真实类名 + 真实结构 + favicon 内联)
// 输出 site/assets/states.json: { stateName: bodyHTML }
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const fs = await import('node:fs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const OUT = '/Users/qianyuchen/tab-group-search/site/assets/states.json';

const ctx = await chromium.launchPersistentContext(`/tmp/tgs-snap-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;

// 与 shots.mjs 同一套数据集(公开站点, 重度场景)
const FAKES = `(() => {
  const now = Date.now();
  const M = 60000, H = 3600000, D = 86400000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  let id = 100;
  const T = (url, title, gid, ago) => mk(id++, url, title, gid, now - ago);
  const base = [
    T('https://github.com/cheney12138/tab-group-control', 'Tab Group Search · GitHub', 11, 2*M),
    T('https://github.com/facebook/react/pulls', 'Pull requests · facebook/react', 11, 15*M),
    T('https://stackoverflow.com/questions/pinyin-table', 'Stack Overflow · 拼音码点表实现思路', 11, 40*M),
    T('https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Array', 'MDN · Array.prototype 方法速查', 11, 3*H),
    T('https://react.dev/reference/react/hooks', 'React 官方文档 · Hooks 参考', 11, 5*H),
    T('https://cn.vuejs.org/guide/essentials/reactivity-fundamentals.html', 'Vue.js · 响应式基础', 11, 8*H),
    T('https://www.typescriptlang.org/docs/handbook/utility-types.html', 'TypeScript · Utility Types', 11, 26*H),
    T('https://web.dev/articles/vitals', 'web.dev · Core Web Vitals', 11, 2*D),
    T('https://nodejs.org/docs/latest/api/fs.html', 'Node.js · File System API', 11, 3*D),
    T('https://developer.chrome.com/docs/extensions/reference/api/tabGroups', 'Chrome Extensions · tabGroups API', 11, 4*D),
    T('https://webpack.js.org/configuration/', 'webpack · Configuration', 11, 5*D),
    T('https://vitejs.dev/guide/', 'Vite · 快速上手', 11, 6*D),
    ...Array.from({ length: 29 }, (_, i) => {
      const items = [
        ['https://zh.javascript.info/', 'JavaScript Info · 现代 JavaScript 教程'],
        ['https://leetcode.cn/problemset/all/', '力扣 · 题库'],
        ['https://www.zhihu.com/question/elegant-code', '知乎 · 有哪些看似简单实则精妙的代码'],
        ['https://book.douban.com/subject/landing', '豆瓣 · 最近想读的书单'],
        ['https://zh.wikipedia.org/wiki/Chinese_input_method', 'Wikipedia · 中文输入法'],
        ['https://www.coursera.org/learn/machine-learning', 'Coursera · Machine Learning'],
        ['https://juejin.cn/post/frontend-perf', '掘金 · 前端性能优化清单'],
        ['https://sspai.com/post/efficiency-tools', '少数派 · 效率工具盘点 2026'],
        ['https://www.ruanyifeng.com/blog/weekly/', '阮一峰 · 科技爱好者周刊'],
        ['https://css-tricks.com/snippets/css/complete-guide-grid/', 'CSS-Tricks · A Complete Guide to Grid'],
        ['https://www.bilibili.com/video/cs-course', 'bilibili · 计算机科学导论'],
        ['https://developer.mozilla.org/docs/Web/CSS', 'MDN · CSS 参考'],
        ['https://regexr.com/', 'RegExr · 正则表达式学习'],
        ['https://news.ycombinator.com/', 'Hacker News'],
        ['https://eloquentjavascript.net/', 'Eloquent JavaScript · 在线书'],
        ['https://www.freecodecamp.org/learn', 'freeCodeCamp · 课程'],
        ['https://github.com/trending', 'GitHub · Trending 本周热门'],
        ['https://caniuse.com/flexbox', 'Can I Use · Flexbox 兼容性'],
        ['https://stackoverflow.com/questions/css-center', 'Stack Overflow · 如何居中对齐'],
        ['https://developer.mozilla.org/docs/Web/API/Fetch_API', 'MDN · Fetch API'],
        ['https://zh.javascript.info/promise-basics', 'JavaScript Info · Promise 基础'],
        ['https://www.zhihu.com/question/how-to-learn', '知乎 · 如何系统地学习一门新语言'],
        ['https://book.douban.com/subject/sicp', '豆瓣 · SICP 计算机程序的构造和解释'],
        ['https://zh.wikipedia.org/wiki/Unicode', 'Wikipedia · Unicode'],
        ['https://juejin.cn/post/rust-wasm', '掘金 · Rust 编译到 WASM 实战'],
        ['https://sspai.com/post/keyboard-maestro', '少数派 · Keyboard Maestro 指南'],
        ['https://www.khanacademy.org/math', 'Khan Academy · 数学'],
        ['https://vue3js.cn/', 'Vue3 中文文档 · 组合式 API'],
        ['https://www.ruanyifeng.com/blog/2026/ai-coding', '阮一峰 · AI 编程的边界'],
      ];
      const it = items[i % items.length];
      const ago = [30*M, 1*H, 3*H, 7*H, 21*H, 26*H, 2*D, 3*D, 5*D][i % 9];
      return T(it[0] + (i > 28 ? '' : '?t=' + i), it[1], 22, ago);
    }),
    T('https://www.bilibili.com/v/popular', 'bilibili · 每周必看视频榜', 33, 50*M),
    T('https://music.163.com/discover', '网易云音乐 · 每日推荐', 33, 90*M),
    T('https://www.youtube.com/playlist?list=WL', 'YouTube · 稍后再看', 33, 5*H),
    T('https://www.douban.com/group/explore', '豆瓣 · 小组热门话题', 33, 26*H),
    T('https://weibo.com/hot/search', '微博 · 热搜榜', 33, 2*D),
    T('https://www.xiaohongshu.com/explore', '小红书 · 发现', 33, 4*D),
    ...Array.from({ length: 33 }, (_, i) => {
      const items = [
        ['https://www.weather.com.cn', '天气预报 · 15 天趋势'],
        ['https://maps.google.com', 'Google 地图'],
        ['https://mail.google.com', 'Gmail · 收件箱'],
        ['https://calendar.google.com', 'Google 日历'],
        ['https://translate.google.com', 'Google 翻译'],
        ['https://www.wikipedia.org/', 'Wikipedia · 首页'],
        ['https://www.amazon.cn/', '亚马逊 · 购物车'],
        ['https://www.taobao.com/', '淘宝 · 首页'],
        ['https://www.jd.com/', '京东 · 首页'],
        ['https://www.ctrip.com/', '携程 · 机票酒店'],
        ['https://www.12306.cn/', '12306 · 车票预订'],
      ];
      const it = items[i % items.length];
      const ago = [2*H, 5*H, 20*H, 30*H, 2*D, 4*D, 7*D][i % 7];
      return T(it[0] + '?t=' + i, it[1], -1, ago);
    }),
  ];
  base[0].active = true;
  const music = base.find(t => t.title.includes('网易云音乐')); if (music) music.audible = true;
  const wiki = base.find(t => t.title.includes('Wikipedia · 中文输入法')); if (wiki) wiki.discarded = true;
  const groups = [
    { id: 11, title: '工作', color: 'blue', windowId: 1 },
    { id: 22, title: '学习', color: 'green', windowId: 1 },
    { id: 33, title: '娱乐', color: 'orange', windowId: 1 },
  ];
  chrome.tabs.query = async (q) => {
    let out = base;
    if (q && q.windowId != null) out = out.filter(t => t.windowId === q.windowId);
    if (q && q.groupId != null) out = out.filter(t => t.groupId === q.groupId);
    return out;
  };
  chrome.tabs.get = async (tid) => {
    const t = base.find(x => x.id === tid);
    if (!t) throw new Error('not found');
    return t;
  };
  chrome.tabGroups.query = async () => groups;
  chrome.tabGroups.get = async (gid) => {
    const g = groups.find(x => x.id === gid);
    if (!g) throw new Error('not found');
    return g;
  };
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
  chrome.bookmarks = chrome.bookmarks || {};
  chrome.bookmarks.search = async () => ([
    { id: 'b1', title: 'React 官方文档 · 中文', url: 'https://zh-hans.react.dev' },
    { id: 'b2', title: 'MDN Web Docs', url: 'https://developer.mozilla.org' },
    { id: 'b3', title: 'Chrome Extensions API', url: 'https://developer.chrome.com/docs/extensions' },
    { id: 'b4', title: 'Vue.js 官方文档', url: 'https://cn.vuejs.org' },
  ]);
  chrome.history = chrome.history || {};
  chrome.history.search = async () => ([
    { id: 'h1', title: '知乎 · 如何评价这个设计', url: 'https://www.zhihu.com/question/design', lastVisitTime: now - 2*H, visitCount: 3 },
    { id: 'h2', title: '掘金 · 前端性能优化清单', url: 'https://juejin.cn/post/perf', lastVisitTime: now - 6*H, visitCount: 1 },
    { id: 'h3', title: 'bilibili · 装机指南 2026', url: 'https://www.bilibili.com/video/pc', lastVisitTime: now - 30*H, visitCount: 12 },
  ]);
  chrome.sessions = chrome.sessions || {};
  chrome.sessions.getRecentlyClosed = async () => ([
    { tab: { title: '掘金 · 周一技术头条', url: 'https://juejin.cn/post/weekly' }, lastModified: (now - 3*M)/1000 },
    { tab: { title: 'V2EX · 分享创造', url: 'https://v2ex.com/t/share' }, lastModified: (now - 2*H)/1000 },
  ]);
  const archives = [
    { id: 'a1', title: '前端学习清单', color: 'blue', archivedAt: now - 3*D, tabs: [
      { title: 'JavaScript Info · 现代教程', url: 'https://zh.javascript.info', favIconUrl: '' },
      { title: 'CSS Grid 完全指南', url: 'https://css-tricks.com/snippets/css/complete-guide-grid/', favIconUrl: '' },
      { title: 'Web.dev · Core Web Vitals', url: 'https://web.dev/vitals/', favIconUrl: '' },
    ]},
    { id: 'a2', title: '周末阅读', color: 'green', archivedAt: now - 14*D, tabs: [
      { title: '少数派 · 效率工具盘点', url: 'https://sspai.com/post/tools', favIconUrl: '' },
      { title: '阮一峰 · 科技爱好者周刊', url: 'https://ruanyifeng.com/blog/weekly/', favIconUrl: '' },
    ]},
  ];
  const groupRules = {
    '工作': ['github.com', 'stackoverflow.com', '*.mozilla.org', 'react.dev', 'cn.vuejs.org'],
    '学习': ['zhihu.com', 'douban.com', '*.wikipedia.org', 'juejin.cn', 'sspai.com'],
  };
  const store = { archivedGroups: archives, groupRules, autoGroupEnabled: true, othersGroupEnabled: true };
  chrome.storage = chrome.storage || {};
  chrome.storage.local = {
    get: async (keys) => {
      if (keys == null) return store;
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(k => k in store).map(k => [k, store[k]]));
    },
    set: async (obj) => { Object.assign(store, obj); },
  };
})();`;

async function openPopup(theme = 'linear', accent = 'blue') {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 480, height: 520 });
  await p.addInitScript(({ th, ac, fakes }) => {
    localStorage.setItem('tgs-theme', th);
    localStorage.setItem('tgs-accent', ac);
    window.__TGS_SKIP_SWITCH = true;
    eval(fakes);
  }, { th: theme, ac: accent, fakes: FAKES });
  await p.emulateMedia({ colorScheme: 'light' });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(500);
  // 强制切回分组视图(视图偏好会被 localStorage 记住, 前面的 recent/window 抓取会污染后续主题快照)
  await p.evaluate(() => {
    const btn = [...document.querySelectorAll('.view-tab')].find(b => b.textContent.trim() === '分组');
    if (btn && !btn.classList.contains('active')) btn.click();
  });
  await p.waitForTimeout(250);
  return p;
}

// 把 favicon 的 chrome-extension:// 地址内联成 data URI(页面离开扩展后仍可用)
async function inlineFavicons(p) {
  await p.evaluate(async () => {
    const imgs = [...document.querySelectorAll('img')];
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('chrome-extension://')) continue;
      try {
        const r = await fetch(src);
        const b = await r.blob();
        const dataUrl = await new Promise(res => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.readAsDataURL(b);
        });
        img.setAttribute('src', dataUrl);
      } catch (e) { img.removeAttribute('src'); }
    }
    // 背景图里的 blob/extension 资源也清掉(主题纹理是 data URI, 无需处理)
  });
}

// 把 DOM 的实时状态固化成 attribute —— innerHTML 不会带 input.value / checkbox.checked
async function freezeFormState(p) {
  await p.evaluate(() => {
    document.querySelectorAll('input').forEach(el => {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) el.setAttribute('checked', ''); else el.removeAttribute('checked');
      } else {
        el.setAttribute('value', el.value);
      }
    });
    document.querySelectorAll('textarea').forEach(el => { el.textContent = el.value; });
    document.querySelectorAll('select').forEach(el => {
      [...el.options].forEach(o => { o.selected = (o.value === el.value); });
    });
    // 开关的视觉由 checked 伪类驱动, 已由上面的 attribute 接管
  });
}

async function grab(p, name) {
  await freezeFormState(p);
  await inlineFavicons(p);
  const html = await p.evaluate(() => document.body.innerHTML);
  const theme = await p.evaluate(() => document.documentElement.dataset.theme || 'linear');
  const accent = await p.evaluate(() => document.documentElement.dataset.accent || '');
  const dark = await p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
  return { name, theme, accent, dark, html };
}

const out = {};

// 1. 分组视图(默认)
{
  const p = await openPopup();
  out.group = await grab(p, 'group');
  // 拼音搜索态
  await p.fill('#search', 'zhihu');
  await p.waitForTimeout(350);
  out.search = await grab(p, 'search');
  await p.fill('#search', '/b');
  await p.waitForTimeout(350);
  out.bookmarks = await grab(p, 'bookmarks');
  await p.close();
  console.log('✓ group / search / bookmarks');
}
// 2. 最近使用 + 当前窗口
{
  const p = await openPopup();
  await p.evaluate(() => { [...document.querySelectorAll('.view-tab')].find(b => b.textContent.trim() === '最近使用')?.click(); });
  await p.waitForTimeout(350);
  out.recent = await grab(p, 'recent');
  await p.evaluate(() => { [...document.querySelectorAll('.view-tab')].find(b => b.textContent.trim() === '当前窗口')?.click(); });
  await p.waitForTimeout(350);
  out.window = await grab(p, 'window');
  await p.close();
  console.log('✓ recent / window');
}
// 3. 设置: 规则编辑器 / 已归档
{
  const p = await openPopup();
  await p.locator('#settingsBtn').click();
  await p.waitForTimeout(500);
  out.settingsRules = await grab(p, 'settingsRules');
  await p.evaluate(() => { [...document.querySelectorAll('.settings-tab')].find(b => b.textContent.includes('归档'))?.click(); });
  await p.waitForTimeout(400);
  out.settingsArchives = await grab(p, 'settingsArchives');
  await p.close();
  console.log('✓ settingsRules / settingsArchives');
}
// 4. 三套主题(分组视图)
for (const th of ['linear', 'ink', 'sky']) {
  const p = await openPopup(th);
  out['theme_' + th] = await grab(p, 'theme_' + th);
  await p.close();
  console.log('✓ theme', th);
}
// 5. 暗色(linear)
{
  const p = await openPopup();
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.reload();
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(500);
  out.theme_linear_dark = await grab(p, 'theme_linear_dark');
  await p.close();
  console.log('✓ theme linear dark');
}
// 6. 右键菜单(单独: 菜单是 JS 动态插入 body 的)
{
  const p = await openPopup();
  const row = p.locator('.tab-item', { hasText: 'JavaScript Info' }).first();
  await row.scrollIntoViewIfNeeded();
  await p.waitForTimeout(200);
  const box = await row.boundingBox();
  await p.mouse.click(box.x + 200, box.y + box.height / 2, { button: 'right' });
  await p.waitForSelector('.ctx-menu', { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(350);
  out.contextmenu = await grab(p, 'contextmenu');
  await p.close();
  console.log('✓ contextmenu');
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const size = fs.statSync(OUT).size;
console.log('states.json', (size / 1024).toFixed(1) + 'KB', Object.keys(out).join(', '));
await ctx.close();
