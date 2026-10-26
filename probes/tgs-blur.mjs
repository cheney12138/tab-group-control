// 验证独立窗口失焦自关: hasFocus 恒真时守卫不误关(CDP 无法模拟真失焦, 真机验证)
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-blur-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };
const helper = await ctx.newPage();
await helper.goto(`chrome-extension://${id}/popup.html?win=1`);
await helper.evaluate(() => new Promise(res => chrome.runtime.sendMessage({ type: 'open-standalone' }, () => res())));
let panel = null;
for (let i = 0; i < 40 && !panel; i++) {
  await new Promise(r => setTimeout(r, 250));
  panel = ctx.pages().find(pg => (pg.url() || '').includes('popup.html?win=1') && pg !== helper) || null;
}
chk('面板已开', !!panel);
await panel.evaluate(() => window.dispatchEvent(new Event('blur')));
await helper.waitForTimeout(600);
const hasPanel = await sw.evaluate(async () =>
  !!(await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).find(c => (c.documentUrl || '').includes('win=1')));
chk('守卫: hasFocus=true 时 blur 不误关', hasPanel);
console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
