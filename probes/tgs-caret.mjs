// tgs-caret.mjs (2026-11-03) — 方块光标不变量:
//   ① 原生 caret 透明 + 方块在场
//   ② 打字后方块 x = 插入点文本宽度(±3px), 且宽 ≈ 光标处字符宽
//   ③ 打字期间不闪, 停手 420ms 后挂 .blink
//   ④ 方向键左移 → 方块左移一个字宽
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
  const caret = document.getElementById('blockCaret');
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
  chk('方块在场(.on)', st.on);
  // 终端方块 = 一行字高(行盒), 不是含 padding 的整个输入框
  chk(`方块高 ≈ 行高(${st.height.toFixed(1)}px, 输入框 ${st.inputH}px 含 7px 上下 padding)`,
    st.height >= 12 && st.height <= st.inputH - 12);
}

// ② 打字后位置对得上
{
  await p.type('#search', 'ab', { delay: 60 });
  await p.waitForTimeout(120);
  const st = await readCaret();
  chk(`打字后 x 与插入点吻合(${st.caretX.toFixed(1)} vs ${st.expectedX.toFixed(1)})`,
    Math.abs(st.caretX - st.expectedX) <= 3);
  chk(`方块宽 ≈ 字符宽(${st.caretW.toFixed(1)} vs ${st.charW.toFixed(1)})`,
    Math.abs(st.caretW - st.charW) <= 2);
  chk('打字时不闪(!blink)', !st.blink);
}

// ③ 停手 420ms 后恢复慢闪
{
  await p.waitForTimeout(520);
  const st = await readCaret();
  chk('停手后挂上 .blink', st.blink);
  const anim = await p.evaluate(() => {
    const c = document.getElementById('blockCaret');
    const a = c.getAnimations().map(x => x.animationName || x.effect?.getKeyframes?.().length);
    return { name: getComputedStyle(c).animationName, timing: getComputedStyle(c).animationDuration };
  });
  chk(`慢闪 1.06s steps(${anim.name} / ${anim.timing})`, anim.name === 'caret-blink' && anim.timing === '1.06s');
}

// ④ 方向键左移 → 方块左移一个字宽
{
  const before = await readCaret();
  await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(140);
  const after = await readCaret();
  const delta = before.caretX - after.caretX;
  chk(`← 后方块左移一个字宽(${delta.toFixed(1)}px, 期望≈${before.charW.toFixed(1)}px)`,
    after.pos === before.pos - 1 && Math.abs(delta - before.charW) <= 4);
}

// ⑤ blur 隐藏
{
  await p.evaluate(() => document.getElementById('search').blur());
  await p.waitForTimeout(80);
  const st = await readCaret();
  chk('blur 后方块隐藏', !st.on);
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
      blockOpacity: getComputedStyle(document.getElementById('blockCaret')).opacity,
    };
  });
  chk('组合期间 wrap 挂 .composing', st.composing);
  chk(`组合期间原生 caret 回来(${st.caretColor})`, st.caretColor !== 'rgba(0, 0, 0, 0)');
  chk(`组合期间方块藏起(opacity ${st.blockOpacity})`, st.blockOpacity === '0');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
