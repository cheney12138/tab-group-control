// tgs-group-order.mjs — 删除 / 撤销后分组排序是否保持
// 守: ① 删除一个标签后, 分组头的先后次序保持不变
//     ② ⌘Z 撤销之后, 分组头的先后次序仍然与删除前一致(撤销是删除的逆动作)
// 做法: 假 chrome API + 真实 popup 页面(未 stub 的 API 走真实扩展环境),
//       用键盘 ⌘⌫ 删行、⌘Z 撤销, 每步读取 .group-header 文本序。
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-go-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

// 场景可参数化: 页面初始化脚本从 window.__scenario 里读(每次用例前注入)
const INIT = () => {
  localStorage.setItem('tgs-theme', 'linear');
  const NOW = Date.now();
  // 基准场景: 学习(组序 1) / 工作(2) / 娱乐(3) / 未分组(4)
  window.__mkTabs = () => ([
    { id: 101, title: '学习一', url: 'https://a.example/1', groupId: 10, windowId: 1,
      active: true,  lastAccessed: NOW - 1000,   index: 0, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 102, title: '学习二', url: 'https://a.example/2', groupId: 10, windowId: 1,
      active: false, lastAccessed: NOW - 4000,   index: 1, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 201, title: '工作一', url: 'https://b.example/1', groupId: 20, windowId: 1,
      active: false, lastAccessed: NOW - 2000,   index: 2, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 202, title: '工作二', url: 'https://b.example/2', groupId: 20, windowId: 1,
      active: false, lastAccessed: NOW - 5000,   index: 3, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 301, title: '娱乐一', url: 'https://c.example/1', groupId: 30, windowId: 1,
      active: false, lastAccessed: NOW - 3000,   index: 4, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 401, title: '散标签', url: 'https://d.example/1', groupId: -1, windowId: 1,
      active: false, lastAccessed: NOW - 6000,   index: 5, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
  ]);
  window.__groups = [
    { id: 10, title: '学习', color: 'blue',   windowId: 1 },
    { id: 20, title: '工作', color: 'green',  windowId: 1 },
    { id: 30, title: '娱乐', color: 'red',    windowId: 1 },
  ];
  window.__tabs = window.__mkTabs();
  window.__nextId = 700;

  chrome.windows.getCurrent = async () => ({ id: 1, type: 'normal' });
  chrome.windows.getAll = async () => [{ id: 1, type: 'normal', focused: true }];
  chrome.tabs.query = async () => window.__tabs.map(t => ({ ...t }));
  chrome.tabGroups.query = async (q) => {
    let list = window.__groups.map(g => ({ ...g }));
    if (q && q.title) list = list.filter(g => g.title === q.title);
    if (q && q.windowId) list = list.filter(g => g.windowId === q.windowId);
    return list;
  };
  chrome.tabGroups.get = async (gid) => ({ ...window.__groups.find(g => g.id === gid) });
  chrome.tabGroups.update = async () => {};
  chrome.tabs.group = async (opts) => {
    const gid = opts.groupId || 500;
    for (const tid of opts.tabIds) {
      const t = window.__tabs.find(x => x.id === tid);
      if (t) t.groupId = gid;
    }
    return gid;
  };
  chrome.tabs.ungroup = async () => {};
  chrome.tabs.get = async (tid) => {
    const t = window.__tabs.find(x => x.id === tid);
    if (!t) throw new Error('no tab ' + tid);
    return { ...t };
  };
  chrome.tabs.remove = async (ids) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
  };
  chrome.tabs.create = async (props) => {
    // Chrome 真实行为: 新标签 lastAccessed = now(最新)
    const t = { id: window.__nextId++, url: props.url, title: props.url, groupId: -1,
      windowId: props.windowId || 1, active: false, lastAccessed: Date.now() + 1,
      index: 0, status: 'complete', audible: false, discarded: false, favIconUrl: '' };
    window.__tabs.push(t);
    return { ...t };
  };
  chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'restore-group') {
      const gid = 500;
      window.__groups.push({ id: gid, title: msg.title, color: msg.color, windowId: msg.windowId || 1 });
      await chrome.tabs.group({ tabIds: msg.tabIds, groupId: gid });
      return { ok: true, merged: false };
    }
    if (msg?.type === 'get-snapshot') return null;
    return null;
  };
  window.__store = { groupRules: {}, manualTabIds: [], archivedGroups: [], hasArchiveUnread: false };
  chrome.storage.local.get = async (keys) => {
    if (typeof keys === 'string') return { [keys]: window.__store[keys] };
    if (Array.isArray(keys)) { const o = {}; for (const k of keys) o[k] = window.__store[k]; return o; }
    return { ...window.__store };
  };
  chrome.storage.local.set = async (obj) => { Object.assign(window.__store, obj); };
  chrome.storage.local.remove = async () => {};
  chrome.storage.session = { get: async () => ({}), set: async () => {}, remove: async () => {} };
};

