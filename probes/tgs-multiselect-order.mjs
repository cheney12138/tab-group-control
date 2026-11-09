// tgs-multiselect-order.mjs — 跨分组多选关闭的排序 + 撤销落位
// 守: ① 跨分组多选关闭后, 剩下的分组**相对次序不变**(被清空的组让位, 但它的位置被记住)
//     ② ⌘Z 撤销后: 被清空的组回到原来的名次, 每一行回到组内原位(不是全部挤到末尾)
//     ③ 撤销的展开动画可见: 恢复行以 .expanding 从 0 高展开, 不被排序跳动打断
//     ④ 单分组多选关闭(整组清空)也遵守同一套
//     ⑤ 关闭「当前激活标签」后 Chrome 换了激活标签 —— 不能因此把那个组钉到第一位(跳动源)
// 做法: 假 chrome API(含 remove 后 Chrome 的"右邻接任激活"行为) + 真实 popup 页面。
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-mso-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

const INIT = ({ resume } = {}) => {
  localStorage.setItem('tgs-theme', 'linear');
  localStorage.setItem('tgs-deletekey', 'cmd-bs');
  const NOW = Date.now();
  window.__mkTabs = () => ([
    { id: 101, title: '学习一', url: 'https://a.example/1', groupId: 10, windowId: 1,
      active: true, lastAccessed: NOW - 1000, index: 0, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 102, title: '学习二', url: 'https://a.example/2', groupId: 10, windowId: 1,
      active: false, lastAccessed: NOW - 4000, index: 1, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 201, title: '工作一', url: 'https://b.example/1', groupId: 20, windowId: 1,
      active: false, lastAccessed: NOW - 2000, index: 2, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 202, title: '工作二', url: 'https://b.example/2', groupId: 20, windowId: 1,
      active: false, lastAccessed: NOW - 5000, index: 3, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 301, title: '娱乐一', url: 'https://c.example/1', groupId: 30, windowId: 1,
      active: false, lastAccessed: NOW - 3000, index: 4, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
    { id: 401, title: '散标签', url: 'https://d.example/1', groupId: -1, windowId: 1,
      active: false, lastAccessed: NOW - 6000, index: 5, status: 'complete', audible: false, discarded: false, favIconUrl: '' },
  ]);
  window.__groups = [
    { id: 10, title: '学习', color: 'blue', windowId: 1 },
    { id: 20, title: '工作', color: 'green', windowId: 1 },
    { id: 30, title: '娱乐', color: 'red', windowId: 1 },
  ];
  window.__tabs = window.__mkTabs();
  window.__nextId = 700;
  window.__removed = [];
  window.__tabById = (tid) => window.__tabs.find(t => t.id === tid) || null;

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
  chrome.tabGroups.update = async (gid, props) => {
    const g = window.__groups.find(x => x.id === gid);
    if (g) Object.assign(g, props);
  };
  chrome.tabs.group = async (opts) => {
    const gid = opts.groupId ?? 500;
    if (!window.__groups.some(g => g.id === gid)) {
      window.__groups.push({ id: gid, title: '', color: 'grey', windowId: opts.createProperties?.windowId ?? 1 });
    }
    for (const tid of opts.tabIds) {
      const t = window.__tabs.find(x => x.id === tid);
      if (t) t.groupId = gid;
    }
    return gid;
  };
  chrome.tabs.ungroup = async () => {};
  chrome.tabs.move = async (tid, props) => {
    const t = window.__tabs.find(x => x.id === tid);
    if (t && typeof props.index === 'number') t.index = props.index;
    return t ? { ...t } : null;
  };
  chrome.tabs.get = async (tid) => {
    const t = window.__tabs.find(x => x.id === tid);
    if (!t) throw new Error('no tab ' + tid);
    return { ...t };
  };
  // Chrome 真实行为: 关掉激活标签后, 右邻(没有则左邻)接任激活
  chrome.tabs.remove = async (ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
    const set = new Set(list);
    const gone = window.__tabs.filter(t => set.has(t.id));
    const activeGone = gone.find(t => t.active);
    if (activeGone) {
      const byIndex = [...window.__tabs].sort((a, b) => a.index - b.index);
      const pos = byIndex.findIndex(t => t.id === activeGone.id);
      const nextUp = byIndex.slice(pos + 1).find(t => !set.has(t.id));
      const prevDown = [...byIndex.slice(0, pos)].reverse().find(t => !set.has(t.id));
      const heir = nextUp || prevDown;
      if (heir) heir.active = true;
    }
    window.__removed.push(...list);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
    // 空组被 Chrome 回收
    const live = new Set(window.__tabs.map(t => t.groupId));
    window.__groups = window.__groups.filter(g => live.has(g.id));
  };
  chrome.tabs.create = async (props) => {
    const t = { id: window.__nextId++, url: props.url, title: props.url, groupId: -1,
      windowId: props.windowId || 1, active: !!props.active, lastAccessed: Date.now() + 1,
      index: typeof props.index === 'number' ? props.index : window.__tabs.length,
      status: 'complete', audible: false, discarded: false, favIconUrl: '' };
    window.__tabs.push(t);
    return { ...t };
  };
  chrome.runtime.sendMessage = async (msg) => {
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
  window.__session = {};
  chrome.storage.session = {
    get: async (keys) => {
      if (typeof keys === 'string') return { [keys]: window.__session[keys] };
      return { ...window.__session };
    },
    set: async (obj) => { Object.assign(window.__session, obj); },
    remove: async (k) => { delete window.__session[k]; },
  };

  // 真弹窗关掉再开: 世界(标签/分组/session)是持久的 —— 沙盘里由上一页导出后注入,
  // 否则每个新页面都从"全部 6 个标签"重新开始, 跨 popup 的撤销凭证就测不到了
  if (resume) {
    window.__tabs = resume.tabs.map(t => ({ ...t }));
    window.__groups = resume.groups.map(g => ({ ...g }));
    window.__session = { ...resume.session };
    window.__nextId = resume.nextId;
    window.__resumed = true;
  }
};

async function openPopup(resume = null) {
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.addInitScript(INIT, { resume });
  await p.setViewportSize({ width: 480, height: 520 });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(700); // 入场播完(body.entrance 摘掉)
  return p;
}

const headerOrder = (p) => p.evaluate(() =>
  [...document.querySelectorAll('.group-header')].map(h =>
    (h.querySelector('.group-title')?.textContent || '').trim()));
const rowOrder = (p) => p.evaluate(() => [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId));
// 撤销会给恢复的标签发新 id, 比"行身份"只能看标题(场景里标题唯一)
const rowTitles = (p) => p.evaluate(() =>
  [...document.querySelectorAll('.tab-item')].map(r =>
    (r.querySelector('.title')?.textContent || '').trim()));
const shiftClick = (p, tabId) => p.evaluate((tabId) => {
  document.querySelector(`.tab-item[data-tab-id="${tabId}"]`)
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
}, tabId);
const key = (p, k, mods = {}) => p.evaluate(({ k, mods }) => {
  document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
    key: k, code: k === 'Backspace' ? 'Backspace' : (k === 'z' ? 'KeyZ' : k),
    bubbles: true, cancelable: true, ...mods }));
}, { k, mods });
const closeSelected = async (p) => { await key(p, 'Backspace', { metaKey: true }); await p.waitForTimeout(900); };
const undo = (p) => key(p, 'z', { metaKey: true });

