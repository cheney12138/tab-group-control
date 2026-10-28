// 验证唤起闪现消灭: 开关 ON → 面板不创建(setPopup('')); OFF → 恢复面板
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-fl-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };
const getPopup = () => sw.evaluate(async () => (await chrome.action.getPopup({})).split('/').pop() || '(空)');
chk(`默认恢复面板(${await getPopup()})`, (await getPopup()) === 'popup.html');
await sw.evaluate(() => chrome.storage.local.set({ openAsWindowEnabled: true }));
await new Promise(r => setTimeout(r, 500));
chk(`开 → 面板不创建(${await getPopup()})`, (await getPopup()) === '(空)');
await sw.evaluate(() => chrome.storage.local.set({ openAsWindowEnabled: false }));
await new Promise(r => setTimeout(r, 500));
chk(`关 → 恢复面板(${await getPopup()})`, (await getPopup()) === 'popup.html');
console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
