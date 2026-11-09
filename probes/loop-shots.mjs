// loop-shots.mjs — 演示页第 8 屏(工作流闭环) + 第 2 屏(唤起)回归自测
// 跑法: node probes/loop-shots.mjs   (截图落到 /tmp/loop-*.png)
// 检查点:
//   1. 唤起屏落位无鬼影(进屏瞬间弹窗在屏外且透明, 不会反向飞出)
//   2. 闭环屏四档视口: 缩放比/不溢出/不超屏/四段步骤依次点亮/归档→恢复往返
//   3. R 重播与「离开再回来」不残留仓库抽屉、右键菜单、空态
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
const fail = msg => { bad = true; console.log('  ✗ ' + msg); };

/* ---------------- 1. 唤起屏: 落位无鬼影 ---------------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(URL);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));

  /* 进屏后前 900ms 内: 弹窗必须一直在屏外 + 全透明(修复前会从就位处反向飞到 -118%) */
  let ghost = 0;
  for (let i = 0; i < 6; i++) {
    const s = await page.evaluate(() => {
      const d = document.querySelector('[data-stage="1"] .popdrop');
      const cs = getComputedStyle(d);
      return { op: +cs.opacity, y: Math.round(new DOMMatrix(cs.transform).m42) };
    });
    if (s.op > 0.02 || s.y > -300) ghost++;
    await page.waitForTimeout(140);
  }
  /* 收尾: 弹窗必须已落位可见 */
  await page.waitForTimeout(2200);
  const end = await page.evaluate(() => {
    const d = document.querySelector('[data-stage="1"] .popdrop');
    const cs = getComputedStyle(d);
    return { op: +cs.opacity, y: Math.round(new DOMMatrix(cs.transform).m42) };
  });
  console.log('scene1  ghostFrames=' + ghost, JSON.stringify(end));
  if (ghost) fail('唤起屏出现鬼影帧(初始态被反向过渡)');
  if (end.op < 0.99 || Math.abs(end.y) > 2) fail('唤起屏弹窗没有落位');
  await page.close();
}

/* ---------------- 2. 闭环屏 ---------------- */
for (const vp of VPS) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(URL);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (let i = 0; i < 7; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });

  const seen = new Set();
  let shotArchive = false, shotRestore = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 13000 && seen.size < 5) {
    const s = await page.evaluate(() => {
      const q = sel => document.querySelector(sel);
      const onChip = q('#stripLoop .gchip[data-g="学习"]');
      return {
        step: q('#loopSteps .st.on')?.dataset.k || '',
        rows: document.querySelectorAll('#loopZoom .pop-row').length,
        q: q('#loopZoom .field-txt').textContent,
        empty: q('#loopZoom .pop-empty').classList.contains('show'),
        drawer: q('#loopZoom .popdrawer').classList.contains('up'),
        chipW: onChip ? Math.round(onChip.getBoundingClientRect().width) : -1
      };
    });
    seen.add(s.step);
    if (s.empty && !shotArchive) { shotArchive = true; await page.screenshot({ path: `/tmp/loop-${vp.width}x${vp.height}-archive.png` }); }
    if (s.drawer && !shotRestore) { shotRestore = true; await page.screenshot({ path: `/tmp/loop-${vp.width}x${vp.height}-restore.png` }); }
    await page.waitForTimeout(180);
  }

  /* 等清空段: 列表回到全量, 标签栏 chip 回来 */
  await page.waitForSelector('#loopSteps .st.on[data-k="loop"]', { timeout: 15000 });
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const win = q('.loop-win').getBoundingClientRect();
    const foot = q('.loop-foot').getBoundingClientRect();
    const chip = q('#stripLoop .gchip[data-g="学习"]');
    return {
      ls: +getComputedStyle(q('#loopRoot')).getPropertyValue('--ls'),
      winW: Math.round(win.width),
      rows: document.querySelectorAll('#loopZoom .pop-row').length,
      steps: [...document.querySelectorAll('#loopSteps .st')].length,
      chipW: chip ? Math.round(chip.getBoundingClientRect().width) : -1,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      fits: foot.bottom <= window.innerHeight - 40,
      drawer: q('#loopZoom .popdrawer').classList.contains('up'),
      menu: q('#loopZoom .ctxmenu').classList.contains('show')
    };
  });
  await page.screenshot({ path: `/tmp/loop-${vp.width}x${vp.height}.png` });

  const ok = !errs.length && !st.overflowX && st.fits && st.rows >= 20 && st.chipW > 20 && !st.drawer && !st.menu
    && seen.size >= 4 && st.ls >= 0.45 && st.ls <= 1.05;
  if (!ok) bad = true;
  console.log(`${vp.width}x${vp.height}`, JSON.stringify(st), 'steps=' + [...seen].join('/'), ok ? 'OK' : 'FAIL', errs);

  /* 离开再回来 / R 重播: 不残留抽屉、右键菜单, 且从「全量列表」重新开始 */
  if (vp.width === 1440) {
    await page.waitForSelector('#loopZoom .popdrawer.up', { timeout: 15000 });
    await page.keyboard.press('r');                       // 重播本屏
    await page.waitForTimeout(160);
    const fresh = await page.evaluate(() => ({
      drawer: document.querySelector('#loopZoom .popdrawer').classList.contains('up'),
      menu: document.querySelector('#loopZoom .ctxmenu').classList.contains('show'),
      q: document.querySelector('#loopZoom .field-txt').textContent,
      rows: document.querySelectorAll('#loopZoom .pop-row').length
    }));
    if (fresh.drawer || fresh.menu || fresh.rows < 20 || fresh.q !== '') fail('重播后残留状态 ' + JSON.stringify(fresh));
    console.log('  replay  ', JSON.stringify(fresh));
  }
  await page.close();
}

await browser.close();
console.log(bad ? 'FAIL' : 'PASS');
process.exit(bad ? 1 : 0);
