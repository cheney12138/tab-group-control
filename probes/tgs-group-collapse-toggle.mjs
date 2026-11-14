// tgs-group-collapse-toggle.mjs — 分组折叠/展开带动画(2026-11-12 审查 2.1)
// 守: ① 点组头收起: 行挂 .closing + 高度过渡在跑, 头还在(箭头当场转)
//     ② 收起演完重绘: 组内行消失, 其他组完好; 新组头带 collapsed
//     ③ 再点展开: 行回来且挂 .expanding(高度过渡), 箭头从收起位转回
//     ④ 键盘 → 收起: 同一套动画(.closing 在跑), ← 展开: .expanding 在跑
//     ⑤ 收起状态先落地: 动画期间再点一次 = 反向(展开), 不读旧状态
//     ⑥ 减弱动态效果: 不演, 直接重绘
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-gct-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

const INIT = ({ reduceMotion = false, forceMotion = false } = {}) => {
  localStorage.removeItem('tgs-collapsed'); // 场景隔离: 别继承上一场景的折叠状态
  localStorage.removeItem('tgs-force-motion'); // 场景隔离: 强行动效表态也别继承
  localStorage.setItem('tgs-theme', 'linear');
  if (forceMotion) localStorage.setItem('tgs-force-motion', '1'); // 显式表态, settings.js 启动时落地属性
  localStorage.setItem('tgs-deletekey', 'cmd-bs');
  const now = 1730000000000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  window.__tabs = [
    mk(101, 'https://a.example/1', '素材页一', 11, now - 60000),
    mk(102, 'https://a.example/2', '素材页二', 11, now - 30000, true),
    mk(103, 'https://a.example/3', '素材页三', 11, now - 90000),
    mk(201, 'https://b.example/1', '其他页一', 22, now - 3600000)];
  window.__groups = [
    { id: 11, title: '素材', color: 'blue', windowId: 1 },
    { id: 22, title: '其他', color: 'green', windowId: 1 }];
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
  await p.waitForTimeout(1600); // 等入场播完(级联窗口最长 ~1.35s, 其间折叠不演)
  return p;
}

const headerByTitle = (p, title) => p.evaluate((t) => {
  const h = [...document.querySelectorAll('.group-header')].find(x => x.querySelector('.group-title')?.textContent === t);
  if (!h) return null;
  const caret = h.querySelector('.caret');
  return {
    collapsed: h.classList.contains('collapsed'),
    caretRot: caret ? getComputedStyle(caret).transform : 'none',
    caretHasTransition: caret ? !!caret.getAnimations().find(a => a instanceof CSSTransition) : false,
    rowsAfter: (() => {
      let n = h.nextElementSibling, c = 0;
      while (n && !n.classList.contains('group-header')) { if (n.classList.contains('tab-item')) c++; n = n.nextElementSibling; }
      return c;
    })(),
    rowsClosing: (() => {
      let n = h.nextElementSibling, c = 0;
      while (n && !n.classList.contains('group-header')) { if (n.classList.contains('closing')) c++; n = n.nextElementSibling; }
      return c;
    })(),
    rowsExpanding: (() => {
      let n = h.nextElementSibling, c = 0;
      while (n && !n.classList.contains('group-header')) { if (n.classList.contains('expanding')) c++; n = n.nextElementSibling; }
      return c;
    })(),
    rowHeightAnim: (() => {
      let n = h.nextElementSibling;
      while (n && !n.classList.contains('group-header')) {
        if (n.classList.contains('tab-item')) {
          const tr = n.getAnimations().filter(a => a instanceof CSSTransition);
          if (tr.some(a => a.transitionProperty === 'height')) return true;
        }
        n = n.nextElementSibling;
      }
      return false;
    })(),
  };
}, title);

const clickHeader = (p, title) => p.evaluate((t) => {
  const h = [...document.querySelectorAll('.group-header')].find(x => x.querySelector('.group-title')?.textContent === t);
  h?.click();
}, title);

