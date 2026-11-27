// features/backup.js: 配置备份 —— 手动导出/导入一份 JSON(支持自选任意目录)。
//
// 为什么非得要有它(2026-10-08 病例): 规则与设置都住 chrome.storage.local, 那是
// **按扩展 id 隔离、卸载时连库一起删** 的存储。实测过一轮(探针扩展):
//   装 → 写 local + sync + localStorage → 卸载 → 重装 ⇒ 三个区全空。
// 注意 sync 也一样空 —— 所以"挪到 chrome.storage.sync 就安全了"是条不成立的路。
// 更阴的是扩展 id = **目录路径的哈希**: 换个文件夹 Load unpacked、或者换台电脑,
// 就是另一个 id、另一个库, 表现出来一模一样是"规则全没了"(数据其实还在, 只是换了抽屉)。
// 于是能活过"卸载 / 清 profile / 换机器"的载体只剩: 磁盘上一个普通文件。
//
// ★ 2026-11-27 重构(两轮): 从"打开弹窗就自动往下载目录写"改成"用户点一下导出 / 导入"。
//   旧方案的四个实测缺陷(细节见 docs/adr/0009-backup-to-file.md 文末):
//     ① 弹窗是短命文档: backupState.sig 常常还没落库弹窗就关了, 下次唤起又判定"内容变了"
//        ⇒ 每次 ⌘E 都从头写一遍文件, 形成死循环下载;
//     ② pagehide 里再兜一次自动写, 与面板打开那次并发, 同一份配置写两遍;
//     ③ 指纹把 tgs-collapsed / tgs-view 这些日常折叠、切视图的临时 UI 态也算进去
//        ⇒ 随手收个组就被判"配置变了";
//     ④ background.js 的 onDeterminingFilename 漏 return true, 异步 suggest 被丢掉。
//
// ★★ 最终口径: **一键 Blob 直接导出 + 面板内拖放/粘贴恢复弹层**。
//   中途试过 File System Access(系统"另存为"框, 让用户自选任意目录), 但它和贴图标弹窗
//   天生不兼容: 系统文件框一抢焦点, Chrome 会立刻销毁弹窗文档 —— 保存框还挂在屏幕上
//   让用户选路径, 弹窗的 JS 上下文已经死了, 写入与 backupState 落库全不执行(用户实测)。
//   转交独立窗口能把流程走通, 但"点个导出先弹一个窗口"体验割裂, 还要维护一次性 URL 参数
//   与聚焦时序(面板 visibility 过渡期间 focus 无效)。
//   于是回到最朴素的做法: Blob + <a download>, 与规则导出一模一样 —— 零弹窗、
//   零权限、同步完成, 贴图标弹窗/独立窗口/普通标签页三种形态行为完全一致。
//   代价是落到浏览器默认下载目录, 而那是"用户主动点出来的"一次, 不是偷跑。
//   恢复端同理交给面板内的弹层(拖放 + 粘贴 + 非贴图标弹窗下可选文件), 不开系统框。
//
// 刻意**不**收进备份的键, 以及为什么:
//   archivedGroups  归档卡是"拍一下就关掉整组标签"的暂存车票, CONTEXT 里定的口径就是
//                   仅存本机、卸载即焚; 它不是配置, 不该跟着备份到处走(要改这条得先改文档)
//   manualTabIds    tabId 一重启浏览器就失效, 存下来也没有意义
//   hasArchiveUnread / groupRulesInit        运行时标记
//   tgs-collapsed / tgs-view                 折叠集合与视图是日常临时态, 不是"用户配出来的东西";
//                                            算进指纹会让收个组就亮"有未导出变更"(缺陷③)
//   backupState / autoBackupEnabled 等        备份自己的元数据(恢复时不该被旧机器覆盖)
import { relativeTime } from '../core/format.js';
import { showToast } from '../core/dom.js';

