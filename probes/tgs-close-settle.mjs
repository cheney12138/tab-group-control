// tgs-close-settle.mjs — 整组被删空后, 光标落点不自动漂移
// 病例(2026-11-12): 分组 a 两个 tab 连删两下删空组, 光标先落到下一分组首行,
// 然后**什么都没操作**又自己下移了一行 —— 重绘后的兜底用了旧 DOM 索引,
// 组头+行一起退场后行全部上移, 同一个数字指向了另一行。
// 守: ① 删空组后光标停在下一分组首行, 不再自己下移
//     ② 收起期间与重绘后是同一行(无第二跳)
//     ③ 组未删空时落点仍按「后继→前驱」原规则
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-cs-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

// 组 a「甲」2 行 / 组 b「乙」3 行 / 组 c「丙」1 行(当前标签在丙)
const INIT = () => {
  localStorage.setItem('tgs-theme', 'linear');
  localStorage.setItem('tgs-deletekey', 'cmd-bs');
  const now = 1730000000000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  window.__tabs = [
    mk(101, 'https://a.example/1', '甲页一', 11, now - 50000),
    mk(102, 'https://a.example/2', '甲页二', 11, now - 40000),
    mk(201, 'https://b.example/1', '乙页一', 22, now - 30000),
    mk(202, 'https://b.example/2', '乙页二', 22, now - 20000),
    mk(203, 'https://b.example/3', '乙页三', 22, now - 10000),
    mk(301, 'https://c.example/1', '丙页一', 33, now - 5000, true)];
  window.__groups = [
    { id: 11, title: '甲', color: 'blue', windowId: 1 },
    { id: 22, title: '乙', color: 'green', windowId: 1 },
    { id: 33, title: '丙', color: 'red', windowId: 1 }];
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
await p.waitForTimeout(700); // 入场播完

const fire = () => p.evaluate(() => {
  document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Backspace', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true }));
});
const activeTabId = () => p.evaluate(() => document.querySelector('.tab-item.active')?.dataset.tabId ?? null);

// DOM 序: 丙(301), 乙(203,202,201), 甲(102,101) — 时间倒序
// 光标 → 甲页二(102, 甲组第二行), ⌘⌫ 删掉 → 甲组只剩 101 → 再 ⌘⌫ 删空甲组
const moveTo = async (tabId) => {
  await p.evaluate((tid) => {
    const rows = [...document.querySelectorAll('.tab-item')];
    const idx = rows.findIndex(r => r.dataset.tabId === tid);
    const cur = Math.max(rows.findIndex(r => r.classList.contains('active')), 0);
    const input = document.getElementById('search');
    for (let i = 0; i < Math.abs(idx - cur); i++) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: idx > cur ? 'ArrowDown' : 'ArrowUp', code: idx > cur ? 'ArrowDown' : 'ArrowUp',
        bubbles: true, cancelable: true }));
    }
  }, tabId);
};

// ── [1] 删空整组: 落下一分组首行, 且不再自动下移 ──
await moveTo('102');
await fire(); // 删 102, 甲组剩 101
await p.waitForTimeout(600); // 演完重绘
const s1 = await activeTabId();
chk('[1] 删甲组第 2 行后落在甲组前驱(101)', s1 === '101', `active=${s1}`);
await fire(); // 删 101, 甲组删空 → 应落乙组首行(201)
await p.waitForTimeout(200); // 收起进行中
const mid = await activeTabId();
chk('[1] 收起期间已落乙组首行(201)', mid === '201', `mid=${mid}`);
await p.waitForTimeout(700); // 演完重绘 + 稳定期
const s2 = await activeTabId();
chk('[1] 重绘后仍在乙组首行(201), 没自动下移', s2 === '201', `active=${s2}`);
await p.waitForTimeout(600); // 再等一拍, 确认没有延迟的第二跳
const s3 = await activeTabId();
chk('[1] 稳定后无第二跳(仍是 201)', s3 === '201', `active=${s3}`);
const groups = await p.evaluate(() => [...document.querySelectorAll('.group-header .group-title')].map(t => t.textContent));
chk('[1] 甲组头随行一起消失', !groups.includes('甲'), `groups=${groups.join(',')}`);
const rowsN = await p.evaluate(() => document.querySelectorAll('.tab-item').length);
chk('[1] 行数正确(乙 3 + 丙 1 = 4)', rowsN === 4, `rows=${rowsN}`);

// ── [2] 组未删空: 原规则(后继→前驱)不变 ──
await moveTo('202'); // 乙组中间行
await fire(); // 删 202
await p.waitForTimeout(700);
const s4 = await activeTabId();
chk('[2] 删中间行落在屏幕下一行(201, 原后继规则)', s4 === '201', `active=${s4}`);

await ctx.close();
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
