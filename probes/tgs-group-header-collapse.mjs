// tgs-group-header-collapse.mjs — 组里最后一个标签被删时, 分组头跟着行一起收
// 守: ① 单行删除清空组 → 头挂 .closing + 高度过渡(不再"愣一拍才消失")
//     ② 组里还有别的行 → 头不动
//     ③ ⌘⌫ 多选跨组整组选中 → 那个组的头跟着收
//     ④ 收起期间头还在 DOM(节点随重渲染退场), 演完重绘后头消失
//     ⑤ 减弱动态效果 → 不演, 直接重绘
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-ghc-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

// 数据: 组 11「素材」3 行 / 组 22「其他」1 行(单行删除清空组的主角) / 组 33「孤组」2 行
const INIT = ({ reduceMotion = false } = {}) => {
  localStorage.setItem('tgs-theme', 'linear');
  localStorage.setItem('tgs-deletekey', 'cmd-bs');
  const now = 1730000000000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  window.__tabs = [
    mk(101, 'https://a.example/1', '素材页一', 11, now - 60000),
    mk(102, 'https://a.example/2', '素材页二', 11, now - 30000, true),
    mk(103, 'https://a.example/3', '素材页三', 11, now - 90000),
    mk(201, 'https://b.example/1', '其他页一', 22, now - 3600000),
    mk(301, 'https://c.example/1', '孤组页一', 33, now - 7200000),
    mk(302, 'https://c.example/2', '孤组页二', 33, now - 7300000)];
  window.__groups = [
    { id: 11, title: '素材', color: 'blue', windowId: 1 },
    { id: 22, title: '其他', color: 'green', windowId: 1 },
    { id: 33, title: '孤组', color: 'red', windowId: 1 }];
  chrome.tabs.query = async () => window.__tabs;
  chrome.tabGroups.query = async () => window.__groups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
  chrome.tabs.get = async (tid) => window.__tabs.find(t => t.id === tid) || Promise.reject(new Error('no tab'));
  chrome.tabs.remove = async (ids) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
  };
  if (reduceMotion) {
    window.matchMedia = (q) => ({ matches: q.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} });
  }
};

async function openPopup(opts = {}) {
  const p = await ctx.newPage();
  await p.addInitScript(INIT, opts);
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(700); // 等入场播完
  return p;
}

const press = (p, key, mods = {}) => p.evaluate(({ key, mods }) => {
  const ev = new KeyboardEvent('keydown', {
    key, code: key === 'Backspace' ? 'Backspace' : `Key${key.toUpperCase()}`,
    ...mods, bubbles: true, cancelable: true });
  document.getElementById('search').dispatchEvent(ev);
}, { key, mods });

// 页面内采样: 各分组头状态(标题/.closing/高度/CSS 过渡)
const headersAt = (p) => p.evaluate(() =>
  [...document.querySelectorAll('.group-header')].map(h => {
    const cs = getComputedStyle(h);
    return {
      title: h.querySelector('.group-title')?.textContent,
      closing: h.classList.contains('closing'),
      h: h.getBoundingClientRect().height,
      op: Number(cs.opacity),
      trans: h.getAnimations().filter(a => a instanceof CSSTransition)
        .map(a => `${a.transitionProperty}:${a.effect.getTiming().duration}`),
    };
  }));

// 把键盘光标移到指定行(用 ↓ 逐行走, 从当前 active 起算最稳)
const moveCursorTo = async (p, tabId) => {
  await p.evaluate((tid) => {
    const rows = [...document.querySelectorAll('.tab-item')];
    const idx = rows.findIndex(r => r.dataset.tabId === String(tid));
    const cur = rows.findIndex(r => r.classList.contains('active'));
    const steps = idx - Math.max(cur, 0);
    const input = document.getElementById('search');
    for (let i = 0; i < Math.abs(steps); i++) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: steps > 0 ? 'ArrowDown' : 'ArrowUp', code: steps > 0 ? 'ArrowDown' : 'ArrowUp',
        bubbles: true, cancelable: true }));
    }
  }, tabId);
};

