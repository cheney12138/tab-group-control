// tgs-backup-manual.mjs — 配置备份 = 一键 Blob 导出 + 面板内拖放/粘贴恢复 + 未导出变更提醒
// 守:
//   ① manifest 不再有 downloads 权限, background.js 不再引用 chrome.downloads,
//     也不再有任何 pane/backup 一次性参数转交; backup.js 不碰 showSaveFilePicker / open-standalone
//   ② 旧版遗留键(autoBackupEnabled / backupFolder / backupStrategy)与旧 schema 的 backupState
//     (7 周前、无 schema 版本号)一律清掉; 从未导出过 ⇒ 圆点不亮、文案「尚未导出」
//   ③ 一键导出(贴图标弹窗模式): 直接点出 <a download="tab_group_rule_bak.json">, blob 内容是
//     合法 tgs-backup JSON, 含全部 LOCAL_KEYS / PREF_KEYS 且不含 tgs-collapsed / tgs-view;
//     **不发 open-standalone、不关窗**; backupState 带 schema:2 落盘; 黄点当场熄灭; toast 正确
//   ④ 改 tgs-collapsed / tgs-view 不算配置变更(不亮); 改主题 / 存储侧开关才亮两处圆点,
//     且四套主题下圆点与文字垂直居中; 再次导出立即熄灭
//   ⑤ 面板内恢复弹层: 贴图标弹窗里点「恢复…」就地弹 .backup-restore-layer(不发 open-standalone、
//     不关窗), 且「选择文件…」被隐藏; 非法 JSON / 错误 format 在弹层内红字报错、不关弹层、不破坏数据;
//     Esc 只关弹层、设置面板仍开着; 粘贴合法 JSON(带恶意键)点「恢复」⇒ 白名单生效、schema:2、
//     重载后不亮黄点
//   ⑥ 非贴图标弹窗(独立窗口/普通标签页)里「选择文件…」可见, 走 #backupFileInput 同样能恢复
//   ⑦ 全流程无 JS 报错
Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
const { chromium } = await import('/Users/qianyuchen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs');
const fs = await import('node:fs');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const REPO = '/Users/qianyuchen/tab-group-search';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

const LOCAL_KEYS = ['groupRules', 'autoGroupEnabled', 'othersGroupEnabled', 'forceMotionEnabled', 'openAsWindowEnabled'];
const PREF_KEYS = ['tgs-theme', 'tgs-accent', 'tgs-accent-linear', 'tgs-deletekey', 'tgs-showurl', 'tgs-force-motion'];

