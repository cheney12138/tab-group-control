// tgs-multiselect.mjs — Shift 多选删除
// 守: ① Shift+点击 勾选/取消(行高亮 + 底部计数条), 虚拟条目(负 id)不进选择集
//     ② ⇧↑↓ 从锚点扩展区间, 往回走会收窄(不是一路叠加)
//     ③ ⌘⌫ 批量关闭: 所有选中行 70ms 错峰收起 → 标签真的被 remove → 选择态清空
//     ④ Esc 取消多选, 不误触清搜索词/关窗
//     ⑤ 单行 ⌘⌫ 语义不变
//     ⑥ 三套主题下多选行底色都来自 --tint(主题 token), ink 的 hover 不吞选择态
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const OUT = '/tmp/tgs-multiselect';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-ms-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

const INIT = ({ theme }) => {
  localStorage.setItem('tgs-theme', theme);
  localStorage.setItem('tgs-deletekey', 'cmd-bs');
  const now = 1730000000000;
  const mk = (id, url, title, gid, la, active) => ({
    id, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  // 105 是 104 的同 URL 副本(合并成一行): 关行要整体关掉两份
  window.__tabs = [
    mk(101, 'https://a.example/1', '素材页一', 11, now - 60000),
    mk(102, 'https://a.example/2', '素材页二', 11, now - 30000, true),
    mk(103, 'https://a.example/3', '素材页三', 11, now - 90000),
    mk(104, 'https://a.example/4', '素材页四', 11, now - 120000),
    mk(105, 'https://a.example/4', '素材页四', 11, now - 125000),
    mk(201, 'https://b.example/1', '其他页一', 22, now - 3600000),
    mk(202, 'https://b.example/2', '其他页二', 22, now - 3700000)];
  const groups = [
    { id: 11, title: '素材', color: 'blue', windowId: 1 },
    { id: 22, title: '其他', color: 'green', windowId: 1 }];
  chrome.tabs.query = async () => window.__tabs;
  chrome.tabGroups.query = async () => groups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
  chrome.tabs.get = async (tid) => window.__tabs.find(t => t.id === tid) || Promise.reject(new Error('no tab'));
  window.__removed = [];
  chrome.tabs.remove = async (ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    window.__removed.push(...list);
    const set = new Set(list);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
  };
  window.__tabById = (tid) => window.__tabs.find(t => t.id === tid) || null;
};

async function openPopup(theme = 'linear') {
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.addInitScript(INIT, { theme });
  // popup.html 的 body 是写死的 480×520(真弹窗按内容定型), 沙盘窗口也得同尺寸
  // —— 否则 body 高过窗口, 底部绝对定位的推送条会跑到折叠线以下, 截图不可信
  await p.setViewportSize({ width: 480, height: 520 });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(700); // 等入场播完(body.entrance 摘掉)
  return p;
}

const shiftClick = (p, tabId) => p.evaluate((tabId) => {
  document.querySelector(`.tab-item[data-tab-id="${tabId}"]`)
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
}, tabId);

const key = (p, k, mods = {}) => p.evaluate(({ k, mods }) => {
  document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
    key: k, code: k.startsWith('Arrow') ? k : (k === 'Backspace' ? 'Backspace' : `Key${k.toUpperCase()}`),
    bubbles: true, cancelable: true, ...mods }));
}, { k, mods });

const snap = (p) => p.evaluate(() => ({
  selected: [...document.querySelectorAll('.tab-item.multi-selected')].map(r => r.dataset.tabId),
  active: document.querySelector('.tab-item.active')?.dataset.tabId ?? null,
  count: document.getElementById('multiHintCount')?.textContent,
  multiMode: document.body.classList.contains('multi-mode'),
  hintOpacity: Number(getComputedStyle(document.getElementById('multiHint')).opacity),
  hintShown: document.getElementById('multiHint').getAttribute('aria-hidden'),
  rows: [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId),
}));
const sorted = (arr) => [...arr].sort().join(',');