// ── [1] 单行删除清空组: 头跟着行一起收 ──
{
  const p = await openPopup();
  const h0 = await p.evaluate(() =>
    document.querySelector('.group-header')?.getBoundingClientRect().height ?? 0);
  // 「其他」组只有一行(201), 光标移过去后 ⌘⌫
  await moveCursorTo(p, 201);
  await press(p, 'Backspace', { metaKey: true });
  await p.waitForTimeout(150); // 收起进行中(头 delay 70ms + 340ms 过渡)
  const mid = await headersAt(p);
  const qiTa = mid.find(h => h.title === '其他');
  const suCai = mid.find(h => h.title === '素材');
  chk('[1] 收起中: 「其他」头挂 .closing', !!qiTa?.closing, JSON.stringify(qiTa));
  chk('[1] 收起中: 「其他」头 height 过渡在跑(340ms)',
    qiTa?.trans.some(t => t.startsWith('height:340')), qiTa?.trans.join(','));
  chk('[1] 收起中: 「其他」头高度已明显变矮但未归零', qiTa && qiTa.h > 0 && qiTa.h < h0 - 2, `h=${qiTa?.h} (初始 ${h0})`);
  chk('[1] 邻组「素材」头不动(还有 3 行)', suCai && !suCai.closing, JSON.stringify(suCai));
  await p.waitForTimeout(900); // 动画 + 重绘
  const after = await headersAt(p);
  chk('[1] 重绘后「其他」头消失', !after.find(h => h.title === '其他'), JSON.stringify(after.map(h => h.title)));
  chk('[1] 重绘后「素材」「孤组」头都在', ['素材', '孤组'].every(t => after.find(h => h.title === t)));
  const rows = await p.evaluate(() => document.querySelectorAll('.tab-item').length);
  chk('[1] 行数正确(3 素材 + 2 孤组 = 5)', rows === 5, `rows=${rows}`);
  await p.close();
}

// ── [2] 组里还有别的行: 头不动 ──
{
  const p = await openPopup();
  await moveCursorTo(p, 102); // 素材组中间一行
  await press(p, 'Backspace', { metaKey: true });
  await p.waitForTimeout(150);
  const mid = await headersAt(p);
  const suCai = mid.find(h => h.title === '素材');
  chk('[2] 组里还有别的行: 「素材」头不挂 .closing', suCai && !suCai.closing, JSON.stringify(suCai));
  await p.waitForTimeout(700);
  const after = await headersAt(p);
  chk('[2] 重绘后「素材」头还在(剩 2 行)', !!after.find(h => h.title === '素材'));
  await p.close();
}

// ── [3] ⌘⌫ 多选跨组: 整组选中的组头跟着收 ──
{
  const p = await openPopup();
  // Shift 点选孤组两行 + 素材一行 → 孤组整组被清, 头收; 素材组头不动
  await p.click('.tab-item[data-tab-id="301"]', { modifiers: ['Shift'] });
  await p.click('.tab-item[data-tab-id="302"]', { modifiers: ['Shift'] });
  await p.click('.tab-item[data-tab-id="101"]', { modifiers: ['Shift'] });
  await press(p, 'Backspace', { metaKey: true });
  await p.waitForTimeout(250); // 多行 70ms 错峰进行中
  const mid = await headersAt(p);
  const guZu = mid.find(h => h.title === '孤组');
  const suCai = mid.find(h => h.title === '素材');
  chk('[3] 多选清空「孤组」: 头挂 .closing', !!guZu?.closing, JSON.stringify(guZu));
  chk('[3] 「素材」组还剩 2 行: 头不动', suCai && !suCai.closing, JSON.stringify(suCai));
  await p.waitForTimeout(1400);
  const after = await headersAt(p);
  chk('[3] 重绘后「孤组」头消失', !after.find(h => h.title === '孤组'), JSON.stringify(after.map(h => h.title)));
  chk('[3] 重绘后「素材」头还在', !!after.find(h => h.title === '素材'));
  const rows = await p.evaluate(() => document.querySelectorAll('.tab-item').length);
  chk('[3] 行数正确(2 素材 + 1 其他 = 3)', rows === 3, `rows=${rows}`);
  await p.close();
}

// ── [4] 减弱动态效果: 不演, 直接重绘 ──
{
  const p = await openPopup({ reduceMotion: true });
  await moveCursorTo(p, 201);
  await press(p, 'Backspace', { metaKey: true });
  await p.waitForTimeout(200);
  const after = await headersAt(p);
  chk('[4] 减弱动态: 头直接消失(无 .closing 残留)', !after.find(h => h.title === '其他'), JSON.stringify(after.map(h => h.title)));
  await p.close();
}

await ctx.close();
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
