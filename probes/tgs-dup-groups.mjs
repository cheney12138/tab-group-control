// tgs-dup-groups.mjs — 同窗口同名分组(异常态)的可见性与一键合并
// 守:
//   ① 同窗口两个同名(同色)组 → 两个组头都挂 dup 标记「重名」+ title 提示右键可合并
//   ② 跨窗口同名是**合法**的 → 一根都不标（这是最容易写错的一刀）
//   ③ 非重复分组的组头右键菜单里没有「合并同名分组」这一项
//   ④ 重复分组右键菜单里有该项；点下去 → 标签全部并进第一组，空组消失，dup 标记随之消失
// 做法: 假 chrome API + 真实 popup 页面。background 的合并动作在探针里用
//       chrome.runtime.sendMessage 的 stub 模拟（按 merge-dup-groups 的消息契约改假状态），
//       这样验的是"菜单 → 消息 → 重渲染"整条 popup 侧链路。
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-dup-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

// 场景由 ?scene= 选: dup(同窗口两个 codedev) / cross(只有跨窗口同名)
const INIT = () => {
  localStorage.setItem('tgs-theme', 'linear');
  const NOW = Date.now();
  const scene = new URLSearchParams(location.search).get('scene') || 'dup';
  const mk = (tid, url, title, gid, wid, la, active) => ({
    id: tid, url, title, groupId: gid, windowId: wid, active: !!active,
    lastAccessed: la, index: 0, status: 'complete', audible: false,
    discarded: false, favIconUrl: '' });

  window.__tabs = []; window.__groups = []; window.__nextId = 900;

  if (scene === 'dup') {
    // 窗口 1: 两个同名同色的「codedev」(异常态) + 一个「工作」
    window.__groups = [
      { id: 10, title: 'codedev', color: 'blue',  windowId: 1 },
      { id: 11, title: 'codedev', color: 'blue',  windowId: 1 },
      { id: 20, title: '工作',    color: 'green', windowId: 1 },
      // 窗口 2 的「工作」: 跨窗口同名, 合法, 不许标
      { id: 30, title: '工作',    color: 'green', windowId: 2 },
    ];
    window.__tabs = [
      mk(101, 'https://code.example/a', '代码一', 10, 1, NOW - 1000, true),
      mk(102, 'https://code.example/b', '代码二', 10, 1, NOW - 4000),
      mk(103, 'https://code.example/c', '代码三', 11, 1, NOW - 2000),
      mk(104, 'https://code.example/d', '代码四', 11, 1, NOW - 5000),
      mk(201, 'https://work.example/a', '工作一', 20, 1, NOW - 3000),
      mk(301, 'https://work.example/b', '工作二', 30, 2, NOW - 6000),
    ];
  } else {
    // 只有跨窗口同名: 窗口 1 / 窗口 2 各一个「工作」—— 合法, 不该有任何标记
    window.__groups = [
      { id: 20, title: '工作', color: 'green', windowId: 1 },
      { id: 30, title: '工作', color: 'green', windowId: 2 },
    ];
    window.__tabs = [
      mk(201, 'https://work.example/a', '工作一', 20, 1, NOW - 3000, true),
      mk(301, 'https://work.example/b', '工作二', 30, 2, NOW - 6000),
    ];
  }

  const tabIn = (t, q = {}) =>
    (q.windowId == null || t.windowId === q.windowId) &&
    (q.groupId == null || t.groupId === q.groupId);

  chrome.windows.getCurrent = async () => ({ id: 1, type: 'normal' });
  chrome.windows.getAll = async () => [{ id: 1, type: 'normal', focused: true }];
  chrome.tabs.query = async (q = {}) => window.__tabs.filter(t => tabIn(t, q)).map(t => ({ ...t }));
  chrome.tabGroups.query = async (q = {}) => window.__groups
    .filter(g => (q.title == null || g.title === q.title) &&
                 (q.windowId == null || g.windowId === q.windowId))
    .map(g => ({ ...g }));
  chrome.tabGroups.get = async (gid) => {
    const g = window.__groups.find(x => x.id === gid);
    if (!g) throw new Error('No group with id: ' + gid);
    return { ...g };
  };
  chrome.tabGroups.update = async (gid, patch) => {
    const g = window.__groups.find(x => x.id === gid);
    if (g) Object.assign(g, patch);
  };
  chrome.tabs.group = async ({ tabIds, groupId }) => {
    const gid = groupId || window.__nextId++;
    for (const tid of tabIds) {
      const t = window.__tabs.find(x => x.id === tid);
      if (t) t.groupId = gid;
    }
    return gid;
  };
  chrome.tabs.ungroup = async (ids) => {
    for (const tid of (Array.isArray(ids) ? ids : [ids])) {
      const t = window.__tabs.find(x => x.id === tid);
      if (t) t.groupId = -1;
    }
  };
  chrome.tabs.get = async (tid) => {
    const t = window.__tabs.find(x => x.id === tid);
    if (!t) throw new Error('No tab with id: ' + tid);
    return { ...t };
  };
  chrome.tabs.remove = async (ids) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
  };
  chrome.tabs.create = async (props) => {
    const t = mk(window.__nextId++, props.url, props.url, -1, props.windowId || 1, Date.now() + 1);
    window.__tabs.push(t);
    return { ...t };
  };
  // background 侧契约的桩: merge-dup-groups 按真实实现的口径改假状态
  // (第一组为 keeper, 其余组的标签并入, 空壳消失)
  window.__mergeCalls = [];
  chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'get-snapshot') return null;
    if (msg?.type === 'tidy-groups') return { ok: true };
    if (msg?.type === 'merge-dup-groups') {
      window.__mergeCalls.push(msg);
      const dups = window.__groups.filter(g =>
        g.windowId === msg.windowId && g.title === msg.title);
      if (dups.length < 2) return { ok: true, merged: 0, tabs: 0, removed: 0 };
      const keeper = dups[0];
      let moved = 0;
      for (const g of dups.slice(1)) {
        for (const t of window.__tabs) {
          if (t.groupId === g.id) { t.groupId = keeper.id; moved += 1; }
        }
      }
      const dead = new Set(dups.slice(1).map(g => g.id));
      window.__groups = window.__groups.filter(g => !dead.has(g.id)); // 临时标签法收尸的等价结果
      return { ok: true, merged: dups.length - 1, tabs: moved, removed: dead.size };
    }
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
const openPopup = async (scene) => {
  await p.goto(`chrome-extension://${id}/popup.html?scene=${scene}`);
  await p.waitForSelector('.group-header', { timeout: 10000 });
  await p.waitForTimeout(600); // 首帧 + 1s 内那次快照追帧由 600ms 挡掉(数据不变不重渲染)
};
// 组头按组名分组: { title: [ {hasDup, dupText, dupTitle} ] }
const headerInfo = () => p.evaluate(() =>
  [...document.querySelectorAll('.group-header')].map(h => {
    const badge = h.querySelector('.group-dup');
    return {
      title: (h.querySelector('.group-title')?.textContent || '').trim(),
      windowScoped: h.dataset.dup || '',
      hasDup: !!badge,
      dupText: badge?.textContent || '',
      dupTitle: badge?.getAttribute('title') || '',
    };
  }));