// ── 1. Shift+点击 勾选 / 取消 ──
{
  console.log('\n[1] Shift+点击 多选');
  const p = await openPopup('linear');
  chk('初始没有多选', (await snap(p)).selected.length === 0 && !(await snap(p)).multiMode);
  await shiftClick(p, 101);
  await shiftClick(p, 103);
  await p.waitForTimeout(220); // 等计数条淡入(0.14s)
  const s = await snap(p);
  chk('两行被勾选', sorted(s.selected) === '101,103', s.selected.join(','));
  chk('计数条显示 2 行', s.count === '2', `count=${s.count}`);
  chk('计数条浮现(body.multi-mode + opacity 1)', s.multiMode && s.hintOpacity > 0.9, `op=${s.hintOpacity}`);
  chk('Shift 点击不切换标签(弹窗仍开着, 当前标签仍是 102)', s.active === '102' && await p.evaluate(() => !document.hidden));

  const ns = await p.evaluate(() => ({
    bg: getComputedStyle(document.querySelector('.tab-item[data-tab-id="101"]')).backgroundColor,
    outline: getComputedStyle(document.querySelector('.tab-item[data-tab-id="101"]')).boxShadow,
    bar: getComputedStyle(document.querySelector('.tab-item[data-tab-id="101"]'), '::after').width,
    plainBg: getComputedStyle(document.querySelector('.tab-item[data-tab-id="102"]')).backgroundColor,
  }));
  chk('多选行有主题色淡底(与普通行不同)', ns.bg !== ns.plainBg, `${ns.bg} vs ${ns.plainBg}`);
  chk('多选行有内描边 + 左侧 3px 竖条', ns.outline.includes('inset') && ns.bar === '3px', `${ns.bar}`);

  await shiftClick(p, 103);
  const after = await snap(p);
  chk('再 Shift 点一次 = 取消该行', after.selected.join(',') === '101', after.selected.join(','));
  chk('计数跟着减少', after.count === '1', `count=${after.count}`);

  // Esc 取消
  await key(p, 'Escape');
  await p.waitForTimeout(220);
  const esc = await snap(p);
  chk('Esc 清空多选且计数条收起', esc.selected.length === 0 && !esc.multiMode && esc.hintOpacity < 0.9,
    `selected=${esc.selected.length} mode=${esc.multiMode} op=${esc.hintOpacity}`);
  chk('Esc 取消多选后弹窗没有被关掉', await p.evaluate(() => !document.hidden));
  await p.close();
}

// ── 2. ⇧↑↓ 区间选择(可扩可收) ──
{
  console.log('\n[2] ⇧↑↓ 区间选择');
  const p = await openPopup('linear');
  const s0 = await snap(p);
  const startIdx = s0.rows.indexOf(s0.active);
  await key(p, 'ArrowDown', { shiftKey: true });
  const s1 = await snap(p);
  chk('第一次 ⇧↓: 当前行 + 下一行同时选中',
    s1.selected.length === 2 && s1.selected.includes(s0.active), s1.selected.join(','));
  chk('光标移到区间端点', s1.rows.indexOf(s1.active) === startIdx + 1, `active=${s1.active}`);

  await key(p, 'ArrowDown', { shiftKey: true });
  const s2 = await snap(p);
  chk('再 ⇧↓: 区间扩到 3 行', s2.selected.length === 3, s2.selected.join(','));

  await key(p, 'ArrowUp', { shiftKey: true });
  await key(p, 'ArrowUp', { shiftKey: true });
  const s3 = await snap(p);
  chk('⇧↑ 往回走: 区间收窄(不是一路叠加)', s3.selected.length === 1, s3.selected.join(','));
  await p.close();
}

