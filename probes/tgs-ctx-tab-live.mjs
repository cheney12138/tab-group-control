// tgs-ctx-tab-live.mjs — 标签行右键菜单 + 「新建分组…」在**真实扩展环境**里的实测
//
// 与其它 stub 探针(假 chrome API + 真 popup)的关键区别: 这一份**不 stub 任何
// chrome.***, 跑的是真 background.js service worker + 真 chrome.tabs / tabGroups /
// storage, 在 Headless Chromium(--headless=new) 里加载真扩展。所有断言都拿
// sw.evaluate 里的 chrome.tabs.query({}) / chrome.tabGroups.query({}) 核对真状态,
// 不信 UI 自己说的话。
//
// 覆盖(见各 Case 横幅):
//   Case 1 菜单结构 / 禁用态 / 焦点与关闭交互
//   Case 2 「新建分组…」正常隔离性基线(不拉入无关标签)
//   Case 3 异常与"无关标签被移入"专项(同名静默并入 / 通配符 / tidy 误合并 /
//          同 URL 副本语义 / 卡片校验与 IME 保护)
//   Case 4 「移出分组」+ 自动分组引擎的 manualTabIds 保护
//   Case 5 行菜单批量关闭(其余 / 下方 / 全部)与撤销、行菜单归档
//
// 做法要点:
//   · 一切 DOM 交互都是真鼠标(Playwright 合成到真 Chromium 的鼠标/键盘事件),
//     右键是真的 button=right mousedown+mouseup, 不是 dispatchEvent('contextmenu')
//     —— 后者会漏掉"右键本身会不会夺焦"这类只有真鼠标才暴露的问题(见 1.4)。
//   · 测试数据用 data:text/html,<title>标签</title>(确定性标题、零网络), 只有
//     规则引擎(2.3 / 4.2)需要 http(s) 主机, 那里起一个本机 http server 换主机名。
//   · 每个 Case 开头 resetEnv(): 关掉自动分组/规则、清 manualTabIds、关掉上一个
//     Case 的窗口 —— 各组用例之间不共享现场。
//   · popup 页面以普通标签页形式开在**被测窗口里**(currentWindowId = 该窗口)。
//     注意: 这个 popup 标签自身是"未分组标签", 会进"关闭本窗口未分组标签 (n)"的
//     分母。凡涉及未分组计数的断言都按真实 query 结果比, 并在输出里注明这一份。
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const http = await import('node:http');
const fs = await import('node:fs');

const EXE = process.env.HOME
  + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const TMP = `/tmp/tgs-ctx-live-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 0. 本机页面服务(给规则引擎用: 规则按 host 匹配, data: URL 永远不命中) ──
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]) || 'root';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<title>${name}</title><h1>${name}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const H = `http://127.0.0.1:${PORT}`;   // 命中规则的主机
const H2 = `http://localhost:${PORT}`;  // 不命中规则的主机(落 Others)

// ── 1. 启动真扩展(headless: 无桌面窗口) ──
const ctx = await chromium.launchPersistentContext(TMP, {
  executablePath: EXE,
  viewport: null,
  headless: true,
  args: [
    '--headless=new', // 显式 new headless: 无头模式加载 MV3 扩展
    `--disable-extensions-except=${REPO}`,
    `--load-extension=${REPO}`,
    '--no-first-run',
  ],
});
ctx.setDefaultTimeout(8000);
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const EXT_ID = new URL(sw.url()).host;
console.log(`扩展已加载: ${EXT_ID}  (headless, 本机服务 ${H})`);

// ── 2. 记账 ──
let pass = 0; let fail = 0;
const failures = [];
const bugs = [];
const chk = (name, ok, extra = '') => {
  if (ok) pass += 1; else { fail += 1; failures.push(name); }
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
};
// 单个 Case 崩溃不拖垮整轮: 记一次失败, 继续下一组(未清理的窗口由下一个 resetEnv 收掉)
async function guard(name, fn) {
  try { await fn(); } catch (e) {
    fail += 1; failures.push(name);
    console.log(`  ✗ [${name}] 用例中断: ${String(e.message || e).split('\n')[0]}`);
  }
}

const bugRepro = (tag, evidence) => {
  bugs.push({ tag, evidence });
  console.log(`  [BUG REPRODUCED] ${tag}`);
  if (evidence) console.log(`    ${String(evidence).replace(/\n/g, '\n    ')}`);
};

// ── 3. 真实 chrome 状态读写(全部走 service worker) ──
const snap = () => sw.evaluate(async () => {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  return {
    tabs: tabs.map((t) => ({
      id: t.id, url: t.url || '', title: t.title || '', groupId: t.groupId,
      windowId: t.windowId, active: !!t.active, index: t.index,
      lastAccessed: t.lastAccessed || 0,
    })),
    groups: groups.map((g) => ({
      id: g.id, title: g.title || '', color: g.color, windowId: g.windowId,
    })),
  };
});

const isProbeTab = (t) => (t.url || '').startsWith('chrome-extension://');
const tagOf = (t) => `#${t.id}:${t.title || '(无标题)'}`;

// 组名 → 成员(真数据, 不是 UI)
function membersOf(s, title, windowId = null) {
  const gs = s.groups.filter((g) => g.title === title
    && (windowId == null || g.windowId === windowId));
  return gs.map((g) => ({ group: g, tabs: s.tabs.filter((t) => t.groupId === g.id) }));
}
function groupTitleOf(s, groupId) {
  const g = s.groups.find((x) => x.id === groupId);
  return g ? (g.title || '(未命名)') : (groupId === -1 ? '(未分组)' : `?(#${groupId})`);
}
// 状态快照 → 一行行证据(打印给用户看的"前后真实 tabs/groups")
function dumpState(s, note = '') {
  const lines = [];
  if (note) lines.push(note);
  for (const g of s.groups) {
    const mem = s.tabs.filter((t) => t.groupId === g.id);
    lines.push(`「${g.title || '(未命名)'}」#${g.id} ${g.color} win=${g.windowId}`
      + ` → ${mem.length} 个: ${mem.map(tagOf).join(', ') || '(空)'}`);
  }
  const un = s.tabs.filter((t) => t.groupId === -1);
  lines.push(`未分组(${un.length}): ${un.map((t) => tagOf(t) + (isProbeTab(t) ? '[探针]' : '')).join(', ')}`);
  return lines.join('\n');
}
// 窗口内 "tabId → 所在组名" 指纹, 用于"其余一切 0 变动"这类断言
function fingerprint(s, windowId) {
  const m = new Map();
  for (const t of s.tabs) {
    if (t.windowId !== windowId) continue;
    m.set(t.id, groupTitleOf(s, t.groupId));
  }
  return m;
}
function diffFingerprint(before, after) {
  const out = [];
  for (const [id, was] of before) {
    const now = after.has(id) ? after.get(id) : '(已关闭)';
    if (now !== was) out.push(`#${id}: ${was} → ${now}`);
  }
  for (const [id, now] of after) {
    if (!before.has(id)) out.push(`#${id}: (新建) → ${now}`);
  }
  return out;
}

// ── 4. 环境: 每个 Case 从干净的开关状态开始 ──
async function resetEnv() {
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      autoGroupEnabled: false,
      othersGroupEnabled: false,
      groupRules: {},
      archivedGroups: [],
      manualTabIds: [],
    });
  });
  await sleep(250);
  // 只留浏览器启动时那个窗口(全关掉浏览器就退出了)
  const wins = await sw.evaluate(async () => (await chrome.windows.getAll({})).map((w) => ({ id: w.id, type: w.type })));
  const normal = wins.filter((w) => w.type === 'normal');
  for (const w of normal.slice(1)) {
    await sw.evaluate(async (id) => { await chrome.windows.remove(id).catch(() => {}); }, w.id);
  }
  await sleep(200);
}

const durl = (label) => `data:text/html;charset=utf-8,${encodeURIComponent(`<title>${label}</title><h1>${label}</h1>`)}`;

// 建一个测试窗口 + 若干标签; labels[0] 用 windows.create 带出来, 其余逐个 create
async function newWindow(labels, urls = {}) {
  const urlOf = (l) => urls[l] || durl(l);
  const winId = await sw.evaluate(async (u) => (await chrome.windows.create({
    url: u, type: 'normal', focused: true,
  })).id, urlOf(labels[0]));
  const ids = {};
  ids[labels[0]] = await sw.evaluate(async ([w]) => (await chrome.tabs.query({ windowId: w, active: true }))[0].id, [winId]);
  for (const l of labels.slice(1)) {
    ids[l] = await sw.evaluate(async ([w, u]) => (await chrome.tabs.create({ url: u, windowId: w, active: false })).id, [winId, urlOf(l)]);
    await sleep(60); // 保证 lastAccessed 严格递增(组内时间序断言依赖它)
  }
  await sleep(400);
  return { winId, ids };
}
async function makeGroup(winId, tabIds, title, color = 'blue') {
  const gid = await sw.evaluate(async ([w, ids]) => chrome.tabs.group({
    tabIds: ids, createProperties: { windowId: w },
  }), [winId, tabIds]);
  if (title) {
    await sw.evaluate(async ([g, t, c]) => chrome.tabGroups.update(g, { title: t, color: c }), [gid, title, color]);
  }
  await sleep(250);
  return gid;
}

