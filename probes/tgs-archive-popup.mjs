// tgs-archive-popup.mjs — 弹窗模式(贴图标弹出的那个 popup)的「重新打开」收场
// 守: ① 动作交给 worker 做完: 弹窗在恢复途中被关掉, 标签照样建齐、归组、归档卡照样焚
//     ② 弹窗消失后 worker 把它唤回来(chrome.action.openPopup), 用户落地的还是那个弹窗
//     ③ 唤回来的新弹窗首屏就显示恢复的分组, 并补一条「已重新打开」回报
//     ④ 弹窗还活着时不做多余的事(不会凭空多开一个弹窗)
//
// 为什么用 CDP 直连: 真 popup 不出现在 playwright 的 pages() 里(它是 POPUP 上下文,
// 不是 TAB), 只能在浏览器级 Target 域里找到它、attach 进去点按钮。
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const { createRequire } = await import('node:module');
const req = createRequire('/tmp/x.js');
const { ws: WS } = req('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/lib/utilsBundle.js');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const PORT = 9451;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

const ctx = await chromium.launchPersistentContext(`/tmp/tgs-ap-${Date.now()}`, {
  executablePath: EXE, viewport: null, headless: false,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run', `--remote-debugging-port=${PORT}`] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });

// ---- 浏览器级 CDP: 真 popup 只能从这里进 ----
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const findPopup = async () => {
  const ts = (await send('Target.getTargets')).targetInfos;
  return ts.find(t => t.type === 'page' && t.url.includes('popup.html') && !t.url.includes('win=1')) || null;
};
const popupContextAlive = async () => {
  const types = await sw.evaluate(async () =>
    (await chrome.runtime.getContexts({})).map(c => c.contextType));
  return types.includes('POPUP');
};
const attach = async (targetId) => {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { sessionId, ev };
};

// ── 0. 现场: 一个普通窗口(几个标签) + 一张两条标签的归档卡 ──
await sleep(900);
const seeded = await sw.evaluate(async () => {
  const win = await chrome.windows.create({ url: 'https://example.com/?a', type: 'normal', width: 1000, height: 760 });
  await chrome.tabs.create({ url: 'https://example.com/?b', windowId: win.id, active: false });
  await chrome.storage.local.set({ archivedGroups: [{
    id: 'arch_pop', title: '素材', color: 'blue', archivedAt: Date.now() - 3600_000,
    tabs: [
      { title: '素材一', url: 'https://example.com/?m1', favIconUrl: '' },
      { title: '素材二', url: 'https://example.com/?m2', favIconUrl: '' },
    ],
  }] });
  return { winId: win.id };
});
await sleep(400);
console.log('\n[1] 弹窗在恢复途中被 Chrome 关掉(模拟失焦自关)');
const opened = await sw.evaluate(async () => { try { await chrome.action.openPopup(); return 'ok'; } catch (e) { return 'err:' + e.message; } });
chk('弹窗已打开', opened === 'ok', opened);
await sleep(900);
const first = await findPopup();
chk('找到真 popup 目标', !!first);
if (!first) { console.log(`\n结果: ${pass} passed, ${fail} failed`); await ctx.close(); process.exit(1); }
const pop = await attach(first.targetId);
await pop.ev("document.getElementById('settingsBtn').click()");
await sleep(220);
await pop.ev("document.querySelector('.settings-tab[data-pane=\\'archive\\']').click()");
await sleep(320);
chk('归档卡在面板里', (await pop.ev("document.querySelectorAll('.archive-card').length")) === 1);
// 点「重新打开」, 随后 60ms 就把自己关掉 —— 等价于 Chrome 在动作中途把浮层带走:
// 动作已经发出去了, 但页面(连同它的 JS)死了, 后半段只能靠 worker 收尾
await pop.ev("document.querySelector('.btn-restore-archive').click(); 'clicked'");
// 先给「素材|blue」记一条"收起来了": 恢复出来的分组必须无视它照样展开
await pop.ev("localStorage.setItem('tgs-collapsed', JSON.stringify(['素材|blue'])); 'set'");
await sleep(60);
await pop.ev('window.close()');
await sleep(400);
chk('弹窗确实关掉了(页面死了)', !(await pop.ev('1+1').catch(() => null)) || !(await findPopup()));

// ── 1. 数据面: 就算弹窗死了, 恢复也要走完 ──
const data = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({});
  const store = await chrome.storage.local.get('archivedGroups');
  const live = tabs.filter(t => ((t.url || t.pendingUrl) || '').includes('example.com/?m'));
  return {
    live: live.map(t => ({ url: t.url, groupId: t.groupId })),
    grouped: live.every(t => groups.some(g => g.id === t.groupId && g.title === '素材')),
    archived: (store.archivedGroups || []).length,
  };
});
chk('标签全部建齐并进了「素材」组', data.live.length === 2 && data.grouped, JSON.stringify(data.live));
chk('归档卡已焚毁(没有半途而废)', data.archived === 0, `archived=${data.archived}`);

