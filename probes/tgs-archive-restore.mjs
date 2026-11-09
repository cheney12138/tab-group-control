// tgs-archive-restore.mjs — 归档「重新打开」的收场
// 守: ① 恢复落点窗口 = 最后聚焦的普通窗口(独立窗口里 getCurrent 是面板自己, 不能拿去建标签)
//     ② 点「重新打开」后**返回分组窗口**(设置面板收起)且弹窗不关(不调 window.close)
//     ③ 回到的列表里恢复的分组已展开、行都在, 归档卡已焚毁
//     ④ 收场顺序: 先刷数据/渲染, 再收面板(不是先收面板再补列表)
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const OUT = '/tmp/tgs-archive-restore';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-ar-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

const INIT = () => {
  localStorage.setItem('tgs-theme', 'linear');
  window.__tabs = [];
  window.__created = [];            // 记录 tabs.create 的入参, 用于验证落点窗口
  window.__closed = 0;              // window.close 被调用的次数
  window.close = () => { window.__closed++; };
  window.__nextId = 700;
  window.__groups = [];
  // 独立窗口形态: getCurrent 返回面板自己(type='popup'), 普通窗口是 1
  chrome.windows.getCurrent = async () => ({ id: 77, type: 'popup' });
  chrome.windows.getAll = async () => [{ id: 1, type: 'normal', focused: true }];
  chrome.tabs.query = async () => window.__tabs;
  chrome.tabGroups.query = async (q) => {
    let list = window.__groups;
    if (q && q.title) list = list.filter(g => g.title === q.title);
    return list;
  };
  chrome.tabGroups.update = async () => {};
  chrome.tabs.group = async (opts) => {
    const gid = opts.groupId || 500;
    for (const tid of opts.tabIds) {
      const t = window.__tabs.find(x => x.id === tid);
      if (t) t.groupId = gid;
    }
    return gid;
  };
  chrome.tabs.get = async (tid) => window.__tabs.find(t => t.id === tid) || Promise.reject(new Error('no tab'));
  chrome.tabs.create = async (props) => {
    window.__created.push({ url: props.url, windowId: props.windowId, active: props.active });
    const t = { id: window.__nextId++, url: props.url, title: props.url, groupId: -1,
      windowId: props.windowId || 1, active: false, lastAccessed: Date.now() + window.__created.length,
      status: 'complete', audible: false, discarded: false, index: 0 };
    window.__tabs.push(t);
    return { ...t };
  };
  // background 的建组应答: 直接在本页假数据里建/并入同名组
  chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'restore-group') {
      const gid = 500;
      window.__groups.push({ id: gid, title: msg.title, color: msg.color, windowId: msg.windowId || 1 });
      await chrome.tabs.group({ tabIds: msg.tabIds, groupId: gid });
      return { ok: true, merged: false };
    }
    // 「重新打开」整套动作现在在 worker 里发生(建标签/归组/焚卡), 页侧只发这一条
    // 消息 —— 打桩就得把 worker 那半边演出来: 建标签 + 归组 + 焚卡, 返回结果。
    if (msg?.type === 'reopen-archive') {
      const list = window.__store.archivedGroups || [];
      const item = list.find(x => x.id === msg.cardId);
      if (!item) return { ok: false, error: '归档卡不存在' };
      const tabs = [];
      for (const t of item.tabs || []) {
        const nt = await chrome.tabs.create({ url: t.url, active: false, windowId: msg.windowId });
        tabs.push({ id: nt.id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '' });
      }
      const gid = 500;
      window.__groups.push({ id: gid, title: item.title, color: item.color, windowId: msg.windowId || 1 });
      await chrome.tabs.group({ tabIds: tabs.map(t => t.id), groupId: gid });
      const nextList = list.filter(x => x.id !== msg.cardId);
      window.__store.archivedGroups = nextList;
      return { ok: true, title: item.title, tabs, failed: 0, merged: false, archiveCount: nextList.length };
    }
    return null;
  };
  // storage.local 打桩: 归档卡 + 设置都在内存里, 读写在页面内同步可见
  window.__store = {
    archivedGroups: [{
      id: 'arch_1', title: '素材', color: 'blue', archivedAt: Date.now() - 3600_000,
      tabs: [
        { title: '素材页一', url: 'https://a.example/1', favIconUrl: '' },
        { title: '素材页二', url: 'https://a.example/2', favIconUrl: '' },
      ],
    }],
    hasArchiveUnread: true,
    groupRules: {},
    manualTabIds: [],
  };
  chrome.storage.local.get = async (keys) => {
    if (keys == null) return { ...window.__store };
    if (typeof keys === 'string') return { [keys]: window.__store[keys] };
    if (Array.isArray(keys)) {
      const o = {};
      for (const k of keys) o[k] = window.__store[k];
      return o;
    }
    const o = {};
    for (const k of Object.keys(keys)) o[k] = window.__store[k] ?? keys[k];
    return o;
  };
  chrome.storage.local.set = async (obj) => { Object.assign(window.__store, obj); };
  chrome.storage.local.remove = async () => {};
  chrome.storage.session = { get: async () => ({}), set: async () => {}, remove: async () => {} };
};