// ── [A] 跨分组多选关闭 → 撤销 ──
{
  console.log('\n[A] 跨分组多选关闭(娱乐整组 + 工作组最新一条) → 撤销');
  const p = await openPopup();
  const baseH = await headerOrder(p);
  const baseR = await rowTitles(p);
  console.log('  关闭前组序:', JSON.stringify(baseH), '行:', baseR.join(','));
  chk('基准行序符合分组(学习/工作/娱乐/未分组)',
    baseR.join(',') === '学习一,学习二,工作一,工作二,娱乐一,散标签', baseR.join(','));

  await shiftClick(p, 201);
  await shiftClick(p, 301);
  await closeSelected(p);
  const hA = await headerOrder(p);
  const rA = await rowTitles(p);
  console.log('  关闭后组序:', JSON.stringify(hA), '行:', rA.join(','));
  chk('关闭后剩下的分组相对次序不变', JSON.stringify(hA) === JSON.stringify(['学习', '工作', '未分组']),
    JSON.stringify(hA));
  chk('关闭后的行序符合数据(工作一/娱乐一 消失)', rA.join(',') === '学习一,学习二,工作二,散标签', rA.join(','));

  // 撤销 + 采样展开动画
  const anim = await p.evaluate(async () => {
    const t0 = performance.now();
    document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true, bubbles: true, cancelable: true }));
    const samples = [];
    for (const at of [60, 140, 240, 380, 560, 900]) {
      const wait = at - (performance.now() - t0);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      samples.push({
        at: Math.round(performance.now() - t0),
        rows: [...document.querySelectorAll('.tab-item')].map(r => ({
          id: r.dataset.tabId,
          expanding: r.classList.contains('expanding'),
          h: r.offsetHeight,
          delay: Math.round((parseFloat(getComputedStyle(r).transitionDelay) || 0) * 1000),
        })),
      });
    }
    return samples;
  });
  await p.waitForTimeout(300);
  const hU = await headerOrder(p);
  const rU = await rowTitles(p);
  console.log('  撤销后组序:', JSON.stringify(hU), '行:', rU.join(','));
  chk('撤销后组序与关闭前一致', JSON.stringify(hU) === JSON.stringify(baseH), JSON.stringify(hU));
  chk('撤销后每一行回到原位', rU.join(',') === baseR.join(','), rU.join(','));

  const withExpanding = anim.filter(s => s.rows.some(r => r.expanding));
  const first = withExpanding[0];
  const settled = anim[anim.length - 1];
  chk('撤销的展开动画在演(.expanding 出现)', withExpanding.length > 0,
    anim.map(s => `${s.at}ms:${s.rows.filter(r => r.expanding).length}`).join(' '));
  const midHeights = first ? first.rows.filter(r => r.expanding) : [];
  chk('恢复行从 0 高展开(采样到中间高度)', first && first.at <= 400 &&
    midHeights.every(r => r.h < (settled.rows.find(x => x.id === r.id)?.h ?? 999) - 2),
    first ? midHeights.map(r => `${r.id}:${r.h}`).join(',') : 'none');
  chk('展开错峰 70ms 递增', first && (() => {
    const ds = midHeights.map(r => r.delay);
    return ds.length > 1 && ds.every((d, i) => i === 0 || d > ds[i - 1]);
  })(), first ? midHeights.map(r => `${r.id}:${r.delay}ms`).join(' ') : 'none');
  chk('演完摘掉 .expanding', settled.rows.every(r => !r.expanding));
  await p.screenshot({ path: `/tmp/tgs-mso-A.png` });
  await p.close();
}