// ── 2. 窗口层: worker 把弹窗唤回来了 ──
console.log('\n[2] worker 把弹窗唤回来, 落点就是恢复出来的分组');
let second = null;
for (let i = 0; i < 24 && !second; i++) {
  await sleep(250);
  second = await findPopup();
  if (second && second.targetId === first.targetId) second = null;
}
chk('弹窗被重新唤起(不是凭空消失)', !!second && (await popupContextAlive()),
  second ? `target=${second.targetId}` : '没有新弹窗');
if (!second) { console.log(`\n结果: ${pass} passed, ${fail} failed`); await ctx.close(); process.exit(1); }
const pop2 = await attach(second.targetId);
await sleep(1200);
const liveIds = await sw.evaluate(async () =>
  (await chrome.tabs.query({})).filter(t => ((t.url || t.pendingUrl) || '').includes('example.com/?m')).map(t => t.id));
const ui = await pop2.ev(`({
  panelOpen: document.getElementById('settingsPanel').classList.contains('open'),
  headers: [...document.querySelectorAll('.group-title')].map(x => x.textContent.trim()),
  restoredRows: [...document.querySelectorAll('.tab-item')]
    .filter(r => ${JSON.stringify(liveIds)}.includes(Number(r.dataset.tabId))).length,
  toasts: [...document.querySelectorAll('#pushStack .push-banner')].map(x => x.textContent),
})`);
chk('回到的弹窗停在分组视图(设置面板是收起的)', ui.panelOpen === false);
chk('列表里有恢复出来的「素材」分组头', ui.headers.includes('素材'), JSON.stringify(ui.headers));
chk('恢复的行都在列表里', ui.restoredRows >= 2, `restoredRows=${ui.restoredRows}`);
const headerCollapsed = await pop2.ev(`[...document.querySelectorAll('.group-header')]
  .filter(h => (h.textContent || '').includes('素材')).map(h => h.classList.contains('collapsed'))`);
chk('恢复的输出分组是展开的(不被旧的收起记忆压回去)',
  headerCollapsed.length > 0 && headerCollapsed.every(c => c === false), JSON.stringify(headerCollapsed));
chk('补上了「已重新打开」回报', ui.toasts.some(t => t.includes('已重新打开')), ui.toasts.join(' | '));
await send('Page.enable', {}, pop2.sessionId);
const shot = await send('Page.captureScreenshot', { format: 'png' }, pop2.sessionId);
const fs = await import('node:fs');
fs.writeFileSync('/tmp/tgs-archive-popup.png', Buffer.from(shot.data, 'base64'));
console.log('  截图: /tmp/tgs-archive-popup.png');
await pop2.ev("window.close()");

// ── 3. 弹窗还活着时不多事: 不会凭空再开一个 ──
console.log('\n[3] 弹窗活着的路径: 不被多开一个');
await sw.evaluate(async () => {
  await chrome.storage.local.set({ archivedGroups: [{
    id: 'arch_pop2', title: '资料', color: 'green', archivedAt: Date.now(),
    tabs: [{ title: '资料页', url: 'https://example.com/?n1', favIconUrl: '' }],
  }] });
});
await sleep(300);
// 真机上弹窗是用户点图标/⌘E 唤起的, 那一瞬浏览器窗口一定在前台 —— 这里先把落点窗口
// 提到前台, 否则 openPopup 会以「找不到聚焦的浏览器窗口」拒绝(自动化特有的坑)
await sw.evaluate(async () => {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const fw = wins[wins.length - 1];
  if (fw) await chrome.windows.update(fw.id, { focused: true });
});
await sleep(300);
const opened2 = await sw.evaluate(async () => { try { await chrome.action.openPopup(); return 'ok'; } catch (e) { return 'err:' + e.message; } });
chk('弹窗再次打开', opened2 === 'ok', opened2);
await sleep(900);
const third = await findPopup();
if (third) {
  const pop3 = await attach(third.targetId);
  await pop3.ev("document.getElementById('settingsBtn').click()");
  await sleep(200);
  await pop3.ev("document.querySelector('.settings-tab[data-pane=\\'archive\\']').click()");
  await sleep(300);
  await pop3.ev("document.querySelector('.btn-restore-archive').click(); 'clicked'");
  await sleep(3000);
  const alive = await popupContextAlive();
  const sameTarget = await findPopup();
  const ui3 = await pop3.ev(`({
    panelOpen: document.getElementById('settingsPanel').classList.contains('open'),
    headers: [...document.querySelectorAll('.group-title')].map(x => x.textContent.trim()),
  })`).catch(() => null);
  chk('弹窗还活着时不做多余动作(同一个弹窗, 面板收起)',
    alive && !!sameTarget && sameTarget.targetId === third.targetId && ui3?.panelOpen === false,
    JSON.stringify({ alive, target: sameTarget?.targetId, ui: ui3 }));
  chk('列表里出现刚恢复的「资料」组', !!ui3?.headers?.includes('资料'), JSON.stringify(ui3?.headers || []));
  await pop3.ev('window.close()').catch(() => {});
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