const stateInfo = () => p.evaluate(() => ({
  groups: window.__groups.map(g => ({ id: g.id, title: g.title, windowId: g.windowId })),
  tabs: window.__tabs.map(t => ({ id: t.id, groupId: t.groupId })),
  mergeCalls: window.__mergeCalls || [],
}));
const openMenuOn = async (title) => {
  await p.evaluate((t) => {
    const h = [...document.querySelectorAll('.group-header')]
      .find(x => (x.querySelector('.group-title')?.textContent || '').trim() === t);
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 8,
    }));
  }, title);
  await p.waitForSelector('.ctx-menu', { timeout: 5000 });
  await p.waitForTimeout(150); // 菜单是异步算 scope 的
};
const menuLabels = () => p.evaluate(() =>
  [...document.querySelectorAll('.ctx-menu .ctx-item')].map(el => el.textContent.trim()));
const closeMenu = async () => {
  await p.keyboard.press('Escape');
  await p.waitForTimeout(100);
};

// ── 用例 A: 同窗口两个同名组 → 两个组头都有 dup 标记; 跨窗口同名不标 ──
console.log('\n[A] 同窗口两个「codedev」→ dup 标记');
await openPopup('dup');
const infoA = await headerInfo();
console.log('  组头:', JSON.stringify(infoA));
const codeA = infoA.filter(h => h.title === 'codedev');
const workA = infoA.filter(h => h.title === '工作');
chk('「codedev」渲染成两个组头', codeA.length === 2, JSON.stringify(codeA.map(h => h.title)));
chk('两个「codedev」组头都带 dup 标记', codeA.length === 2 && codeA.every(h => h.hasDup),
  JSON.stringify(codeA.map(h => h.hasDup)));
