// tgs-ctx-group-live.mjs — 分组头右键菜单在**真实扩展环境**里的收场
// (tgs-dup-groups.mjs 是 stub 版; 这份一个 chrome.* 都不 stub ——
//  真 background.js service worker + 真 chrome.tabs / tabGroups / storage, 纯 headless)
//
// 守的是 docs/adr/0005 + docs/group-uniqueness.md + ADR-0007 落到"组头右键"上的那几条:
//   [1] 菜单结构与**跨窗口隔离**: 关闭全部标签只打中运行时分组实例(窗口 + groupId),
//       不是 groupKey 身份 —— 两个窗口各有一个「工作」时, 关一个不许动另一个;
//       未分组分区只认本窗口, 只给「关闭本窗口未分组标签」, 不给组级动作
//   [2] 编辑分组…: 改名/改色落到真的 chrome.tabGroups; 同窗口撞名**拒绝**(改名不是合并);
//       跨窗口同名合法; 规则组改名连着规则键(默认勾)/脱钩(取消勾选); 收起记忆随身份迁移
//   [3] 解散分组: 标签退回未分组、一个都不关、组被 Chrome 回收; 成员进 manualTabIds 白名单,
//       autoGroupEnabled 开着也不会被自动分组立刻拉回
//   [4] 合并同名分组: 同窗口重名异常态(真的用 chrome.tabs.group 造出来)才给入口,
//       跨窗口同名不给; 合并只收本窗口那几根
//   [5] 归档此分组(组头): 归档卡 title/color/tabs 与运行时实例一致, 标签关闭, 别处不动
//   [6] 搜索态: 按 groupKey 聚合显示(跨窗口同名同色合成一个头), 但右键关闭仍按
//       ADR-0005 只关单个窗口的运行时分组实例
//
// 已知缺陷锁(本探针会红一条): background.js 的 collapseEmptyGroup() 用
// `const [tmp] = await chrome.tabs.create(...)` 解构 —— chrome.tabs.create 的 promise
// 解出来是 Tab 对象(不可迭代), 于是 TypeError 被自己的 catch 吃掉, 而它刚才建的那根
// about:blank 临时标签再没人关 → 每次合并同名分组(以及 tidy 收空壳)都会在窗口里漏一根
// about:blank。4.3 最后一条断言就是锁这个的(标签数守恒)。
//
// 跑法: node probes/tgs-ctx-group-live.mjs   (纯 headless, 不弹桌面窗口)
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const UD = `/tmp/tgs-ctx-group-${Date.now()}`;
const ctx = await chromium.launchPersistentContext(UD, {
  executablePath: EXE, viewport: null,
  args: [`--headless=new`, `--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`,
         '--no-first-run'],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
const POPUP = `chrome-extension://${id}/popup.html`;

let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`);
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const p = ctx.pages()[0] || await ctx.newPage();
p.on('pageerror', e => console.log('  [popup pageerror]', e.message));
await p.goto(POPUP); // 先落到扩展 origin, 后面才能写 localStorage
await wait(600);

// ---------------------------------------------------------------------------
// 真实环境操作: 全走 sw.evaluate(chrome.*) —— 现场由浏览器自己搭, 不是假状态
// ---------------------------------------------------------------------------

// 当前 popup 所在的窗口 id(resetWorld 要留着它, 其余窗口全关)
const popupWinId = () => p.evaluate(async () => (await chrome.windows.getCurrent()).id);

// 清场: 关掉除 popup 窗口外的所有窗口 + 清本地存储(归档/白名单/规则)
async function resetWorld() {
  const keep = await popupWinId();
  const out = await sw.evaluate(async (keep) => {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const closed = [];
    for (const w of wins) {
      if (w.id === keep) continue;
      try { await chrome.windows.remove(w.id); closed.push(w.id); } catch (e) { /* 已没了 */ }
    }
    await chrome.storage.local.set({
      archivedGroups: [], manualTabIds: [], groupRules: {}, hasArchiveUnread: false,
      autoGroupEnabled: false, othersGroupEnabled: false,
    });
    return { keep, closed };
  }, keep);
  // 多余的 playwright 页(不该有, 保险)
  for (const pg of ctx.pages()) if (pg !== p) await pg.close().catch(() => {});
  await wait(400);
  return out;
}

// 用真实 chrome.windows.create / tabs.create / tabs.group / tabGroups.update 搭现场。
// spec = { windows: [{ urls: [...], groups: [{ title, color, from, to }] }], nudge?: true }
// 注意: 种子标签一律 active:true —— 后台标签在无头窗口里可能永远不加载(url 空),
//       那样 popup 首帧拿不到 url/title, 归档卡的 tabs 也对不上。
async function buildWorld(spec) {
  const world = await sw.evaluate(async (spec) => {
    // 先掐掉自动分组, 否则 onCreated 会把散标签立刻收进 Others, 现场就不是我们搭的了
    await chrome.storage.local.set({ autoGroupEnabled: false, othersGroupEnabled: false });
    const out = { windows: [], tabs: [], groups: [], nudgeWinId: null };
    for (const ws of spec.windows) {
      const win = await chrome.windows.create({
        url: ws.urls[0], type: 'normal', width: 900, height: 700, focused: false,
      });
      const first = (await chrome.tabs.query({ windowId: win.id }))[0];
      const ids = [first.id];
      for (const u of ws.urls.slice(1)) {
        const t = await chrome.tabs.create({ url: u, windowId: win.id, active: true });
        ids.push(t.id);
      }
      out.windows.push({ id: win.id, urls: ws.urls, tabIds: ids });
      ids.forEach((tid, i) => out.tabs.push({ id: tid, windowId: win.id, url: ws.urls[i] }));
      for (const g of ws.groups || []) {
        const memberIds = ids.slice(g.from, g.to);
        const gid = await chrome.tabs.group({
          tabIds: memberIds, createProperties: { windowId: win.id },
        });
        await chrome.tabGroups.update(gid, { title: g.title, color: g.color });
        out.groups.push({ id: gid, title: g.title, color: g.color, windowId: win.id, tabIds: memberIds });
      }
    }
    if (spec.nudge) {
      const nw = await chrome.windows.create({
        url: 'https://example.com/?nudge', type: 'normal', width: 500, height: 400, focused: false,
      });
      out.nudgeWinId = nw.id;
    }
    // 等种子标签真的加载完(url 定型), 否则面板首帧会读到空 url
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const tabs = await chrome.tabs.query({});
      const mine = tabs.filter(t => out.tabs.some(s => s.id === t.id));
      if (mine.length === out.tabs.length && mine.every(t => t.url && t.status === 'complete')) break;
      await new Promise(r => setTimeout(r, 120));
    }
    const tabs = await chrome.tabs.query({});
    for (const s of out.tabs) {
      const t = tabs.find(x => x.id === s.id);
      if (t) { s.url = t.url || t.pendingUrl || ''; s.title = t.title || ''; }
    }
    return out;
  }, spec);
  await wait(400);
  return world;
}

// 打开/重开面板。localStorage 先复位(收起记忆 / 视图), 每次都是干净的浏览态
async function openPopup() {
  await p.evaluate(() => {
    localStorage.setItem('tgs-collapsed', '[]');
    localStorage.setItem('tgs-view', 'grouped');
  });
  await p.goto(POPUP);
  await p.waitForSelector('.group-header, .empty', { timeout: 20000 });
  // 越过首帧后的 1s「快照追帧」窗口: 那一趟若重渲染, 会把已打开的菜单/卡片砸掉
  await wait(1700);
}

// 打包一次真实查询(验收的判据一律来自 chrome.* 而不是 DOM)
const realState = () => sw.evaluate(async () => {
  const [tabs, groups, store] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.storage.local.get(['archivedGroups', 'manualTabIds', 'groupRules', 'autoGroupEnabled']),
  ]);
  return {
    tabs: tabs.map(t => ({
      id: t.id, windowId: t.windowId, groupId: t.groupId,
      url: t.url || t.pendingUrl || '', title: t.title || '',
    })),
    groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color, windowId: g.windowId })),
    archived: store.archivedGroups || [],
    manualTabIds: store.manualTabIds || [],
    groupRules: store.groupRules || {},
    autoGroupEnabled: !!store.autoGroupEnabled,
  };
});

// 组头快照: 标题 / 身份键 / 收起态 / dup 徽章 / 本分区下的行(行 id 是定位分区的唯一可靠线索,
// 因为未分组分区的 groupKey 全是 '__ungrouped__', 同名组也可能有两根一模一样的头)
const headerInfo = () => p.evaluate(() => [...document.querySelectorAll('.group-header')].map((h, i) => {
  const rows = [];
  let n = h.nextElementSibling;
  while (n && !n.classList.contains('group-header')) {
    if (n.classList.contains('tab-item')) rows.push(Number(n.dataset.tabId));
    n = n.nextElementSibling;
  }
  const badge = h.querySelector('.group-dup');
  return {
    i,
    title: (h.querySelector('.group-title')?.textContent || '').trim(),
    key: h.dataset.groupKey || '',
    collapsed: h.classList.contains('collapsed'),
    dup: !!badge,
    dupText: badge?.textContent || '',
    dupTitle: badge?.getAttribute('title') || '',
    count: (h.querySelector('.group-count')?.textContent || '').trim(),
    rows,
  };
}));

const rowIds = () => p.evaluate(() => [...document.querySelectorAll('.tab-item')].map(r => Number(r.dataset.tabId)));

// 按标题(可加行 id)定位组头并派发 contextmenu
async function openHeaderMenu({ title, tabIds = [] }) {
  const ok = await p.evaluate(({ title, tabIds }) => {
    const headers = [...document.querySelectorAll('.group-header')];
    const rowsOf = (h) => {
      const rows = [];
      let n = h.nextElementSibling;
      while (n && !n.classList.contains('group-header')) {
        if (n.classList.contains('tab-item')) rows.push(Number(n.dataset.tabId));
        n = n.nextElementSibling;
      }
      return rows;
    };
    const h = headers.find(x => {
      const t = (x.querySelector('.group-title')?.textContent || '').trim();
      if (title != null && t !== title) return false;
      if (!tabIds.length) return true;
      const rows = rowsOf(x);
      return tabIds.some(id => rows.includes(id));
    });
    if (!h) return false;
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(r.left + 24), clientY: Math.round(r.top + r.height / 2),
    }));
    return true;
  }, { title, tabIds });
  if (!ok) return false;
  await p.waitForSelector('.ctx-menu', { timeout: 6000 });
  await wait(280); // 菜单是异步算 scope 的(loadScopeByKey + tabGroups.query)
  return true;
}

const menuLabels = () => p.evaluate(() =>
  [...document.querySelectorAll('.ctx-menu .ctx-item')].map(el => el.textContent.trim()));
const closeMenu = async () => {
  await p.keyboard.press('Escape');
  await wait(150);
  // Esc 被 main 的全局路由抢走时菜单可能还在: 兜底点空白
  const still = await p.evaluate(() => !!document.querySelector('.ctx-menu'));
  if (still) { await p.mouse.click(5, 5); await wait(150); }
};
async function clickMenu(label) {
  const ok = await p.evaluate((label) => {
    const el = [...document.querySelectorAll('.ctx-menu .ctx-item')]
      .find(x => x.textContent.trim() === label);
    if (!el) return false;
    el.click();
    return true;
  }, label);
  return ok;
}

// 编辑卡快照
const cardInfo = () => p.evaluate(() => {
  const l = document.querySelector('.ge-layer');
  if (!l) return null;
  return {
    heading: (l.querySelector('.ge-head')?.textContent || '').trim(),
    name: l.querySelector('.ge-input')?.value ?? null,
    color: l.querySelector('.ge-swatch.active')?.dataset.color || '',
    hasRuleCheck: !!l.querySelector('.ge-rule-check'),
    ruleChecked: !!l.querySelector('.ge-rule-check')?.checked,
    error: (l.querySelector('.ge-error')?.textContent || '').trim(),
    hasRuleTip: !!l.querySelector('.ge-ruletip'),
  };
});

// 填卡并提交
async function submitCard({ name, color, uncheckRule = false, settle = 1200 }) {
  if (name != null) await p.fill('.ge-input', name);
  if (color) await p.click(`.ge-layer .ge-swatch[data-color="${color}"]`);
  if (uncheckRule) await p.uncheck('.ge-layer .ge-rule-check');
  await p.click('.ge-layer .ge-ok');
  await wait(settle);
}

const toastText = () => p.evaluate(() =>
  [...document.querySelectorAll('.push-msg')].map(x => x.textContent.trim()).join(' | '));
const undoBanner = () => p.evaluate(() => {
  const b = document.querySelector('.undo-banner');
  return b ? (b.textContent || '').trim() : '';
});

// 点组头(收起/展开): 用真实鼠标坐标点标题区, 不走 el.click() —— 组头的 click 语义就是左键
async function clickHeader({ title, tabIds = [] }) {
  const box = await p.evaluate(({ title, tabIds }) => {
    const rowsOf = (h) => {
      const rows = [];
      let n = h.nextElementSibling;
      while (n && !n.classList.contains('group-header')) {
        if (n.classList.contains('tab-item')) rows.push(Number(n.dataset.tabId));
        n = n.nextElementSibling;
      }
      return rows;
    };
    const h = [...document.querySelectorAll('.group-header')].find(x => {
      const t = (x.querySelector('.group-title')?.textContent || '').trim();
      if (title != null && t !== title) return false;
      if (!tabIds.length) return true;
      return tabIds.some(id => rowsOf(x).includes(id));
    });
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
  }, { title, tabIds });
  if (!box) return false;
  await p.mouse.click(box.x, box.y);
  await wait(800); // 收起带动画 + 收尾 render
  return true;
}

// 造完现场后 popup 需要重渲染: 靠 tabs.onUpdated(groupId) 的 400ms 防抖刷新。
// 万一没触发(时序问题), 用一根"摇杆"标签反复脱组/归组把事件顶出去 —— 不动被测现场的计数。
async function nudge(nudgeWinId) {
  if (!nudgeWinId) return;
  await sw.evaluate(async (nid) => {
    const [t] = await chrome.tabs.query({ windowId: nid });
    if (!t) return;
    if (t.groupId > 0) await chrome.tabs.ungroup([t.id]);
    else await chrome.tabs.group({ tabIds: [t.id], createProperties: { windowId: nid } });
  }, nudgeWinId);
}
async function untilOk(fn, { timeout = 9000, nudgeWinId = null } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await nudge(nudgeWinId);
    await wait(700);
  }
  return last;
}

const groupOf = (st, gid) => st.groups.find(g => g.id === gid) || null;
const memberIds = (st, gid) => st.tabs.filter(t => t.groupId === gid).map(t => t.id).sort((a, b) => a - b);
const aliveIds = (st, ids) => ids.filter(id => st.tabs.some(t => t.id === id)).sort((a, b) => a - b);
const eqArr = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// ===========================================================================
// [Case 1] 菜单结构 + 跨窗口未分组 / 同名组批量关闭隔离
// ===========================================================================
console.log('\n[Case 1] 组头菜单结构 + 跨窗口批量关闭隔离');
{
  await resetWorld();
  const w = await buildWorld({ windows: [
    { urls: ['https://example.com/?c1a', 'https://example.com/?c1b', 'https://example.com/?c1c', 'https://example.com/?c1d'],
      groups: [{ title: '工作', color: 'blue', from: 0, to: 2 }] },
    { urls: ['https://example.com/?c1e', 'https://example.com/?c1f', 'https://example.com/?c1g'],
      groups: [{ title: '工作', color: 'green', from: 0, to: 2 }] },
  ] });
  const [W1, W2] = w.windows;
  const g1 = w.groups.find(g => g.windowId === W1.id);
  const g2 = w.groups.find(g => g.windowId === W2.id);
  const w1Ungrouped = [W1.tabIds[2], W1.tabIds[3]];
  const w2Ungrouped = [W2.tabIds[2]];
  await openPopup();

  // ── 1.1 普通命名分组头: 四项本事, 没有「合并同名分组」(本窗口不重名) ──
  let infos = await headerInfo();
  console.log('  组头:', JSON.stringify(infos.map(h => ({ t: h.title, dup: h.dup, n: h.rows.length }))));
  let opened = await openHeaderMenu({ title: '工作', tabIds: g1.tabIds });
  chk('1.1 能右键到窗口1的「工作」组头', opened);
  const labels1 = opened ? await menuLabels() : [];
  console.log('  菜单:', JSON.stringify(labels1));
  chk('1.1 菜单含「关闭「工作」全部标签 (2)」', labels1[0] === '关闭「工作」全部标签 (2)', JSON.stringify(labels1[0]));
  chk('1.1 菜单含「编辑分组…」', labels1.includes('编辑分组…'), JSON.stringify(labels1));
  chk('1.1 菜单含「解散分组」', labels1.includes('解散分组'), JSON.stringify(labels1));
  chk('1.1 菜单含「归档此分组」', labels1.includes('归档此分组'), JSON.stringify(labels1));
  chk('1.1 菜单不含「合并同名分组」(本窗口无重名)', !labels1.includes('合并同名分组'), JSON.stringify(labels1));
  await closeMenu();

  // ── 1.2 未分组分区头: 只有「关闭本窗口未分组标签」, 组级动作一个都不给 ──
  opened = await openHeaderMenu({ title: '未分组', tabIds: w1Ungrouped });
  chk('1.2 能右键到窗口1的「未分组」分区头', opened);
  const labels2 = opened ? await menuLabels() : [];
  console.log('  未分组菜单:', JSON.stringify(labels2));
  chk('1.2 未分组菜单只有「关闭本窗口未分组标签 (2)」',
    labels2.length === 1 && labels2[0] === '关闭本窗口未分组标签 (2)', JSON.stringify(labels2));
  chk('1.2 未分组菜单不含编辑/解散/归档/合并',
    !labels2.some(l => /编辑分组|解散分组|归档|合并同名/.test(l)), JSON.stringify(labels2));
  await closeMenu();

  // ── 1.3 双窗口未分组隔离: 关窗口2 → 只关窗口2 ──
  const before13 = await realState();
  opened = await openHeaderMenu({ title: '未分组', tabIds: w2Ungrouped });
  const labels3 = opened ? await menuLabels() : [];
  chk('1.3 右键窗口2的「未分组」组头拿到 (1)', labels3[0] === '关闭本窗口未分组标签 (1)', JSON.stringify(labels3));
  await clickMenu(labels3[0] || '');
  await wait(1400);
  let st = await realState();
  chk('1.3 窗口2的未分组标签已关闭',
    aliveIds(st, w2Ungrouped).length === 0, JSON.stringify(aliveIds(st, w2Ungrouped)));
  chk('1.3 窗口1的未分组标签全部存活(跨窗口没被误关)',
    eqArr(aliveIds(st, w1Ungrouped), w1Ungrouped),
    `alive=${JSON.stringify(aliveIds(st, w1Ungrouped))} want=${JSON.stringify(w1Ungrouped)}`);
  chk('1.3 两个「工作」分组一根标签都没少',
    eqArr(aliveIds(st, g1.tabIds), g1.tabIds) && eqArr(aliveIds(st, g2.tabIds), g2.tabIds),
    JSON.stringify({ w1: aliveIds(st, g1.tabIds), w2: aliveIds(st, g2.tabIds) }));
  chk('1.3 其它标签一个没关(总存活数 = 关前 - 1)',
    st.tabs.length === before13.tabs.length - 1,
    `before=${before13.tabs.length} after=${st.tabs.length}`);
  const bar1 = await undoBanner();
  chk('1.3 弹出撤销条(带「撤销全部」)', /已关闭/.test(bar1) && /撤销全部/.test(bar1),
    JSON.stringify(bar1.slice(0, 80)));

  // ── 1.4 双窗口同名组隔离: 关窗口2的「工作」→ 窗口1 完全不动 ──
  const before14 = await realState();
  opened = await openHeaderMenu({ title: '工作', tabIds: g2.tabIds });
  const labels4 = opened ? await menuLabels() : [];
  chk('1.4 右键窗口2的「工作」组头拿到 (2)',
    labels4[0] === '关闭「工作」全部标签 (2)', JSON.stringify(labels4));
  await clickMenu(labels4[0] || '');
  await wait(1500);
  st = await realState();
  chk('1.4 窗口2的「工作」标签已关闭', aliveIds(st, g2.tabIds).length === 0,
    JSON.stringify(aliveIds(st, g2.tabIds)));
  chk('1.4 窗口2的「工作」分组已被 Chrome 回收', !groupOf(st, g2.id),
    JSON.stringify(st.groups));
  chk('1.4 窗口1的「工作」分组还在(同名跨窗口不被连带)',
    !!groupOf(st, g1.id) && groupOf(st, g1.id).title === '工作',
    JSON.stringify(st.groups));
  chk('1.4 窗口1的「工作」标签一根没少',
    eqArr(aliveIds(st, g1.tabIds), g1.tabIds), JSON.stringify(aliveIds(st, g1.tabIds)));
  chk('1.4 关前关后只少了窗口2那两根',
    st.tabs.length === before14.tabs.length - 2,
    `before=${before14.tabs.length} after=${st.tabs.length}`);
  infos = await headerInfo();
  chk('1.4 列表里「工作」只剩窗口1那一根', infos.filter(h => h.title === '工作').length === 1,
    JSON.stringify(infos.map(h => h.title)));
}

// ===========================================================================
// [Case 2] 编辑分组… 改名 / 改色 / 撞车拒绝 / 跨窗口同名 / 规则联动 / 收起迁移
// ===========================================================================
console.log('\n[Case 2] 「编辑分组…」改名改色 + 撞车拒绝 + 规则联动 + 收起迁移');

// ── 2.1 正常改名 + 改色, 顺手把 2.6(收起记忆迁移)也在这套现场里验 ──
{
  await resetWorld();
  const w = await buildWorld({ windows: [
    { urls: ['https://example.com/?c21a', 'https://example.com/?c21b', 'https://example.com/?c21c', 'https://example.com/?c21d'],
      groups: [
        { title: '工程', color: 'blue', from: 0, to: 2 },
        { title: '设计', color: 'green', from: 2, to: 4 },
      ] },
  ] });
  const W1 = w.windows[0];
  const eng = w.groups.find(g => g.title === '工程');
  const des = w.groups.find(g => g.title === '设计');
  await openPopup();

  let st0 = await realState();
  let opened = await openHeaderMenu({ title: '工程', tabIds: eng.tabIds });
  chk('2.1 右键「工程」→ 菜单有「编辑分组…」', opened && (await menuLabels()).includes('编辑分组…'));
  await clickMenu('编辑分组…');
  await p.waitForSelector('.ge-layer', { timeout: 5000 });
  await wait(250);
  let card = await cardInfo();
  console.log('  卡片:', JSON.stringify(card));
  chk('2.1 卡片标题「编辑分组」且预填当前组名', card?.heading === '编辑分组' && card?.name === '工程',
    JSON.stringify(card));
  chk('2.1 卡片预选当前颜色 blue', card?.color === 'blue', JSON.stringify(card?.color));
  chk('2.1 非规则组不挂「同时重命名域名规则」', card?.hasRuleCheck === false, JSON.stringify(card));
  await submitCard({ name: '工程改', color: 'red' });
  const toast21 = await toastText();
  console.log('  toast:', JSON.stringify(toast21));
  chk('2.1 卡片已关闭', (await cardInfo()) === null);
  chk('2.1 toast 报「已重命名为「工程改」」', /已重命名为「工程改」/.test(toast21), JSON.stringify(toast21));
  let st = await realState();
  chk('2.1 真实分组 title 已更新', groupOf(st, eng.id)?.title === '工程改', JSON.stringify(groupOf(st, eng.id)));
  chk('2.1 真实分组 color 已更新', groupOf(st, eng.id)?.color === 'red', JSON.stringify(groupOf(st, eng.id)));
  chk('2.1 组内成员完全不变(同一 groupId, 同样两根标签)',
    eqArr(memberIds(st, eng.id), eng.tabIds) && memberIds(st, eng.id).length === 2,
    JSON.stringify(memberIds(st, eng.id)));
  chk('2.1 另一个分组没被波及',
    groupOf(st, des.id)?.title === '设计' && eqArr(memberIds(st, des.id), des.tabIds),
    JSON.stringify(st.groups));
  let infos = await headerInfo();
  chk('2.1 列表里出现「工程改」组头', infos.some(h => h.title === '工程改'), JSON.stringify(infos.map(h => h.title)));

  // ── 2.6 收起记忆迁移: 先收起, 再右键这根收起头改名/改色, 重渲染后仍收起 ──
  const clicked = await clickHeader({ title: '设计', tabIds: des.tabIds });
  chk('2.6 点组头后「设计」进入收起态', clicked && (await headerInfo()).some(h => h.title === '设计' && h.collapsed),
    JSON.stringify((await headerInfo()).map(h => ({ t: h.title, c: h.collapsed }))));
  const collapsedStore = await p.evaluate(() => JSON.parse(localStorage.getItem('tgs-collapsed') || '[]'));
  chk('2.6 收起键「设计|green」已落 localStorage', collapsedStore.includes('设计|green'),
    JSON.stringify(collapsedStore));
  opened = await openHeaderMenu({ title: '设计' });
  chk('2.6 收起态组头照样能右键开菜单', opened && (await menuLabels()).includes('编辑分组…'));
  await clickMenu('编辑分组…');
  await p.waitForSelector('.ge-layer', { timeout: 5000 });
  await wait(250);
  await submitCard({ name: '设计改', color: 'red' });
  infos = await headerInfo();
  console.log('  改完后的组头:', JSON.stringify(infos.map(h => ({ t: h.title, c: h.collapsed, k: h.key }))));
  const renamed = infos.find(h => h.title === '设计改');
  chk('2.6 改色改名后组头仍在收起态(没有莫名自动展开)', renamed?.collapsed === true,
    JSON.stringify(infos.map(h => ({ t: h.title, c: h.collapsed }))));
  const store2 = await p.evaluate(() => JSON.parse(localStorage.getItem('tgs-collapsed') || '[]'));
  chk('2.6 收起键已搬到新身份「设计改|red」',
    store2.includes('设计改|red') && !store2.includes('设计|green'), JSON.stringify(store2));
  st = await realState();
  chk('2.6 真实分组 title/color 同步更新',
    groupOf(st, des.id)?.title === '设计改' && groupOf(st, des.id)?.color === 'red',
    JSON.stringify(groupOf(st, des.id)));
  chk('2.6 收起时被隐藏的行没有丢(标签仍在真实分组里)',
    eqArr(memberIds(st, des.id), des.tabIds), JSON.stringify(memberIds(st, des.id)));
}

// ── 2.2 同窗口同名撞车: 拒绝, 绝不静默并组 ──
{
  await resetWorld();
  const w = await buildWorld({ windows: [
    { urls: ['https://example.com/?c22a', 'https://example.com/?c22b', 'https://example.com/?c22c', 'https://example.com/?c22d'],
      groups: [
        { title: 'A组', color: 'blue', from: 0, to: 2 },
        { title: 'B组', color: 'yellow', from: 2, to: 4 },
      ] },
  ] });
  const A = w.groups.find(g => g.title === 'A组');
  const B = w.groups.find(g => g.title === 'B组');
  await openPopup();
  const before = await realState();

  await openHeaderMenu({ title: 'B组', tabIds: B.tabIds });
  await clickMenu('编辑分组…');
  await p.waitForSelector('.ge-layer', { timeout: 5000 });
  await wait(250);
  await submitCard({ name: 'A组', color: 'yellow' });
  const card = await cardInfo();
  console.log('  撞车后卡片:', JSON.stringify(card));
  chk('2.2 撞名后卡片不关闭', card !== null);
  chk('2.2 .ge-error 报「本窗口已有同名分组「A组」」',
    /本窗口已有同名分组「A组」/.test(card?.error || ''), JSON.stringify(card?.error));
  const after = await realState();
  chk('2.2 组 A 仍是 2 根标签', eqArr(memberIds(after, A.id), A.tabIds) && memberIds(after, A.id).length === 2,
    JSON.stringify(memberIds(after, A.id)));
  chk('2.2 组 B 仍是 2 根标签(没有被并进 A)', eqArr(memberIds(after, B.id), B.tabIds) && memberIds(after, B.id).length === 2,
    JSON.stringify(memberIds(after, B.id)));
  chk('2.2 两个分组都还在, 名字没变',
    groupOf(after, A.id)?.title === 'A组' && groupOf(after, B.id)?.title === 'B组',
    JSON.stringify(after.groups));
  chk('2.2 没有多出/少掉任何标签', after.tabs.length === before.tabs.length,
    `before=${before.tabs.length} after=${after.tabs.length}`);
  await p.keyboard.press('Escape');
  await wait(250);
  chk('2.2 Esc 能关掉报错卡片', (await cardInfo()) === null);
}

// ── 2.3 跨窗口同名: 合法, 允许, 且绝不跨窗口合并 ──
{
  await resetWorld();
  const w = await buildWorld({ windows: [
    { urls: ['https://example.com/?c23a', 'https://example.com/?c23b'],
      groups: [{ title: '工作', color: 'blue', from: 0, to: 2 }] },
    { urls: ['https://example.com/?c23c', 'https://example.com/?c23d'],
      groups: [{ title: '其它', color: 'purple', from: 0, to: 2 }] },
  ] });
  const G1 = w.groups.find(g => g.title === '工作');
  const G2 = w.groups.find(g => g.title === '其它');
  await openPopup();

  await openHeaderMenu({ title: '其它', tabIds: G2.tabIds });
  await clickMenu('编辑分组…');
  await p.waitForSelector('.ge-layer', { timeout: 5000 });
  await wait(250);
  await submitCard({ name: '工作', color: 'blue' });
  const card = await cardInfo();
  const toast = await toastText();
  chk('2.3 跨窗口同名不被拒绝(卡片已关闭)', card === null, JSON.stringify(card));
  chk('2.3 没有报错提示', !card || !card.error, JSON.stringify(card?.error));
  chk('2.3 toast 报重命名成功', /已重命名为「工作」/.test(toast), JSON.stringify(toast));
  const st = await realState();
  chk('2.3 窗口2的组真的改成了「工作」', groupOf(st, G2.id)?.title === '工作', JSON.stringify(groupOf(st, G2.id)));
  chk('2.3 没有跨窗口并组: 两个「工作」仍是两个不同 groupId 的两个窗口',
    groupOf(st, G1.id) && groupOf(st, G2.id) && G1.id !== G2.id &&
    groupOf(st, G1.id).windowId !== groupOf(st, G2.id).windowId,
    JSON.stringify(st.groups));
  chk('2.3 各自标签归属不变',
    eqArr(memberIds(st, G1.id), G1.tabIds) && eqArr(memberIds(st, G2.id), G2.tabIds),
    JSON.stringify({ a: memberIds(st, G1.id), b: memberIds(st, G2.id) }));
  const infos = await headerInfo();
  chk('2.3 列表里两根「工作」组头都没挂重名徽章(跨窗口同名合法)',
    infos.filter(h => h.title === '工作').length === 2 && infos.every(h => !h.dup),
    JSON.stringify(infos.map(h => ({ t: h.title, dup: h.dup }))));
}

// ── 2.4 / 2.5 规则组改名: 默认联动规则键; 取消勾选即脱钩 ──
{
  await resetWorld();
  await sw.evaluate(async () => {
    // 规则域名一律用不会命中的 .invalid(现场别被自动归组搅了)
    await chrome.storage.local.set({ groupRules: { 规则甲: ['rule-a.invalid'], 规则丙: ['rule-c.invalid'] } });
  });
  await wait(500);
  const w = await buildWorld({ windows: [
    { urls: ['https://example.com/?c24a', 'https://example.com/?c24b', 'https://example.com/?c24c', 'https://example.com/?c24d'],
      groups: [
        { title: '规则甲', color: 'blue', from: 0, to: 2 },
        { title: '规则丙', color: 'cyan', from: 2, to: 4 },
      ] },
  ] });
  const RA = w.groups.find(g => g.title === '规则甲');
  const RC = w.groups.find(g => g.title === '规则丙');
  await openPopup();

  // 2.4 默认勾选 → 规则键跟着改名
  await openHeaderMenu({ title: '规则甲', tabIds: RA.tabIds });
  await clickMenu('编辑分组…');
  await p.waitForSelector('.ge-layer', { timeout: 5000 });
  await wait(250);
  let card = await cardInfo();
  console.log('  规则组卡片:', JSON.stringify(card));
  chk('2.4 规则组卡片挂出「同时重命名域名规则」', card?.hasRuleCheck === true, JSON.stringify(card));
  chk('2.4 勾选框默认勾上', card?.ruleChecked === true, JSON.stringify(card));
  chk('2.4 有规则脱钩说明(.ge-ruletip)', card?.hasRuleTip === true, JSON.stringify(card));
  await submitCard({ name: '规则乙', color: 'blue' });
  const toast24 = await toastText();
  console.log('  toast:', JSON.stringify(toast24));
  chk('2.4 toast 报「已重命名为「规则乙」并同步规则名」',
    /已重命名为「规则乙」并同步规则名/.test(toast24), JSON.stringify(toast24));
  let st = await realState();
  console.log('  groupRules:', JSON.stringify(st.groupRules));
  chk('2.4 groupRules 的键改成了「规则乙」', Object.keys(st.groupRules).includes('规则乙'),
    JSON.stringify(Object.keys(st.groupRules)));
  chk('2.4 groupRules 里「规则甲」已消失', !Object.keys(st.groupRules).includes('规则甲'),
    JSON.stringify(Object.keys(st.groupRules)));
  chk('2.4 规则键的域名原样搬过去', eqArr(st.groupRules['规则乙'] || [], ['rule-a.invalid']),
    JSON.stringify(st.groupRules['规则乙']));
  chk('2.4 真实分组改名成功', groupOf(st, RA.id)?.title === '规则乙', JSON.stringify(groupOf(st, RA.id)));
  chk('2.4 没有产生重复分组(本窗口没有「规则甲」壳)',
    !st.groups.some(g => g.title === '规则甲'), JSON.stringify(st.groups.map(g => g.title)));
  chk('2.4 成员没被搬走', eqArr(memberIds(st, RA.id), RA.tabIds), JSON.stringify(memberIds(st, RA.id)));

  // 2.5 取消勾选 → 规则保持原样, 分组名脱钩
  await openHeaderMenu({ title: '规则丙', tabIds: RC.tabIds });
  await clickMenu('编辑分组…');
  await p.waitForSelector('.ge-layer', { timeout: 5000 });
  await wait(250);
  card = await cardInfo();
  chk('2.5 「规则丙」也被认成规则组', card?.hasRuleCheck === true && card?.ruleChecked === true,
    JSON.stringify(card));
  await p.uncheck('.ge-layer .ge-rule-check');
  await wait(200);
  card = await cardInfo();
  chk('2.5 取消勾选后卡片里 ruleCheck = false(改名前真的脱钩了)',
    card?.ruleChecked === false, JSON.stringify(card));
  await submitCard({ name: '独立组', color: 'cyan', settle: 1400 });
  const toast25 = await toastText();
  console.log('  toast:', JSON.stringify(toast25));
  chk('2.5 脱钩改名 toast 不带「同步规则名」', /已重命名为「独立组」/.test(toast25) && !/同步规则名/.test(toast25),
    JSON.stringify(toast25));
  st = await realState();
  console.log('  groupRules:', JSON.stringify(st.groupRules));
  chk('2.5 storage 里「规则丙」仍在', Object.keys(st.groupRules).includes('规则丙'),
    JSON.stringify(Object.keys(st.groupRules)));
  chk('2.5 storage 里没有「独立组」键(真的脱钩了)',
    !Object.keys(st.groupRules).includes('独立组'), JSON.stringify(Object.keys(st.groupRules)));
  chk('2.5 Chrome 分组名已变成「独立组」', groupOf(st, RC.id)?.title === '独立组',
    JSON.stringify(groupOf(st, RC.id)));
  chk('2.5 成员没被搬走', eqArr(memberIds(st, RC.id), RC.tabIds), JSON.stringify(memberIds(st, RC.id)));
  chk('2.5 规则键的域名没被写坏', eqArr(st.groupRules['规则丙'] || [], ['rule-c.invalid']),
    JSON.stringify(st.groupRules['规则丙']));
}

// ===========================================================================
// [Case 3] 解散分组
// ===========================================================================
console.log('\n[Case 3] 「解散分组」');
{
  await resetWorld();
  const w = await buildWorld({ windows: [
    { urls: ['https://example.com/?c31a', 'https://example.com/?c31b', 'https://example.com/?c31c',
             'https://example.com/?c31d', 'https://example.com/?c31e'],
      groups: [
        { title: '解散组', color: 'pink', from: 0, to: 3 },
        { title: '旁组', color: 'grey', from: 3, to: 5 },
      ] },
    { urls: ['https://example.com/?c31f'],
      groups: [{ title: '他窗组', color: 'orange', from: 0, to: 1 }] },
  ] });
  const D = w.groups.find(g => g.title === '解散组');
  const side = w.groups.find(g => g.title === '旁组');
  const other = w.groups.find(g => g.title === '他窗组');
  await openPopup();
  const before = await realState();

  await openHeaderMenu({ title: '解散组', tabIds: D.tabIds });
  const labels = await menuLabels();
  chk('3.1 菜单有「解散分组」', labels.includes('解散分组'), JSON.stringify(labels));
  await clickMenu('解散分组');
  await wait(1300);
  const toast = await toastText();
  console.log('  toast:', JSON.stringify(toast));
  chk('3.1 toast 报解散数量「(3 个标签退回未分组)」', /已解散「解散组」\(3 个标签退回未分组\)/.test(toast),
    JSON.stringify(toast));
  const st = await realState();
  console.log('  解散后:', JSON.stringify({ groups: st.groups, tabs: st.tabs.map(t => [t.id, t.groupId]) }));
  chk('3.1 组内 3 根标签真实 groupId 全变成 -1',
    D.tabIds.every(id => st.tabs.find(t => t.id === id)?.groupId === -1),
    JSON.stringify(D.tabIds.map(id => st.tabs.find(t => t.id === id)?.groupId)));
  chk('3.1 0 根标签被关闭', eqArr(aliveIds(st, D.tabIds), D.tabIds),
    JSON.stringify(aliveIds(st, D.tabIds)));
  chk('3.1 原分组被 Chrome 回收(tabGroups.query 查不到)',
    !groupOf(st, D.id) && !st.groups.some(g => g.title === '解散组'),
    JSON.stringify(st.groups.map(g => g.title)));
  chk('3.1 其它分组不受影响',
    groupOf(st, side.id)?.title === '旁组' && eqArr(memberIds(st, side.id), side.tabIds) &&
    groupOf(st, other.id)?.title === '他窗组' && eqArr(memberIds(st, other.id), other.tabIds),
    JSON.stringify(st.groups.map(g => g.title)));
  chk('3.1 存活标签总数没变', st.tabs.length === before.tabs.length,
    `before=${before.tabs.length} after=${st.tabs.length}`);
  chk('3.1 列表里「解散组」组头消失, 3 行退回「未分组」',
    !(await headerInfo()).some(h => h.title === '解散组') &&
    (await rowIds()).filter(id => D.tabIds.includes(id)).length === 3,
    JSON.stringify((await headerInfo()).map(h => h.title)));
}

// ── 3.2 规则组解散后: 成员进 manualTabIds 白名单, autoGroupEnabled 开着也不被立刻拉回 ──
{
  await resetWorld();
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ groupRules: { 规则丙: ['rule-c.invalid'] } });
  });
  await wait(400);
  const w = await buildWorld({ windows: [
    { urls: ['https://rule-c.invalid/?c32a', 'https://rule-c.invalid/?c32b'],
      groups: [{ title: '规则丙', color: 'cyan', from: 0, to: 2 }] },
  ] });
  const RG = w.groups.find(g => g.title === '规则丙');
  await openPopup();
  // 打开自动分组总开关(现场必须真的"开着", 否则这条测不到东西)
  await sw.evaluate(async () => { await chrome.storage.local.set({ autoGroupEnabled: true }); });
  await wait(400);
  console.log('  autoGroupEnabled =', (await realState()).autoGroupEnabled);

  await openHeaderMenu({ title: '规则丙', tabIds: RG.tabIds });
  await clickMenu('解散分组');
  await wait(1600); // 观察窗: 自动分组若不受保护, 这里就该把标签拉回同名组
  let st = await realState();
  console.log('  解散 1.6s 后:', JSON.stringify(st.tabs.map(t => [t.id, t.groupId])));
  chk('3.2 规则组成员退回未分组', RG.tabIds.every(id => st.tabs.find(t => t.id === id)?.groupId === -1),
    JSON.stringify(RG.tabIds.map(id => st.tabs.find(t => t.id === id)?.groupId)));
  chk('3.2 1.6s 内没有被自动分组拉回原组(没重建「规则丙」)',
    !st.groups.some(g => g.title === '规则丙'), JSON.stringify(st.groups.map(g => g.title)));
  chk('3.2 成员进了 manualTabIds 白名单',
    RG.tabIds.every(id => st.manualTabIds.includes(id)),
    JSON.stringify({ want: RG.tabIds, got: st.manualTabIds }));
  // 再补一刀: 真触发一次自动分组(改 url → tabs.onUpdated → autoGroupTab), 白名单必须挡住
  await sw.evaluate(async (ids) => {
    for (const tid of ids) await chrome.tabs.update(tid, { url: 'https://rule-c.invalid/?re' + tid });
  }, RG.tabIds);
  await wait(1600);
  st = await realState();
  chk('3.2 触发自动分组(url 变化)后仍未被拉回', RG.tabIds.every(id => st.tabs.find(t => t.id === id)?.groupId === -1)
    && !st.groups.some(g => g.title === '规则丙'),
  JSON.stringify({ tabs: st.tabs.filter(t => RG.tabIds.includes(t.id)).map(t => [t.id, t.groupId]), groups: st.groups.map(g => g.title) }));
  chk('3.2 标签一个都没被关', eqArr(aliveIds(st, RG.tabIds), RG.tabIds), JSON.stringify(aliveIds(st, RG.tabIds)));
}

// ===========================================================================
// [Case 4] 「合并同名分组」—— 真·同窗口重名异常态
// ===========================================================================
console.log('\n[Case 4] 「合并同名分组」');
{
  await resetWorld();
  // 先把空面板打开: tidy 在空现场上跑完, 之后再造重名组, 才不会被唤起整理静默合并掉
  await openPopup();
  const w = await buildWorld({ nudge: true, windows: [
    { urls: ['https://example.com/?c4a1', 'https://example.com/?c4a2', 'https://example.com/?c4a3', 'https://example.com/?c4a4'],
      groups: [
        { title: '重名组', color: 'blue', from: 0, to: 2 },
        { title: '重名组', color: 'blue', from: 2, to: 4 },
      ] },
    { urls: ['https://example.com/?c4b1'],
      groups: [{ title: '重名组', color: 'blue', from: 0, to: 1 }] },
  ] });
  const WA = w.windows[0], WB = w.windows[1];
  const dupGroups = w.groups.filter(g => g.windowId === WA.id);
  const cross = w.groups.find(g => g.windowId === WB.id);
  const allA = [...dupGroups[0].tabIds, ...dupGroups[1].tabIds].sort((a, b) => a - b);

  // 现场由 tabs.onUpdated(groupId) 的 400ms 防抖刷新带进面板; 没进来就用摇杆顶
  const infos4 = await untilOk(async () => {
    const infos = await headerInfo();
    const marked = infos.filter(h => h.title === '重名组' && h.dup);
    return marked.length === 2 ? infos : null;
  }, { nudgeWinId: w.nudgeWinId, timeout: 12000 });
  const infos = infos4 || await headerInfo();
  console.log('  组头:', JSON.stringify(infos.map(h => ({ t: h.title, dup: h.dup, rows: h.rows.length }))));
  const marked = infos.filter(h => h.title === '重名组' && h.dup);
  const clean = infos.filter(h => h.title === '重名组' && !h.dup);

  chk('4.2 同窗口两个「重名组」组头都挂 .group-dup「重名」',
    marked.length === 2 && marked.every(h => h.dupText === '重名'),
    JSON.stringify(marked.map(h => ({ dup: h.dup, text: h.dupText }))));
  chk('4.2 徽章 title 提示「同窗口存在同名分组, 右键可合并」',
    marked.length === 2 && marked.every(h => h.dupTitle === '同窗口存在同名分组, 右键可合并'),
    JSON.stringify(marked.map(h => h.dupTitle)));
  chk('4.2 跨窗口那根「重名组」不带徽章', clean.length === 1, JSON.stringify(clean));

  // 跨窗口那根的菜单里不该有「合并同名分组」
  let opened = await openHeaderMenu({ title: '重名组', tabIds: cross.tabIds });
  let labels = opened ? await menuLabels() : [];
  console.log('  跨窗口重名组菜单:', JSON.stringify(labels));
  chk('4.2 跨窗口「重名组」的右键菜单没有「合并同名分组」',
    opened && !labels.includes('合并同名分组'), JSON.stringify(labels));
  await closeMenu();

  // 同窗重名组 → 有合并项
  opened = await openHeaderMenu({ title: '重名组', tabIds: dupGroups[0].tabIds });
  labels = opened ? await menuLabels() : [];
  console.log('  同窗重名组菜单:', JSON.stringify(labels));
  chk('4.3 同窗重名组菜单出现「合并同名分组」', opened && labels.includes('合并同名分组'),
    JSON.stringify(labels));
  // 合并前后窗口内的真实标签快照: 合并只该搬标签, 不该多出任何东西
  const waBefore = (await realState()).tabs.filter(t => t.windowId === WA.id);
  await clickMenu('合并同名分组');
  await wait(2200);
  const toast = await toastText();
  console.log('  toast:', JSON.stringify(toast));
  const st = await realState();
  console.log('  合并后:', JSON.stringify({ groups: st.groups, a: st.tabs.filter(t => allA.includes(t.id)).map(t => [t.id, t.groupId]) }));
  const liveA = st.tabs.filter(t => allA.includes(t.id));
  const gidsA = [...new Set(liveA.map(t => t.groupId))];
  chk('4.3 该窗口 4 根标签全部收进同一个组', liveA.length === 4 && gidsA.length === 1 && gidsA[0] > 0,
    JSON.stringify(liveA.map(t => [t.id, t.groupId])));
  chk('4.3 重复组已消失(该窗口只剩一个「重名组」)',
    st.groups.filter(g => g.windowId === WA.id && g.title === '重名组').length === 1,
    JSON.stringify(st.groups.filter(g => g.windowId === WA.id).map(g => ({ id: g.id, t: g.title }))));
  chk('4.3 重复组已被 Chrome 回收(旧 groupId 查不到)',
    !groupOf(st, dupGroups[1].id) || dupGroups[1].id === gidsA[0],
    JSON.stringify({ old: dupGroups[1].id, keeper: gidsA[0] }));
  chk('4.3 另一窗口的「重名组」分组完好', groupOf(st, cross.id)?.title === '重名组',
    JSON.stringify(st.groups.filter(g => g.windowId === WB.id)));
  chk('4.3 另一窗口的标签没被搬走没被关',
    eqArr(memberIds(st, cross.id), cross.tabIds), JSON.stringify(memberIds(st, cross.id)));
  const afterInfos = await headerInfo();
  chk('4.3 重名徽章全部消失', afterInfos.every(h => !h.dup),
    JSON.stringify(afterInfos.map(h => ({ t: h.title, dup: h.dup }))));
  chk('4.3 列表里该窗口只剩一根「重名组」组头, 跨窗口那根还在',
    afterInfos.filter(h => h.title === '重名组').length === 2,
    JSON.stringify(afterInfos.map(h => h.title)));
  chk('4.3 有合并回报 toast', /合并/.test(toast), JSON.stringify(toast));
  // 诊断: 合并的收尸走的是「临时标签法」(Chrome 无删组 API)。临时标签若漏进列表,
  // 会留下一根点开就报错的幽灵行 —— 顺手把列表行与真实标签对一遍
  const ghostRows = await rowIds();
  const liveIds = new Set(st.tabs.map(t => t.id));
  console.log('  全部标签:', JSON.stringify(st.tabs.map(t => [t.id, t.windowId, t.groupId, t.url])));
  console.log('  未分组分区:', JSON.stringify(afterInfos.filter(h => h.title === '未分组').map(h => h.rows)));
  chk('4.3 列表行与真实标签一致(临时标签没有漏成幽灵行)',
    ghostRows.every(tid => liveIds.has(tid)),
    JSON.stringify({ ghost: ghostRows.filter(tid => !liveIds.has(tid)), rows: ghostRows }));
  // 收尸走的是「临时标签法」: 建一根 about:blank → 塞进空壳 → 关掉。
  // 窗口里的标签总数因此必须守恒 —— 多出来的就是没被关掉的临时标签。
  const waAfter = st.tabs.filter(t => t.windowId === WA.id);
  const leaked = waAfter.filter(t => !waBefore.some(b => b.id === t.id));
  chk('4.3 合并后该窗口标签数守恒(临时标签法没有漏下 about:blank)',
    waAfter.length === waBefore.length && leaked.length === 0,
    JSON.stringify({ before: waBefore.length, after: waAfter.length,
      leaked: leaked.map(t => [t.id, t.groupId, t.url]) }));
}

// ===========================================================================
// [Case 5] 「归档此分组」(组头右键)
// ===========================================================================
console.log('\n[Case 5] 「归档此分组」');
{
  await resetWorld();
  const w = await buildWorld({ windows: [
    { urls: ['https://example.com/?c51a', 'https://example.com/?c51b', 'https://example.com/?c51c'],
      groups: [
        { title: '归档组', color: 'purple', from: 0, to: 2 },
        { title: '旁组', color: 'grey', from: 2, to: 3 },
      ] },
    { urls: ['https://example.com/?c51d'],
      groups: [{ title: '归档组', color: 'purple', from: 0, to: 1 }] },
  ] });
  const AR = w.groups.find(g => g.title === '归档组' && g.windowId === w.windows[0].id);
  const SIDE = w.groups.find(g => g.title === '旁组');
  const CROSS = w.groups.find(g => g.title === '归档组' && g.windowId === w.windows[1].id);
  const urls = AR.tabIds.map(id => w.tabs.find(t => t.id === id).url);
  await openPopup();
  const before = await realState();
  chk('5.1 归档前没有归档卡', before.archived.length === 0, JSON.stringify(before.archived.length));

  await openHeaderMenu({ title: '归档组', tabIds: AR.tabIds });
  const labels = await menuLabels();
  chk('5.1 菜单有「归档此分组」', labels.includes('归档此分组'), JSON.stringify(labels));
  await clickMenu('归档此分组');
  await wait(1500);
  const toast = await toastText();
  console.log('  toast:', JSON.stringify(toast));
  const st = await realState();
  console.log('  归档卡:', JSON.stringify(st.archived));
  chk('5.1 toast 报归档数量', /已归档「归档组」\(2 个标签\)/.test(toast), JSON.stringify(toast));
  chk('5.1 archivedGroups 新增一张卡', st.archived.length === 1, JSON.stringify(st.archived.length));
  const card = st.archived[0] || {};
  chk('5.1 归档卡 title/color 与运行时实例一致',
    card.title === '归档组' && card.color === 'purple', JSON.stringify({ t: card.title, c: card.color }));
  chk('5.1 归档卡 tabs 完整匹配(2 条, url 一一对上)',
    Array.isArray(card.tabs) && card.tabs.length === 2 &&
    eqArr(card.tabs.map(t => t.url), urls),
    JSON.stringify({ got: card.tabs?.map(t => t.url), want: urls }));
  chk('5.1 该组标签全部关闭', aliveIds(st, AR.tabIds).length === 0, JSON.stringify(aliveIds(st, AR.tabIds)));
  chk('5.1 原分组已被 Chrome 回收',
    !st.groups.some(g => g.id === AR.id), JSON.stringify(st.groups.map(g => g.title)));
  chk('5.1 同窗口「旁组」不受影响',
    groupOf(st, SIDE.id)?.title === '旁组' && eqArr(memberIds(st, SIDE.id), SIDE.tabIds),
    JSON.stringify(st.groups.map(g => ({ t: g.title, w: g.windowId }))));
  chk('5.1 另一窗口的同名「归档组」及其标签完好',
    groupOf(st, CROSS.id)?.title === '归档组' && eqArr(memberIds(st, CROSS.id), CROSS.tabIds),
    JSON.stringify(st.groups.filter(g => g.windowId === w.windows[1].id)));
}

// ===========================================================================
// [Case 6] 搜索态组头右键 + 同名同色组按 groupKey 聚合 vs 关闭按实例
// ===========================================================================
console.log('\n[Case 6] 搜索态组头右键 + groupKey 聚合 / ADR-0005 关闭口径');
{
  await resetWorld();
  const w = await buildWorld({ windows: [
    { urls: ['https://example.com/?c61a', 'https://example.com/?c61b'],
      groups: [{ title: '工作', color: 'blue', from: 0, to: 2 }] },
    { urls: ['https://example.com/?c61c', 'https://example.com/?c61d'],
      groups: [{ title: '工作', color: 'blue', from: 0, to: 2 }] },
  ] });
  const G1 = w.groups.find(g => g.windowId === w.windows[0].id);
  const G2 = w.groups.find(g => g.windowId === w.windows[1].id);
  await openPopup();

  const browseInfos = await headerInfo();
  chk('6.1 浏览态两根「工作」组头, 跨窗口同名不挂重名徽章',
    browseInfos.filter(h => h.title === '工作').length === 2 && browseInfos.every(h => !h.dup),
    JSON.stringify(browseInfos.map(h => ({ t: h.title, dup: h.dup }))));

  // 进搜索态
  await p.fill('#search', '工作');
  await wait(700);
  let infos = await headerInfo();
  console.log('  搜索态组头:', JSON.stringify(infos.map(h => ({ t: h.title, key: h.key, rows: h.rows.length }))));
  chk('6.1 搜索态按 groupKey 聚合成一个「工作」组头(不是两根)',
    infos.filter(h => h.title === '工作').length === 1, JSON.stringify(infos.map(h => h.title)));
  chk('6.1 聚合头下四根标签都在(两个窗口各两根)',
    infos[0]?.rows.length === 4 &&
    eqArr(infos[0].rows, [...G1.tabIds, ...G2.tabIds]),
    JSON.stringify(infos[0]?.rows));

  // 搜索态右键: 菜单要能用, 且计数按**单个窗口实例**算(不是 4)
  const opened = await openHeaderMenu({ title: '工作' });
  const labels = opened ? await menuLabels() : [];
  console.log('  搜索态菜单:', JSON.stringify(labels));
  chk('6.1 搜索态组头右键能正常开菜单并含组级动作',
    opened && labels.includes('编辑分组…') && labels.includes('解散分组') && labels.includes('归档此分组'),
    JSON.stringify(labels));
  chk('6.1 关闭项数量按单个窗口实例算(2 而不是 4) —— ADR-0005 轴二',
    labels[0] === '关闭「工作」全部标签 (2)', JSON.stringify(labels[0]));

  const before = await realState();
  await clickMenu(labels[0] || '');
  await wait(1600);
  const st = await realState();
  const alive1 = aliveIds(st, G1.tabIds);
  const alive2 = aliveIds(st, G2.tabIds);
  console.log('  关闭后存活:', JSON.stringify({ w1: alive1, w2: alive2, groups: st.groups.map(g => g.title) }));
  const closedWindows = [alive1.length === 0, alive2.length === 0].filter(Boolean).length;
  chk('6.1 只关掉了一个窗口的「工作」实例(另一个窗口 2 根全活)',
    closedWindows === 1, JSON.stringify({ w1: alive1, w2: alive2 }));
  chk('6.1 总共只关了 2 根标签(不是 4 根)',
    st.tabs.length === before.tabs.length - 2, `before=${before.tabs.length} after=${st.tabs.length}`);
  chk('6.1 没被关的那个窗口的「工作」分组还在',
    st.groups.filter(g => g.title === '工作').length === 1,
    JSON.stringify(st.groups.map(g => ({ t: g.title, w: g.windowId }))));
  chk('6.1 搜索态列表已刷新(只剩活着的 2 行)',
    (await rowIds()).length === 2, JSON.stringify(await rowIds()));
}

// ---------------------------------------------------------------------------
console.log(`\n结果: ${pass} passed, ${fail} failed`);
try { await ctx.close(); } catch (e) { /* ignore */ }
try { (await import('node:fs')).rmSync(UD, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