// ── [B] 关闭「当前激活标签」→ Chrome 换激活, 组序不许因此跳动 ──
{
  console.log('\n[B] 多选里含激活标签(散标签为激活) → 撤销');
  const p = await openPopup();
  // 让「未分组」成为当前激活标签(它数据上最旧, 但会被钉到第一位)
  await p.evaluate(() => {
    for (const t of window.__tabs) t.active = t.id === 401;
  });
  await p.reload();
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(700);
  const baseH = await headerOrder(p);
  const baseR = await rowTitles(p);
  console.log('  关闭前组序:', JSON.stringify(baseH), '行:', baseR.join(','));

  await shiftClick(p, 401); // 激活标签
  await shiftClick(p, 301); // 另一组的整组
  await closeSelected(p);
  const hB = await headerOrder(p);
  const rB = await rowTitles(p);
  console.log('  关闭后组序:', JSON.stringify(hB), '行:', rB.join(','));
  chk('换激活标签后组序不跳动', JSON.stringify(hB) === JSON.stringify(['学习', '工作']), JSON.stringify(hB));

  await undo(p);
  await p.waitForTimeout(1400);
  const hU = await headerOrder(p);
  const rU = await rowTitles(p);
  console.log('  撤销后组序:', JSON.stringify(hU), '行:', rU.join(','));
  chk('撤销后组序与关闭前一致', JSON.stringify(hU) === JSON.stringify(baseH), JSON.stringify(hU));
  chk('撤销后每一行回到原位', rU.join(',') === baseR.join(','), rU.join(','));
  await p.close();
}