chk('dup 徽章文案是「重名」', codeA.length === 2 && codeA.every(h => h.dupText === '重名'),
  JSON.stringify(codeA.map(h => h.dupText)));
chk('dup 徽章 title 提示「同窗口存在同名分组, 右键可合并」',
  codeA.length === 2 && codeA.every(h => h.dupTitle === '同窗口存在同名分组, 右键可合并'),
  JSON.stringify(codeA.map(h => h.dupTitle)));
chk('跨窗口同名「工作」两处都不标记', workA.length === 2 && workA.every(h => !h.hasDup),
  JSON.stringify(workA.map(h => ({ t: h.title, dup: h.hasDup }))));
const rowsA = await p.evaluate(() => [...document.querySelectorAll('.tab-item')].length);
chk('六个标签一行不少', rowsA === 6, `rows=${rowsA}`);

// ── 用例 B: 只有跨窗口同名 → 无 dup 标记, 菜单里没有合并项 ──
console.log('\n[B] 只有跨窗口同名「工作」→ 不标记、不给合并入口');
await openPopup('cross');
const infoB = await headerInfo();
console.log('  组头:', JSON.stringify(infoB));
chk('跨窗口同名两个组头都不带 dup 标记',
  infoB.filter(h => h.title === '工作').length === 2 && infoB.every(h => !h.hasDup),
  JSON.stringify(infoB));
await openMenuOn('工作');
const labelsB = await menuLabels();
console.log('  菜单:', JSON.stringify(labelsB));
chk('非重复分组的菜单里没有「合并同名分组」', !labelsB.includes('合并同名分组'),
  JSON.stringify(labelsB));
await closeMenu();

// ── 用例 C: 重复分组右键 → 合并同名分组 → 标签并进第一组、空组消失、标记消失 ──
console.log('\n[C] 右键「codedev」→ 合并同名分组');
await openPopup('dup');
await openMenuOn('codedev');
const labelsC = await menuLabels();
console.log('  菜单:', JSON.stringify(labelsC));
chk('重复分组的菜单里有「合并同名分组」', labelsC.includes('合并同名分组'), JSON.stringify(labelsC));
// 点下去(菜单项自己关菜单并执行动作)
await p.evaluate(() => {
  const el = [...document.querySelectorAll('.ctx-menu .ctx-item')]
    .find(x => x.textContent.trim() === '合并同名分组');
  el.click();
});
await p.waitForTimeout(900); // 消息 + refreshData + 重渲染
const st = await stateInfo();
console.log('  合并后假状态:', JSON.stringify(st));
chk('只发了一次 merge-dup-groups 消息', st.mergeCalls.length === 1,
  JSON.stringify(st.mergeCalls));
chk('消息带窗口与组名',
  st.mergeCalls[0]?.windowId === 1 && st.mergeCalls[0]?.title === 'codedev',
  JSON.stringify(st.mergeCalls[0]));
chk('第二组(11)已消失', !st.groups.some(g => g.id === 11), JSON.stringify(st.groups));
chk('第一组(10)收下了 103/104 两根标签',
  [101, 102, 103, 104].every(tid => st.tabs.find(t => t.id === tid)?.groupId === 10),
  JSON.stringify(st.tabs));
chk('别的窗口的同名组没被波及(组 30 还在)',
  st.groups.some(g => g.id === 30), JSON.stringify(st.groups));
const infoC = await headerInfo();
console.log('  合并后组头:', JSON.stringify(infoC));
chk('合并后「codedev」只剩一个组头', infoC.filter(h => h.title === 'codedev').length === 1,
  JSON.stringify(infoC.map(h => h.title)));
chk('合并后 dup 标记全部消失', infoC.every(h => !h.hasDup), JSON.stringify(infoC));
chk('合并后标签一行不少(4 个 codedev + 2 个 工作)',
  (await p.evaluate(() => [...document.querySelectorAll('.tab-item')].length)) === 6);
const toast = await p.evaluate(() =>
  [...document.querySelectorAll('.push-msg')].map(x => x.textContent.trim()).join(' | '));
chk('有「已合并」回报', /已合并「codedev」/.test(toast), toast);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