// 在被测窗口里开一个真实 popup 页面(currentWindowId = 该窗口)
async function openPopup(winId) {
  const [page] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 15000 }),
    sw.evaluate(async (w) => {
      await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), windowId: w, active: true });
    }, winId),
  ]);
  page.on('pageerror', (e) => console.log('    [popup pageerror]', e.message));
  await page.waitForSelector('#search', { timeout: 15000 });
  await page.waitForFunction(() => !document.body.classList.contains('entrance'), null, { timeout: 10000 }).catch(() => {});
  await sleep(1300); // 过 main.js 的 1s 快照追帧, 确保列表已拿到最新 groupId
  return page;
}

async function closeCase(page, winId) {
  if (page) await page.close().catch(() => {});
  await sw.evaluate(async (id) => { await chrome.windows.remove(id).catch(() => {}); }, winId).catch(() => {});
  await sleep(250);
}
async function closeWindow(winId) {
  await sw.evaluate(async (id) => { await chrome.windows.remove(id).catch(() => {}); }, winId).catch(() => {});
  await sleep(250);
}

// ── 5. DOM 工具 ──
const rowSel = (id) => `.tab-item[data-tab-id="${id}"]`;
// 等行出现; 等不到就带诊断抛错(把当前行/搜索词打出来, 免得只看到一句 timeout)
async function waitRow(page, tabId, ms = 8000) {
  try {
    await page.waitForSelector(rowSel(tabId), { timeout: ms });
  } catch (e) {
    const diag = await page.evaluate(() => ({
      search: document.getElementById('search')?.value,
      rows: [...document.querySelectorAll('.tab-item')].map((r) => Number(r.dataset.tabId)),
      headers: [...document.querySelectorAll('.group-title')].map((x) => x.textContent.trim()),
      empty: document.querySelector('.empty')?.textContent?.slice(0, 40) || '',
    }));
    throw new Error(`行 #${tabId} 未渲染 — 当前 DOM: ${JSON.stringify(diag)}`);
  }
}
async function rightClickRow(page, tabId) {
  await waitRow(page, tabId);
  await page.click(rowSel(tabId), { button: 'right', position: { x: 40, y: 8 } });
}
// 清空搜索 + 重载页面: 命令态(/b /h)之后 state.activeCmd 不会自动复位,
// 列表会停在"命令视图"里 —— 换个干净现场最稳
async function resetView(page) {
  await page.fill('#search', '');
  await page.reload();
  await page.waitForSelector('#search', { timeout: 10000 });
  await page.waitForFunction(() => !document.body.classList.contains('entrance'), null, { timeout: 10000 }).catch(() => {});
  await sleep(600);
}
// 某个分组头之下的行(按 DOM 顺序 = 面板时间序)
async function sectionRows(page, title) {
  return page.evaluate((t) => {
    const h = [...document.querySelectorAll('.group-header')]
      .find((x) => (x.querySelector('.group-title')?.textContent || '').trim() === t);
    if (!h) return null;
    const out = [];
    let n = h.nextElementSibling;
    while (n && !n.classList.contains('group-header')) {
      if (n.classList.contains('tab-item')) out.push(Number(n.dataset.tabId));
      n = n.nextElementSibling;
    }
    return out;
  }, title);
}
async function allHeaders(page) {
  return page.evaluate(() => [...document.querySelectorAll('.group-title')].map((x) => x.textContent.trim()));
}
// 菜单结构: 逐项 { text, disabled, aria } + 分隔线占位('--sep--')
async function readMenu(page) {
  await page.waitForSelector('.ctx-menu', { timeout: 6000 });
  return page.evaluate(() => ({
    items: [...document.querySelectorAll('.ctx-menu > *')].map((el) => (el.classList.contains('ctx-sep')
      ? { sep: true }
      : {
        text: el.textContent.trim(),
        disabled: el.classList.contains('disabled'),
        aria: el.getAttribute('aria-disabled'),
      })),
    activeId: document.activeElement?.id || '',
    activeTag: document.activeElement?.tagName || '',
    activeInMenu: !!document.querySelector('.ctx-menu')?.contains(document.activeElement),
  }));
}
const itemTexts = (m) => m.items.filter((i) => !i.sep).map((i) => i.text);
async function clickMenuItem(page, prefix) {
  const h = await page.evaluateHandle((p) => [...document.querySelectorAll('.ctx-menu .ctx-item')]
    .find((i) => i.textContent.trim().startsWith(p)), prefix);
  const el = h.asElement();
  if (!el) throw new Error(`菜单项不存在: ${prefix}`);
  await el.click();
  await sleep(200);
}
async function cardInfo(page) {
  await page.waitForSelector('.ge-card', { timeout: 6000 });
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      head: (q('.ge-head')?.textContent || '').trim(),
      sub: (q('.ge-sub')?.textContent || '').trim(),
      hint: (q('.ge-hint')?.textContent || '').trim(),
      error: (q('.ge-error')?.textContent || '').trim(),
      value: q('.ge-input')?.value,
      activeColor: q('.ge-swatch.active')?.dataset.color,
      activeEl: document.activeElement?.className || '',
    };
  });
}
const cardOpen = (page) => page.evaluate(() => !!document.querySelector('.ge-card'));
async function toastTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('.push-banner .push-msg')].map((x) => x.textContent.trim()));
}

// 组内成员的时间序(与 close-batch 的 computeTargets 同一把尺子: lastAccessed 倒序, index 兜底)
function orderedMembers(s, groupId, windowId = null) {
  return s.tabs.filter((t) => t.groupId === groupId && (windowId == null || t.windowId === windowId))
    .sort((a, b) => (b.lastAccessed - a.lastAccessed) || (a.index - b.index));
}

// ██ 开始 ██
console.log(`\nHEADLESS 探针启动: headless=true + --headless=new, 无桌面窗口`);

// ═══════════════════════════════════════════════════════════════════════════
// Case 1 菜单结构 / 禁用态 / 焦点与关闭交互
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[Case 1] 菜单结构 / 禁用态 / 焦点与关闭交互');
await guard('1.1+1.2 菜单结构', async () => {
  await resetEnv();
  const { winId, ids } = await newWindow(['甲1', '甲2', '甲3', '散1']);
  const gid = await makeGroup(winId, [ids['甲1'], ids['甲2'], ids['甲3']], '组甲', 'blue');
  const page = await openPopup(winId);
  const s0 = await snap();
  const members = orderedMembers(s0, gid);
  const domOrder = await sectionRows(page, '组甲');
  chk('1.0 面板行序 = 数据源组内时间序(lastAccessed 倒序)',
    JSON.stringify(domOrder) === JSON.stringify(members.map((t) => t.id)),
    `DOM=${JSON.stringify(domOrder)} 数据源=${JSON.stringify(members.map((t) => t.id))}`);

  // —— 1.1 组内标签行 ——
  const anchor = members[1].id; // 第 2 行
  await rightClickRow(page, anchor);
  const m1 = await readMenu(page);
  const texts = itemTexts(m1);
  const restN = members.length - 1;
  const belowN = members.length - 2; // 第 2 行之后还有 1 个
  const expectGrouped = [
    '新建分组…', '移出分组',
    `关闭本组其余标签 (${restN})`,
    `关闭本组此标签下方标签 (${belowN})`,
    '关闭「组甲」全部标签 (3)',
    '归档「组甲」分组',
  ];
  chk('1.1 组内行菜单项与顺序完全符合', JSON.stringify(texts) === JSON.stringify(expectGrouped),
    `实际=${JSON.stringify(texts)}`);
  chk('1.1 菜单有 role=menu 且挂 body 下(fixed, 不被滚动容器裁切)',
    await page.evaluate(() => {
      const el = document.querySelector('.ctx-menu');
      return !!el && el.getAttribute('role') === 'menu' && el.parentElement === document.body;
    }));
  await page.keyboard.press('Escape');
  await sleep(150);

  // —— 1.2 未分组标签行 ——
  await rightClickRow(page, ids['散1']);
  const m2 = await readMenu(page);
  const t2 = itemTexts(m2);
  // 未分组分区的作用域 = 本窗口内 groupId=-1 的全部标签。注意: 探针自己的 popup 标签
  // 也是一个未分组标签(它是 chrome-extension:// 所以不进列表), 但它**在分母里** ——
  // 菜单文案(2) 与真实 query 一致, 只是其中 1 个在 UI 上看不见。
  const unMembers = orderedMembers(s0, -1, winId);
  const pos = unMembers.findIndex((t) => t.id === ids['散1']);
  const unAllN = unMembers.length;
  const unRestN = unAllN - 1;
  const unBelowN = pos < 0 ? 0 : unMembers.slice(pos + 1).length;
  const expectUngrouped = [
    '新建分组…',
    `关闭本组其余标签 (${unRestN})`,
    `关闭本组此标签下方标签 (${unBelowN})`,
    `关闭本窗口未分组标签 (${unAllN})`,
  ];
  chk('1.2 未分组行菜单项与顺序完全符合', JSON.stringify(t2) === JSON.stringify(expectUngrouped),
    `实际=${JSON.stringify(t2)}; 未分组真实标签=${unAllN} 个(${unMembers.map(tagOf).join(', ')}, 其中 1 个是探针 popup 标签)`);
  chk('1.2 未分组行菜单不含「移出分组」', !t2.some((x) => x.startsWith('移出分组')));
  chk('1.2 未分组行菜单不含「归档」', !t2.some((x) => x.includes('归档')));
  await page.keyboard.press('Escape');
  await sleep(150);
  await closeCase(page, winId);
});