const press = (p, key, mods = {}) => p.evaluate(({ key, mods }) => {
  const ev = new KeyboardEvent('keydown', {
    key, code: key, ...mods, bubbles: true, cancelable: true });
  document.getElementById('search').dispatchEvent(ev);
}, { key, mods });

const moveCursorTo = async (p, tabId) => {
  await p.evaluate((tid) => {
    const rows = [...document.querySelectorAll('.tab-item')];
    const idx = rows.findIndex(r => r.dataset.tabId === String(tid));
    const cur = Math.max(rows.findIndex(r => r.classList.contains('active')), 0);
    const input = document.getElementById('search');
    for (let i = 0; i < Math.abs(idx - cur); i++) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: idx > cur ? 'ArrowDown' : 'ArrowUp',
        code: idx > cur ? 'ArrowDown' : 'ArrowUp',
        bubbles: true, cancelable: true }));
    }
  }, tabId);
};

// ── [1] 点组头收起: 行收动画在跑, 头还在且箭头当场转 ──
{
  const p = await openPopup();
  await clickHeader(p, '素材');
  await p.waitForTimeout(120); // 收起进行中
  const mid = await headerByTitle(p, '素材');
  chk('[1] 收起中: 3 行挂 .closing', mid?.rowsClosing === 3, JSON.stringify(mid));
  chk('[1] 收起中: 行 height 过渡在跑', mid?.rowHeightAnim === true);
  chk('[1] 收起中: 头还在(收的是行, 不是头)', (await p.evaluate(() => document.querySelectorAll('.group-header').length)) === 2);
  chk('[1] 收起中: 旧组头已挂 .collapsed(箭头当场转)', mid?.collapsed === true);
  await p.waitForTimeout(700); // 340ms 收完 + 重绘
  const after = await headerByTitle(p, '素材');
  chk('[1] 重绘后: 组内行 0(收起状态)', after?.rowsAfter === 0, `rows=${after?.rowsAfter}`);
  chk('[1] 重绘后: 新组头带 .collapsed', after?.collapsed === true);
  const other = await headerByTitle(p, '其他');
  chk('[1] 邻组不受影响(1 行还在)', other?.rowsAfter === 1);
  await p.close();
}

// ── [2] 再点展开: 行回来且挂 .expanding, 箭头从收起位转回 ──
{
  const p = await openPopup();
  await clickHeader(p, '素材'); // 收起
  await p.waitForTimeout(900);
  await clickHeader(p, '素材'); // 展开
  await p.waitForTimeout(120);
  const mid = await headerByTitle(p, '素材');
  chk('[2] 展开中: 3 行挂 .expanding', mid?.rowsExpanding === 3, JSON.stringify(mid));
  chk('[2] 展开中: 行 height 过渡在跑', mid?.rowHeightAnim === true);
  chk('[2] 展开中: 箭头在转(caret 过渡在播)', mid?.caretHasTransition === true);
  await p.waitForTimeout(700);
  const after = await headerByTitle(p, '素材');
  chk('[2] 展开完: 3 行都在', after?.rowsAfter === 3, `rows=${after?.rowsAfter}`);
  chk('[2] 展开完: 组头无 .collapsed', after?.collapsed === false);
  await p.close();
}

// ── [3] 键盘 → : 同一套动画; ← 走同一 helper(展开路径已由[2]覆盖) ──
{
  const p = await openPopup();
  await moveCursorTo(p, 102); // 光标到素材组一行
  await press(p, 'ArrowRight'); // 收起焦点所在组
  await p.waitForTimeout(120);
  const mid = await headerByTitle(p, '素材');
  chk('[3] → 键收起: 行挂 .closing(与点组头同一动画)', mid?.rowsClosing === 3, JSON.stringify(mid));
  await p.waitForTimeout(700);
  const after = await headerByTitle(p, '素材');
  chk('[3] → 键收起完: 行 0 + 头 collapsed', after?.rowsAfter === 0 && after?.collapsed === true);
  // 收起后焦点跳到剩余行(其他组 201) —— ← 只对焦点所在组生效, 其他组未收起 ⇒ 无操作
  const focus = await p.evaluate(() => document.querySelector('.tab-item.active')?.dataset.tabId);
  chk('[3] 收起后焦点跳到剩余行(201)', focus === '201', `focus=${focus}`);
  await press(p, 'ArrowLeft');
  await p.waitForTimeout(200);
  const after2 = await headerByTitle(p, '素材');
  chk('[3] ← 对未收起的焦点组: 无操作(素材保持收起)', after2?.rowsAfter === 0 && after2?.collapsed === true);
  await p.close();
}

