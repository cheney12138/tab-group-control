// tgs-archive-live.mjs — 归档「重新打开」在**真实扩展环境**里的收场
// (tgs-archive-restore.mjs 是 stub 版; 这份不 stub chrome.* —— 建标签/归组/失焦都是真的)
// 守: ① 独立窗口面板点「重新打开」后窗口还在(没有被失焦自关带走)
//     ② 面板收起, 回到分组列表, 恢复的分组头与行都在
//     ③ 恢复的标签真的进了同名原生分组; 归档卡被焚毁
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-al-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

// ── 0. 真实现场: 一个普通窗口 + 已有分组 + 一张归档卡 ──
const helper = await ctx.newPage();
await helper.goto(`chrome-extension://${id}/popup.html`);
await new Promise(r => setTimeout(r, 800));
const seed = await sw.evaluate(async () => {
  const win = await chrome.windows.create({ url: 'https://example.com/?a', type: 'normal', width: 900, height: 700 });
  const mk = (url) => chrome.tabs.create({ url, windowId: win.id, active: false });
  const t2 = await mk('https://example.com/?b');
  const t3 = await mk('https://example.com/?c');
  const gid = await chrome.tabs.group({ tabIds: [t2.id, t3.id], createProperties: { windowId: win.id } });
  await chrome.tabGroups.update(gid, { title: '旧组', color: 'green' });
  await chrome.storage.local.set({ archivedGroups: [{
    id: 'arch_live', title: '素材', color: 'blue', archivedAt: Date.now() - 60_000,
    tabs: [
      { title: '素材一', url: 'https://example.com/?m1', favIconUrl: '' },
      { title: '素材二', url: 'https://example.com/?m2', favIconUrl: '' },
    ],
  }] });
  return { winId: win.id, gid };
});
await new Promise(r => setTimeout(r, 600));

// ── 1. 开独立窗口面板 ──
const openStandalone = () => helper.evaluate(() => new Promise(res => {
  try { chrome.runtime.sendMessage({ type: 'open-standalone' }, () => res()); } catch (e) { res(); }
}));
await openStandalone();
let panel = null;
for (let i = 0; i < 40 && !panel; i++) {
  await new Promise(r => setTimeout(r, 250));
  panel = ctx.pages().find(pg => (pg.url() || '').includes('popup.html?win=1')) || null;
}
chk('独立窗口面板已打开', !!panel);
if (!panel) { console.log(`\n结果: ${pass} passed, ${fail} failed`); await ctx.close(); process.exit(1); }
panel.on('pageerror', e => console.log('[panel pageerror]', e.message));
await panel.waitForSelector('.tab-item, .empty', { timeout: 10000 });
await panel.waitForTimeout(700);

// ── 2. 设置 → 已归档 → 重新打开 ──
await panel.click('#settingsBtn');
await panel.waitForTimeout(200);
await panel.click('.settings-tab[data-pane="archive"]');
await panel.waitForSelector('.archive-card', { timeout: 5000 });
await panel.click('.btn-restore-archive');
await panel.waitForTimeout(2500);

const alive = ctx.pages().some(pg => (pg.url() || '').includes('popup.html?win=1'));
chk('面板窗口没有被关掉(失焦自关守卫生效)', alive,
  alive ? '' : '窗口已消失');

const state = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({});
  const store = await chrome.storage.local.get('archivedGroups');
  const live = tabs.filter(t => (t.url || '').includes('example.com/?m'));
  return {
    groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color, windowId: g.windowId })),
    live: live.map(t => ({ url: t.url, groupId: t.groupId })),
    archived: (store.archivedGroups || []).length,
  };
});
chk('恢复的标签全部进了「素材」组',
  state.live.length === 2 && state.live.every(t => {
    const g = state.groups.find(x => x.id === t.groupId);
    return g && g.title === '素材';
  }), JSON.stringify(state.live));
chk('归档卡已焚毁', state.archived === 0, `archived=${state.archived}`);

