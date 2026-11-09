// tgs-undo-expand.mjs — 撤销删除(⌘Z)的展开动画
// 守: ① 撤销恢复的行先以 .expanding 出现, height 0 → 自然高度(340ms 过渡, 与收起同参)
//     ② 伴随透明度 0 → 1 / 位移 translateX(16px) → 0
//     ③ 批量撤销多行错峰(transitionDelay 70ms 节拍, 总跨度 ≤ 420ms)
//     ④ 演完清场: 摘 .expanding + 抹掉全部内联样式(不留固定高)
//     ⑤ prefers-reduced-motion: 不演, 行直接落位
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const OUT = '/tmp/tgs-undo-expand';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-ux-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

// 页面内假数据: 关标签真的从假表里删, 撤销真的往假表里建(否则重渲染会把刚关的行"复活")
const INIT = ({ tabCount }) => {
  localStorage.setItem('tgs-theme', 'linear');
  localStorage.setItem('tgs-deletekey', 'cmd-bs');
  const now = 1730000000000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  window.__tabs = [];
  for (let i = 0; i < tabCount; i++) {
    window.__tabs.push(mk(101 + i, `https://a.example/${i}`, `素材页${i + 1}`, 11,
      now - 60000 - i * 1000, i === tabCount - 1));
  }
  window.__nextId = 900;
  const groups = [{ id: 11, title: '素材', color: 'blue', windowId: 1 }];
  chrome.tabs.query = async () => window.__tabs;
  chrome.tabGroups.query = async (q) => (q && q.title && q.title !== '素材' ? [] : groups);
  chrome.windows.getCurrent = async () => ({ id: 1, type: 'normal' });
  chrome.windows.getAll = async () => [{ id: 1, type: 'normal', focused: true }];
  chrome.runtime.sendMessage = async () => null;
  chrome.tabs.get = async (tid) => window.__tabs.find(t => t.id === tid) || Promise.reject(new Error('no tab'));
  chrome.tabs.remove = async (ids) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
  };
  chrome.tabs.create = async (props) => {
    const t = { id: window.__nextId++, url: props.url, title: 'Loading...',
      groupId: props.windowId ? -1 : -1, windowId: props.windowId || 1, active: false,
      lastAccessed: Date.now(), status: 'complete', audible: false, discarded: false, index: 0 };
    window.__tabs.push(t);
    return { ...t };
  };
  chrome.tabs.group = async (opts) => {
    const gid = opts.groupId || 77;
    for (const tid of opts.tabIds) {
      const t = window.__tabs.find(x => x.id === tid);
      if (t) t.groupId = gid;
    }
    return gid;
  };
  chrome.tabGroups.update = async () => {};
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  } catch (e) {}
};

async function openPopup(tabCount = 4, opts = {}) {
  const p = await ctx.newPage();
  if (opts.reducedMotion) await p.emulateMedia({ reducedMotion: 'reduce' });
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.addInitScript(INIT, { tabCount });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(700); // 等入场播完(body.entrance 摘掉)
  return p;
}

// 在页面里: 关掉当前选中行 → 等收起演完 → 按 ⌘Z → 定时采样(不依赖 rAF, 弹窗页 rAF 会被节流)
const closeThenUndoAndSample = ({ closeCount = 1, sampleAt = [] }) => {
  const key = (k, mods = {}) => document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
    key: k, code: k === 'Backspace' ? 'Backspace' : `Key${k.toUpperCase()}`,
    bubbles: true, cancelable: true, ...mods }));
  const snap = () => ({
    rows: [...document.querySelectorAll('.tab-item')].map(r => {
      const cs = getComputedStyle(r);
      return {
        id: Number(r.dataset.tabId),
        expanding: r.classList.contains('expanding'),
        h: r.offsetHeight,
        op: Number(cs.opacity),
        tx: (() => { const m = cs.transform.match(/matrix\(([^)]+)\)/); return m ? Number(m[1].split(',')[4]) : 0; })(),
        delay: parseFloat(cs.transitionDelay) || 0,
        transitions: r.getAnimations().filter(a => a instanceof CSSTransition)
          .map(a => `${a.transitionProperty}:${a.effect.getTiming().duration}`),
        inlineHeight: r.style.height,
      };
    }),
  });
  return (async () => {
    const beforeIds = [...document.querySelectorAll('.tab-item')].map(r => Number(r.dataset.tabId));
    const closedIds = [];
    for (let i = 0; i < closeCount; i++) {
      closedIds.push(...[...document.querySelectorAll('.tab-item.active')].map(r => Number(r.dataset.tabId)));
      key('Backspace', { metaKey: true });
      await new Promise(r => setTimeout(r, 700)); // 收起 340ms + 重渲染
    }
    const restoredIds = window.__tabs.map(t => t.id).filter(x => !beforeIds.includes(x));
    const t0 = performance.now();
    key('z', { metaKey: true });
    const samples = [];
    for (const at of sampleAt) {
      const wait = at - (performance.now() - t0);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      samples.push({ at: Math.round(performance.now() - t0), ...snap() });
    }
    return { beforeIds, closedIds, 
      // 撤销建出来的标签 id = 演完时的全集 - 撤销前的全集
      restoredIds: window.__tabs.map(t => t.id).filter(x => !beforeIds.includes(x)),
      samples,
      tabsNow: window.__tabs.map(t => t.id) };
  })();
};