const p = await ctx.newPage();
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(INIT);
const openPopup = async () => {
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(600);
};
const headerOrder = () => p.evaluate(() =>
  [...document.querySelectorAll('.group-header')].map(h =>
    (h.querySelector('.group-title')?.textContent || '').trim()));
const rowOrder = () => p.evaluate(() => [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId));
const focusRow = async (tabId) => {
  await p.evaluate((tid) => {
    const row = [...document.querySelectorAll('.tab-item')].find(r => r.dataset.tabId === String(tid));
    row?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const input = document.getElementById('searchInput') || document.querySelector('input');
    input.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    // 用键盘把光标挪到目标行(直接点行会切标签, 这里只改光标)
    const idx = [...document.querySelectorAll('.tab-item')].indexOf(row);
    const cur = [...document.querySelectorAll('.tab-item')].findIndex(r => r.classList.contains('active'));
    const delta = idx - (cur < 0 ? 0 : cur);
    const key = delta >= 0 ? 'ArrowDown' : 'ArrowUp';
    for (let i = 0; i < Math.abs(delta); i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
  }, tabId);
};
const deleteFocused = async () => {
  await p.keyboard.down('Meta');
  await p.keyboard.press('Backspace');
  await p.keyboard.up('Meta');
  await p.waitForTimeout(700); // 收起动画 340ms + 收尾重渲染
};
const undo = async () => {
  await p.keyboard.down('Meta');
  await p.keyboard.press('z');
  await p.keyboard.up('Meta');
  await p.waitForTimeout(1200); // 建标签 + 归组 + 展开动画
};

// ── 用例 A: 删除组内「非最新」标签(不影响该组的 lastAccessed 最大值) ──
console.log('\n[A] 删除组内非最新标签 → 撤销');
await openPopup();
const baseA = await headerOrder();
console.log('  删除前组序:', JSON.stringify(baseA), '行:', (await rowOrder()).join(','));
await focusRow(202); // 工作二(lastAccessed 最新的是 201)
await deleteFocused();
const afterDelA = await headerOrder();
console.log('  删除后组序:', JSON.stringify(afterDelA), '行:', (await rowOrder()).join(','));
chk('删除后分组排序不变', JSON.stringify(afterDelA) === JSON.stringify(baseA),
  `before=${JSON.stringify(baseA)} after=${JSON.stringify(afterDelA)}`);
await undo();
const afterUndoA = await headerOrder();
console.log('  撤销后组序:', JSON.stringify(afterUndoA), '行:', (await rowOrder()).join(','));
chk('撤销后分组排序与删除前一致', JSON.stringify(afterUndoA) === JSON.stringify(baseA),
  `before=${JSON.stringify(baseA)} after=${JSON.stringify(afterUndoA)}`);
chk('撤销后行回到组内原位(201 之前, 202 之后)',
  (await rowOrder()).slice(0, 4).join(',') === '101,102,201,700',
  (await rowOrder()).join(','));

// ── 用例 B: 删除整组(组内只剩一个标签, 组随之消失) → 撤销 ──
console.log('\n[B] 删除整组(最后一根标签) → 撤销');
await openPopup();
const baseB = await headerOrder();
console.log('  删除前组序:', JSON.stringify(baseB));
await focusRow(301); // 娱乐一, 组内唯一
await deleteFocused();
console.log('  删除后组序:', JSON.stringify(await headerOrder()));
await undo();
const afterUndoB = await headerOrder();
console.log('  撤销后组序:', JSON.stringify(afterUndoB), '行:', (await rowOrder()).join(','));
chk('撤销后「娱乐」回到原位置', JSON.stringify(afterUndoB) === JSON.stringify(baseB),
  `before=${JSON.stringify(baseB)} after=${JSON.stringify(afterUndoB)}`);

// ── 用例 C: 删除组内「最新」标签(该组时间戳降级) → 撤销 ──
console.log('\n[C] 删除组内最新标签 → 撤销');
await openPopup();
const baseC = await headerOrder();
console.log('  删除前组序:', JSON.stringify(baseC));
await focusRow(201); // 工作一, 工作组最新
await deleteFocused();
const afterDelC = await headerOrder();
console.log('  删除后组序:', JSON.stringify(afterDelC));
await undo();
const afterUndoC = await headerOrder();
console.log('  撤销后组序:', JSON.stringify(afterUndoC));
chk('撤销后组序回到删除前', JSON.stringify(afterUndoC) === JSON.stringify(baseC),
  `before=${JSON.stringify(baseC)} after=${JSON.stringify(afterUndoC)}`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