if (alive) {
  const ui = await panel.evaluate(() => ({
    panelOpen: document.getElementById('settingsPanel').classList.contains('open'),
    headers: [...document.querySelectorAll('.group-header')].map(h => (h.querySelector('.group-title')?.textContent || '').trim()),
    rows: [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId),
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
  }));
  chk('设置面板已收起(回到分组窗口)', ui.panelOpen === false);
  chk('列表里出现「素材」分组头', ui.headers.includes('素材'), JSON.stringify(ui.headers));
  chk('恢复的行在列表里', ui.rows.length >= 4, `rows=${ui.rows.length}`);
  await panel.screenshot({ path: '/tmp/tgs-archive-live.png' });
}

// ── 3. 焦点被浏览器窗口抢走时: 收场后必须把面板窗口提回前台 ──
// (这就是"弹窗还是关闭了"的真身: 窗口还活着, 却埋在浏览器窗口后面)
console.log('\n[3] 恢复期间失焦 → 收场后回到分组窗口');
const seeded2 = await sw.evaluate(async () => {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const win = wins[wins.length - 1];
  await chrome.windows.update(win.id, { focused: true });   // 抢走焦点
  await chrome.storage.local.set({ archivedGroups: [{
    id: 'arch_focus', title: '焦点组', color: 'purple', archivedAt: Date.now(),
    tabs: [{ title: '焦点页', url: 'https://example.com/?f1', favIconUrl: '' }],
  }] });
  return { winId: win.id };
});
await new Promise(r => setTimeout(r, 300));
// 让页面"失焦": hasFocus 恒假 + 派发 blur(等价于建标签把焦点抢走那一下)
await panel.evaluate(() => {
  document.hasFocus = () => false;
  // 记账: 收场后到底有没有把本窗口重新提到前台
  window.__focusCalls = [];
  const orig = chrome.windows.update.bind(chrome.windows);
  chrome.windows.update = async (id, props) => {
    window.__focusCalls.push({ id, focused: !!props?.focused });
    return orig(id, props);
  };
  window.dispatchEvent(new Event('blur'));
});
await panel.click('#settingsBtn');
await panel.waitForTimeout(200);
await panel.click('.settings-tab[data-pane="archive"]');
await panel.waitForSelector('.archive-card', { timeout: 5000 });
await panel.click('.btn-restore-archive');
await panel.waitForTimeout(3000);
const winState = await sw.evaluate(async () => {
  const wins = await chrome.windows.getAll({ populate: false });
  return wins.map(w => ({ id: w.id, type: w.type, focused: !!w.focused }));
});
const panelWin = winState.find(w => w.type === 'popup');
chk('恢复期间失焦也没把面板窗口关掉', ctx.pages().some(pg => (pg.url() || '').includes('popup.html?win=1')),
  JSON.stringify(winState));
chk('收场后面板窗口回到了前台(不是埋在浏览器后面)', panelWin?.focused === true,
  JSON.stringify(winState));
const focusCalls = await panel.evaluate(() => window.__focusCalls || []);
chk('收场时确实对本窗口调了 windows.update({focused:true})',
  focusCalls.some(c => c.focused && c.id === panelWin?.id),
  JSON.stringify(focusCalls));
const ui2 = await panel.evaluate(() => ({
  panelOpen: document.getElementById('settingsPanel').classList.contains('open'),
  headers: [...document.querySelectorAll('.group-header')].map(h => (h.querySelector('.group-title')?.textContent || '').trim()),
}));
chk('面板已收起且列表里有「焦点组」', ui2.panelOpen === false && ui2.headers.includes('焦点组'),
  JSON.stringify(ui2));

// 收场后的失焦宽限期: 面板已收起, 但还在动作的宽限窗口内 → 不自关
const holdCheck = await panel.evaluate(async () => {
  window.__closeCalls = 0;
  window.close = () => { window.__closeCalls++; };
  document.hasFocus = () => false;
  window.dispatchEvent(new Event('blur'));
  await new Promise(r => setTimeout(r, 500));
  return window.__closeCalls;
});
chk('收场后的失焦宽限期内不自关(blur 不调 window.close)', holdCheck === 0,
  `closeCalls=${holdCheck}`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
