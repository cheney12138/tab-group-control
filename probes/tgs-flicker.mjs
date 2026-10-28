// tgs-flicker.mjs — 入场窗口内 ⬇️: 旧行不得重启 row-settle(闪烁病根)
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-flk-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem('tgs-theme', 'linear');
  const now = 1730000000000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  const fakeTabs = [
    mk(101, 'https://a.example/1', '素材页一', 11, now - 60000),
    mk(102, 'https://a.example/2', '素材页二', 11, now - 30000, true),
    mk(103, 'https://a.example/3', '素材页三', 11, now - 90000),
    mk(201, 'https://b.example/1', '其他页一', 22, now - 3600000),
    mk(202, 'https://b.example/2', '其他页二', 22, now - 3700000)];
  fakeTabs[1].audible = true;
  chrome.tabs.query = async () => fakeTabs;
  chrome.tabGroups.query = async () => [
    { id: 11, title: '素材', color: 'blue', windowId: 1 },
    { id: 22, title: '其他', color: 'green', windowId: 1 }];
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
});
await page.goto(`chrome-extension://${id}/popup.html`);
await page.waitForSelector('.tab-item', { timeout: 10000 });
let pass = 0, fail = 0;
const chk = (n, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };
const countStarts = () => page.evaluate(() => {
  const seen = window.__seen || (window.__seen = new WeakSet());
  let n = 0;
  for (const el of document.querySelectorAll('#results .tab-item'))
    for (const a of el.getAnimations())
      if (a.animationName === 'row-settle' && !seen.has(a)) { seen.add(a); n++; }
  return n;
});
await page.evaluate(() => { window.__seen = new WeakSet(); });
for (const wait of [80, 300, 600]) {
  await page.waitForTimeout(wait);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const added = (await countStarts()) - (await countStarts());
  chk(`+${wait}ms 后 ⬇️ 不重启 row-settle`, added === 0);
}
const activeCount = await page.evaluate(() =>
  document.querySelectorAll('#results .tab-item.active').length);
chk(`active 行恰 1 个(${activeCount})`, activeCount === 1);
console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