await guard('1.3 禁用态', async () => {
  // —— 1.3 靶子为空 → 禁用置灰而不是隐藏 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['单1', '多1', '多2', '多3']);
  await makeGroup(winId, [ids['单1']], '单标签组', 'green');
  const gMult = await makeGroup(winId, [ids['多1'], ids['多2'], ids['多3']], '多标签组', 'red');
  const page = await openPopup(winId);
  const s = await snap();
  const ordered = orderedMembers(s, gMult);
  const lastRow = ordered[ordered.length - 1].id;

  await rightClickRow(page, ids['单1']);
  const mA = await readMenu(page);
  const itA = mA.items.filter((i) => !i.sep);
  const restItem = itA.find((i) => i.text.startsWith('关闭本组其余标签'));
  const belowItem = itA.find((i) => i.text.startsWith('关闭本组此标签下方标签'));
  chk('1.3 单标签组:「其余 (0)」仍在菜单里(未被隐藏)', !!restItem && restItem.text === '关闭本组其余标签 (0)',
    JSON.stringify(restItem));
  chk('1.3 「其余 (0)」禁用置灰: .disabled + aria-disabled="true"',
    !!restItem && restItem.disabled === true && restItem.aria === 'true',
    JSON.stringify(restItem));
  chk('1.3 「下方 (0)」禁用置灰: .disabled + aria-disabled="true"',
    !!belowItem && belowItem.disabled === true && belowItem.aria === 'true',
    JSON.stringify(belowItem));
  chk('1.3 「全部 (1)」仍可用(不因靶子小就被禁用)',
    itA.some((i) => i.text === '关闭「单标签组」全部标签 (1)' && !i.disabled), JSON.stringify(itemTexts(mA)));
  // 禁用项不是"点了没反应"的假条目: 不应有 click 处理器 —— 这里验证它至少不报错/不关组
  await page.keyboard.press('Escape');
  await sleep(120);

  await rightClickRow(page, lastRow);
  const mB = await readMenu(page);
  const itB = mB.items.filter((i) => !i.sep);
  const belowB = itB.find((i) => i.text.startsWith('关闭本组此标签下方标签'));
  const restB = itB.find((i) => i.text.startsWith('关闭本组其余标签'));
  chk('1.3 组内最后一行:「下方 (0)」禁用置灰(而非隐藏)',
    !!belowB && belowB.text === '关闭本组此标签下方标签 (0)' && belowB.disabled && belowB.aria === 'true',
    JSON.stringify(belowB));
  chk('1.3 同一行「其余 (2)」保持可用', !!restB && !restB.disabled, JSON.stringify(restB));
  await page.keyboard.press('Escape');
  await sleep(120);
  await closeCase(page, winId);
});

await guard('1.4 焦点与关闭', async () => {
  // —— 1.4 菜单不夺焦点 / Esc / 点外部关闭 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['焦1', '焦2', '焦3']);
  const gid = await makeGroup(winId, [ids['焦1'], ids['焦2'], ids['焦3']], '焦点组', 'purple');
  const page = await openPopup(winId);
  const s0 = await snap();
  const mem = orderedMembers(s0, gid);

  await page.fill('#search', '焦');
  await page.waitForFunction(() => document.querySelectorAll('.tab-item').length > 0, null, { timeout: 6000 });
  await sleep(300);
  const before = await page.evaluate(() => document.activeElement?.id);
  chk('1.4 前置: 搜索框持焦 且 搜索词已输入', before === 'search',
    `activeElement=#${before}, value=${await page.inputValue('#search')}`);

  await rightClickRow(page, mem[0].id);
  const mf = await readMenu(page);
  chk('1.4 打开菜单后 document.activeElement.id === "search"', mf.activeId === 'search',
    `实际 activeElement=<${mf.activeTag} id="${mf.activeId}">`);
  if (mf.activeId !== 'search') {
    bugRepro('1.4 右键打开行菜单后搜索框丢了焦点', [
      '设计契约(contextmenu.js 文件头): "菜单**不夺焦点**(mousedown 上 preventDefault), 搜索框始终持焦,',
      '  关掉菜单可以直接继续打字" —— 实测搜索框已失焦, activeElement 变成 BODY。',
      `  证据: activeElement=<${mf.activeTag} id="${mf.activeId}">, 菜单本身未持焦(activeInMenu=${mf.activeInMenu})。`,
      '  归因: 不是菜单抢的(直接派发 contextmenu 事件时 activeElement 仍是 #search),',
      '        而是行的真右键 mousedown 让 Chrome 把焦点移到了 BODY —— 行上没有任何 mousedown 防护。',
    ].join('\n'));
  }
  chk('1.4 菜单本身不持焦(焦点不在 .ctx-menu 内)', mf.activeInMenu === false);

  // Esc 关菜单 + 不清搜索词
  const valBefore = await page.inputValue('#search');
  await page.keyboard.press('Escape');
  await sleep(200);
  const afterEsc = await page.evaluate(() => ({
    menu: !!document.querySelector('.ctx-menu'),
    val: document.getElementById('search').value,
    settingsOpen: document.getElementById('settingsPanel')?.classList.contains('open'),
    active: document.activeElement?.id || document.activeElement?.tagName,
  }));
  chk('1.4 Esc 关闭菜单', afterEsc.menu === false);
  chk('1.4 Esc 不清空搜索词', afterEsc.val === valBefore, `前后都是「${valBefore}」`);
  chk('1.4 Esc 只关菜单, 不连带关设置面板', !afterEsc.settingsOpen);
  // 失焦的实际后果: 菜单关掉后直接打字, 搜索词不动(必须重新点搜索框)
  const typed = await page.evaluate(async () => {
    const before = document.getElementById('search').value;
    return { before, active: document.activeElement?.tagName || '' };
  });
  await page.keyboard.type('x');
  await sleep(200);
  const afterType = await page.inputValue('#search');
  if (mf.activeId !== 'search') {
    chk('1.4 [契约后果] 关菜单后直接打字应继续进入搜索框', afterType !== typed.before,
      `activeElement=${typed.active}, 打字后 value 仍为「${afterType}」(旧值「${typed.before}」)`);
  } else {
    chk('1.4 [契约后果] 关菜单后直接打字进入搜索框', afterType !== typed.before, `value=${afterType}`);
  }
  await page.fill('#search', '');

  // 点击菜单外关闭
  await rightClickRow(page, mem[0].id);
  await readMenu(page);
  const atCorner = await page.evaluate(() => {
    const el = document.elementFromPoint(2, 2);
    return { tag: el?.tagName, cls: el?.className || '' };
  });
  await page.mouse.click(2, 2);
  await sleep(250);
  chk('1.4 点击菜单外(左上角 2,2)关闭菜单',
    (await page.evaluate(() => !document.querySelector('.ctx-menu'))),
    `点中的元素=<${atCorner.tag} class="${atCorner.cls}">`);
  await closeCase(page, winId);
});

