// tgs-caret.mjs (2026-11-03) — 方块光标不变量:
//   ① 原生 caret 透明 + 细竖线在场(宽 2px, 不是贴字宽的方块)
//   ② 打字后 x = 插入点文本宽度(±3px)
//   ③ 打字期间不闪, 停手 420ms 后挂 .blink
//   ④ 换位置是补间滑行: 中间帧存在非端点 x(顿跳只会有 2 个 x)
//   ⑤ blur 隐藏 / 拼音组合期间交还原生 caret
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-caret-${Date.now()}`, {
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
    mk(102, 'https://a.example/2', '素材页二', 11, now - 30000, true)];
  chrome.tabs.query = async () => fakeTabs;
  chrome.tabGroups.query = async () => [{ id: 11, title: '素材', color: 'blue', windowId: 1 }];
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
};

const p = await ctx.newPage();
await p.addInitScript((fakesSrc) => {
  localStorage.setItem('tgs-theme', 'linear');
  eval(`(${fakesSrc})`)();
  localStorage.setItem('tgs-theme', 'linear');
}, FAKES.toString());
await p.goto(`chrome-extension://${id}/popup.html`);
await p.waitForSelector('.tab-item', { timeout: 10000 });

const readCaret = () => p.evaluate(() => {
  const input = document.getElementById('search');
  const caret = document.getElementById('smoothCaret');
  const cs = getComputedStyle(input);
  const ctx2 = document.createElement('canvas').getContext('2d');
  ctx2.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const ch = input.value[pos] || input.value[pos - 1] || 'x';
  const inputRect = input.getBoundingClientRect();
  const wrapRect = input.closest('.search-wrap').getBoundingClientRect();
  const boxLeft = inputRect.left - wrapRect.left + (parseFloat(cs.paddingLeft) || 0);
  const caretRect = caret.getBoundingClientRect();
  return {
    caretColor: cs.caretColor,
    // 方块左沿相对 wrap 的位移(transform 已作用在 rect 上)
    caretX: caretRect.left - wrapRect.left,
    expectedX: boxLeft + ctx2.measureText(before).width - input.scrollLeft,
    caretW: caretRect.width,
    charW: ctx2.measureText(ch).width,
    on: caret.classList.contains('on'),
    blink: caret.classList.contains('blink'),
    width: caretRect.width,
    glide: getComputedStyle(caret).transition,
    height: caretRect.height,
    inputH: inputRect.height,
    pos,
  };
});

// ① 初始: 原生 caret 透明, 方块在场
{
  await p.click('#search');
  await p.waitForTimeout(150);
  const st = await readCaret();
  chk(`原生 caret 透明(${st.caretColor})`, st.caretColor === 'rgba(0, 0, 0, 0)' || st.caretColor === 'transparent');
  chk('光标在场(.on)', st.on);
  chk(`是细竖线不是方块(宽 ${st.width.toFixed(2)}px)`, st.width >= 1.5 && st.width <= 2.5);
  // 竖线高 = 一行字高(行盒), 不是含 padding 的整个输入框
  chk(`竖线高 ≈ 行高(${st.height.toFixed(1)}px, 输入框 ${st.inputH}px 含 7px 上下 padding)`,
    st.height >= 12 && st.height <= st.inputH - 12);
  chk('位移带补间(transition 含 transform 90ms)', /transform/.test(st.glide) && /0\.09s|90ms/.test(st.glide));
}

// ② 打字后位置对得上
{
  await p.type('#search', 'ab', { delay: 60 });
  await p.waitForTimeout(120);
  const st = await readCaret();
  chk(`打字后 x 与插入点吻合(${st.caretX.toFixed(1)} vs ${st.expectedX.toFixed(1)})`,
    Math.abs(st.caretX - st.expectedX) <= 3);
  chk('打字时不闪(!blink)', !st.blink);
}

// ③ 停手 420ms 后恢复慢闪
{
  await p.waitForTimeout(520);
  const st = await readCaret();
  chk('停手后挂上 .blink', st.blink);
  const anim = await p.evaluate(() => {
    const c = document.getElementById('smoothCaret');
    const cs = getComputedStyle(c);
    return { name: cs.animationName, timing: cs.animationDuration };
  });
  chk(`慢闪 1.06s steps(${anim.name} / ${anim.timing})`, anim.name === 'caret-blink' && anim.timing === '1.06s');
}

// ④ 换位置是"滑"过去的: 采样中间帧, 必须存在非端点的 x
{
  const res = await p.evaluate(async () => {
    const input = document.getElementById('search');
    const caret = document.getElementById('smoothCaret');
    const xs = [];
    let running = true;
    const t0 = performance.now();
    const tick = () => {
      xs.push([performance.now() - t0, caret.getBoundingClientRect().left]);
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await new Promise(r => setTimeout(r, 40));
    const startX = caret.getBoundingClientRect().left;
    input.setSelectionRange(input.value.length - 1, input.value.length - 1);
    input.dispatchEvent(new Event('select'));   // 重定位 → CSS 补间滑行
    await new Promise(r => setTimeout(r, 240));
    running = false;
    const endX = caret.getBoundingClientRect().left;
    const mid = xs.map(([, x]) => x);
    const between = mid.filter(x => x < startX - 0.4 && x > endX + 0.4).length;
    const uniq = new Set(mid.map(x => x.toFixed(1))).size;
    return { dist: startX - endX, between, uniq };
  });
  chk(`光标位移 ${res.dist.toFixed(1)}px`, res.dist > 3);
  chk(`中间帧落在起止之间(${res.between} 帧 / 共 ${res.uniq} 个不同 x) —— 顿跳只会有 2 个 x`,
    res.between >= 1 && res.uniq >= 3);
}

// ⑤ blur 隐藏
{
  await p.evaluate(() => document.getElementById('search').blur());
  await p.waitForTimeout(80);
  const st = await readCaret();
  chk('blur 后光标隐藏', !st.on);
}

// ⑥ 拼音组合期间交还原生 caret
{
  await p.click('#search');
  await p.waitForTimeout(100);
  await p.evaluate(() => {
    document.getElementById('search').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  await p.waitForTimeout(220); // 等 opacity 0.1s 过渡跑完
  const st = await p.evaluate(() => {
    const input = document.getElementById('search');
    const wrap = document.querySelector('.search-wrap');
    return {
      caretColor: getComputedStyle(input).caretColor,
      composing: wrap.classList.contains('composing'),
      blockOpacity: getComputedStyle(document.getElementById('smoothCaret')).opacity,
    };
  });
  chk('组合期间 wrap 挂 .composing', st.composing);
  chk(`组合期间原生 caret 回来(${st.caretColor})`, st.caretColor !== 'rgba(0, 0, 0, 0)');
  chk(`组合期间光标藏起(opacity ${st.blockOpacity})`, st.blockOpacity === '0');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