const BACKUP_FILE = 'tab_group_rule_bak.json';
const BACKUP_FORMAT = 'tgs-backup';
const BACKUP_VERSION = 1;
const STATE_KEY = 'backupState';
// backupState 的结构版本。旧版(downloads 自动备份)留下的快照 sig 是按另一套 schema
// 算的(含 tgs-collapsed/tgs-view、不含 openAsWindowEnabled), 与新口径不可能相等
// ⇒ 不认版本号就会把「7 周前的旧备份」当成真的导出过, 一升级就亮黄点、
// 永远消不掉(2026-11-27 用户实测: 点了导出还是「有未导出变更 · 上次导出 7 周前」)。
const STATE_SCHEMA = 2;

// 旧版(downloads 自动备份)留下的键, 开面板时一次性清掉
const LEGACY_KEYS = ['autoBackupEnabled', 'backupFolder', 'backupStrategy'];
const LEGACY_STATE_FIELDS = ['id', 'folder', 'needAuth', 'hint', 'mode'];

// 进备份的 chrome.storage.local 键(白名单 —— 恢复时也按它过滤,
// 手改过的 JSON 塞不进别的键)
const LOCAL_KEYS = [
  'groupRules', 'autoGroupEnabled', 'othersGroupEnabled',
  'forceMotionEnabled', 'openAsWindowEnabled',
];
// 进备份的 localStorage 偏好键(同一份白名单口径)
const PREF_KEYS = [
  'tgs-theme', 'tgs-accent', 'tgs-accent-linear', 'tgs-deletekey',
  'tgs-showurl', 'tgs-force-motion',
];