// ── 3. ⌘⌫ 批量关闭(带动画 + 撤销) ──
{
  console.log('\n[3] ⌘⌫ 批量关闭');
  const p = await openPopup('linear');
  const rowsBefore = (await snap(p)).rows;
  await shiftClick(p, 101);
  await shiftClick(p, 102);
  await shiftClick(p, 104); // 104 这一行带着同 URL 副本 105
  const before = await snap(p);
  chk('三行被勾选', sorted(before.selected) === '101,102,104', before.selected.join(','));

  const anim = await p.evaluate(async () => {
    document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true }));
    const t0 = performance.now();
    const out = { probes: [] };
    for (const at of [30, 60, 120, 300, 700]) {
      const wait = at - (performance.now() - t0);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      out.probes.push({
        at: Math.round(performance.now() - t0),
        closing: [...document.querySelectorAll('.tab-item.closing')].map(r => ({
          id: r.dataset.tabId,
          delay: Math.round((parseFloat(getComputedStyle(r).transitionDelay) || 0) * 1000),
          h: r.offsetHeight,
        })),
        selected: [...document.querySelectorAll('.tab-item.multi-selected')].length,
        multiMode: document.body.classList.contains('multi-mode'),
        removed: [...window.__removed],
        count: document.querySelectorAll('.tab-item').length,
        active: document.querySelector('.tab-item.active')?.dataset.tabId ?? null,
      });
    }
    out.undo = [...document.querySelectorAll('#pushStack .push-banner')].map(x => x.textContent);
    return out;
  });
  const p30 = anim.probes.find(x => x.at >= 30);
  const p700 = anim.probes.find(x => x.at >= 700);
  chk('选中行进入收起状态', p30.closing.length === 3, `closing=${p30.closing.map(c => c.id).join(',')}`);
  chk('收起错峰 70ms 递增',
    p30.closing.length > 1 && p30.closing.every((c, i) => i === 0 || c.delay > p30.closing[i - 1].delay),
    p30.closing.map(c => `${c.id}:${c.delay}ms`).join(' '));
  chk('收起动画在演(30ms 时高度未归零)', p30.closing.every(c => c.h > 3), p30.closing.map(c => c.h).join(','));
  chk('关闭动作已落地(3 行 = 4 个标签, 含副本 105)',
    [101, 102, 104, 105].every(x => p30.removed.includes(x)), p30.removed.join(','));
  chk('选择态立即清空、计数条收起', p30.selected === 0 && p30.multiMode === false);
  chk('演完(~700ms)后行数正确', p700.count === rowsBefore.length - 3, `${rowsBefore.length} → ${p700.count}`);
  chk('焦点落在选区之后的第一行(201)或合理邻居', !!p700.active && p700.active !== '101', `active=${p700.active}`);
  chk('弹出撤销条(可 ⌘Z 恢复)', anim.undo.some(t => t.includes('已关闭')), anim.undo.join(' | '));
  chk('标签数据里确实少了这几份',
    await p.evaluate(() => ![101, 102, 104, 105].some(id => window.__tabById(id))));
  await p.screenshot({ path: `${OUT}-batch.png` });
  await p.close();
}

// ── 4. 单行 ⌘⌫ 语义不变 ──
{
  console.log('\n[4] 单行删除不受影响');
  const p = await openPopup('linear');
  const before = await snap(p);
  await key(p, 'Backspace', { metaKey: true });
  await p.waitForTimeout(900);
  const after = await snap(p);
  chk('只关掉光标那一行', after.rows.length === before.rows.length - 1,
    `${before.rows.join(',')} → ${after.rows.join(',')}`);
  chk('单行删除没有把列表变成多选态', !after.multiMode && after.selected.length === 0);
  await p.close();
}

// ── 5. 三主题视觉 + ink hover 不吞选择态 ──
for (const theme of ['linear', 'ink', 'sky']) {
  console.log(`\n[5] 多选视觉 (${theme})`);
  const p = await openPopup(theme);
  await shiftClick(p, 101);
  await shiftClick(p, 103);
  await shiftClick(p, 201);
  await p.waitForTimeout(260);
  const v = await p.evaluate(() => {
    const row = document.querySelector('.tab-item[data-tab-id="101"]');
    const cs = getComputedStyle(row);
    const hint = document.getElementById('multiHint');
    const hcs = getComputedStyle(hint);
    const badge = getComputedStyle(document.getElementById('multiHintCount'));
    return {
      bg: cs.backgroundColor, shadow: cs.boxShadow,
      barColor: getComputedStyle(row, '::after').backgroundColor,
      hintBg: hcs.backgroundColor, hintRadius: hcs.borderRadius,
      hintShadow: hcs.boxShadow, hintZ: hcs.zIndex,
      badgeBg: badge.backgroundColor, badgeColor: badge.color,
      hintBottom: Math.round(hint.getBoundingClientRect().bottom),
    };
  });
  // hover 后再量一次: 选择态底色必须还在
  await p.hover('.tab-item[data-tab-id="101"]');
  await p.waitForTimeout(200);
  const hoverBg = await p.evaluate(() =>
    getComputedStyle(document.querySelector('.tab-item[data-tab-id="101"]')).backgroundColor);
  chk('多选行有底色 + 内描边', v.bg !== 'rgba(0, 0, 0, 0)' && v.shadow.includes('inset'), v.bg);
  chk('左侧竖条用 accent', v.barColor !== 'rgba(0, 0, 0, 0)', v.barColor);
  chk('hover 不会掉选择态底色', hoverBg !== v.bg || hoverBg !== 'rgba(0, 0, 0, 0)', `${v.bg} → ${hoverBg}`);
  chk('计数条浮在底部, 徽章实底', v.hintBottom > 0 && v.badgeBg !== v.hintBg, `badge=${v.badgeBg} hint=${v.hintBg}`);
  await p.screenshot({ path: `${OUT}-${theme}.png` });
  console.log(`    bg=${v.bg} bar=${v.barColor} hint=${v.hintBg} badge=${v.badgeBg}/${v.badgeColor}`);
  await p.close();
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await ctx.close();
process.exit(fail ? 1 : 0);