await guard('1.5 虚拟条目', async () => {
  // —— 1.5 虚拟条目(书签/历史)右键不弹菜单 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['书1', '书2']);
  await makeGroup(winId, [ids['书1'], ids['书2']], '书签组', 'cyan');
  const bmId = await sw.evaluate(async () => (await chrome.bookmarks.create({
    title: '探针书签-甲', url: 'http://127.0.0.1:1/probe-bookmark',
  })).id);
  const page = await openPopup(winId);
  await page.fill('#search', '/b');
  await page.waitForSelector('.tab-item', { timeout: 8000 });
  await sleep(600);
  const virtualRows = await page.evaluate(() => [...document.querySelectorAll('.tab-item')]
    .map((r) => ({ id: Number(r.dataset.tabId), text: r.textContent.trim().slice(0, 20) })));
  const negs = virtualRows.filter((r) => r.id < 0);
  chk('1.5 前置: /b 命令下存在虚拟条目(负 tabId)', negs.length > 0,
    `虚拟行=${JSON.stringify(negs)}`);

  // 真右键虚拟条目
  await page.click(rowSel(negs[0].id), { button: 'right', position: { x: 40, y: 8 } });
  await sleep(700);
  const menuAfterVirtual = await page.evaluate(() => !!document.querySelector('.ctx-menu'));
  chk('1.5 右键虚拟条目(书签)不弹 .ctx-menu', menuAfterVirtual === false,
    menuAfterVirtual ? '菜单冒出来了' : '');

  // /h 历史同理(有历史就一起测)
  await page.fill('#search', '/h');
  await page.waitForSelector('.tab-item', { timeout: 8000 });
  await sleep(600);
  const histRows = await page.evaluate(() => [...document.querySelectorAll('.tab-item')]
    .map((r) => Number(r.dataset.tabId)).filter((x) => x < 0));
  if (histRows.length) {
    await page.click(rowSel(histRows[0]), { button: 'right', position: { x: 40, y: 8 } });
    await sleep(700);
    const m = await page.evaluate(() => !!document.querySelector('.ctx-menu'));
    chk('1.5 右键虚拟条目(/h 历史)不弹 .ctx-menu', m === false, m ? '菜单冒出来了' : '');
  } else {
    console.log('  - 1.5 (跳过 /h: 该 profile 无历史记录)');
  }
  // 实体行仍可弹(对照组, 证明不是"整个页面都弹不出")
  await resetView(page);
  await rightClickRow(page, ids['书1']);
  chk('1.5 对照组: 真实标签行仍能正常弹菜单',
    (await readMenu(page)).items.some((i) => i.text === '新建分组…'));
  await page.keyboard.press('Escape');
  await sw.evaluate(async (id) => { await chrome.bookmarks.remove(id).catch(() => {}); }, bmId);
  await closeCase(page, winId);
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 2 「新建分组…」正常隔离性基线
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[Case 2] 「新建分组…」隔离性基线(不拉入无关标签)');
await guard('2.1+2.2 建组隔离性', async () => {
  // —— 2.1 / 2.2 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['A1', 'A2', 'A3', '散X', '散Y']);
  const gA = await makeGroup(winId, [ids['A1'], ids['A2'], ids['A3']], '组A', 'blue');
  const gOther = await makeGroup(winId, [ids['散Y']], '别组Z', 'pink');
  const page = await openPopup(winId);
  const s0 = await snap();
  const fp0 = fingerprint(s0, winId);
  const mem = orderedMembers(s0, gA);
  const anchor = mem[1].id; // 第 2 个标签

  await rightClickRow(page, anchor);
  await clickMenuItem(page, '新建分组');
  const c0 = await cardInfo(page);
  chk('2.1 「新建分组」卡片打开并预填蓝色', c0.head === '新建分组' && c0.activeColor === 'blue',
    JSON.stringify({ head: c0.head, sub: c0.sub, color: c0.activeColor }));
  await page.fill('.ge-input', '新建隔离组');
  await page.click('.ge-swatch[data-color="purple"]');
  await page.click('.ge-ok');
  await sleep(900);
  const toasts = await toastTexts(page);
  chk('2.1 提交后提示「已新建分组」', toasts.some((t) => t.includes('已新建分组「新建隔离组」')), JSON.stringify(toasts));

  // —— 2.2 真状态核对 ——
  const s1 = await snap();
  const created = membersOf(s1, '新建隔离组', winId);
  chk('2.2 新组「新建隔离组」存在且唯一', created.length === 1, `命中 ${created.length} 个组`);
  chk('2.2 新组颜色 = purple', created[0]?.group.color === 'purple', created[0]?.group.color);
  chk('2.2 新组内有且仅有被右键的那 1 个标签',
    created[0]?.tabs.length === 1 && created[0].tabs[0].id === anchor,
    created[0] ? created[0].tabs.map(tagOf).join(', ') : '(无)');
  const aLeft = s1.tabs.filter((t) => t.groupId === gA);
  chk('2.2 原组 A 剩余 2 个标签完好',
    aLeft.length === 2 && aLeft.every((t) => t.id !== anchor)
    && [ids['A1'], ids['A2'], ids['A3']].filter((x) => x !== anchor).every((x) => aLeft.some((t) => t.id === x)),
    aLeft.map(tagOf).join(', '));
  const diff = diffFingerprint(fp0, fingerprint(s1, winId));
  chk('2.2 其他分组与未分组标签 0 变动', diff.length === 1 && diff[0].includes(anchor),
    `变化项=${JSON.stringify(diff)}`);
  chk('2.2 别组Z 完好未受牵连', s1.tabs.filter((t) => t.groupId === gOther).length === 1,
    s1.tabs.filter((t) => t.groupId === gOther).map(tagOf).join(', '));
  if (diff.length !== 1 || created[0]?.tabs.length !== 1) {
    console.log('    ' + dumpState(s1, '  实测状态:').replace(/\n/g, '\n    '));
  }
  await closeCase(page, winId);
});

await guard('2.3 引擎不拉回', async () => {
  // —— 2.3 手动建组 vs 自动分组引擎: 不被拉回、不被塞无关标签 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['规则页', '散页'], { 规则页: `${H}/rule-hit`, 散页: `${H2}/no-rule` });
  const page = await openPopup(winId);

  // 打开引擎 + 规则: 证明引擎确实是活的(规则页 → 规则组; 散页 → Others)
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      groupRules: { 自动规则组: ['127.0.0.1'] },
      autoGroupEnabled: true,
      othersGroupEnabled: true,
    });
  });
  await sw.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'group-existing' }).catch(() => {}); });
  await sleep(1800);
  const sOn = await snap();
  const ruleHit = sOn.tabs.find((t) => t.id === ids['规则页']);
  const otherHit = sOn.tabs.find((t) => t.id === ids['散页']);
  chk('2.3 前置: 规则引擎已生效(命中规则的标签进了「自动规则组」)',
    groupTitleOf(sOn, ruleHit.groupId) === '自动规则组', groupTitleOf(sOn, ruleHit.groupId));
  chk('2.3 前置: 未命中规则的标签在 Others',
    groupTitleOf(sOn, otherHit.groupId) === 'Others', groupTitleOf(sOn, otherHit.groupId));

  await page.reload();
  await page.waitForSelector('#search');
  await page.waitForFunction(() => !document.body.classList.contains('entrance'), null, { timeout: 10000 }).catch(() => {});
  await sleep(700);
  await rightClickRow(page, ids['散页']);
  await clickMenuItem(page, '新建分组');
  await page.fill('.ge-input', '手动保护组');
  await page.click('.ge-ok');
  await sleep(900);
  const sMid = await snap();
  const justMade = membersOf(sMid, '手动保护组', winId);
  chk('2.3 手动建组成功', justMade.length === 1 && justMade[0].tabs.length === 1,
    justMade[0] ? justMade[0].tabs.map(tagOf).join(', ') : '(无)');

  // 让引擎再跑一轮(等价于用户后续开标签/切标签时的自动分组)
  await sw.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'group-existing' }).catch(() => {}); });
  await sleep(1500);
  const sAfter = await snap();
  const finalTab = sAfter.tabs.find((t) => t.id === ids['散页']);
  const finalGroup = membersOf(sAfter, '手动保护组', winId);
  chk('2.3 1500ms 后该标签仍在「手动保护组」', !!finalTab && groupTitleOf(sAfter, finalTab.groupId) === '手动保护组',
    finalTab ? `实际所在组=${groupTitleOf(sAfter, finalTab.groupId)}` : '标签已消失');
  chk('2.3 「手动保护组」内没有混入无关标签',
    finalGroup.length === 1 && finalGroup[0].tabs.length === 1 && finalGroup[0].tabs[0].id === ids['散页'],
    finalGroup[0] ? finalGroup[0].tabs.map(tagOf).join(', ') : '(组已消失)');
  const othersNow = sAfter.tabs.filter((t) => t.groupId !== -1
    && groupTitleOf(sAfter, t.groupId) === '手动保护组' && t.id !== ids['散页']);
  chk('2.3 无其他标签进入「手动保护组」', othersNow.length === 0, othersNow.map(tagOf).join(', '));
  console.log('    ' + dumpState(sAfter, '  实测状态:').replace(/\n/g, '\n    '));
  await closeCase(page, winId);
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 3 异常与"无关标签被移入"专项
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[Case 3] 「新建分组…」异常与疑似"无关标签移入"专项实测');