function fingerprint(obj) {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${h.toString(16)}:${s.length}`;
}

async function snapshot() {
  const stored = await chrome.storage.local.get(LOCAL_KEYS);
  const local = {};
  for (const k of LOCAL_KEYS) if (k in stored) local[k] = stored[k];
  const prefs = {};
  for (const k of PREF_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) prefs[k] = v;
  }
  const rules = local.groupRules || {};
  const hosts = Object.values(rules).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    // 冗余但有用: 文件被人肉打开时一眼能看出"这份备份里有多少东西"
    counts: { groups: Object.keys(rules).length, hosts },
    data: { local, prefs },
  };
}

export async function readBackupState() {
  const s = await chrome.storage.local.get(STATE_KEY);
  return s[STATE_KEY] || null;
}

// 旧版残留: 意图键 + 旧结构的 backupState。
// 不清的话, 用户明明已经不用自动备份了, 这些东西还会一直躺在库里;
// 更坑的是旧 sig 与新 schema 不可比, 会直接误判成「有未导出变更」。
export async function cleanupLegacyKeys() {
  const s = await chrome.storage.local.get([...LEGACY_KEYS, STATE_KEY]);
  const present = LEGACY_KEYS.filter((k) => k in s);
  if (present.length) await chrome.storage.local.remove(present);
  const raw = s[STATE_KEY];
  if (!raw || typeof raw !== 'object') {
    if (raw !== undefined) await chrome.storage.local.remove(STATE_KEY);
    return;
  }
  // 版本对不上就是旧自动备份时代的快照(哪怕它带着 at/sig), 直接丢掉
  if (raw.schema !== STATE_SCHEMA) {
    await chrome.storage.local.remove(STATE_KEY);
    return;
  }
  const st = { ...raw };
  for (const k of LEGACY_STATE_FIELDS) delete st[k];
  const valid = ['at', 'sig', 'bytes', 'groups', 'hosts', 'name'].some((k) => k in st);
  if (valid) await chrome.storage.local.set({ [STATE_KEY]: st });
  else await chrome.storage.local.remove(STATE_KEY);
}

// 一键直接导出: Blob + <a download>(与 rules.js 的「导出规则」同款)。
// 为什么不用系统"另存为"框(File System Access API): 贴图标弹窗里一弹系统保存框,
// Chrome 会立刻销毁弹窗文档, 用户选完路径点「保存」时写入与 backupState 落库都没人执行
// (2026-11-27 实测)。
// 这里全程同步、零弹窗、零权限, 三种页面形态行为一致。
export async function exportBackup() {
  const snap = await snapshot();
  const text = JSON.stringify(snap, null, 2) + '\n';
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = BACKUP_FILE;
  a.style.display = 'none';
  // 挂进文档再点: 游离节点上的 click() 在部分环境不触发默认下载行为
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  const state = {
    schema: STATE_SCHEMA,
    at: Date.now(),
    sig: fingerprint(snap.data),
    bytes: text.length,
    groups: snap.counts.groups,
    hosts: snap.counts.hosts,
    name: BACKUP_FILE,
  };
  await chrome.storage.local.set({ [STATE_KEY]: state });
  return state;
}

// 从文件恢复。返回实际写回的内容摘要, 供调用方提示。
export async function restoreFromText(text, fileName = BACKUP_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  if (parsed?.format !== BACKUP_FORMAT) throw new Error('不是本插件的备份文件');
  const local = parsed.data?.local || {};
  const prefs = parsed.data?.prefs || {};
  const patch = {};
  for (const k of LOCAL_KEYS) if (k in local) patch[k] = local[k];
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  let prefCount = 0;
  for (const k of PREF_KEYS) {
    if (k in prefs) { localStorage.setItem(k, String(prefs[k])); prefCount++; }
  }

  // 恢复后立刻把状态同步成"刚导出/刚同步", 指纹按恢复后的实际内容重算 ——
  // 否则下一步的 refreshBackupStatus 会拿旧指纹比, 一恢复就亮"有未导出变更"。
  const afterSnap = await snapshot();
  await chrome.storage.local.set({ [STATE_KEY]: {
    schema: STATE_SCHEMA,
    at: Date.now(),
    sig: fingerprint(afterSnap.data),
    bytes: text.length,
    groups: afterSnap.counts.groups,
    hosts: afterSnap.counts.hosts,
    name: fileName,
  } });

  const rules = patch.groupRules || {};
  return {
    groups: Object.keys(rules).length,
    hosts: Object.values(rules).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
    prefs: prefCount,
    exportedAt: parsed.exportedAt || '',
  };
}

// 渲染"上次导出 / 有未导出变更"。settings.js 打开设置面板时也会调一次。
// 口径: 从未导出过的用户**不亮圆点**(不打扰); 导出过之后配置有改动才亮。
export async function refreshBackupStatus() {
  const label = document.getElementById('backupStateLabel');
  const dot = document.getElementById('backupDirtyDot');
  const tabDot = document.getElementById('funcBackupDot');
  if (!label && !dot && !tabDot) return null;

  const state = await readBackupState();
  const snap = await snapshot();
  const curSig = fingerprint(snap.data);
  const hasExported = !!(state && state.at && state.sig);
  const isDirty = hasExported && state.sig !== curSig;

  if (label) {
    if (!hasExported) {
      label.textContent = `尚未导出 · ${snap.counts.groups} 组 / ${snap.counts.hosts} 域名`;
    } else if (isDirty) {
      label.textContent = `有未导出变更 · 上次导出 ${relativeTime(state.at) || '刚刚'}`;
    } else {
      label.textContent = `上次导出 ${relativeTime(state.at) || '刚刚'} · ${state.groups} 组 / ${state.hosts} 域名`;
    }
  }
  dot?.classList.toggle('show', isDirty);
  tabDot?.classList.toggle('show', isDirty);
  return { hasExported, isDirty, state, counts: snap.counts };
}

// ---------------------------------------------------------------------------
// 设置页接线: 一键导出 / 面板内恢复弹层 / 未导出提醒
// ---------------------------------------------------------------------------
// 贴图标弹出面板(默认 action.default_popup)里**不能**开系统文件框: <input type=file>
// 的系统打开框一抢焦点, Chrome 会立刻销毁弹窗文档(macOS 实测)。所以导出走纯 Blob
// 一键直出, 恢复弹层里的「选择文件…」也只在非贴图标弹窗形态下出现。
// 判据: 贴图标面板不属于任何 tab, getCurrent() 返回 undefined;
// 独立窗口(?win=1)与普通标签页都会返回真实 Tab 对象。
async function isToolbarPopup() {
  try {
    return !(await chrome.tabs.getCurrent());
  } catch {
    return false;
  }
}

// 恢复弹层(单例)。main.js 的 Esc 分支与焦点兜底监听器要判它是否开着
// (弹层是叠在设置面板上的, 这一下 Esc 只该关弹层)。
let restoreLayer = null;

export function isBackupRestoreOpen() {
  return !!restoreLayer;
}

export function closeBackupRestore() {
  if (!restoreLayer) return;
  restoreLayer.remove();
  restoreLayer = null;
}

const BTN_BASE = 'padding:5px 14px;border-radius:6px;cursor:pointer;font-size:11.5px;';
const BTN_GHOST = BTN_BASE + 'border:1px solid var(--hairline);background:var(--surface);color:var(--text);';

// 面板内恢复弹层: 拖放 + 粘贴一体。视觉语言对齐 rules.js 的「导入规则 JSON」(同一套
// 遮罩 + 居中卡片), 用户不用学第二种弹层。
function openRestoreModal() {
  if (restoreLayer) return;

  const layer = document.createElement('div');
  layer.className = 'backup-restore-layer';
  layer.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.35);'
    + 'display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'width:min(420px,92vw);background:var(--surface);'
    + 'border:1px solid var(--hairline);border-radius:12px;padding:14px;'
    + 'box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:12px';
  box.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px">从备份恢复</div>
    <div style="color:var(--text-3);margin-bottom:8px;line-height:1.5">
      把之前导出的 <code>tab_group_rule_bak.json</code> 拖到这里，或直接粘贴 JSON 内容。
      恢复会<b>覆盖</b>当前规则与外观偏好。
    </div>
    <textarea class="backup-restore-area" placeholder="在此拖入备份文件，或粘贴 JSON…"
      style="width:100%;height:180px;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;padding:8px;border:1px solid var(--hairline);border-radius:8px;background:var(--bg);color:var(--text);resize:vertical;outline:none;transition:border-color .12s"></textarea>
    <div class="backup-restore-error" style="color:var(--danger,#e0457b);font-size:11px;margin-top:6px;min-height:14px"></div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
      <button class="backup-pick-file" style="${BTN_GHOST}">选择文件…</button>
      <span style="flex:1"></span>
      <button class="backup-cancel" style="${BTN_GHOST}">取消</button>
      <button class="backup-confirm" style="${BTN_BASE}border:none;background:var(--accent);color:#fff;font-weight:600">恢复</button>
    </div>`;
  layer.appendChild(box);
  document.body.appendChild(layer);
  restoreLayer = layer;

  const area = box.querySelector('.backup-restore-area');
  const errEl = box.querySelector('.backup-restore-error');
  const pickBtn = box.querySelector('.backup-pick-file');
  let droppedFileName = '';

  const resetDragStyle = () => { area.style.borderColor = ''; area.style.boxShadow = ''; };
  const doRestore = async (text, fileName) => {
    errEl.textContent = '';
    try {
      const res = await restoreFromText(text, fileName);
      closeBackupRestore();
      showToast(`已恢复 ${res.groups} 组 / ${res.hosts} 域名${res.prefs ? ` 与 ${res.prefs} 项外观设置` : ''}`);
      // 面板是"开的时候读一次 storage"的结构, 恢复完必须重载才会显示新规则。
      // 用 reload 而不是逐块刷新: 撤销栈/收起集合/主题都可能被换掉, 重载是唯一一致的做法
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      errEl.textContent = '恢复失败: ' + (e?.message || e);
    }
  };

  area.focus();
  layer.addEventListener('click', (e) => { if (e.target === layer) closeBackupRestore(); });
  // 兜底: 拖到弹层非 textarea 区域时也吃掉默认行为 —— 否则浏览器会把文件当页面打开,
  // 弹窗文档随之被替换, 整个面板没了
  layer.addEventListener('dragover', (e) => e.preventDefault());
  layer.addEventListener('drop', (e) => e.preventDefault());
  box.querySelector('.backup-cancel').addEventListener('click', () => closeBackupRestore());
  area.addEventListener('keydown', (e) => {
    e.stopPropagation();   // 不触发全局快捷键
    if (e.key === 'Escape') closeBackupRestore();
  });

  // 拖放: 只把文件内容填进 textarea(不直接恢复) —— 用户能先一眼核对再点「恢复」
  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.style.borderColor = 'var(--accent)';
    area.style.boxShadow = '0 0 0 3px var(--ring)';
  });
  area.addEventListener('dragleave', resetDragStyle);
  area.addEventListener('drop', async (e) => {
    e.preventDefault();
    resetDragStyle();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      area.value = await file.text();
      droppedFileName = file.name || '';
      errEl.textContent = '';
    } catch (err) {
      errEl.textContent = '读不到拖入的文件: ' + (err?.message || err);
    }
  });

  // 贴图标弹窗里不显示「选择文件…」: 系统打开框会把弹窗文档一起带走
  pickBtn.addEventListener('click', () => {
    document.getElementById('backupFileInput')?.click();
  });
  isToolbarPopup().then((toolbar) => {
    // 弹层可能已经被关掉(用户手快), 别去碰已脱离文档的节点
    if (toolbar && restoreLayer === layer) pickBtn.style.display = 'none';
  }).catch(() => {});

  box.querySelector('.backup-confirm').addEventListener('click', () => {
    if (!area.value.trim()) {
      errEl.textContent = '内容为空：先拖入备份文件或粘贴 JSON';
      return;
    }
    doRestore(area.value, droppedFileName || BACKUP_FILE);
  });
}

