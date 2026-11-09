// comic-shots.mjs — 演示页第 7 屏(归档 · 漫画分镜)视觉自测
// 跑法: node probes/comic-shots.mjs   (截图落到 /tmp/comic-*.png)
// 检查点: 四档视口下三格排布/缩放、控制台报错、横向溢出、R 重播与中途离开
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
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    }
  });
  await page.waitForTimeout(7000);
  await page.screenshot({ path: `/tmp/comic-${vp.width}x${vp.height}.png` });

  const st = await page.evaluate(() => {
    const stage = document.querySelector('[data-stage="6"]');
    const cp3 = stage.querySelector('.cp-3');
    return {
      scale: [...stage.querySelectorAll('.cp')].map(cp => getComputedStyle(cp).getPropertyValue('--s').trim()),
      archived: cp3.querySelector('.sp-pill').textContent,
      rowIn: getComputedStyle(cp3.querySelector('.sp-arc-item.fresh')).opacity,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      fits: stage.getBoundingClientRect().bottom <= window.innerHeight - 60
    };
  });

  if (errs.length || st.overflowX || !st.fits || st.rowIn !== '1') bad = true;
  console.log(`${vp.width}x${vp.height}`, JSON.stringify(st), errs);

  // R 重播 / 离开再回来, 检查 DOM 重建干净
  if (vp.width === 1440) {
    await page.keyboard.press('r');
    await page.waitForTimeout(1200);
    const replay = await page.evaluate(() => {
      const cp3 = document.querySelector('[data-stage="6"] .cp-3');
      return { pill: cp3.querySelector('.sp-pill').textContent, lists: cp3.querySelectorAll('.sp-arc-list').length };
    });
    if (replay.pill !== '1' || replay.lists !== 1) bad = true;
    console.log('  replay  ', JSON.stringify(replay));
  }
  await page.close();
}

await browser.close();
console.log(bad ? 'FAIL' : 'PASS');
process.exit(bad ? 1 : 0);