await guard('3.1 同名组预警 + 允许并入', async () => {
  // —— 3.1 同名自定义组: 卡片必须预警 / 并入本身是**已确认的产品口径** ——
  // 用户口径(2026-11-25 确认): 新建分组撞上同窗口已有自定义组时「允许并入」,
  // 但必须先预警(不许静默)。所以本 Case 验收的是两件事:
  //   ① 卡片 .ge-hint 给出「本窗口已有同名分组，确定后会并入它」;
  //   ② 并入确实发生且干净: 同窗口同名组只有 1 个, T1/T2/T3 都在其中, toast 报「已并入」
  await resetEnv();
  const { winId, ids } = await newWindow(['T1', 'T2', 'T3', 'T4']);
  const gExist = await makeGroup(winId, [ids['T1'], ids['T2']], '已有自定义', 'orange');
  const gOtherGroup = await makeGroup(winId, [ids['T3']], '别的组', 'grey');
  const page = await openPopup(winId);
  const before = await snap();
  const anchor = ids['T3'];

  await rightClickRow(page, anchor);
  await clickMenuItem(page, '新建分组');
  await page.fill('.ge-input', '已有自定义');
  await sleep(300);
  const cHint = await cardInfo(page);
  const hasWarn = cHint.hint.includes('已有同名') && cHint.hint.includes('并入');
  chk('3.1 输入已存在的自定义组名时, .ge-hint 给出“会并入”预警',
    hasWarn, `.ge-hint = ${JSON.stringify(cHint.hint)}`);
  if (!hasWarn) {
    bugRepro('3.1 输入与"已有自定义组"同名的名字, 卡片毫无预警(静默并入盲区)', [
      '卡片打开后输入「已有自定义」(同窗口已存在同名组, 内含无关标签 T1/T2), .ge-hint 没有给出预警。',
      'group-edit.js 的 refreshHint 必须同时看 ruleNames(规则键) 与 windowGroupNames(本窗口已有组名)。',
    ].join('\n'));
  }
  await page.click('.ge-ok');
  await sleep(1000);
  const after = await snap();
  const merged = membersOf(after, '已有自定义', winId);
  const toasts = await toastTexts(page);
  const mergedIds = merged[0] ? merged[0].tabs.map((t) => t.id).sort((a, b) => a - b) : [];
  const expectIds = [ids['T1'], ids['T2'], ids['T3']].sort((a, b) => a - b);
  console.log('    ' + dumpState(after, '  实测状态:').replace(/\n/g, '\n    '));
  console.log(`    toast: ${JSON.stringify(toasts)}`);
  console.log(`    证据: 并入前「已有自定义」#${gExist}, 「别的组」#${gOtherGroup}`);
  const mergedClean = merged.length === 1 && mergedIds.length === 3
    && expectIds.every((id) => mergedIds.includes(id));
  chk('3.1 允许并入: 同窗口同名组只有 1 个, T1/T2/T3 都在其中',
    mergedClean, `「已有自定义」组数=${merged.length}, 成员=${JSON.stringify(mergedIds)}`);
  const toastMerge = toasts.some((x) => x.includes('已并入同名分组「已有自定义」'));
  chk('3.1 并入后给出「已并入同名分组「已有自定义」」toast',
    toastMerge, JSON.stringify(toasts));
  if (!mergedClean || !toastMerge) {
    bugRepro('3.1 [实锤] 同名自定义组的并入没有按契约发生/表述', [
      `期望: 同窗口同名组数 = 1 且成员 = T1/T2/T3; 实测组数=${merged.length}, 成员=${JSON.stringify(mergedIds)}`,
      `期望 toast 含「已并入同名分组「已有自定义」」; 实测: ${JSON.stringify(toasts)}`,
      `卡片预警: ${JSON.stringify(cHint.hint)}`,
      `「别的组」#${gOtherGroup} 预期随最后一个标签迁走而消失: groups=${JSON.stringify(after.groups.map((g) => g.title))}`,
    ].join('\n'));
  }
  await closeCase(page, winId);
});

await guard('3.2 通配符', async () => {
  // —— 3.2 通配符 ? / * ——
  await resetEnv();
  const { winId, ids } = await newWindow(['任1', '任2', '项1', '项2']);
  const gTask = await makeGroup(winId, [ids['任1']], '任务1', 'blue');
  const gTmp = await makeGroup(winId, [ids['任2']], '临时组', 'grey');
  const page = await openPopup(winId);

  await rightClickRow(page, ids['任2']);
  await clickMenuItem(page, '新建分组');
  await page.fill('.ge-input', '任务?');
  await page.click('.ge-ok');
  await sleep(1100);
  const sQ = await snap();
  const qGroups = membersOf(sQ, '任务?', winId);
  const taskGroup = membersOf(sQ, '任务1', winId);
  console.log('    ' + dumpState(sQ, '  实测状态(输 任务? 之后):').replace(/\n/g, '\n    '));
  console.log(`    toast: ${JSON.stringify(await toastTexts(page))}`);
  chk('3.2 通配符 ? : 安全预期 — 新建独立分组「任务?」', qGroups.length === 1,
    `「任务?」组数=${qGroups.length}; 「任务1」成员=${taskGroup[0] ? taskGroup[0].tabs.map(tagOf).join(', ') : '(组已消失)'}`);
  if (qGroups.length === 0 && taskGroup.length === 1 && taskGroup[0].tabs.length === 2) {
    bugRepro('3.2 [实锤] 分组名里的 "?" 被当成通配符, 标签被并入无关的「任务1」组', [
      'chrome.tabGroups.query({title}) 的 title 是**通配匹配**(? = 任意单字符, * = 任意串),',
      '  而 createOrMergeGroup 直接把它当成"查同名组"用:',
      `  query({title:'任务?'}) 命中「任务1」#${gTask} ⇒ 走 merged 分支把标签并进去, 不新建组。`,
      `  「任务1」现有成员 = ${taskGroup[0].tabs.map(tagOf).join(', ')} (任1 + 被并入的 任2)`,
      `  原「临时组」#${gTmp} 已随唯一标签迁走而消失。`,
    ].join('\n'));
  }

  // 第二个: 组「项目A」存在时输入名字 '*'  —— 通配符全匹配, 会把标签并进窗口里"第一个"组
  const sPre = await snap();
  const gProj = await makeGroup(winId, [ids['项1']], '项目A', 'green');
  await makeGroup(winId, [ids['项2']], '项目B', 'pink');
  await page.reload();
  await page.waitForSelector('#search');
  await page.waitForFunction(() => !document.body.classList.contains('entrance'), null, { timeout: 10000 }).catch(() => {});
  await sleep(700);
  const preStar = await snap();
  await rightClickRow(page, ids['项2']);
  await clickMenuItem(page, '新建分组');
  await page.fill('.ge-input', '*');
  await page.click('.ge-ok');
  await sleep(1100);
  const sStar = await snap();
  const starGroups = membersOf(sStar, '*', winId);
  const movedTab = sStar.tabs.find((t) => t.id === ids['项2']);
  console.log('    ' + dumpState(sStar, '  实测状态(输 * 之后):').replace(/\n/g, '\n    '));
  console.log(`    toast: ${JSON.stringify(await toastTexts(page))}`);
  chk('3.2 通配符 * : 安全预期 — 新建独立分组「*」', starGroups.length === 1,
    `「*」组数=${starGroups.length}; 项2 实际落在「${groupTitleOf(sStar, movedTab.groupId)}」`);
  if (starGroups.length === 0) {
    const landed = sStar.groups.find((g) => g.id === movedTab.groupId);
    bugRepro('3.2 [实锤] 分组名 "*" 匹配到了窗口里任意已有组, 标签被并入该组而不是新建分组', [
      `query({title:'*'}) 通配全匹配 ⇒ 命中窗口内第一个组「${landed ? landed.title : '?'}」#${movedTab.groupId}`,
      `  项2 #${ids['项2']} 现在在「${groupTitleOf(sStar, movedTab.groupId)}」:`
      + ` ${sStar.tabs.filter((t) => t.groupId === movedTab.groupId).map(tagOf).join(', ')}`,
      `  原「项目B」组已消失; 输 '*' 的用户本意显然不是"并进某个已有组"。`,
      `  (对照: 输 '*' 前窗口内组 = ${JSON.stringify(preStar.groups.filter((g) => g.windowId === winId).map((g) => g.title))})`,
    ].join('\n'));
  }
  await closeCase(page, winId);
});

