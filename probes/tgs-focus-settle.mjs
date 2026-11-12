// tgs-focus-settle.mjs — 删除后选中态: 暂停之后才落到上一行
// 守: ① 删除收起期间光标静音(body.cursor-muted), 选中态视觉不亮
//     ② 键盘落点已在上一行(连按 ⌘⌫ 不吞键, 向上扫)
//     ③ 收起演完(暂停)后静音摘除, 上一行亮起
//     ④ 连按场景: 每次操作都不亮, 暂停后落到最后删的那行的前驱
//     ⑤ 列表剩余行正确
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-fb-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

const INIT = () => {
  localStorage.setItem('tgs-theme', 'linear');
  localStorage.setItem('tgs-deletekey', 'cmd-bs');
  const now = 1730000000000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  // DOM 序(时间倒序): 305(当前), 304, 303, 302, 301 — 光标从 304 起连按 3 次
  window.__tabs = [
    mk(301, 'https://a.example/1', '页一', 11, now - 50000),
    mk(302, 'https://a.example/2', '页二', 11, now - 40000),
    mk(303, 'https://a.example/3', '页三', 11, now - 30000),
    mk(304, 'https://a.example/4', '页四', 11, now - 20000),
    mk(305, 'https://a.example/5', '页五', 11, now - 10000, true)];
  window.__groups = [{ id: 11, title: '素材', color: 'blue', windowId: 1 }];
  chrome.tabs.query = async () => window.__tabs;
  chrome.tabGroups.query = async () => window.__groups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
  chrome.tabs.get = async (tid) => window.__tabs.find(t => t.id === tid) || Promise.reject(new Error('no tab'));
  chrome.tabs.remove = async (ids) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
  };
};
const p = await ctx.newPage();
await p.addInitScript(INIT);
await p.goto(`chrome-extension://${id}/popup.html`);
await p.waitForSelector('.tab-item', { timeout: 10000 });
await p.waitForTimeout(700);
// 光标到 304(DOM 序 305,304,303,... 的第 2 行)
await p.evaluate(() => {
  const rows = [...document.querySelectorAll('.tab-item')];
  const idx = rows.findIndex(r => r.dataset.tabId === '302');
  const cur = Math.max(rows.findIndex(r => r.classList.contains('active')), 0);
  const input = document.getElementById('search');
  for (let i = 0; i < Math.abs(idx - cur); i++) {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: idx > cur ? 'ArrowDown' : 'ArrowUp', code: idx > cur ? 'ArrowDown' : 'ArrowUp',
      bubbles: true, cancelable: true }));
  }
});
// 连按 3 次 ⌘⌫, 间隔 120ms (落在收起窗口内 = "每次操作"不是"暂停")
const burst = await p.evaluate(async () => {
  const fire = () => document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Backspace', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true }));
  const out = { deleted: [], mutedDuring: [], activeVisible: [] };
  for (let i = 0; i < 3; i++) {
    fire();
    await new Promise(r => setTimeout(r, 120));
    out.deleted = [...window.__tabs.map(t => t.id)];
    out.mutedDuring.push(document.body.classList.contains('cursor-muted'));
    const a = document.querySelector('.tab-item.active');
    out.activeVisible.push(a ? (getComputedStyle(a).backgroundImage !== 'none') : false);
  }
  return out;
});
chk('连按 3 次删了 3 行(302,303,304 向上扫)', !burst.deleted.includes(302) && !burst.deleted.includes(303) && !burst.deleted.includes(304), `剩=${burst.deleted.join(',')}`);
chk('连按期间光标一直静音(每次操作不亮)', burst.mutedDuring.every(m => m === true), JSON.stringify(burst.mutedDuring));
chk('连按期间选中态视觉未亮', burst.activeVisible.every(v => v === false), JSON.stringify(burst.activeVisible));
await p.waitForTimeout(1000); // 暂停后
const settled = await p.evaluate(() => {
  const a = document.querySelector('.tab-item.active');
  return { active: a?.dataset.tabId, muted: document.body.classList.contains('cursor-muted'),
    visible: a ? getComputedStyle(a).backgroundImage !== 'none' : false,
    rows: [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId) };
});
chk('暂停后选中态落到上一行(305, 最后删的 304 的前驱)', settled.active === '305', `active=${settled.active}`);
chk('暂停后静音摘除 + 选中态亮起', settled.muted === false && settled.visible === true, `muted=${settled.muted} visible=${settled.visible}`);
chk('列表剩余行正确(305, 301)', settled.rows.join(',') === '305,301', `rows=${settled.rows.join(',')}`);
await ctx.close();
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
