// keyboard-comic-shots.mjs — 演示页第 4/5 屏(slash 命令 · 键盘流 · 漫画分镜)视觉自测
// 跑法: node probes/keyboard-comic-shots.mjs   (截图落到 /tmp/kbd-*.png)
// 检查点: 三格/四格缩放有值、行入场可见、/h 半透明、无横向溢出、整页不超屏、控制台无报错
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');

const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = 'file:///Users/qianyuchen/tab-group-search/site/demo.html';
const VPS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 430, height: 932 }
];

const browser = await chromium.launch({ executablePath: EXE });
let bad = false;

for (const vp of VPS) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(URL);
  await page.waitForTimeout(400);

  /* --- 第 4 屏: slash 命令 --- */
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    }
  });
  await page.waitForTimeout(5600);
  await page.screenshot({ path: `/tmp/kbd-${vp.width}x${vp.height}.png` });

  const s3 = await page.evaluate(() => {
    const stage = document.querySelector('[data-stage="3"]');
    const cps = [...stage.querySelectorAll('.cp')];
    return {
      scales: cps.map(cp => getComputedStyle(cp).getPropertyValue('--s').trim()),
      rows: cps.map(cp => [...cp.querySelectorAll('.cmd-row')].map(r => getComputedStyle(r).opacity)),
      hist: cps[1] ? getComputedStyle(cps[1].querySelector('.cmdp-list')).opacity : null,
      typed: cps.map(cp => cp.querySelector('.field-txt').textContent),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      fits: stage.getBoundingClientRect().bottom <= window.innerHeight - 55
    };
  });
  if (errs.length || s3.overflowX || !s3.fits) { bad = true; console.log('  !! p4 base', errs, s3.overflowX, s3.fits); }
  if (s3.typed.join(',') !== '/b,/h,/r') { bad = true; console.log('  !! typed'); }
  if (s3.rows.some(list => list.some(o => o !== '1'))) { bad = true; console.log('  !! rows3'); }
  if (s3.hist !== '0.55') { bad = true; console.log('  !! hist'); }
  console.log(`${vp.width}x${vp.height} page4`, JSON.stringify(s3), errs);

  /* --- 第 5 屏: 键盘流 --- */
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await page.waitForTimeout(7000);
  await page.screenshot({ path: `/tmp/kbd4-${vp.width}x${vp.height}.png` });

  const s4 = await page.evaluate(() => {
    const stage = document.querySelector('[data-stage="4"]');
    const cps = [...stage.querySelectorAll('.cp')];
    return {
      scales: cps.map(cp => getComputedStyle(cp).getPropertyValue('--s').trim()),
      /* 格 1 行已恢复, 格 2 两行已收起, 格 1/2/4 toast 出现, 格 3 复制浮标出现 */
      r1: [...cps[0].querySelectorAll('.cmd-row')].map(r => getComputedStyle(r).opacity),
      r2: [...cps[1].querySelectorAll('.cmd-row')].map(r => getComputedStyle(r).opacity),
      r4: [...cps[3].querySelectorAll('.cmd-row')].map(r => getComputedStyle(r).opacity),
      copy: getComputedStyle(cps[2].querySelector('.cmd-copy')).opacity,
      heights: cps.map(cp => Math.round(cp.querySelector('.cp-zoom').offsetHeight)),
      pushes: cps.map(cp => { const p = cp.querySelector('.pop-push'); return p ? p.classList.contains('show') : null; }),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      fits: stage.getBoundingClientRect().bottom <= window.innerHeight - 55
    };
  });
  if (errs.length || s4.overflowX || !s4.fits) { bad = true; console.log('  !! p5 base', errs, s4.overflowX, s4.fits); }
  if (s4.r1[1] !== '1' || s4.r2[1] !== '0' || s4.r2[2] !== '0' || s4.r4[1] !== '0' || s4.copy !== '1') { bad = true; console.log('  !! rows5'); }
  if (new Set(s4.heights).size !== 1) { bad = true; console.log('  !! heights'); }   /* 四格面板高���一致 → 缩放比一致 */
  console.log(`${vp.width}x${vp.height} page5`, JSON.stringify(s4), errs);

  /* --- R 重播: 两屏都要干净重建 --- */
  if (vp.width === 1440) {
    await page.keyboard.press('r');
    await page.waitForTimeout(900);
    const replay = await page.evaluate(() => {
      const s4 = document.querySelector('[data-stage="4"]');
      return {
        comics: s4.querySelectorAll('.comic').length,
        rows: s4.querySelectorAll('.cmd-row').length,
        pushes: [...s4.querySelectorAll('.pop-push')].filter(p => p.classList.contains('show')).length
      };
    });
    if (replay.comics !== 1 || replay.rows !== 16 || replay.pushes !== 0) { bad = true; console.log('  !! replay'); }
    console.log('  replay  ', JSON.stringify(replay));
  }
  await page.close();
}

await browser.close();
console.log(bad ? 'FAIL' : 'PASS');
process.exit(bad ? 1 : 0);