await guard('3.3 未命名组 tidy', async () => {
  // —— 3.3 tidy-groups 是否会合并两个毫无关系的未命名分组 ——
  // 这一段**故意不先开 popup**: popup 启动时自己会发一条 tidy-groups(main.js 的
  // requestTidyGroups), 先开会把现场提前毁掉, 就测不出"这条消息本身干了什么"。
  await resetEnv();
  const { winId, ids } = await newWindow(['X1', 'X2', 'Y1', 'Y2']);
  const gX = await makeGroup(winId, [ids['X1'], ids['X2']], '', 'grey'); // 未命名组 X
  const gY = await makeGroup(winId, [ids['Y1'], ids['Y2']], '', 'grey'); // 未命名组 Y
  await sleep(300);
  const beforeTidy = await snap();
  console.log('    ' + dumpState(beforeTidy, '  tidy 前:').replace(/\n/g, '\n    '));
  chk('3.3 前置: 同窗口确实并存 2 个未命名分组(title="")',
    beforeTidy.groups.filter((g) => g.windowId === winId && g.title === '').length === 2,
    JSON.stringify(beforeTidy.groups.filter((g) => g.windowId === winId).map((g) => ({ id: g.id, t: g.title }))));

  await sw.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'tidy-groups' }).catch(() => {}); });
  await sleep(1000);
  const afterTidy = await snap();
  console.log('    ' + dumpState(afterTidy, '  tidy 后(等 1000ms):').replace(/\n/g, '\n    '));
  const unnamed = afterTidy.groups.filter((g) => g.windowId === winId && g.title === '');
  const xMembers = beforeTidy.tabs.filter((t) => t.groupId === gX).map((t) => t.id);
  const yMembers = beforeTidy.tabs.filter((t) => t.groupId === gY).map((t) => t.id);
  chk('3.3 安全预期: 两个未命名分组都是"用户自己的身份", tidy 不该把它们合并',
    unnamed.length === 2, `tidy 后未命名组数=${unnamed.length}`);
  const mergedMembers = unnamed.length === 1
    ? afterTidy.tabs.filter((t) => t.groupId === unnamed[0].id).map((t) => t.id) : [];
  chk('3.3 双保险: 即使被合并, X 与 Y 的标签也不该出现在同一个组里',
    !(mergedMembers.includes(ids['X1']) && mergedMembers.includes(ids['Y1'])),
    `未命名组残留成员=${JSON.stringify(mergedMembers)}`);
  if (unnamed.length < 2 && mergedMembers.includes(ids['X1']) && mergedMembers.includes(ids['Y1'])) {
    bugRepro('3.3 [实锤] tidy-groups 把两个毫无关系的未命名分组暴力合并成一个', [
      `tidy 前: 未命名组 X #${gX} = [${xMembers.join(', ')}], 未命名组 Y #${gY} = [${yMembers.join(', ')}]`,
      `tidy 后: 只剩 ${unnamed.length} 个未命名组 #${unnamed[0]?.id}, 成员 = [${mergedMembers.join(', ')}]`,
      '  根因: doTidyGroups 用 `const key = g.title || \'\'` 做同名键 —— 所有未命名组都落到同一个',
      '        空串键上, 于是被当成"同名重复组"合并, 另一个壳被临时标签法收尸删掉。',
      '  这是数据毁伤: Chrome 没有删组 API, 合并后无法还原两个组的原始边界。',
    ].join('\n'));
  }

  // —— 3.3b 用户真实路径: 什么都不做, 只"唤起一次面板" ——
  // popup 启动时 main.js 的 requestTidyGroups() 会发同一条 tidy-groups, 所以用户侧的表现是:
  // "我手动分的两个未命名组, 打开一次插件面板就自己并成一个了"。这段证明触发源是产品自己。
  const w2 = await newWindow(['P1', 'P2', 'Q1', 'Q2']);
  await makeGroup(w2.winId, [w2.ids['P1'], w2.ids['P2']], '', 'grey');
  await makeGroup(w2.winId, [w2.ids['Q1'], w2.ids['Q2']], '', 'grey');
  await sleep(300);
  const prePopup = await snap();
  chk('3.3b 前置: 新窗口里并存 2 个未命名分组',
    prePopup.groups.filter((g) => g.windowId === w2.winId && g.title === '').length === 2,
    JSON.stringify(prePopup.groups.filter((g) => g.windowId === w2.winId).map((g) => ({ id: g.id, t: g.title }))));
  const page2 = await openPopup(w2.winId); // 只打开面板, 什么都不点
  await sleep(1800);
  const postPopup = await snap();
  const unnamed2 = postPopup.groups.filter((g) => g.windowId === w2.winId && g.title === '');
  const ppMembers = unnamed2.length === 1
    ? postPopup.tabs.filter((t) => t.groupId === unnamed2[0].id).map((t) => t.id) : [];
  chk('3.3b 安全预期: 仅仅唤起面板不应改变分组结构', unnamed2.length === 2,
    `唤起后未命名组数=${unnamed2.length}, 成员=${JSON.stringify(ppMembers)}`);
  if (unnamed2.length < 2) {
    bugRepro('3.3b [实锤] 仅仅打开一次面板, 两个互不相干的未命名分组就被并成一个', [
      `唤起前: 2 个未命名组(${JSON.stringify(prePopup.groups.filter((g) => g.windowId === w2.winId).map((g) => g.id))}),`
      + ` P1/P2 与 Q1/Q2 各在一组`,
      `  唤起后: ${unnamed2.length} 个未命名组, 成员 = [${ppMembers.join(', ')}]`,
      '  触发源不是我的合成消息: popup 一加载, main.js 的 requestTidyGroups() 就发 tidy-groups',
      '  → background doTidyGroups() → 按空标题键把两个无名组合并。',
    ].join('\n'));
  }
  await closeCase(page2, w2.winId);
  await closeWindow(winId);
});

await guard('3.4 同 URL 副本', async () => {
  // —— 3.4 同 URL 副本打包语义(组 A 的合并行) ——
  await resetEnv();
  const dupUrl = durl('DUP');
  const otherUrl = durl('O1');
  // 先建 D3(组 B) 再建 D1/D2: 保证同 URL 行的"代表"是组 A 里的那个
  const { winId, ids } = await newWindow(['D3', 'O1', 'D1', 'D2'], {
    D3: dupUrl, D1: dupUrl, D2: dupUrl, O1: otherUrl,
  });
  const gB = await makeGroup(winId, [ids['D3']], '组B', 'grey');
  const gA = await makeGroup(winId, [ids['O1'], ids['D1'], ids['D2']], '组A', 'blue');
  const page = await openPopup(winId);
  try {
    const s0 = await snap();
    const repRow = await page.evaluate(() => {
      // 面板里同 URL 只留一行(代表 = 最近使用的那份), 找组A分区里 UI 上的那一行
      const h = [...document.querySelectorAll('.group-header')]
        .find((x) => (x.querySelector('.group-title')?.textContent || '').trim() === '组A');
      if (!h) return null; // 让调用方给出诊断, 而不是在这里抛
      const out = [];
      let n = h.nextElementSibling;
      while (n && !n.classList.contains('group-header')) {
        if (n.classList.contains('tab-item')) out.push(Number(n.dataset.tabId));
        n = n.nextElementSibling;
      }
      return out;
    });
    if (!repRow) {
      chk('3.4 前置: 面板里出现「组A」分区', false,
        `实际分区=${JSON.stringify(await allHeaders(page))}; 真实状态: ${dumpState(s0)}`);
      throw new Error('3.4 前置失败: 面板里没有「组A」分区');
    }
    chk('3.4 前置: 组 A 在面板里只有 2 行(O1 行 + 同 URL 合并行)',
      repRow.length === 2, JSON.stringify(repRow));
    const dupRowTab = repRow.find((x) => x !== ids['O1']);
    chk('3.4 前置: 同 URL 合并行的代表属于组 A(不是组 B 的 D3)',
      dupRowTab === ids['D2'] || dupRowTab === ids['D1'], `代表=#${dupRowTab}`);

    await rightClickRow(page, dupRowTab);
    await clickMenuItem(page, '新建分组');
    const c = await cardInfo(page);
    chk('3.4 卡片副标题提示"等 2 个标签"(副本只算本组内的)',
      /等 2 个标签/.test(c.sub), `.ge-sub = ${JSON.stringify(c.sub)}`);
    await page.fill('.ge-input', '同URL新组');
    await page.click('.ge-ok');
    await sleep(1000);
    const s1 = await snap();
    const newG = membersOf(s1, '同URL新组', winId);
    const newIds = newG[0] ? newG[0].tabs.map((t) => t.id).sort((a, b) => a - b) : [];
    const expectNew = [ids['D1'], ids['D2']].sort((a, b) => a - b);
    chk('3.4 D1、D2 一起进了新组', JSON.stringify(newIds) === JSON.stringify(expectNew),
      `实际=${JSON.stringify(newIds)} 期望=${JSON.stringify(expectNew)}`);
    chk('3.4 O1 留在组 A', (s1.tabs.find((t) => t.id === ids['O1']).groupId) === gA,
      `O1 所在组=${groupTitleOf(s1, s1.tabs.find((t) => t.id === ids['O1']).groupId)}`);
    chk('3.4 组 B 的 D3 不受影响(仍在组 B)',
      s1.tabs.find((t) => t.id === ids['D3']).groupId === gB,
      `D3 所在组=${groupTitleOf(s1, s1.tabs.find((t) => t.id === ids['D3']).groupId)}`);
  } finally {
    await closeCase(page, winId);
  }
});