// ── 1. 单行撤销: 从 0 高展开回自然高度 ──
{
  console.log('\n[1] 撤销单行删除的展开动画');
  const p = await openPopup(4);
  const h0 = await p.evaluate(() => document.querySelector('.tab-item').offsetHeight);
  const r = await p.evaluate(closeThenUndoAndSample,
    { closeCount: 1, sampleAt: [30, 90, 160, 240, 330, 430, 800] });
  chk('撤销真的把标签建回来了', r.restoredIds.length === 1, `restored=${r.restoredIds.join(',')}`);
  const rid = r.restoredIds[0];
  const pick = (s) => s.rows.find(x => x.id === rid) || {};
  const s30 = pick(r.samples.find(s => s.at >= 30) || {});
  const s90 = pick(r.samples.find(s => s.at >= 90) || {});
  const s160 = pick(r.samples.find(s => s.at >= 160) || {});
  const s240 = pick(r.samples.find(s => s.at >= 240) || {});
  const s800 = pick(r.samples.find(s => s.at >= 780) || r.samples[r.samples.length - 1]);
  chk('恢复的行先以 .expanding 出现', s30.expanding === true);
  chk('height 过渡真的在跑(0.34s, 与收起同参)',
    (s30.transitions || s90.transitions || []).some(t => t.startsWith('height:340')),
    `${s30.transitions || s90.transitions}`);
  chk('高度从近 0 逐步长到自然高',
    s30.h < h0 && s160.h > s30.h && s240.h > s160.h,
    `h0=${h0} → 30ms:${s30.h} → 160ms:${s160.h} → 240ms:${s240.h} → 800ms:${s800.h}`);
  chk('伴随淡入(opacity 0 → 1)', s30.op < 1 && (s240.op > s30.op), `30ms=${s30.op} → 240ms=${s240.op}`);
  chk('伴随位移(从右侧 translateX>0 滑到 0)', s30.tx > 0.5 && Math.abs(s800.tx) < 0.5,
    `30ms tx=${s30.tx} → 800ms tx=${s800.tx}`);
  chk('演完高度 = 自然行高', s800.h === h0, `${s800.h} vs ${h0}`);
  chk('演完摘掉 .expanding + 抹干净内联样式',
    s800.expanding === false && !s800.inlineHeight, `inline=${JSON.stringify(s800.inlineHeight)}`);
  await p.screenshot({ path: `${OUT}-single.png`, clip: { x: 0, y: 0, width: 480, height: 320 } });
  await p.close();
}

// ── 2. 批量撤销: 多行同时展开 + 70ms 错峰 ──
{
  console.log('\n[2] 批量撤销的错峰展开');
  const p = await openPopup(4);
  const r = await p.evaluate(closeThenUndoAndSample,
    { closeCount: 2, sampleAt: [60, 140, 900] });
  chk('一次撤销建回两个标签', r.restoredIds.length === 2, `restored=${r.restoredIds.join(',')}`);
  const mid = r.samples.find(s => s.at >= 60);
  const exp = mid.rows.filter(x => x.expanding);
  chk('两行同时处于 .expanding', exp.length === 2, `expanding=${exp.length}`);
  const delays = exp.map(x => Math.round(x.delay * 1000));
  chk('错峰 delay 递增(70ms 节拍)',
    delays.length > 1 && delays.every((d, i) => i === 0 || d > delays[i - 1]), `delays=${delays.join(',')}ms`);
  chk('总错峰跨度 ≤ 420ms 封顶', Math.max(...delays) <= 420, `max=${Math.max(...delays)}ms`);
  const late = r.samples.find(s => s.at >= 880) || r.samples[r.samples.length - 1];
  chk('批量撤销演完后也清场', late.rows.every(x => !x.expanding && !x.inlineHeight));
  await p.close();
}

// ── 3. prefers-reduced-motion: 不演, 直接落位 ──
{
  console.log('\n[3] prefers-reduced-motion 降级');
  const p = await openPopup(4, { reducedMotion: true });
  const h0 = await p.evaluate(() => document.querySelector('.tab-item').offsetHeight);
  const r = await p.evaluate(closeThenUndoAndSample, { closeCount: 1, sampleAt: [40] });
  const rid = r.restoredIds[0];
  const seen = r.samples[0].rows.find(x => x.id === rid) || {};
  chk('减弱动态效果下不挂 .expanding', seen.expanding === false);
  chk('行直接以自然高度出现(40ms 内)', seen.h === h0, `h=${seen.h} vs ${h0}`);
  await p.close();
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