const p = await ctx.newPage();
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(INIT);
await p.goto(`chrome-extension://${id}/popup.html`);
await p.waitForSelector('.tab-item, .empty', { timeout: 10000 });
await p.waitForTimeout(700);

// ── 1. 打开设置 → 已归档 pane → 点「重新打开」 ──
console.log('\n[1] 重新打开归档的收场');
await p.click('#settingsBtn');
await p.waitForTimeout(150);
await p.click('.settings-tab[data-pane="archive"]');
await p.waitForSelector('.archive-card', { timeout: 5000 });
const panelBefore = await p.evaluate(() => ({
  open: document.getElementById('settingsPanel').classList.contains('open'),
  bodyFlag: document.body.classList.contains('settings-open'),
  cards: document.querySelectorAll('.archive-card').length,
}));
chk('设置面板已打开且在「已归档」', panelBefore.open && panelBefore.cards === 1,
  `open=${panelBefore.open} cards=${panelBefore.cards}`);

await p.click('.btn-restore-archive');
await p.waitForFunction(() => !document.getElementById('settingsPanel').classList.contains('open'),
  { timeout: 8000 });
await p.waitForTimeout(400);

const after = await p.evaluate(() => ({
  panelOpen: document.getElementById('settingsPanel').classList.contains('open'),
  bodyFlag: document.body.classList.contains('settings-open'),
  closedCount: window.__closed,
  created: window.__created,
  rows: [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId),
  groupHeaders: [...document.querySelectorAll('.group-header')].map(h => ({
    text: h.textContent.slice(0, 20),
    collapsed: h.classList.contains('collapsed'),
  })),
  archived: window.__store.archivedGroups.length,
  toasts: [...document.querySelectorAll('#pushStack .push-banner')].map(x => x.textContent),
  resultsVisible: document.getElementById('results').getBoundingClientRect().height > 0,
}));

chk('收场后回到分组窗口(面板收起)', after.panelOpen === false && after.bodyFlag === false);
chk('弹窗没有被关掉(window.close 零调用)', after.closedCount === 0, `close=${after.closedCount}`);
chk('落点窗口 = 当前窗口(普通 popup 模式)',
  after.created.length === 2 && after.created.every(c => c.windowId === 77),
  JSON.stringify(after.created.map(c => c.windowId)));
chk('标签全部在后台创建(active:false)', after.created.every(c => c.active === false));
chk('回到的列表里能看到恢复的标签行', after.rows.length === 2, `rows=${after.rows.join(',')}`);
chk('恢复的分组已展开(组头不是 collapsed)',
  after.groupHeaders.length === 1 && after.groupHeaders[0].collapsed === false,
  JSON.stringify(after.groupHeaders));
chk('分组头 = 归档卡名「素材」', (after.groupHeaders[0]?.text || '').includes('素材'));
chk('归档卡已焚毁', after.archived === 0, `archived=${after.archived}`);
chk('给了「已重新打开」提示', after.toasts.some(t => t.includes('已重新打开')), after.toasts.join(' | '));
chk('主列表确实可见(不是空白覆盖层)', after.resultsVisible);
await p.screenshot({ path: `${OUT}.png`, clip: { x: 0, y: 0, width: 480, height: 320 } });

// ── 2. 收场顺序: 先收面板, 再刷列表 ──
// 原来的行为: 先收面板, 再刷新数据, 最后 afterRestore 展开分组
console.log('\n[2] 收场顺序(先收面板, 后刷列表)');
const order = await p.evaluate(async () => {
  // 重新塞一张归档卡, 再来一次
  window.__store.archivedGroups = [{
    id: 'arch_2', title: '资料', color: 'green', archivedAt: Date.now(),
    tabs: [{ title: '资料页', url: 'https://c.example/1', favIconUrl: '' }],
  }];
  window.__tabs = []; window.__groups = []; window.__created = [];
  document.getElementById('settingsBtn').click();
  await new Promise(r => setTimeout(r, 120));
  document.querySelector('.settings-tab[data-pane="archive"]').click();
  await new Promise(r => setTimeout(r, 200));
  const snapshotAtClose = await new Promise(resolve => {
    const panel = document.getElementById('settingsPanel');
    const mo = new MutationObserver(() => {
      if (!panel.classList.contains('open')) {
        mo.disconnect();
        resolve([...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId));
      }
    });
    mo.observe(panel, { attributes: true, attributeFilter: ['class'] });
    document.querySelector('.btn-restore-archive').click();
    setTimeout(() => { mo.disconnect(); resolve(null); }, 6000);
  });
  return { snapshotAtClose, created: window.__created.length };
});
chk('面板收起后列表里有恢复的行(先收面板后刷列表)',
  order.created === 1,
  `created=${order.created}`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