await guard('3.5 卡片校验/IME/取消', async () => {
  // —— 3.5 卡片输入校验 & IME 保护 & 取消 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['校1', '校2', '校3']);
  await makeGroup(winId, [ids['校1'], ids['校2'], ids['校3']], '校验组', 'yellow');
  const page = await openPopup(winId);
  const s0 = await snap();
  const fp0 = fingerprint(s0, winId);
  const row = ids['校2'];

  await rightClickRow(page, row);
  await clickMenuItem(page, '新建分组');
  await page.click('.ge-ok'); // 空名提交
  await sleep(300);
  const cErr = await cardInfo(page);
  chk('3.5 空名提交报「分组名不能为空」且卡片不关',
    cErr.error === '分组名不能为空' && (await cardOpen(page)), JSON.stringify(cErr.error));

  await page.fill('.ge-input', '输入校验组');
  await sleep(250);
  const cClear = await cardInfo(page);
  chk('3.5 继续打字后报错立刻清空', cClear.error === '', `.ge-error=${JSON.stringify(cClear.error)}`);

  // IME: isComposing=true 的 Enter 必须被放行(不提交、不报错)
  const imeRes = await page.evaluate(() => {
    const el = document.querySelector('.ge-input');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true, bubbles: true, cancelable: true,
    }));
    return { open: !!document.querySelector('.ge-card'), err: document.querySelector('.ge-error')?.textContent || '' };
  });
  await sleep(600);
  const sIme = await snap();
  chk('3.5 IME 组合中的 Enter(isComposing=true) 不提交卡片', imeRes.open === true,
    `卡片仍开=${imeRes.open}`);
  chk('3.5 IME 的 Enter 不误报错', imeRes.err === '', `.ge-error=${JSON.stringify(imeRes.err)}`);
  chk('3.5 IME 的 Enter 没有偷偷建组', membersOf(sIme, '输入校验组', winId).length === 0,
    JSON.stringify(membersOf(sIme, '输入校验组', winId).map((x) => x.group.id)));

  // 取消
  await page.click('.ge-cancel');
  await sleep(300);
  const afterCancel = await snap();
  chk('3.5 点取消: 卡片关闭', (await cardOpen(page)) === false);
  chk('3.5 点取消: 一个标签都没动',
    diffFingerprint(fp0, fingerprint(afterCancel, winId)).length === 0,
    JSON.stringify(diffFingerprint(fp0, fingerprint(afterCancel, winId))));

  // 遮罩点击
  await rightClickRow(page, row);
  await clickMenuItem(page, '新建分组');
  await page.fill('.ge-input', '遮罩测试组');
  await page.click('.ge-layer', { position: { x: 5, y: 5 } });
  await sleep(300);
  const afterOverlay = await snap();
  chk('3.5 点遮罩: 卡片关闭', (await cardOpen(page)) === false);
  chk('3.5 点遮罩: 一个标签都没动',
    diffFingerprint(fp0, fingerprint(afterOverlay, winId)).length === 0,
    JSON.stringify(diffFingerprint(fp0, fingerprint(afterOverlay, winId))));

  // Esc
  await rightClickRow(page, row);
  await clickMenuItem(page, '新建分组');
  await page.fill('.ge-input', 'Esc测试组');
  await page.keyboard.press('Escape');
  await sleep(300);
  const afterEs = await snap();
  chk('3.5 按 Esc: 卡片关闭', (await cardOpen(page)) === false);
  chk('3.5 按 Esc: 一个标签都没动',
    diffFingerprint(fp0, fingerprint(afterEs, winId)).length === 0,
    JSON.stringify(diffFingerprint(fp0, fingerprint(afterEs, winId))));
  chk('3.5 三次取消都没有产生新分组',
    ['输入校验组', '遮罩测试组', 'Esc测试组'].every((t) => membersOf(afterEs, t, winId).length === 0),
    JSON.stringify(afterEs.groups.filter((g) => g.windowId === winId).map((g) => g.title)));
  await closeCase(page, winId);
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 4 「移出分组」
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[Case 4] 「移出分组」');
await guard('4.1 移出分组', async () => {
  // —— 4.1 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['移1', '移2', '移3', '别1']);
  const gid = await makeGroup(winId, [ids['移1'], ids['移2'], ids['移3']], '移出组', 'blue');
  await makeGroup(winId, [ids['别1']], '别处组', 'grey');
  const page = await openPopup(winId);
  await rightClickRow(page, ids['移2']);
  const m = await readMenu(page);
  chk('4.1 组内行菜单有「移出分组」', itemTexts(m).includes('移出分组'));
  await clickMenuItem(page, '移出分组');
  await sleep(900);
  const s1 = await snap();
  const t2 = s1.tabs.find((t) => t.id === ids['移2']);
  chk('4.1 被移出的标签真实 groupId === -1', t2.groupId === -1, `groupId=${t2.groupId}`);
  const left = s1.tabs.filter((t) => t.groupId === gid).map((t) => t.id).sort((a, b) => a - b);
  chk('4.1 同组其余标签仍留在原组',
    JSON.stringify(left) === JSON.stringify([ids['移1'], ids['移3']].sort((a, b) => a - b)),
    JSON.stringify(left));
  chk('4.1 别的组不受影响', s1.tabs.find((t) => t.id === ids['别1']).groupId !== -1);
  await closeCase(page, winId);
});

await guard('4.2 manualTabIds 保护', async () => {
  // —— 4.2 自动分组开启时, 被移出的标签受 manualTabIds 保护 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['保1', '保2', '保3', '对照散'], {
    保1: `${H}/keep1`, 保2: `${H}/keep2`, 保3: `${H}/keep3`, 对照散: `${H}/control`,
  });
  const gid = await makeGroup(winId, [ids['保1'], ids['保2'], ids['保3']], '移出组2', 'red');
  // 打开引擎 + 规则(127.0.0.1 → 自动规则组): 移出后的标签如果不被保护, 会被拉进规则组
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      groupRules: { 自动规则组: ['127.0.0.1'] }, autoGroupEnabled: true, othersGroupEnabled: true,
    });
  });
  await sleep(1200);
  // 清空白名单: 建组动作本身也会落进 manualTabIds(建组 = 手动干预), 不清就测不出"移出"的功劳
  await sw.evaluate(async () => { await chrome.storage.local.set({ manualTabIds: [] }); });
  await sleep(400);
  const preManual = await sw.evaluate(async () => (await chrome.storage.local.get('manualTabIds')).manualTabIds || []);
  chk('4.2 前置: 白名单已清空(否则测不出移出动作的保护)', !preManual.includes(ids['保2']),
    `manualTabIds=${JSON.stringify(preManual)}`);

  const page = await openPopup(winId);
  await rightClickRow(page, ids['保2']);
  await clickMenuItem(page, '移出分组');
  await sleep(800);
  const sMid = await snap();
  chk('4.2 移出后 groupId === -1', sMid.tabs.find((t) => t.id === ids['保2']).groupId === -1);
  const manualAfter = await sw.evaluate(async () => (await chrome.storage.local.get('manualTabIds')).manualTabIds || []);
  chk('4.2 移出动作把该标签写进了 manualTabIds(白名单)',
    manualAfter.includes(ids['保2']), `manualTabIds=${JSON.stringify(manualAfter)}`);

  // 让引擎再跑一轮; 未被保护的对照散标签应该被拉进规则组(证明引擎真的在动)
  await sw.evaluate(async () => { await chrome.runtime.sendMessage({ type: 'group-existing' }).catch(() => {}); });
  await sleep(1600);
  const sAfter = await snap();
  const kept = sAfter.tabs.find((t) => t.id === ids['保2']);
  const ctrl = sAfter.tabs.find((t) => t.id === ids['对照散']);
  chk('4.2 对照: 未被保护的散标签被引擎拉进了「自动规则组」(引擎确实在跑)',
    groupTitleOf(sAfter, ctrl.groupId) === '自动规则组', `对照散 在「${groupTitleOf(sAfter, ctrl.groupId)}」`);
  chk('4.2 1500ms 后, 被移出的标签没有被拉回任何组', kept.groupId === -1,
    `实际所在组=「${groupTitleOf(sAfter, kept.groupId)}」`);
  chk('4.2 原组其余标签仍在原组',
    sAfter.tabs.filter((t) => t.groupId === gid).length === 2,
    sAfter.tabs.filter((t) => t.groupId === gid).map(tagOf).join(', '));
  console.log('    ' + dumpState(sAfter, '  实测状态:').replace(/\n/g, '\n    '));
  await closeCase(page, winId);
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 5 行菜单批量关闭与撤销
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[Case 5] 行菜单批量关闭与撤销(其余 / 下方 / 全部 / 归档)');
await guard('5.1 其余+撤销', async () => {
  // —— 5.1 「关闭本组其余标签」+ ⌘Z 撤销 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['关1', '关2', '关3', '留1', '散D']);
  const gClose = await makeGroup(winId, [ids['关1'], ids['关2'], ids['关3']], '关闭组', 'blue');
  const gKeep = await makeGroup(winId, [ids['留1']], '别动组', 'green');
  const page = await openPopup(winId);
  const s0 = await snap();
  const ordered = orderedMembers(s0, gClose);
  const anchor = ordered[1].id;
  const expectClosed = ordered.filter((t) => t.id !== anchor).map((t) => t.id).sort((a, b) => a - b);

  await rightClickRow(page, anchor);
  const m = await readMenu(page);
  chk('5.1 菜单计数 (n) 与数据源一致(其余 = 2)',
    itemTexts(m).includes('关闭本组其余标签 (2)'), JSON.stringify(itemTexts(m)));
  await clickMenuItem(page, '关闭本组其余标签');
  await sleep(900);
  const s1 = await snap();
  const closedNow = expectClosed.filter((id) => !s1.tabs.some((t) => t.id === id)).sort((a, b) => a - b);
  chk('5.1 只关掉本组除本行外的 2 个标签', JSON.stringify(closedNow) === JSON.stringify(expectClosed),
    `关掉=${JSON.stringify(closedNow)} 期望=${JSON.stringify(expectClosed)}`);
  chk('5.1 本行标签仍然活着', s1.tabs.some((t) => t.id === anchor));
  chk('5.1 别组标签完好', s1.tabs.some((t) => t.id === ids['留1']) && s1.tabs.find((t) => t.id === ids['留1']).groupId === gKeep);
  chk('5.1 别组的行数没变', s1.tabs.filter((t) => t.groupId === gKeep).length === 1);
  const banner = await page.evaluate(() => {
    const b = document.querySelector('.undo-banner');
    return b ? { text: b.textContent.replace(/\s+/g, ' ').trim().slice(0, 40), action: b.querySelector('.push-action')?.textContent } : null;
  });
  chk('5.1 底部弹出撤销条', !!banner && /已关闭/.test(banner.text), JSON.stringify(banner));

  // ⌘Z 撤销
  await page.keyboard.press('Meta+z');
  await sleep(1800);
  const s2 = await snap();
  const restored = s2.tabs.filter((t) => t.url.includes(encodeURIComponent('关'))
    || /关\d/.test(t.title));
  chk('5.1 ⌘Z 恢复被关掉的 2 个标签',
    expectClosed.every((id) => s2.tabs.some((t) => t.id === id || t.url === s1.tabs.find(() => true)?.url)),
    `恢复后本组成员=${s2.tabs.filter((t) => t.groupId === gClose).map(tagOf).join(', ')}`);
  const byTitle = (title) => s2.tabs.filter((t) => t.title === title);
  chk('5.1 恢复后「关1」「关3」都回来了', byTitle('关1').length === 1 && byTitle('关3').length === 1,
    JSON.stringify({ 关1: byTitle('关1').length, 关2: byTitle('关2').length, 关3: byTitle('关3').length }));
  chk('5.1 恢复的标签回到原分组「关闭组」',
    byTitle('关1')[0] && groupTitleOf(s2, byTitle('关1')[0].groupId) === '关闭组'
    && byTitle('关3')[0] && groupTitleOf(s2, byTitle('关3')[0].groupId) === '关闭组',
    `关1 在「${byTitle('关1')[0] ? groupTitleOf(s2, byTitle('关1')[0].groupId) : '?'}」, `
    + `关3 在「${byTitle('关3')[0] ? groupTitleOf(s2, byTitle('关3')[0].groupId) : '?'}」`);
  console.log('    ' + dumpState(s2, '  撤销后实测状态:').replace(/\n/g, '\n    '));
  await closeCase(page, winId);
});