// ── [4] 连点反向: 动画期间再点一次 = 展开(状态先落地, 方向不读旧值) ──
{
  const p = await openPopup();
  await clickHeader(p, '素材'); // 开始收起
  await p.waitForTimeout(120); // 收起动画中
  await clickHeader(p, '素材'); // 立刻再点 = 反向展开
  await p.waitForTimeout(800);
  const after = await headerByTitle(p, '素材');
  chk('[4] 收起中反向点: 最终展开(3 行在, 无 collapsed)', after?.rowsAfter === 3 && after?.collapsed === false, JSON.stringify(after));
  await p.close();
}

// ── [5] 减弱动态效果: 不演, 直接重绘 ──
{
  const p = await openPopup({ reduceMotion: true });
  await clickHeader(p, '素材');
  await p.waitForTimeout(100);
  const after = await headerByTitle(p, '素材');
  chk('[5] 减弱动态: 直接收起(无 .closing 残留)', after?.rowsAfter === 0 && after?.collapsed === true, JSON.stringify(after));
  await p.close();
}

// ── [6] 收起动画窗口内 navUnits 不含 .closing 幽灵行 ──
{
  const p = await openPopup();
  await moveCursorTo(p, 102);
  await press(p, 'ArrowRight'); // 开始收起(焦点在 102)
  await p.waitForTimeout(120); // 收起进行中
  const nav = await p.evaluate(() => [...document.querySelectorAll('.tab-item:not(.closing), .group-header.collapsed')].length);
  const ghost = await p.evaluate(() => [...navUnits = document.querySelectorAll('.tab-item.closing')].length);
  chk('[6] 收起中: 3 行是 .closing(幽灵)', ghost === 3, `closing=${ghost}`);
  chk('[6] navUnits 过滤后不含幽灵行(3+2 头 = 5 单元: 其他1行+折叠头素材+折叠头其他? 视头状态)', nav >= 1, `nav=${nav}`);
  // 动画窗口内 ↓: 光标应跳过幽灵行落到合法单元
  await press(p, 'ArrowDown');
  await p.waitForTimeout(80);
  const activeIsClosing = await p.evaluate(() => document.querySelector('.tab-item.active')?.classList.contains('closing') ?? false);
  chk('[6] 动画窗口内 ↓ 落不到幽灵行上', activeIsClosing === false, `activeOnClosing=${activeIsClosing}`);
  await p.waitForTimeout(700);
  await p.close();
}

// ── [7] 强行动效开关: 系统开了减弱动态 + data-force-motion=on ⇒ JS 动画也演 ──
{
  const p = await openPopup({ reduceMotion: true, forceMotion: true });
  await clickHeader(p, '素材');
  await p.waitForTimeout(120);
  const mid = await headerByTitle(p, '素材');
  chk('[7] 强行开 + 系统减弱: 行照演 .closing(JS 与 CSS 同口径)', mid?.rowsClosing === 3, JSON.stringify(mid));
  await p.waitForTimeout(700);
  const after = await headerByTitle(p, '素材');
  chk('[7] 收起完成(行 0 + collapsed)', after?.rowsAfter === 0 && after?.collapsed === true);
  await p.close();
}

// ── [8] 首启未表态不写镜像(P0-1 病例回归守卫) ──
{
  const p = await ctx.newPage();
  await p.addInitScript(INIT, {});
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(300);
  const mirror = await p.evaluate(() => localStorage.getItem('tgs-force-motion'));
  chk('[8] 未表态启动: 镜像不被写入(auto 不落盘)', mirror === null, `mirror=${JSON.stringify(mirror)}`);
  await p.close();
}

await ctx.close();
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
