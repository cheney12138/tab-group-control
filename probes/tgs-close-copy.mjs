// tgs-close-copy.mjs — 删除收起动画 + ⌘C 行内浮标
// 守: ① 删除时行先收起(height 340ms 过渡 + 淡出), ~340ms 后才重渲染消失
//     ② 焦点立刻离开正在收起的行(连按 ⌘⌫ 不吞键)
//     ③ 批量删除多行同时收起且错峰(transitionDelay 递增)
//     ④ ⌘C 成功 → 行内 .copy-badge 浮现 / 遮罩住文字(位置不动, mask 渐隐) / 2s 后自动消失 / 底部无 toast
//     ⑤ 减弱动态效果时退化为立即重渲染(不卡住行)
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const OUT = '/tmp/tgs-close-copy';
const ctx = await chromium.launchPersistentContext(`/tmp/tgs-cc-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

// 页面内假数据: chrome.tabs.remove 真的从假表里删(否则重渲染会把刚关的行"复活")
const INIT = ({ theme }) => {
  localStorage.setItem('tgs-theme', theme);
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
    mk(202, 'https://b.example/2', '其他页二', 22, now - 3700000)];
  const groups = [
    { id: 11, title: '素材', color: 'blue', windowId: 1 },
    { id: 22, title: '其他', color: 'green', windowId: 1 }];
  chrome.tabs.query = async () => window.__tabs;
  chrome.tabGroups.query = async () => groups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;
  chrome.tabs.get = async (tid) => window.__tabs.find(t => t.id === tid) || Promise.reject(new Error('no tab'));
  chrome.tabs.remove = async (ids) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    window.__tabs = window.__tabs.filter(t => !set.has(t.id));
  };
  // 剪贴板在扩展页可能被拒; 探针里给一个必成功的实现
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  } catch (e) {}
};

async function openPopup(theme) {
  const p = await ctx.newPage();
  await p.addInitScript(INIT, { theme });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item', { timeout: 10000 });
  await p.waitForTimeout(700); // 等入场播完(body.entrance 摘掉)
  return p;
}

// 单击一次 keydown(只在 input 上派发 —— 它会冒泡到 document 的全局处理器)
const press = (p, key, mods = {}) => p.evaluate(({ key, mods }) => {
  document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
    key, code: key === 'Backspace' ? 'Backspace' : `Key${key.toUpperCase()}`,
    bubbles: true, cancelable: true, ...mods }));
}, { key, mods });

// ── 1. 单行删除: 先收起, 再消失 ──
{
  console.log('\n[1] 删除收起动画');
  const p = await openPopup('linear');
  const before = await p.evaluate(() => ({
    count: document.querySelectorAll('.tab-item').length,
    order: [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId),
    activeId: document.querySelector('.tab-item.active')?.dataset.tabId,
    h: document.querySelector('.tab-item[data-tab-id="102"]')?.offsetHeight,
  }));
  chk('初始选中行为当前标签(102)', before.activeId === '102', `activeId=${before.activeId}`);

  const s = await p.evaluate(async () => {
    const row = document.querySelector('.tab-item[data-tab-id="102"]');
    const h0 = row.offsetHeight;
    const t0 = performance.now();
    document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true }));
    const out = { h0, probes: [] };
    // 固定时点采样(不依赖 rAF —— 弹窗页的 rAF 会被节流, 帧数不可靠)
    for (const at of [0, 40, 90, 140, 200, 280, 340, 420, 700]) {
      const wait = at - (performance.now() - t0);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      const el = document.querySelector('.tab-item[data-tab-id="102"]');
      const cs = el && getComputedStyle(el);
      out.probes.push({
        at: Math.round(performance.now() - t0),
        inDom: !!el,
        closing: !!el && el.classList.contains('closing'),
        h: el ? el.offsetHeight : -1,
        op: cs ? Number(cs.opacity) : -1,
        // CSS 过渡是否真的在跑(height 340ms)
        trans: el ? el.getAnimations().filter(a => a instanceof CSSTransition)
          .map(a => `${a.transitionProperty}:${a.effect.getTiming().duration}`) : [],
        active: document.querySelector('.tab-item.active')?.dataset.tabId ?? null,
        count: document.querySelectorAll('.tab-item').length,
      });
    }
    return out;
  });
  const at = ms => s.probes.find(x => x.at >= ms) || {};
  const p40 = at(40), p90 = at(90), p140 = at(140), p200 = at(200), p280 = at(280), p700 = at(700);
  chk('删除瞬间(40ms 内)进入 .closing 状态', p40.closing === true);
  chk('height 过渡真的在跑(0.34s)', p90.trans.some(t => t.startsWith('height:340')), p90.trans.join(','));
  chk('高度逐步收缩(140ms 内已明显变矮)',
    [p90.h, p140.h].some(h => h > 0 && h < s.h0 - 2),
    `${s.h0} → 40ms:${p40.h} → 90ms:${p90.h} → 140ms:${p140.h} → 200ms:${p200.h}`);
  chk('伴随淡出(opacity < 1)', p200.op >= 0 && p200.op < 1, `opacity@200ms=${p200.op}`);
  chk('收起还在演时(~280ms)节点仍在 DOM 且几乎没了', p280.inDom && p280.h <= 3, `h@280ms=${p280.h}`);
  chk('焦点立刻离开正在收起的行', p40.active && p40.active !== '102', `active@40ms=${p40.active}`);
  chk('演完(~700ms)才从 DOM 移除', p700.inDom === false);
  chk('重渲染后行数 -1', p700.count === before.count - 1, `${before.count} → ${p700.count}`);
  chk('收起后仍有选中行(键盘可用)', !!p700.active, `active=${p700.active}`);
  chk('关闭动作在动画之前就已落地', await p.evaluate(() => !window.__tabs.some(t => t.id === 102)));
  await p.close();
}

// ── 2. 连按 ⌘⌫: 不吞键, 第二下删的是下一个 ──
{
  console.log('\n[2] 连按删除');
  const p = await openPopup('linear');
  const seq = await p.evaluate(async () => {
    const fire = () => document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true }));
    const out = { first: null, second: null, closingIds: null };
    fire();
    await new Promise(r => setTimeout(r, 40)); // chrome.tabs.remove 是异步的
    out.first = document.querySelector('.tab-item.active')?.dataset.tabId;
    await new Promise(r => setTimeout(r, 120));
    fire(); // 第一行还在收起, 这一下必须落到**另一行**
    await new Promise(r => setTimeout(r, 40));
    out.second = document.querySelector('.tab-item.active')?.dataset.tabId;
    out.closingIds = [...document.querySelectorAll('.tab-item.closing')].map(r => r.dataset.tabId);
    await new Promise(r => setTimeout(r, 900));
    out.remaining = [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId);
    return out;
  });
  chk('第一下后焦点已换行', seq.first === '101', `first=${seq.first}`);
  chk('第二下删的是另一行(不吞键)', seq.second !== '101' || seq.closingIds.length === 2,
    `active=${seq.second}, closing=${seq.closingIds.join(',')}`);
  chk('两行同时处于收起状态', seq.closingIds.length === 2, `closing=${seq.closingIds.join(',')}`);
  chk('两行最终都从列表消失', !seq.remaining.includes('102') && !seq.remaining.includes('101'),
    `remaining=${seq.remaining.join(',')}`);
  await p.close();
}

// ── 3. 批量关闭: 多行同时收起 + 错峰 ──
{
  console.log('\n[3] 批量删除 staggered');
  const p = await openPopup('linear');
  await p.evaluate(() => {
    const row = document.querySelector('.tab-item[data-tab-id="101"]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
  });
  await p.waitForSelector('.ctx-item');
  const labels = await p.evaluate(() => [...document.querySelectorAll('.ctx-item')].map(el => el.textContent));
  console.log('    菜单项:', labels.join(' | '));
  const clicked = await p.evaluate(() => {
    const el = [...document.querySelectorAll('.ctx-item')].find(x => x.textContent.includes('其余'));
    if (!el) return false;
    el.click();
    return true;
  });
  chk('行菜单里有「关闭本组其余标签」', clicked);
  const staggered = await p.evaluate(async () => {
    await new Promise(r => setTimeout(r, 150)); // remove+refresh 之后, 收起开始
    return [...document.querySelectorAll('.tab-item.closing')].map(r => ({
      id: r.dataset.tabId,
      delay: parseFloat(getComputedStyle(r).transitionDelay) || 0,
      h: r.offsetHeight,
    }));
  });
  chk('多行同时进入收起状态', staggered.length >= 2, `closing=${staggered.length}`);
  const delays = staggered.map(x => x.delay * 1000);
  chk('错峰 delay 递增(70ms 节拍)',
    delays.length > 1 && delays.every((d, i) => i === 0 || d > delays[i - 1]), `delays=${delays.join(',')}ms`);
  await p.waitForTimeout(900);
  const left = await p.evaluate(() => [...document.querySelectorAll('.tab-item')].map(r => r.dataset.tabId));
  chk('批量收起结束后列表也更新了', left.length === 1, `remaining=${left.join(',')}`);
  await p.close();
}

// ── 4. ⌘C 行内浮标(三主题) ──
for (const theme of ['linear', 'ink', 'sky']) {
  console.log(`\n[4] ⌘C 浮标 (${theme})`);
  const p = await openPopup(theme);
  await press(p, 'c', { metaKey: true });
  await p.waitForTimeout(320); // 过渡 0.2s
  const info = await p.evaluate(() => {
    const badges = [...document.querySelectorAll('.copy-badge')];
    const badge = badges[0];
    if (!badge) return { found: false };
    const row = badge.closest('.tab-item');
    const info = row.querySelector('.tab-info');
    const b = badge.getBoundingClientRect();
    const span = badge.querySelector('span').getBoundingClientRect();
    const cs = getComputedStyle(badge);
    const before = getComputedStyle(badge, '::before');
    const grow = {
      top: +(span.top - b.top).toFixed(1), bottom: +(b.bottom - span.bottom).toFixed(1),
      left: +(span.left - b.left).toFixed(1), right: +(b.right - span.right).toFixed(1),
    };
    return {
      found: true, count: badges.length,
      show: badge.classList.contains('show'),
      opacity: Number(cs.opacity),
      bg: cs.backgroundColor,
      color: cs.color,
      fontSize: cs.fontSize,
      text: badge.textContent.trim(),
      hasSvg: !!badge.querySelector('svg'),
      svgColor: getComputedStyle(badge.querySelector('svg')).stroke,
      rowIsActive: row.classList.contains('active'),
      badgeW: +b.width.toFixed(1), badgeH: +b.height.toFixed(1),
      spanW: +span.width.toFixed(1), spanH: +span.height.toFixed(1),
      padTop: parseFloat(cs.paddingTop), padLeft: parseFloat(cs.paddingLeft),
      radius: cs.borderTopLeftRadius,
      borderW: parseFloat(cs.borderTopWidth),
      borderColor: cs.borderTopColor,
      shadow: cs.boxShadow,
      beforeContent: before.content,
      beforeImage: before.backgroundImage,
      grow,
      textInside: span.top > b.top && span.bottom < b.bottom && span.left > b.left && span.right < b.right,
      rightGap: Math.round(row.getBoundingClientRect().right - b.right),
      badgeLeft: Math.round(b.left),
      badgeRight: Math.round(b.right),
      // —— 遮罩态: 浮标盖在文字上而不是把文字挤走 ——
      infoPadRight: parseFloat(getComputedStyle(info).paddingRight),
      maskImage: (getComputedStyle(info).maskImage || getComputedStyle(info).webkitMaskImage || 'none'),
      maskEndX: Math.round(info.getBoundingClientRect().right
        - parseFloat(getComputedStyle(info).getPropertyValue('--copy-mask-end'))),
      infoTransitions: info.getAnimations().map(a => a.transitionProperty),
      lastUsedDisplay: getComputedStyle(row.querySelector('.last-used')).display,
      toasts: [...document.querySelectorAll('#pushStack .push-banner')]
        .map(x => x.textContent).filter(t => t.includes('复制')),
    };
  });
  chk('浮标已插入并完全浮现', info.found && info.count === 1 && info.show && info.opacity > 0.9);
  chk('文案 = URL 已复制 + 复制图标', info.text === 'URL 已复制' && info.hasSvg);
  chk('挂在选中行上', info.rowIsActive);
  // 浮标是遮罩: 不再用 .tab-info 的右内边距让位(那是"URL 被挤短"的根源)
  chk('行内边距没有被浮标撑开(不再让位)', info.infoPadRight === 0,
    `pad-right=${info.infoPadRight}px`);
  chk('tab-info 上没有 padding 过渡(没有缩短/回弹动画)', info.infoTransitions.length === 0,
    info.infoTransitions.join(','));
  chk('文字用 mask 在浮标左缘前淡出(浮标下面无字)',
    info.maskImage.includes('linear-gradient') && info.maskEndX <= info.badgeLeft + 1
    && info.maskEndX >= info.badgeLeft - 8,
    `maskEnd=${info.maskEndX} badge.left=${info.badgeLeft} mask=${info.maskImage.slice(0, 60)}`);
  chk('选中行的时间戳槽位让开(遮罩坐标才能对齐行右缘)', info.lastUsedDisplay === 'none',
    `display=${info.lastUsedDisplay}`);
  // 遮罩要"盖住文字": 有底的主题必须是不透明背景(alpha=1), ink 靠墨点 + mask 兜底
  chk('浮标底色不透明(盖得住下面的字)', theme === 'ink' || /^rgb\(/.test(info.bg), `bg=${info.bg}`);
  chk('底部 toast(复制提示)已被行内浮标取代', info.toasts.length === 0, info.toasts?.join(' | '));
  // 文字必须被包住: ink/sky 的底图是"形状", 不是胶囊, 内边距尤其不能省
  chk('文字四边都在浮标盒内', info.textInside,
    `grow=${JSON.stringify(info.grow)}`);
  chk('文字四周留白 ≥ 4px', Math.min(...Object.values(info.grow)) >= 4,
    `grow=${JSON.stringify(info.grow)}`);
  if (theme === 'ink') {
    chk('ink: 最小高 ≥ 28px 且四周留白 ≥ 6px',
      info.badgeH >= 28 && info.padTop >= 6 && info.padLeft >= 6
      && Math.min(...Object.values(info.grow)) >= 6,
      `H=${info.badgeH} pad=${info.padTop}/${info.padLeft} grow=${JSON.stringify(info.grow)}`);
    chk('ink: 浮标高/宽都明显大于文字',
      info.badgeH >= info.spanH + 10 && info.badgeW >= info.spanW + 24,
      `badge=${info.badgeW}×${info.badgeH} text=${info.spanW}×${info.spanH}`);
    chk('ink: 形状底仍在(::before 有底图)', info.beforeImage !== 'none');
  }
  if (theme === 'sky') {
    // sky = 徽章(不画云): 圆角矩形 / 描边 / 云白面 / 蓝调阴影, 且**没有** ::before 底图
    chk('sky: 是徽章(圆角 12px + 1px 描边 + 云白面)',
      info.radius === '12px' && info.borderW === 1 && info.bg === 'rgb(242, 245, 252)',
      `radius=${info.radius} border=${info.borderW} bg=${info.bg}`);
    chk('sky: 阴影走云层深蓝墨(非中性黑) + 内顶光',
      info.shadow.includes('31, 52, 110') && info.shadow.includes('inset'), info.shadow);
    chk('sky: 云朵底图已删除(::before 无底图)',
      info.beforeImage === 'none' && (info.beforeContent === 'none' || info.beforeContent === 'normal'),
      `content=${info.beforeContent}`);
    chk('sky: 徽章比文字盒大一圈(横竖都 ≥ 6px)',
      info.badgeH >= info.spanH + 6 && info.badgeW >= info.spanW + 20,
      `badge=${info.badgeW}×${info.badgeH} text=${info.spanW}×${info.spanH}`);
  }
  await p.screenshot({ path: `${OUT}-${theme}.png`, clip: { x: 0, y: 0, width: 480, height: 240 } });
  await p.waitForTimeout(2300);
  const gone = await p.evaluate(() => document.querySelectorAll('.copy-badge').length);
  chk('2 秒后浮标自动消失', gone === 0, `remaining=${gone}`);
  console.log(`    主题 ${theme}: bg=${info.bg} text=${info.color} svg=${info.svgColor} font=${info.fontSize}`);
  await p.close();
}

// ── 4b. 长标题: 文字的位置**不动()**, 由 mask 在浮标左缘前淡出 ──
{
  console.log('\n[4b] 长标题 + 浮标');
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.addInitScript(() => {
    localStorage.setItem('tgs-theme', 'linear');
    const now = 1730000000000;
    const mk = (id, url, title, la, active) => ({ id, url, title, groupId: 11, windowId: 1, active: !!active, lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
    window.__tabs = [
      mk(102, 'https://a.example/deep/path', '一个非常长的标签页标题, 用来测试浮标出现时标题是否会被盖住 (2)', now - 30000, true),
      mk(101, 'https://a.example/1', '短标题', now - 60000)];
    chrome.tabs.query = async () => window.__tabs;
    chrome.tabGroups.query = async () => [{ id: 11, title: '素材', color: 'blue', windowId: 1 }];
    chrome.windows.getCurrent = async () => ({ id: 1 });
    chrome.runtime.sendMessage = async () => null;
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); } catch (e) {}
  });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item');
  await p.waitForTimeout(700);
  const before = await p.evaluate(() => {
    const row = document.querySelector('.tab-item.active');
    const title = row.querySelector('.title');
    const r = document.createRange();
    r.setStart(title.firstChild, 0); r.setEnd(title.firstChild, 3);
    const head = r.getBoundingClientRect(); // 开头几个字: 浮标出现前后必须在原地
    return { headLeft: Math.round(head.left), headRight: Math.round(head.right),
      titleBoxRight: Math.round(title.getBoundingClientRect().right) };
  });
  await press(p, 'c', { metaKey: true });
  await p.waitForTimeout(400);
  const d = await p.evaluate(() => {
    const row = document.querySelector('.tab-item.active');
    const title = row.querySelector('.title');
    const box = title.getBoundingClientRect();
    const badge = document.querySelector('.copy-badge').getBoundingClientRect();
    const info = row.querySelector('.tab-info');
    const r = document.createRange();
    r.setStart(title.firstChild, 0); r.setEnd(title.firstChild, 3);
    const head = r.getBoundingClientRect();
    return {
      titleBoxRight: Math.round(box.right), badgeLeft: Math.round(badge.left),
      headLeft: Math.round(head.left), headRight: Math.round(head.right),
      infoPadRight: getComputedStyle(info).paddingRight,
      infoTransitions: info.getAnimations().map(a => a.transitionProperty),
      maskImage: (getComputedStyle(info).maskImage || getComputedStyle(info).webkitMaskImage || 'none'),
      maskEndX: Math.round(info.getBoundingClientRect().right
        - parseFloat(getComputedStyle(info).getPropertyValue('--copy-mask-end'))),
      ellipsisShown: title.scrollWidth > title.clientWidth,
    };
  });
  chk('长标题仍然溢出(省略号还在, 只是被遮罩盖住)', d.ellipsisShown === true);
  chk('标题**没有被挤**(开头的字一动不动)',
    d.headLeft === before.headLeft && d.headRight === before.headRight,
    `before=${before.headLeft}~${before.headRight} after=${d.headLeft}~${d.headRight}`);
  chk('tab-info 右内边距没变(92px 让位规则已删)', d.infoPadRight === '0px', `pad=${d.infoPadRight}`);
  chk('没有任何 padding 过渡在跑(没有缩短/回弹动画)', d.infoTransitions.length === 0,
    d.infoTransitions.join(','));
  chk('浮标遮罩生效: 文字在浮标左缘前已透明(无字从浮标上下缘探出)',
    d.maskImage.includes('linear-gradient') && d.maskEndX <= d.badgeLeft + 1
    && d.maskEndX >= d.badgeLeft - 8,
    `maskEnd=${d.maskEndX} ≈ badge.left=${d.badgeLeft}`);
  await p.screenshot({ path: `${OUT}-longtitle.png`, clip: { x: 0, y: 100, width: 480, height: 140 } });
  // 浮标退场后遮罩/时间戳槽位要还原(不然标题会永远缺一截)
  await p.waitForTimeout(2300);
  const back = await p.evaluate(() => {
    const row = document.querySelector('.tab-item.active');
    const info = row.querySelector('.tab-info');
    return {
      badges: document.querySelectorAll('.copy-badge').length,
      maskImage: (getComputedStyle(info).maskImage || getComputedStyle(info).webkitMaskImage || 'none'),
      lastUsedDisplay: getComputedStyle(row.querySelector('.last-used')).display,
      infoPadRight: getComputedStyle(info).paddingRight,
    };
  });
  chk('浮标退场后遮罩一起摘下', back.badges === 0 && back.maskImage === 'none',
    `badges=${back.badges} mask=${back.maskImage}`);
  chk('浮标退场后时间戳槽位还原', back.lastUsedDisplay !== 'none', `display=${back.lastUsedDisplay}`);
  await p.close();
}

// ── 4c. 没有选中行时 ⌘C 不响应(不复制 / 不弹浮标 / 不吞键) ──
{
  console.log('\n[4c] 无选中行时的 ⌘C');
  const p = await openPopup('sky');
  const r = await p.evaluate(() => {
    // 记录剪贴板写入次数(探针里 writeText 已被顶替成空实现)
    window.__writes = 0;
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (t) => { window.__writes++; return orig(t); };
    // 真实场景: 列表重渲染后没有任何行带 .active(比如 Esc 清掉选中)
    document.querySelectorAll('.tab-item.active').forEach(el => el.classList.remove('active'));
    const notPrevented = document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'c', code: 'KeyC', metaKey: true, bubbles: true, cancelable: true }));
    return { notPrevented, writes: window.__writes };
  });
  const now = await p.evaluate(() => ({
    badges: document.querySelectorAll('.copy-badge').length,
    toasts: [...document.querySelectorAll('#pushStack .push-banner')].map(x => x.textContent),
    activeRows: document.querySelectorAll('.tab-item.active').length,
  }));
  chk('无选中行: 不复制(剪贴板零写入)', r.writes === 0, `writes=${r.writes}`);
  chk('无选中行: 不弹浮标', now.badges === 0, `badges=${now.badges}`);
  chk('无选中行: 不弹 toast', now.toasts.length === 0, now.toasts.join(' | '));
  chk('无选中行: 不吞键(放行原生 ⌘C)', r.notPrevented === true);
  chk('前置条件: 确实处于无选中状态', now.activeRows === 0);
  await p.close();
}

// ── 5. 减弱动态效果: 退化为立即重渲染 ──
{
  console.log('\n[5] prefers-reduced-motion');
  const p = await ctx.newPage();
  await p.emulateMedia({ reducedMotion: 'reduce' });
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.addInitScript(INIT, { theme: 'linear' });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector('.tab-item');
  await p.waitForTimeout(700);
  const r = await p.evaluate(async () => {
    const id102 = document.querySelector('.tab-item[data-tab-id="102"]')?.dataset.tabId;
    document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 30));
    return {
      had102: !!id102,
      closing: document.querySelectorAll('.tab-item.closing').length,
      gone: !document.querySelector('.tab-item[data-tab-id="102"]'),
      active: document.querySelector('.tab-item.active')?.dataset.tabId ?? null,
    };
  });
  chk('减弱动态效果下不做收起动画', r.closing === 0);
  chk('行立刻消失(30ms 内)', r.gone && r.active, `active=${r.active}`);
  await p.close();
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