await guard('5.2 下方', async () => {
  // —— 5.2 「关闭本组此标签下方标签」: 组内时间序 + 搜索态下仍按数据源 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['bw1', 'bw2', 'bw3', 'bw4', '别的行']);
  const gid = await makeGroup(winId, [ids['bw1'], ids['bw2'], ids['bw3'], ids['bw4']], '下方组', 'cyan');
  await makeGroup(winId, [ids['别的行']], '无关组', 'grey');
  const page = await openPopup(winId);
  const s0 = await snap();
  const ordered = orderedMembers(s0, gid); // 数据源组内时间序(倒序)
  const anchor = ordered[1].id;
  const expectedBelow = ordered.slice(2).map((t) => t.id).sort((a, b) => a - b);
  const domRows = await sectionRows(page, '下方组');
  chk('5.2 前置: 面板组内行序与数据源时间序一致', JSON.stringify(domRows) === JSON.stringify(ordered.map((t) => t.id)),
    `DOM=${JSON.stringify(domRows)} 数据源=${JSON.stringify(ordered.map((t) => t.id))}`);

  // 先进搜索态(搜索排序与时间序不同), 再右键
  await page.fill('#search', 'bw');
  await page.waitForSelector('.tab-item');
  await sleep(600);
  const searchRows = await page.evaluate(() => [...document.querySelectorAll('.tab-item')].map((r) => Number(r.dataset.tabId)));
  chk('5.2 前置: 搜索态只显示命中行', searchRows.length >= 4 && !searchRows.includes(ids['别的行']),
    JSON.stringify(searchRows));
  await rightClickRow(page, anchor);
  const m = await readMenu(page);
  const belowItem = m.items.find((i) => !i.sep && i.text.startsWith('关闭本组此标签下方标签'));
  chk('5.2 搜索态下 (n) 仍按数据源组内时间序计算', belowItem && belowItem.text === `关闭本组此标签下方标签 (${expectedBelow.length})`,
    `实际=${JSON.stringify(belowItem?.text)} 期望 (${expectedBelow.length})`);
  await clickMenuItem(page, '关闭本组此标签下方标签');
  await sleep(1000);
  const s1 = await snap();
  const gone = expectedBelow.filter((id) => !s1.tabs.some((t) => t.id === id)).sort((a, b) => a - b);
  chk('5.2 只关掉数据源里"本行之后"的标签', JSON.stringify(gone) === JSON.stringify(expectedBelow),
    `关掉=${JSON.stringify(gone)} 期望=${JSON.stringify(expectedBelow)}`);
  chk('5.2 本行与它上面的标签都还在',
    s1.tabs.some((t) => t.id === anchor) && s1.tabs.some((t) => t.id === ordered[0].id),
    `存活组内=${s1.tabs.filter((t) => t.groupId === gid).map(tagOf).join(', ')}`);
  chk('5.2 不误关别组的标签(搜索态下尤其)', s1.tabs.some((t) => t.id === ids['别的行']),
    s1.tabs.find((t) => t.id === ids['别的行']) ? '还在' : '被误关了');
  await page.fill('#search', '');
  await closeCase(page, winId);
});

await guard('5.3 全部关闭(双窗口)', async () => {
  // —— 5.3 「关闭「组名」全部标签」: 双窗口同名组只关本窗口那个 ——
  await resetEnv();
  const w1 = await newWindow(['同1a', '同1b', '窗1散']);
  const g1 = await makeGroup(w1.winId, [w1.ids['同1a'], w1.ids['同1b']], '同名组', 'blue');
  const w2 = await newWindow(['同2a', '同2b', '窗2散']);
  const g2 = await makeGroup(w2.winId, [w2.ids['同2a'], w2.ids['同2b']], '同名组', 'blue');
  const page = await openPopup(w1.winId);
  const s0 = await snap();
  chk('5.3 前置: 两个窗口各有一个「同名组」', membersOf(s0, '同名组').length === 2,
    JSON.stringify(membersOf(s0, '同名组').map((x) => ({ gid: x.group.id, win: x.group.windowId, n: x.tabs.length }))));

  await rightClickRow(page, w1.ids['同1a']);
  const m = await readMenu(page);
  chk('5.3 行菜单文案带组名与全组计数', itemTexts(m).includes('关闭「同名组」全部标签 (2)'),
    JSON.stringify(itemTexts(m)));
  await clickMenuItem(page, '关闭「同名组」全部标签');
  await sleep(1100);
  const s1 = await snap();
  const w1Left = s1.tabs.filter((t) => t.groupId === g1);
  const w2Left = s1.tabs.filter((t) => t.groupId === g2);
  chk('5.3 目标窗口这一组被全部关闭', w1Left.length === 0, w1Left.map(tagOf).join(', '));
  chk('5.3 另一窗口的同名组一根都没动', w2Left.length === 2, w2Left.map(tagOf).join(', '));
  chk('5.3 两窗口的散标签不受影响',
    s1.tabs.some((t) => t.id === w1.ids['窗1散']) && s1.tabs.some((t) => t.id === w2.ids['窗2散']));
  console.log('    ' + dumpState(s1, '  实测状态:').replace(/\n/g, '\n    '));
  await closeCase(page, w1.winId);
  await resetEnv();
});

await guard('5.4 行菜单归档', async () => {
  // —— 5.4 行菜单「归档「组名」分组」 ——
  await resetEnv();
  const { winId, ids } = await newWindow(['归1', '归2', '留A']);
  const gArc = await makeGroup(winId, [ids['归1'], ids['归2']], '归档组', 'orange');
  const gStay = await makeGroup(winId, [ids['留A']], '留着组', 'green');
  const page = await openPopup(winId);
  await rightClickRow(page, ids['归1']);
  const m = await readMenu(page);
  chk('5.4 行菜单最下方是「归档「归档组」分组」(danger 之外的独立分组)',
    itemTexts(m).includes('归档「归档组」分组'), JSON.stringify(itemTexts(m)));
  await clickMenuItem(page, '归档「归档组」分组');
  await sleep(1300);
  const s1 = await snap();
  const store = await sw.evaluate(async () => (await chrome.storage.local.get('archivedGroups')).archivedGroups || []);
  chk('5.4 写入 storage.local.archivedGroups', store.length === 1 && store[0].title === '归档组',
    JSON.stringify(store.map((x) => ({ title: x.title, n: x.tabs.length }))));
  chk('5.4 归档卡记录了该组全部 2 个标签', store[0]?.tabs.length === 2,
    JSON.stringify(store[0]?.tabs.map((t) => t.title)));
  chk('5.4 该组所有标签被关闭',
    !s1.tabs.some((t) => t.id === ids['归1']) && !s1.tabs.some((t) => t.id === ids['归2']),
    s1.tabs.filter((t) => t.groupId === gArc).map(tagOf).join(', ') || '(组内已空)');
  chk('5.4 其他组不受影响(留着组完好)',
    s1.tabs.filter((t) => t.groupId === gStay).length === 1,
    s1.tabs.filter((t) => t.groupId === gStay).map(tagOf).join(', '));
  console.log('    ' + dumpState(s1, '  实测状态:').replace(/\n/g, '\n    '));
  await closeCase(page, winId);
});

// ═══════════════════════════════════════════════════════════════════════════
// 收尾
// ═══════════════════════════════════════════════════════════════════════════
server.close();
await ctx.close().catch(() => {});
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

console.log('\n════════════════ 汇总 ════════════════');
console.log(`总通过: ${pass}   总失败: ${fail}`);
if (failures.length) {
  console.log('失败项:');
  for (const f of failures) console.log(`  ✗ ${f}`);
}
if (bugs.length) {
  console.log('\n在真实 Headless Chrome 中实锤复现的 Bug:');
  bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b.tag}`));
} else {
  console.log('\n未复现出 Bug。');
}
process.exit(fail ? 1 : 0);
