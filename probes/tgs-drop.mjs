// tgs-drop.mjs (重建) — 入场动效断言:
// ①揭纱(results-ink: opacity+scale, 无 filter) ②row-settle 0.5s ③级联压缩 650ms ④节拍单调
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-drp-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };

const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem('tgs-theme', 'ink');
  const now = 1730000000000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  const fakeTabs = [], fakeGroups = [];
  for (let g = 1; g <= 13; g++) {
    fakeGroups.push({ id: g, title: '组' + g, color: 'grey', windowId: 1 });
    for (let r = 0; r < 5; r++) fakeTabs.push(mk(g * 10 + r, `https://g${g}.example/${r}`, `组${g}页${r}`, g, now - r * 1000));
  }
  fakeTabs[2].active = true;
  chrome.tabs.query = async () => fakeTabs;
  chrome.tabGroups.query = async () => fakeGroups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
});
await page.goto(`chrome-extension://${id}/popup.html`);
await page.waitForSelector('.tab-item', { timeout: 10000 });

// ① 合成元素读计算样式(不跟动画赛跑)
const probe = await page.evaluate(() => {
  document.body.classList.add('entrance');
  const el = document.createElement('div');
  el.className = 'tab-item';
  document.querySelector('#results').appendChild(el);
  const cs = getComputedStyle(el);
  const res = { name: cs.animationName, dur: cs.animationDuration };
  el.remove();
  document.body.classList.remove('entrance');
  return res;
});
chk(`动画名 row-settle(${probe.name} ${probe.dur})`, probe.name === 'row-settle' && probe.dur === '0.5s');

// ② 揭纱动画: results-ink 挂上, from 有 scale 无 filter
const ink = await page.evaluate(() => {
  const el = document.querySelector('#results');
  const kf = el.getAnimations().find(x => x.animationName === 'results-ink')
    ?.effect.getKeyframes().find(k => k.offset === 0);
  return { has: el.classList.contains('ink-in'), name: getComputedStyle(el).animationName,
    fromFilter: kf?.filter ?? '无', fromScale: kf?.transform ?? '无' };
});
chk(`揭纱挂上(${ink.name}, from ${ink.fromScale}, filter ${ink.fromFilter})`,
    ink.has && ink.name === 'results-ink' && ink.fromFilter === '无' && ink.fromScale.includes('scale'));

// ③ 级联压缩 + 节拍
const delays = await page.evaluate(() =>
  [...document.querySelectorAll('#results .tab-item')].map(r => parseFloat(r.style.animationDelay) || 0));
const maxD = Math.max(...delays);
chk(`大列表(${delays.length} 行)最大延迟 ${maxD}ms ≤ 650`, maxD <= 650 && maxD > 0);
const diffs = delays.slice(1).map((d, i) => d - delays[i]).filter(d => d > 0);
chk(`行间节拍 ≥ 10ms(47 行真实列表 13.8ms; 此处 ${Math.min(...diffs)}ms)`, Math.min(...diffs) >= 10);
chk('顺序保持(DOM 序延迟单调不减)', delays.every((d, i) => i === 0 || d >= delays[i - 1]));

console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
