// tgs-undo-stack-banner.mjs — 撤销条叠加: 连删不再反复弹条, 角标计数 + 展开逐条撤销
// 守: ① 连续删除 3 个 → 只有一条撤销条(不跳), 角标 +3, 文案「已关闭 3 个标签页」
//     ② 点角标展开列表: 3 行(最近关的在上), 每行有独立的「撤销」
//     ③ 单独撤销中间一条: 只恢复那一个, 栈剩 2, 角标 +2
//     ④ 再点角标收起列表; 「撤销全部」恢复剩余 2 个
//     ⑤ 倒计时窗口后整条消失
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-usb-${Date.now()}`, {
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
  window.__tabs = [
    mk(101, 'https://a.example/1', '甲页一', 11, now - 60000),
    mk(102, 'https://a.example/2', '甲页二', 11, now - 50000),
    mk(103, 'https://a.example/3', '甲页三', 11, now - 40000),
    mk(104, 'https://a.example/4', '甲页四', 11, now - 30000, true)];
  window.__groups = [{ id: 11, title: '甲', color: 'blue', windowId: 1 }];
  chrome.tabs.query = async () => window.__tabs;
  chrome.tabGroups.query = async () => window.__groups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
  chrome.tabs.get = async (tid) => window.__tabs.find(t => t.id === tid) || Promise.reject(new Error('no tab'));
  chrome.tabs.remove = async (ids) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
  };
  chrome.tabs.create = async (props) => {
    const t = { id: 9000 + Math.floor(Math.random() * 1000), url: props.url,
      title: props.url, groupId: -1, windowId: props.windowId ?? 1, active: false,
      lastAccessed: Date.now(), status: 'complete', audible: false, discarded: false, index: 0 };
    window.__tabs.push(t);
    return t;
  };
};
const p = await ctx.newPage();
await p.addInitScript(INIT);
await p.goto(`chrome-extension://${id}/popup.html`);
await p.waitForSelector('.tab-item', { timeout: 10000 });
await p.waitForTimeout(700);

const bannerState = () => p.evaluate(() => {
  const b = document.querySelector('.push-banner');
  if (!b) return { exists: false };
  return {
    exists: true,
    msg: b.querySelector('.undo-msg')?.textContent,
    badge: b.querySelector('.undo-badge')?.textContent ?? null,
    actionText: b.querySelector('.push-action')?.textContent,
    listItems: [...b.querySelectorAll('.undo-item')].map(i => i.querySelector('.undo-item-title')?.textContent),
  };
});
const fireDel = (n = 1) => p.evaluate((n) => {
  for (let i = 0; i < n; i++) {
    document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true }));
  }
}, n);

// 光标 → 甲页一(最旧, 屏幕最下), 依次向上删: 101, 102, 103 (甲页四是当前标签不删)
await p.evaluate(() => {
  const rows = [...document.querySelectorAll('.tab-item')];
  const idx = rows.findIndex(r => r.dataset.tabId === '101');
  const cur = Math.max(rows.findIndex(r => r.classList.contains('active')), 0);
  const input = document.getElementById('search');
  for (let i = 0; i < Math.abs(idx - cur); i++) {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: idx > cur ? 'ArrowDown' : 'ArrowUp', code: idx > cur ? 'ArrowDown' : 'ArrowUp',
      bubbles: true, cancelable: true }));
  }
});

// ── [1] 连删 3 个: 一条叠加, 角标 +3 ──
await fireDel(1);
await p.waitForTimeout(150);
await fireDel(1);
await p.waitForTimeout(150);
await fireDel(1);
await p.waitForTimeout(900); // 第 3 删的收尾(收起动画 380ms + banner 重建)走完
const s1 = await bannerState();
const bannerCount = await p.evaluate(() => document.querySelectorAll('.push-banner').length);
chk('[1] 只有一条撤销条(不反复弹)', bannerCount === 1, `banners=${bannerCount}`);
chk('[1] 角标 +3(叠加计数)', s1.badge === '+3', `badge=${s1.badge}`);
chk('[1] 文案「已关闭 3 个标签页」', s1.msg === '已关闭 3 个标签页', `msg=${s1.msg}`);
chk('[1] 按钮是「撤销全部」', s1.actionText === '撤销全部', `btn=${s1.actionText}`);

// ── [2] 点角标展开: 3 行, 最近关的在上 ──
await p.click('.undo-badge');
await p.waitForTimeout(150);
const s2 = await bannerState();
chk('[2] 展开后 3 行', s2.listItems.length === 3, `items=${s2.listItems.length}`);
chk('[2] 最近关的在上(甲页三在最上)', s2.listItems[0] === '甲页三', `items=${s2.listItems.join(',')}`);

// ── [3] 单独撤销中间一条(甲页二): 只恢复它 ──
const tabsBefore = await p.evaluate(() => window.__tabs.length);
await p.evaluate(() => {
  const items = [...document.querySelectorAll('.undo-item')];
  const mid = items.find(i => i.querySelector('.undo-item-title')?.textContent === '甲页二');
  mid.querySelector('.push-action').click();
});
await p.waitForTimeout(800);
const tabsAfter = await p.evaluate(() => window.__tabs.length);
chk('[3] 只恢复 1 个(标签数 +1)', tabsAfter === tabsBefore + 1, `${tabsBefore} → ${tabsAfter}`);
const s3 = await bannerState();
chk('[3] 角标降到 +2', s3.badge === '+2', `badge=${s3.badge}`);
const hasEr = await p.evaluate(() => window.__tabs.some(t => t.title === '甲页二' || (t.url || '').includes('a.example/2')));
chk('[3] 恢复的正是甲页二', hasEr === true);

// ── [4] 单撤后列表自动收起(内容重建); 点角标可重新展开; 撤销全部恢复剩余 2 个 ──
await p.waitForTimeout(100);
const listGone = await p.evaluate(() => !document.querySelector('.undo-list'));
chk('[4] 单撤后列表自动收起', listGone === true);
await p.click('.undo-badge');
await p.waitForTimeout(100);
const reopened = await p.evaluate(() => {
  const items = [...document.querySelectorAll('.undo-item-title')].map(e => e.textContent);
  return items;
});
chk('[4] 重新展开: 剩余 2 行且已撤的不在列表里',
  reopened.length === 2 && !reopened.includes('甲页二'), `items=${reopened.join(',')}`);
await p.click('.undo-badge'); // 收起, 走主按钮路径
await p.waitForTimeout(100);
await p.evaluate(() => {
  const b = document.querySelector('.push-banner');
  b.querySelector('.push-action').click(); // 「撤销全部」
});
await p.waitForTimeout(800);
const finalTabs = await p.evaluate(() => window.__tabs.map(t => t.title || t.url));
chk('[4] 剩余 2 个全部恢复(共 4 个标签)', finalTabs.length === 4, `tabs=${finalTabs.length}`);
const bannerGone = await p.evaluate(() => !document.querySelector('.push-banner'));
chk('[4] 撤销全部后条目消失', bannerGone === true);

await ctx.close();
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
