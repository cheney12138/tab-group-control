// tgs-verify.mjs (2026-10-25 重建) — 核心不变量:
// row-settle 0.5s / 揭纱 ink-in / ⬇️不重启 / 帮助卡键帽 / 主题不透明底 / wave-icon
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-ver-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}`); };

const FAKES = () => {
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
  const fakeGroups = [
    { id: 11, title: '素材', color: 'blue', windowId: 1 },
    { id: 22, title: '其他', color: 'green', windowId: 1 }];
  chrome.tabs.query = async () => fakeTabs;
  chrome.tabGroups.query = async () => fakeGroups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
};

async function openPopup(theme) {
  const p = await ctx.newPage();
  await p.addInitScript((th) => {
    localStorage.setItem('tgs-theme', th);
const FAKES = () => {
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
  const fakeGroups = [
    { id: 11, title: '素材', color: 'blue', windowId: 1 },
    { id: 22, title: '其他', color: 'green', windowId: 1 }];
  fakeTabs[1].audible = true; // 素材页二在播 → wave-icon
  chrome.tabs.query = async () => fakeTabs;
  chrome.tabGroups.query = async () => fakeGroups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
};
  FAKES();
  }, theme);
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  return p;
}

// ── 1. 入场编排 ──
{
  const p = await openPopup('linear');
  const st = await p.evaluate(() => {
    document.body.classList.add('entrance');
    const el = document.createElement('div');
    el.className = 'tab-item';
    document.querySelector('#results').appendChild(el);
    const cs = getComputedStyle(el);
    const out = { name: cs.animationName, dur: cs.animationDuration, ease: cs.animationTimingFunction };
    el.remove();
    document.body.classList.remove('entrance');
    const ink = document.querySelector('#results');
    out.ink = ink.classList.contains('ink-in') &&
      !!ink.getAnimations().find(x => x.animationName === 'results-ink');
    return out;
  });
  chk(`动画名 row-settle(${st.name} ${st.dur})`, st.name === 'row-settle' && st.dur === '0.5s');
  chk(`曲线 ease-out(${st.ease})`, (st.ease || '').includes('ease-out'));
  chk('揭纱 ink-in 挂上(results-ink)', st.ink);
  const headAnim = await p.evaluate(() =>
    [...document.querySelectorAll('#results .group-header')].flatMap(h => h.getAnimations().map(a => a.animationName)));
  chk('组头不参与入场动画', headAnim.length === 0);

  // ── 2. ⬇️ 导航: 旧行不得重启 row-settle ──
  const countStarts = async () => p.evaluate(() => {
    const seen = window.__seen || (window.__seen = new WeakSet());
    let n = 0;
    for (const el of document.querySelectorAll('#results .tab-item'))
      for (const a of el.getAnimations())
        if (a.animationName === 'row-settle' && !seen.has(a)) { seen.add(a); n++; }
    return n;
  });
  await p.evaluate(() => { window.__seen = new WeakSet(); });
  const before = await countStarts();
  await p.keyboard.press('ArrowDown');
  await p.waitForTimeout(150);
  const after = await countStarts();
  chk(`⬇️ 不重启 row-settle(${after - before} 个新启动)`, after - before === 0);

  // ── 3. 帮助卡 ──
  const kbd = await p.evaluate(() => {
    const caps = document.querySelectorAll('.help-card .kbd').length;
    const group = document.querySelector('.sbtn .keycaps');
    const ks = group ? [...group.querySelectorAll('.kbd')] : [];
    const spread = ks.length >= 2 ? ks[1].getBoundingClientRect().left - ks[0].getBoundingClientRect().right : -1;
    return { caps, group: !!group, spread };
  });
  chk(`帮助卡键帽 ${kbd.caps} 个(≥20)`, kbd.caps >= 20);
  chk(`设置行键帽组不拆分(间距 ${Math.round(kbd.spread)}px ≤ 12)`, kbd.group && kbd.spread >= 0 && kbd.spread <= 12);
  await p.close();
}

// ── 4. 主题: ink #results 不透明 / sky body 不透明 ──
{
  const p = await openPopup('ink');
  const bg = await p.evaluate(() => getComputedStyle(document.querySelector('#results')).backgroundColor);
  const c = bg.match(/\d+/g)?.map(Number) || [];
  chk(`ink: #results 不透明(${bg})`, c.length === 4 ? c[3] === 1 : bg !== 'rgba(0, 0, 0, 0)');
  await p.close();
}
{
  const p = await openPopup('sky');
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const c = bg.match(/\d+/g)?.map(Number) || [];
  chk(`sky: body 不透明(${bg})`, c.length === 4 ? c[3] === 1 : bg !== 'rgba(0, 0, 0, 0)');
  await p.close();
}

// ── 5. 有声行 wave-icon ──
{
  const p = await openPopup('linear');
  const waves = await p.evaluate(() => document.querySelectorAll('#results .tab-item .wave-icon').length);
  console.log('  [dbg] wave-icon:', waves);
  chk(`有声行 wave-icon(实际 ${waves})`, waves === 1);
  await p.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