export function initBackup() {
  const exportBtn = document.getElementById('backupExportBtn');
  const restoreBtn = document.getElementById('backupRestoreBtn');
  const fileInput = document.getElementById('backupFileInput');
  const funcPane = document.getElementById('pane-func');
  if (!exportBtn || !restoreBtn || !fileInput) return;

  // 先清旧版残留, 再按新口径渲染一次状态。**这里不做任何写盘/下载**。
  cleanupLegacyKeys()
    .catch(() => {})
    .then(() => refreshBackupStatus())
    .catch(() => {});

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;      // 防连点: 两次导出叠在一起没必要
    try {
      const state = await exportBackup();
      await refreshBackupStatus();  // 黄点当场熄灭, 文案立刻变成「上次导出 刚刚」
      showToast(`已导出 ${state.groups} 组 / ${state.hosts} 域名 → ${state.name}`);
    } catch (e) {
      showToast('导出失败: ' + e.message);
    } finally {
      exportBtn.disabled = false;
    }
  });

  // 恢复: 就地弹层(拖放/粘贴), 不再转交独立窗口 —— 三种页面形态同一行为
  restoreBtn.addEventListener('click', () => { openRestoreModal(); });

  // 弹层里点了「选择文件…」(仅非贴图标弹窗): 选完直接恢复
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const res = await restoreFromText(await file.text(), file.name);
      closeBackupRestore();
      showToast(`已恢复 ${res.groups} 组 / ${res.hosts} 域名${res.prefs ? ` 与 ${res.prefs} 项外观设置` : ''}`);
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      const errEl = restoreLayer?.querySelector('.backup-restore-error');
      if (errEl) errEl.textContent = '恢复失败: ' + e.message;
      showToast('恢复失败: ' + e.message);
    } finally {
      fileInput.value = '';   // 同一个文件连选两次也要能触发 change
    }
  });

  // chrome.storage.local 侧的配置(规则/开关)变化: 防抖后重算指纹
  let storageTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!LOCAL_KEYS.some((k) => k in changes)) return;
    clearTimeout(storageTimer);
    storageTimer = setTimeout(() => { refreshBackupStatus().catch(() => {}); }, 200);
  });

  // localStorage 侧的偏好(主题/突出色/删除键/显示 URL/强行动效)不触发 onChanged,
  // 用设置面板里的点击/变更事件兜住(防抖, 一次操作只重算一次)
  let prefTimer = null;
  const onPrefChange = () => {
    clearTimeout(prefTimer);
    prefTimer = setTimeout(() => { refreshBackupStatus().catch(() => {}); }, 150);
  };
  funcPane?.addEventListener('change', onPrefChange);
  funcPane?.addEventListener('click', onPrefChange);
}