// ── [C] 单分组多选关闭(整组清空) → 撤销 ──
{
  console.log('\n[C] 单分组多选关闭(学习整组) → 撤销');
  const p = await openPopup();
  const baseH = await headerOrder(p);
  const baseR = await rowTitles(p);
  await shiftClick(p, 101);
  await shiftClick(p, 102);
  await closeSelected(p);
  const hC = await headerOrder(p);
  console.log('  关闭后组序:', JSON.stringify(hC), '行:', (await rowTitles(p)).join(','));
  chk('整组关掉后其余分组次序不变', JSON.stringify(hC) === JSON.stringify(['工作', '娱乐', '未分组']),
    JSON.stringify(hC));
  await undo(p);
  await p.waitForTimeout(1400);
  const hU = await headerOrder(p);
  const rU = await rowTitles(p);
  console.log('  撤销后组序:', JSON.stringify(hU), '行:', rU.join(','));
  chk('撤销后「学习」回到第一位', JSON.stringify(hU) === JSON.stringify(baseH), JSON.stringify(hU));
  chk('撤销后行序回到关闭前', rU.join(',') === baseR.join(','), rU.join(','));
  await p.close();
}

// ── [D] 跨分组多选关闭后关掉弹窗 → 重开 → 撤销(凭证 + 组序记忆跨 popup) ──
{
  console.log('\n[D] 关闭弹窗后重开再撤销(跨 popup 的撤销凭证)');
  const p = await openPopup();
  const baseH = await headerOrder(p);
  const baseR = await rowTitles(p);
  await shiftClick(p, 101); // 激活标签 → 真 Chrome 会当场关掉 popup
  await shiftClick(p, 301);
  await key(p, 'Backspace', { metaKey: true });
  await p.waitForTimeout(900);
  // 导出这一页的"世界"(标签/分组/撤销凭证), 再模拟 popup 被关掉
  const world = await p.evaluate(() => ({
    tabs: window.__tabs, groups: window.__groups,
    session: window.__session, nextId: window.__nextId,
  }));
  await p.close();
  console.log('  关闭后剩余标签:', world.tabs.map(t => t.id).join(','),
    '| session 里的凭证:', Object.keys(world.session).join(','));
  chk('撤销凭证落到了 session(含分区次序)',
    !!world.session['tgs-undo-pending']?.snapshots?.length &&
    Array.isArray(world.session['tgs-undo-pending']?.order),
    JSON.stringify(world.session['tgs-undo-pending']?.order || null));

  const p2 = await openPopup(world);
  const hOpen = await headerOrder(p2);
  const rOpen = await rowTitles(p2);
  console.log('  重开后组序:', JSON.stringify(hOpen), '行:', rOpen.join(','));
  chk('重开时被清空的「娱乐」确实不在列表里(不带标签的组不占位)',
    JSON.stringify(hOpen) === JSON.stringify(['学习', '工作', '未分组']), JSON.stringify(hOpen));
  await undo(p2);
  await p2.waitForTimeout(1500);
  const hU = await headerOrder(p2);
  const rU = await rowTitles(p2);
  console.log('  撤销后组序:', JSON.stringify(hU), '行:', rU.join(','));
  chk('重开后撤销: 组序回到关闭前', JSON.stringify(hU) === JSON.stringify(baseH), JSON.stringify(hU));
  chk('重开后撤销: 行序回到关闭前', rU.join(',') === baseR.join(','), rU.join(','));
  await p2.close();
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
