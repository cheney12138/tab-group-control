// 验证位置策略: 指针可查→跟随; 拿不到→聚焦普通窗口居中; 宽高记忆
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-anc-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };
const findWin = () => sw.evaluate(async () => {
  const ws = await chrome.windows.getAll();
  return ws.find(w => w.type === 'popup') || null;
});
const helper = await ctx.newPage();
await helper.goto(`chrome-extension://${id}/popup.html?win=1`);
const send = (msg) => helper.evaluate((m) => new Promise(res => {
  try { chrome.runtime.sendMessage(m, r => res(chrome.runtime.lastError?.message || JSON.stringify(r))); }
  catch (e) { res(String(e)); }
}), msg);
const norm = await sw.evaluate(async () => {
  const w = await chrome.windows.create({ url: 'https://example.com', type: 'normal', width: 800, height: 600, left: 100, top: 100 });
  return { id: w.id, left: w.left, top: w.top, width: w.width, height: w.height };
});
await sw.evaluate(() => chrome.storage.local.remove('standaloneBounds'));
await new Promise(r => setTimeout(r, 500));
await send({ type: 'open-standalone' });
await new Promise(r => setTimeout(r, 1200));
let w = await findWin();
const expL = Math.round(norm.left + (norm.width - 480) / 2), expT = Math.round(norm.top + (norm.height - 520) / 2);
chk(`尺寸 480×520(${w?.width}×${w?.height})`, w?.width === 480 && w?.height === 520);
chk(`居中(实际 ${w?.left},${w?.top}, 期望≈${expL},${expT})`,
    Math.abs(w?.left - expL) <= 60 && Math.abs(w?.top - expT) <= 60);
await sw.evaluate((wid) => chrome.windows.update(wid, { width: 700, height: 600 }), w.id);
await new Promise(r => setTimeout(r, 500));
await sw.evaluate((wid) => chrome.windows.remove(wid), w.id);
await new Promise(r => setTimeout(r, 1200));
await send({ type: 'open-standalone' });
await new Promise(r => setTimeout(r, 1200));
w = await findWin();
chk(`宽高记忆(${w?.width}×${w?.height} = 700×600)`, w?.width === 700 && w?.height === 600);
console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
