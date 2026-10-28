// 验证休眠 tab 唤起: discarded 的行被点击时, 扩展显式 reload(而不是落在空白帧)
// 注意: 点击行会 window.close(), reload 记录写 localStorage, 从常驻 helper 页读取
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-dsc-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };

const helper = await ctx.newPage(); // 常驻页: localStorage 读取端
await helper.goto(`chrome-extension://${id}/popup.html?win=1`);

const clickRow = async (title) => {
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    localStorage.setItem('tgs-theme', 'ink');
    localStorage.removeItem('tgs-reload-calls');
    const now = 1730000000000;
    const mk = (id, url, title, gid, la, active) => ({
      id, url, title, groupId: gid, windowId: 1, active: !!active,
      lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
    const fakeTabs = [
      mk(101, 'https://a.example/1', '素材页一', 11, now - 60000),
      mk(102, 'https://a.example/2', '休眠页二', 11, now - 30000, true)];
    fakeTabs[1].discarded = true;
    fakeTabs[1].status = 'unloaded';
    chrome.tabs.query = async () => fakeTabs;
    chrome.tabGroups.query = async () => [{ id: 11, title: '素材', color: 'blue', windowId: 1 }];
    chrome.windows.getCurrent = async () => ({ id: 1 });
    chrome.windows.update = async () => ({});
    chrome.runtime.sendMessage = async () => null;
    chrome.tabs.get = async (tid) => fakeTabs.find(t => t.id === tid) || null;
    chrome.tabs.update = async () => ({});
    chrome.tabs.reload = (tabId) => {
      const calls = JSON.parse(localStorage.getItem('tgs-reload-calls') || '[]');
      calls.push(tabId);
      localStorage.setItem('tgs-reload-calls', JSON.stringify(calls));
      return Promise.resolve();
    };
  });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  try {
    await p.evaluate((t) => {
      const row = [...document.querySelectorAll('#results .tab-item')].find(r => r.textContent.includes(t));
      row.click();
    }, title);
    await p.waitForTimeout(400); // window.close() 生效, 页面会关
  } catch (e) { /* 页面自关 = 正常 */ }
  const calls = await helper.evaluate(() =>
    JSON.parse(localStorage.getItem('tgs-reload-calls') || '[]'));
  await helper.evaluate(() => localStorage.removeItem('tgs-reload-calls'));
  return calls;
};

const calls1 = await clickRow('休眠页二');
chk(`discard 行被点击 → 显式 reload(${JSON.stringify(calls1)})`, calls1.includes(102));
const calls2 = await clickRow('素材页一');
chk(`正常行被点击 → 不多余 reload(${JSON.stringify(calls2)})`, !calls2.includes(101));

console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
