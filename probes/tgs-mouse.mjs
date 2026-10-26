// 验证真指针跟随: content.js 记录 mousemove, 唤起时窗口开在指针旁
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-mouse-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };
const helper = await ctx.newPage();
await helper.goto(`chrome-extension://${id}/popup.html?win=1`);
const send = (msg) => helper.evaluate((m) => new Promise(res => {
  try { chrome.runtime.sendMessage(m, r => res(chrome.runtime.lastError?.message || JSON.stringify(r))); }
  catch (e) { res(String(e)); }
}), msg);
const tab = await ctx.newPage();
await tab.goto('https://example.com', { timeout: 20000 }).catch(() => {});
await tab.waitForTimeout(600);
const expected = await tab.evaluate(() => new Promise(res => {
  window.addEventListener('mousemove', (e) => res({ x: window.screenX + e.clientX, y: window.screenY + e.clientY }), { once: true });
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 120 }));
}));
chk(`content.js 已记录指针(${expected.x},${expected.y})`, !!expected);
await sw.evaluate(() => chrome.storage.local.remove('standaloneBounds'));
await send({ type: 'open-standalone' });
await new Promise(r => setTimeout(r, 1200));
const w = await sw.evaluate(async () => (await chrome.windows.getAll()).find(x => x.type === 'popup') || null);
chk('窗口已建', !!w);
const nearX = Math.abs(w?.left - expected.x) <= 60;
chk(`x 跟随(实际 ${w?.left}, 期望 ${expected.x})`, nearX);
console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