// ── 0. 静态: 权限与源码里不许再有 downloads / 系统文件框 / 独立窗口转交 ──
console.log('\n[0] 静态检查: downloads 权限 / chrome.downloads / 转交残留');
{
  const manifest = JSON.parse(fs.readFileSync(`${REPO}/manifest.json`, 'utf8'));
  chk('manifest.permissions 不含 downloads', !(manifest.permissions || []).includes('downloads'),
    JSON.stringify(manifest.permissions));
  const bg = fs.readFileSync(`${REPO}/background.js`, 'utf8');
  chk('background.js 不含 chrome.downloads', !bg.includes('chrome.downloads'));
  // open-standalone 消息还在(⌘E 唤起独立窗口), 但不该再携带 pane / backup 一次性参数
  chk('background.js 无 pane / backup 转交残留',
    !/\bbackup\b/.test(bg) && !bg.includes('msg.pane') && !/openStandalone\(\{/.test(bg),
    `backup=${/\bbackup\b/.test(bg)} pane=${bg.includes('msg.pane')}`);
  const backupSrc = fs.readFileSync(`${REPO}/src/features/backup.js`, 'utf8');
  chk('backup.js 无 chrome.downloads 调用', !backupSrc.includes('chrome.downloads.'));
  chk('backup.js 无 showSaveFilePicker', !backupSrc.includes('showSaveFilePicker'));
  chk('backup.js 无 open-standalone 转交', !backupSrc.includes('open-standalone'));
  chk('backup.js 不再自动写盘(pagehide 监听 / maybeAutoBackup 已消失)',
    !backupSrc.includes("addEventListener('pagehide'") && !backupSrc.includes('maybeAutoBackup('));
  chk('backup.js 导出走 Blob + <a download>',
    backupSrc.includes('new Blob(') && backupSrc.includes('a.download = BACKUP_FILE'));
}

const ctx = await chromium.launchPersistentContext(`/tmp/tgs-bk-${Date.now()}`, {
  executablePath: EXE, viewport: null,
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`, '--no-first-run'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;

// 页面内假标签数据(与 tgs-verify 同款), chrome.storage 保持真扩展的
const INIT = () => {
  const now = 1730000000000;
  const mk = (tid, url, title, gid, la, active) => ({
    id: tid, url, title, groupId: gid, windowId: 1, active: !!active,
    lastAccessed: la, status: 'complete', audible: false, discarded: false, index: 0 });
  const tabs = [
    mk(101, 'https://a.example/1', '素材页一', 11, now - 60000),
    mk(102, 'https://a.example/2', '素材页二', 11, now - 30000, true),
    mk(201, 'https://b.example/1', '其他页一', 22, now - 3600000)];
  const groups = [
    { id: 11, title: '素材', color: 'blue', windowId: 1 },
    { id: 22, title: '其他', color: 'green', windowId: 1 }];
  chrome.tabs.query = async () => tabs;
  chrome.tabGroups.query = async () => groups;
  chrome.windows.getCurrent = async () => ({ id: 1 });
  chrome.runtime.sendMessage = async () => null;

  // 只在没有时填默认偏好 —— 恢复后 reload 不能把刚写回的 tgs-theme 又冲掉
  const seed = (k, v) => { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); };
  seed('tgs-theme', 'linear');
  seed('tgs-accent', 'blue');
  seed('tgs-accent-linear', 'blue');
  seed('tgs-deletekey', 'cmd-bs');
  seed('tgs-showurl', '1');
  seed('tgs-force-motion', '0');
};

// ── 1. 预置旧版遗留键, 打开弹窗后应被清掉 ──
console.log('\n[1] 遗留键清理 + 新 DOM');
const seedRes = await sw.evaluate(async () => {
  const seed = {
    autoBackupEnabled: true,
    backupFolder: 'TGS',
    backupStrategy: 'downloads',
    // 旧版 downloads 自动备份留下的快照: 带 at/sig(7 周前的旧指纹)与废弃字段,
    // 但**没有 schema 版本号** ⇒ 与新口径不可比, 必须整体丢掉
    backupState: {
      at: Date.now() - 49 * 24 * 3600 * 1000,
      sig: 'deadbeef:4096',
      bytes: 2048,
      groups: 3,
      hosts: 9,
      name: 'tab_group_rule_bak.json',
      id: 7, folder: 'TGS', needAuth: true, hint: '旧提示', mode: 'downloads',
    },
    groupRules: { 'a.example': ['www'], 'b.example': ['x', 'y'] },
    autoGroupEnabled: true,
    othersGroupEnabled: false,
    forceMotionEnabled: true,
    openAsWindowEnabled: false,
  };
  // 全新 profile 本是空的; background 启动时的 loadRules() 会在 groupRules 键不存在时
  // 回填 DEFAULT_RULES({}), 而且顶部那次与 onInstalled 那次可能并发读空、各写一次 {}
  // ⇒ 直接把"等它写完 + 写完再核对"做进播种里, 否则我们刚写的规则会被盖回 {}
  // (真实竞态: 曾让探针的 counts 偶发变成 0)。
  for (let i = 0; i < 50; i++) {
    const s = await chrome.storage.local.get('groupRules');
    if ('groupRules' in s) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));
  for (let i = 0; i < 5; i++) {
    await chrome.storage.local.set(seed);
    await new Promise((r) => setTimeout(r, 300));
    const s = await chrome.storage.local.get('groupRules');
    if (JSON.stringify(s.groupRules) === JSON.stringify(seed.groupRules)) return 'ok';
  }
  return 'unstable';
});
chk('初始种子锁定(2 组规则未被 background 回填冲掉)', seedRes === 'ok', seedRes);
await sleep(400);

const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
await p.addInitScript(INIT);
await p.goto(`chrome-extension://${id}/popup.html`);
await p.waitForSelector('#backupStateLabel', { state: 'attached', timeout: 10000 });
await p.waitForTimeout(900);

const stored = await p.evaluate(() => chrome.storage.local.get(null));
chk('autoBackupEnabled 已清除', !('autoBackupEnabled' in stored));
chk('backupFolder 已清除', !('backupFolder' in stored));
chk('backupStrategy 已清除', !('backupStrategy' in stored));
chk('旧版 backupState(无 schema 版本号的 7 周前快照)被整体清除', !('backupState' in stored),
  JSON.stringify(stored.backupState || null));

const dom = await p.evaluate(() => {
  const has = (x) => !!document.getElementById(x);
  const shown = (x) => {
    const el = document.getElementById(x);
    return !!el && (el.classList.contains('show') || getComputedStyle(el).display !== 'none');
  };
  return {
    exportBtn: has('backupExportBtn'),
    restoreBtn: has('backupRestoreBtn'),
    stateLabel: has('backupStateLabel'),
    fileInput: has('backupFileInput'),
    dirtyDot: has('backupDirtyDot'),
    funcDot: has('funcBackupDot'),
    dirtyShown: shown('backupDirtyDot'),
    funcShown: shown('funcBackupDot'),
    legacy: ['optAutoBackup', 'backupFolderInput', 'backupRevealBtn', 'backupNowBtn',
      'backupOpenFolderBtn', 'backupHintBtn', 'backupHintLine'].filter(has),
    label: document.getElementById('backupStateLabel')?.textContent || '',
    exportText: document.getElementById('backupExportBtn')?.textContent.trim() || '',
    exportTitle: document.getElementById('backupExportBtn')?.title || '',
    restoreTitle: document.getElementById('backupRestoreBtn')?.title || '',
  };
});
chk('backupExportBtn / backupRestoreBtn / backupFileInput 存在',
  dom.exportBtn && dom.restoreBtn && dom.fileInput);
chk('backupStateLabel / backupDirtyDot / funcBackupDot 存在',
  dom.stateLabel && dom.dirtyDot && dom.funcDot);
chk('旧自动备份 DOM 已全部移除', dom.legacy.length === 0, dom.legacy.join(','));
chk(`导出按钮文案是一键直出「导出备份」(${dom.exportText})`, dom.exportText === '导出备份');
chk(`导出按钮 title 不再提"自选保存目录"(${dom.exportTitle})`,
  dom.exportTitle.includes('JSON 文件') && !dom.exportTitle.includes('目录'));
chk(`恢复按钮 title 提示拖入/粘贴(${dom.restoreTitle})`,
  dom.restoreTitle.includes('拖入') && dom.restoreTitle.includes('粘贴'));
chk('首次未导出: 两个圆点都不亮', !dom.dirtyShown && !dom.funcShown);
chk(`首次未导出文案含「尚未导出」(${dom.label})`, dom.label.includes('尚未导出'));
chk('文案带当前规模(2 组 / 3 域名)', dom.label.includes('2 组 / 3 域名'));
chk('开弹窗不产生任何写盘(backupState 仍不存在)', !('backupState' in stored));
chk('弹窗加载无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

// 贴图标弹窗模式 + 捕获 <a download>: 后续 [2]~[5] 都在这个形态下跑
// (真实病例: 贴图标弹窗里弹系统文件框会让 Chrome 立刻销毁文档 —— 所以这里必须零弹窗)
await p.evaluate(() => {
  chrome.tabs.getCurrent = async () => undefined;   // 伪装成贴图标弹出面板
  window.__sent = [];
  chrome.runtime.sendMessage = async (msg) => { window.__sent.push(msg); return { ok: true }; };
  window.__closed = 0;
  Object.defineProperty(window, 'close', { configurable: true, value: () => { window.__closed++; } });
  window.__dl = [];
  window.__dlText = '';
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      // 记下点击并读出 blob 内容, 但不真的落盘(无头环境不必产生下载文件)
      window.__dl.push({ name: this.download, href: String(this.href),
        inBody: document.body.contains(this), type: this.type || '' });
      fetch(this.href).then((r) => r.text()).then((t) => { window.__dlText = t; }).catch(() => {});
      return;
    }
    return orig.call(this);
  };
  // 系统文件框一律拦住(真弹出来会把弹窗文档带走, 探针也就没得测了)
  window.__fileInputClick = 0;
  document.getElementById('backupFileInput').click = () => { window.__fileInputClick++; };
});

// ── 2. 一键导出(贴图标弹窗模式, 零弹窗) ──
console.log('\n[2] 一键导出(贴图标弹窗: <a download>, 不发消息不关窗)');
const toasts = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.push-msg')].map((e) => e.textContent));
await p.evaluate(() => document.getElementById('backupExportBtn').click());
await p.waitForTimeout(700);
{
  const r = await p.evaluate(() => ({
    dl: window.__dl, text: window.__dlText, sent: window.__sent, closed: window.__closed,
    disabled: document.getElementById('backupExportBtn').disabled,
  }));
  const parsed = r.text ? JSON.parse(r.text) : null;
  const after = await p.evaluate(() => chrome.storage.local.get(null));
  const st = after.backupState || {};
  const toastTexts = await toasts(p);
  const ui = await p.evaluate(() => ({
    dirty: document.getElementById('backupDirtyDot').classList.contains('show'),
    func: document.getElementById('funcBackupDot').classList.contains('show'),
    label: document.getElementById('backupStateLabel').textContent,
  }));

  chk('点导出恰好点了一次 <a download>', r.dl.length === 1, JSON.stringify(r.dl));
  chk('下载名是 tab_group_rule_bak.json', r.dl[0]?.name === 'tab_group_rule_bak.json', String(r.dl[0]?.name));
  chk('下载链接是 blob: URL', String(r.dl[0]?.href || '').startsWith('blob:'), String(r.dl[0]?.href));
  chk('锚点点击时已挂进文档(标准 DOM 行为)', r.dl[0]?.inBody === true);
  chk('贴图标弹窗里导出不发 open-standalone',
    r.sent.filter((m) => m?.type === 'open-standalone').length === 0, JSON.stringify(r.sent));
  chk('贴图标弹窗里导出不关窗', r.closed === 0, String(r.closed));
  chk('导出后按钮恢复可用', r.disabled === false);
  chk('blob 内容是合法 tgs-backup JSON',
    parsed?.format === 'tgs-backup' && parsed?.version === 1,
    `format=${parsed?.format} version=${parsed?.version}`);
  chk('JSON 含全部 LOCAL_KEYS',
    LOCAL_KEYS.every((k) => k in (parsed?.data?.local || {})),
    LOCAL_KEYS.filter((k) => !(k in (parsed?.data?.local || {}))).join(','));
  chk('JSON 含全部 PREF_KEYS',
    PREF_KEYS.every((k) => k in (parsed?.data?.prefs || {})),
    PREF_KEYS.filter((k) => !(k in (parsed?.data?.prefs || {}))).join(','));
  chk('JSON 不含 tgs-collapsed / tgs-view',
    !('tgs-collapsed' in (parsed?.data?.prefs || {})) && !('tgs-view' in (parsed?.data?.prefs || {})));
  chk('counts 正确(2 组 / 3 域名)',
    parsed?.counts?.groups === 2 && parsed?.counts?.hosts === 3, JSON.stringify(parsed?.counts));
  chk('backupState 落盘(at/sig/bytes/规模/文件名)',
    st.at > 0 && !!st.sig && st.bytes > 0 && st.groups === 2 && st.hosts === 3
      && st.name === 'tab_group_rule_bak.json', JSON.stringify(st));
  chk('backupState 带 schema: 2(升级后不再把旧指纹当自己人)', st.schema === 2, String(st.schema));
  chk('backupState 不再有旧字段', !('id' in st) && !('folder' in st) && !('needAuth' in st));
  chk('导出后两个圆点熄灭', !ui.dirty && !ui.func);
  chk(`导出后文案含「上次导出」(${ui.label})`, ui.label.includes('上次导出'));
  chk('导出成功 toast 带文件名', toastTexts.some((x) => x.includes('已导出') && x.includes('tab_group_rule_bak.json')),
    toastTexts.join(' | '));
}

// ── 3. 变更检测: 临时 UI 态不算, 真配置才算 ──
console.log('\n[3] 变更检测');
await p.evaluate(() => {
  localStorage.setItem('tgs-collapsed', '["a.example"]');
  localStorage.setItem('tgs-view', 'flat');
  document.getElementById('pane-func').dispatchEvent(new Event('click', { bubbles: true }));
});
await p.waitForTimeout(450);
{
  const ui = await p.evaluate(() => ({
    dirty: document.getElementById('backupDirtyDot').classList.contains('show'),
    func: document.getElementById('funcBackupDot').classList.contains('show'),
    label: document.getElementById('backupStateLabel').textContent,
  }));
  chk('改 tgs-collapsed / tgs-view 不亮圆点', !ui.dirty && !ui.func);
  chk(`改折叠/视图后文案仍是「上次导出」(${ui.label})`, ui.label.includes('上次导出'));
}

await p.evaluate(() => {
  localStorage.setItem('tgs-theme', 'ink');
  document.getElementById('pane-func').dispatchEvent(new Event('click', { bubbles: true }));
});
await p.waitForTimeout(450);
// 打开设置面板并切到「功能」, 才能量到两个圆点真的可见、且与文字垂直居中
await p.evaluate(() => {
  document.getElementById('settingsBtn').click();
  document.querySelector('.settings-tab[data-pane="func"]').click();
});
await p.waitForTimeout(500);
{
  const m = await p.evaluate(() => {
    const f = document.getElementById('funcBackupDot');
    const d = document.getElementById('backupDirtyDot');
    const centerOfText = (el) => {
      const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
      const r = document.createRange();
      r.selectNodeContents(node);
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2;
    };
    const fc = f.getBoundingClientRect();
    const dc = d.getBoundingClientRect();
    return {
      fShown: f.classList.contains('show'), fw: f.offsetWidth,
      dShown: d.classList.contains('show'), dw: d.offsetWidth,
      fDelta: Math.abs((fc.top + fc.height / 2) - centerOfText(f.closest('.settings-tab'))),
      dDelta: Math.abs((dc.top + dc.height / 2) - centerOfText(d.closest('.slabel'))),
      label: document.getElementById('backupStateLabel').textContent,
    };
  });
  chk('改 tgs-theme 后 backupDirtyDot 亮且可见', m.dShown && m.dw > 0, `w=${m.dw}`);
  chk('改 tgs-theme 后 funcBackupDot 亮且可见', m.fShown && m.fw > 0, `w=${m.fw}`);
  chk(`tab 圆点与「功能」文字垂直居中(偏差 ${m.fDelta.toFixed(1)}px)`, m.fDelta <= 3);
  chk(`行内圆点与「配置备份」文字垂直居中(偏差 ${m.dDelta.toFixed(1)}px)`, m.dDelta <= 3);
  chk(`文案变「有未导出变更」(${m.label})`, m.label.includes('有未导出变更'));
}
// 四套主题下圆点都要自然居中(主题会换字体/字号)
for (const th of ['linear', 'ink', 'sky', 'deepseek']) {
  await p.evaluate((theme) => {
    const sel = document.getElementById('optTheme');
    sel.value = theme;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, th);
  await p.waitForTimeout(220);
  const mt = await p.evaluate(() => {
    const f = document.getElementById('funcBackupDot');
    const d = document.getElementById('backupDirtyDot');
    const centerOfText = (el) => {
      const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
      const r = document.createRange();
      r.selectNodeContents(node);
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2;
    };
    const fc = f.getBoundingClientRect();
    const dc = d.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      fw: f.offsetWidth, dw: d.offsetWidth,
      fDelta: Math.abs((fc.top + fc.height / 2) - centerOfText(f.closest('.settings-tab'))),
      dDelta: Math.abs((dc.top + dc.height / 2) - centerOfText(d.closest('.slabel'))),
    };
  });
  chk(`${th}: 两个圆点可见且垂直居中(tab Δ${mt.fDelta.toFixed(1)}px / 行内 Δ${mt.dDelta.toFixed(1)}px)`,
    mt.theme === th && mt.fw > 0 && mt.dw > 0 && mt.fDelta <= 3 && mt.dDelta <= 3);
}

// 再次导出 → 干净
await p.evaluate(() => document.getElementById('backupExportBtn').click());
await p.waitForTimeout(700);
{
  const ui = await p.evaluate(() => ({
    dirty: document.getElementById('backupDirtyDot').classList.contains('show'),
    func: document.getElementById('funcBackupDot').classList.contains('show'),
    label: document.getElementById('backupStateLabel').textContent,
  }));
  chk('再次导出后圆点消失', !ui.dirty && !ui.func);
  chk(`再次导出后文案恢复「上次导出」(${ui.label})`, ui.label.includes('上次导出'));
}

// 存储侧(storage.onChanged)变更也要亮
await p.evaluate(() => chrome.storage.local.set({ forceMotionEnabled: false }));
await p.waitForTimeout(700);
{
  const shown = await p.evaluate(() =>
    document.getElementById('backupDirtyDot').classList.contains('show'));
  const label = await p.evaluate(() =>
    document.getElementById('backupStateLabel').textContent);
  chk('storage 侧开关变更(防抖后)亮圆点', shown);
  chk(`storage 侧变更文案「有未导出变更」(${label})`, label.includes('有未导出变更'));
}

// ── 4. 面板内恢复弹层(贴图标弹窗: 就地弹, 不发消息不关窗) ──
console.log('\n[4] 恢复弹层(贴图标弹窗模式)');
await p.evaluate(() => {
  window.__sent = [];
  window.__closed = 0;
  document.getElementById('backupRestoreBtn').click();
});
await p.waitForTimeout(400);
{
  const r = await p.evaluate(() => {
    const layer = document.querySelector('.backup-restore-layer');
    const pick = layer?.querySelector('.backup-pick-file');
    return {
      layer: !!layer,
      title: layer?.querySelector('div')?.textContent || '',
      hasArea: !!layer?.querySelector('.backup-restore-area'),
      hasErr: !!layer?.querySelector('.backup-restore-error'),
      confirmText: layer?.querySelector('.backup-confirm')?.textContent.trim() || '',
      cancelText: layer?.querySelector('.backup-cancel')?.textContent.trim() || '',
      pickExists: !!pick,
      pickHidden: !pick ? null : (getComputedStyle(pick).display === 'none' || pick.offsetParent === null),
      focusIsArea: document.activeElement?.classList.contains('backup-restore-area'),
      sent: window.__sent, closed: window.__closed,
    };
  });
  chk('点「恢复…」就地弹出 .backup-restore-layer', r.layer);
  chk('弹层标题是「从备份恢复」', r.title.includes('从备份恢复'), r.title.slice(0, 40));
  chk('弹层含 textarea / 错误行 / 恢复 / 取消', r.hasArea && r.hasErr
    && r.confirmText === '恢复' && r.cancelText === '取消');
  chk('贴图标弹窗里恢复不发 open-standalone',
    r.sent.filter((m) => m?.type === 'open-standalone').length === 0, JSON.stringify(r.sent));
  chk('贴图标弹窗里恢复不关窗', r.closed === 0, String(r.closed));
  chk('「选择文件…」按钮存在但被隐藏(系统文件框会杀掉弹窗)',
    r.pickExists && r.pickHidden === true, `exists=${r.pickExists} hidden=${r.pickHidden}`);
  chk('打开后焦点在 textarea 上', r.focusIsArea === true);
}

// 非法 JSON: 弹层内红字, 不关弹层, 不破坏数据
console.log('\n[4.1] 非法输入');
{
  const before = await p.evaluate(() => chrome.storage.local.get(null));
  await p.fill('.backup-restore-area', '{ not json');
  await p.click('.backup-confirm');
  await p.waitForTimeout(350);
  const r = await p.evaluate(() => ({
    layer: !!document.querySelector('.backup-restore-layer'),
    err: document.querySelector('.backup-restore-error')?.textContent || '',
  }));
  chk('非法 JSON 在弹层内报错', r.err.includes('恢复失败') && r.err.includes('JSON'), r.err);
  chk('非法 JSON 不关弹层', r.layer === true);
  const afterBad = await p.evaluate(() => chrome.storage.local.get(null));
  chk('非法 JSON 不改 groupRules',
    JSON.stringify(afterBad.groupRules) === JSON.stringify(before.groupRules));
  chk('非法 JSON 不改 backupState',
    JSON.stringify(afterBad.backupState) === JSON.stringify(before.backupState));

  // 空文本
  await p.fill('.backup-restore-area', '   ');
  await p.click('.backup-confirm');
  await p.waitForTimeout(250);
  const empty = await p.evaluate(() => ({
    layer: !!document.querySelector('.backup-restore-layer'),
    err: document.querySelector('.backup-restore-error')?.textContent || '',
  }));
  chk('空内容在弹层内提示且不关弹层', empty.layer && empty.err.includes('内容为空'), empty.err);

  // 错误 format
  await p.fill('.backup-restore-area', JSON.stringify({ format: 'not-tgs', data: { local: { groupRules: {} } } }));
  await p.click('.backup-confirm');
  await p.waitForTimeout(350);
  const fmt = await p.evaluate(() => ({
    layer: !!document.querySelector('.backup-restore-layer'),
    err: document.querySelector('.backup-restore-error')?.textContent || '',
  }));
  chk('错误 format 在弹层内报错', fmt.err.includes('不是本插件的备份文件'), fmt.err);
  chk('错误 format 不关弹层', fmt.layer === true);
  const afterFmt = await p.evaluate(() => chrome.storage.local.get(null));
  chk('错误 format 不改 groupRules',
    JSON.stringify(afterFmt.groupRules) === JSON.stringify(before.groupRules));
  chk('错误 format 不改 backupState',
    JSON.stringify(afterFmt.backupState) === JSON.stringify(before.backupState));
}

// ── 5. Esc 只关弹层, 设置面板仍开着 ──
console.log('\n[5] Esc 关闭恢复弹层');
{
  await p.evaluate(() => document.querySelector('.backup-restore-area').focus());
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  const r = await p.evaluate(() => ({
    layer: !!document.querySelector('.backup-restore-layer'),
    panelOpen: document.getElementById('settingsPanel').classList.contains('open'),
    sent: window.__sent, closed: window.__closed,
  }));
  chk('Esc 关掉恢复弹层', r.layer === false);
  chk('Esc 后设置面板仍然打开', r.panelOpen === true);
  chk('Esc 不触发任何 open-standalone / 关窗',
    r.sent.filter((m) => m?.type === 'open-standalone').length === 0 && r.closed === 0);
}

// ── 6. 粘贴合法 JSON 恢复(白名单 + 状态同步 + 重载) ──
console.log('\n[6] 粘贴 JSON 恢复(白名单)');
const goodBackup = {
  format: 'tgs-backup', version: 1, app: 'probe', exportedAt: '2026-11-01T00:00:00.000Z',
  counts: { groups: 1, hosts: 2 },
  data: {
    local: {
      groupRules: { 'r.example': ['a', 'b'] },
      autoGroupEnabled: false,
      wildKey: 'MUST_BE_IGNORED',
    },
    prefs: { 'tgs-theme': 'sky', 'tgs-evil': 'MUST_BE_IGNORED' },
  },
};
await p.evaluate(() => document.getElementById('backupRestoreBtn').click());
await p.waitForTimeout(300);
await p.fill('.backup-restore-area', JSON.stringify(goodBackup, null, 2));
await p.click('.backup-confirm');
// 700ms 后会 reload, 先抓 toast 与弹层状态
let restoreToast = '';
let closedBeforeReload = null;
for (let i = 0; i < 10; i++) {
  await sleep(80);
  const t = await toasts(p).catch(() => []);
  const hit = t.find((x) => x.includes('已恢复'));
  if (hit) { restoreToast = hit; break; }
}
closedBeforeReload = await p.evaluate(() => !document.querySelector('.backup-restore-layer')).catch(() => null);
chk('恢复 toast 报告规模', restoreToast.includes('已恢复') && restoreToast.includes('1 组 / 2 域名'),
  restoreToast);
chk('恢复成功后弹层关闭', closedBeforeReload === true, String(closedBeforeReload));
await p.waitForTimeout(1800);
await p.waitForSelector('#backupStateLabel', { state: 'attached', timeout: 10000 });
await p.waitForTimeout(700);
{
  const after = await p.evaluate(() => chrome.storage.local.get(null));
  const localPrefs = await p.evaluate(() => ({
    theme: localStorage.getItem('tgs-theme'),
    evil: localStorage.getItem('tgs-evil'),
  }));
  const ui = await p.evaluate(() => ({
    dirty: document.getElementById('backupDirtyDot').classList.contains('show'),
    func: document.getElementById('funcBackupDot').classList.contains('show'),
    label: document.getElementById('backupStateLabel').textContent,
  }));
  const st = after.backupState || {};
  chk('白名单键写回(groupRules)',
    JSON.stringify(after.groupRules) === JSON.stringify({ 'r.example': ['a', 'b'] }),
    JSON.stringify(after.groupRules));
  chk('白名单键写回(autoGroupEnabled=false)', after.autoGroupEnabled === false);
  chk('白名单键写回(localStorage tgs-theme=sky)', localPrefs.theme === 'sky', String(localPrefs.theme));
  chk('恶意键 wildKey 被忽略', !('wildKey' in after));
  chk('恶意偏好 tgs-evil 被忽略', localPrefs.evil === null, String(localPrefs.evil));
  chk('恢复后 backupState 同步为最新', st.groups === 1 && st.hosts === 2 && !!st.sig && st.at > 0,
    JSON.stringify(st));
  chk('恢复后 backupState 带 schema: 2', st.schema === 2, String(st.schema));
  chk('恢复后不亮脏圆点(重载后立即干净)', !ui.dirty && !ui.func);
  chk(`恢复后文案「上次导出」(${ui.label})`, ui.label.includes('上次导出'));
}

// ── 7. 非贴图标弹窗(独立窗口/普通标签页): 「选择文件…」可见 + file input 恢复 ──
console.log('\n[7] 非贴图标弹窗: 选择文件恢复');
{
  const p2 = await ctx.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(String(e && e.message ? e.message : e)));
  await p2.addInitScript(INIT);
  // 真标签页形态: chrome.tabs.getCurrent 是 Chrome 原生实现, 返回真实 Tab
  await p2.goto(`chrome-extension://${id}/popup.html?win=1`);
  await p2.waitForSelector('#backupStateLabel', { state: 'attached', timeout: 10000 });
  await p2.waitForTimeout(900);
  await p2.evaluate(() => {
    window.__fileInputClicks = 0;
    document.getElementById('backupFileInput').click = () => { window.__fileInputClicks++; };
    document.getElementById('settingsBtn').click();
    document.querySelector('.settings-tab[data-pane="func"]').click();
    document.getElementById('backupRestoreBtn').click();
  });
  await p2.waitForTimeout(500);
  {
    const r = await p2.evaluate(() => {
      const layer = document.querySelector('.backup-restore-layer');
      const pick = layer?.querySelector('.backup-pick-file');
      return {
        layer: !!layer,
        pickVisible: !!pick && pick.offsetWidth > 0 && getComputedStyle(pick).display !== 'none',
      };
    });
    chk('非贴图标弹窗: 恢复弹层打开', r.layer);
    chk('非贴图标弹窗: 「选择文件…」可见', r.pickVisible === true);
    await p2.click('.backup-pick-file');
    await p2.waitForTimeout(150);
    const clicks = await p2.evaluate(() => window.__fileInputClicks);
    chk('点「选择文件…」触发 #backupFileInput.click()', clicks === 1, String(clicks));
  }

  // 走真实 file input 路径恢复(白名单 + 状态同步)
  const fileBackup = {
    format: 'tgs-backup', version: 1, app: 'probe', exportedAt: '2026-11-02T00:00:00.000Z',
    counts: { groups: 1, hosts: 2 },
    data: {
      local: { groupRules: { 'f.example': ['c'] }, otherGroupEnabled: true },
      prefs: { 'tgs-theme': 'ink', 'tgs-evil': 'MUST_BE_IGNORED' },
    },
  };
  await p2.setInputFiles('#backupFileInput', {
    name: 'file-restore.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fileBackup)),
  });
  let fileToast = '';
  for (let i = 0; i < 10; i++) {
    await sleep(80);
    const t = await toasts(p2).catch(() => []);
    const hit = t.find((x) => x.includes('已恢复'));
    if (hit) { fileToast = hit; break; }
  }
  chk('选文件恢复 toast 报告规模',
    fileToast.includes('已恢复') && fileToast.includes('1 组 / 1 域名'), fileToast);
  await p2.waitForTimeout(1800);
  await p2.waitForSelector('#backupStateLabel', { state: 'attached', timeout: 10000 });
  await p2.waitForTimeout(700);
  {
    const after = await p2.evaluate(() => chrome.storage.local.get(null));
    const prefs = await p2.evaluate(() => localStorage.getItem('tgs-theme'));
    const ui = await p2.evaluate(() => ({
      dirty: document.getElementById('backupDirtyDot').classList.contains('show'),
      func: document.getElementById('funcBackupDot').classList.contains('show'),
      label: document.getElementById('backupStateLabel').textContent,
    }));
    chk('选文件恢复写回 groupRules',
      JSON.stringify(after.groupRules) === JSON.stringify({ 'f.example': ['c'] }),
      JSON.stringify(after.groupRules));
    chk('选文件恢复写回 tgs-theme=ink', prefs === 'ink', String(prefs));
    chk('选文件恢复后 backupState 带 schema: 2', after.backupState?.schema === 2,
      String(after.backupState?.schema));
    chk('选文件恢复后不亮脏圆点', !ui.dirty && !ui.func);
    chk('选文件恢复后无 JS 报错', errs2.length === 0, errs2.join(' | '));
  }

  // 非法文件: 弹层还开着时报错在弹层内 + toast, 数据不变
  await p2.evaluate(() => {
    document.getElementById('settingsBtn').click();
    document.querySelector('.settings-tab[data-pane="func"]').click();
    document.getElementById('backupRestoreBtn').click();
  });
  await p2.waitForTimeout(400);
  const beforeBad = await p2.evaluate(() => chrome.storage.local.get(null));
  await p2.setInputFiles('#backupFileInput', {
    name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{ not json'),
  });
  await p2.waitForTimeout(500);
  {
    const r = await p2.evaluate(() => ({
      err: document.querySelector('.backup-restore-error')?.textContent || '',
      t: [...document.querySelectorAll('.push-msg')].map((e) => e.textContent),
    }));
    chk('非法文件在弹层内红字报错', r.err.includes('恢复失败') && r.err.includes('JSON'), r.err);
    chk('非法文件同时弹 toast', r.t.some((x) => x.includes('恢复失败')), r.t.join(' | '));
    const afterBad = await p2.evaluate(() => chrome.storage.local.get(null));
    chk('非法文件不改 groupRules',
      JSON.stringify(afterBad.groupRules) === JSON.stringify(beforeBad.groupRules));
    chk('非法文件不改 backupState',
      JSON.stringify(afterBad.backupState) === JSON.stringify(beforeBad.backupState));
  }
  await p2.close();
}

chk('全流程(含恢复后重载)无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));
console.log(`\n  ${pass} passed, ${fail} failed`);
await ctx.close();
process.exit(fail ? 1 : 0);
