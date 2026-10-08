// features/backup.js: 配置备份 —— 把"用户自己配出来的东西"落成磁盘上的一个 JSON 文件。
//
// 为什么非得要有它(2026-10-08 病例): 规则与设置都住 chrome.storage.local, 那是
// **按扩展 id 隔离、卸载时连库一起删** 的存储。实测过一轮(探针扩展):
//   装 → 写 local + sync + localStorage → 卸载 → 重装 ⇒ 三个区全空。
// 注意 sync 也一样空 —— 所以"挪到 chrome.storage.sync 就安全了"是条不成立的路。
// 更阴的是扩展 id = **目录路径的哈希**: 换个文件夹 Load unpacked、或者换台电脑,
// 就是另一个 id、另一个库, 表现出来一模一样是"规则全没了"(数据其实还在, 只是换了抽屉)。
//
// 于是能活过"卸载 / 清 profile / 换机器"的载体只剩: 磁盘上一个普通文件。
// 落点选「下载」目录 + 固定文件名(用户指定: tab_group_rule_bak.json) +
// conflictAction:'overwrite' —— 同名**原地覆盖**,
// 不会堆出 backup (1).json, 也不需要每次弹保存框(实测: 文档里用 data: URL 就能触发下载,
// 无需手势)。设置页那个「文件位置」按钮就是给这个文件开的口子: 点一下在访达里选中它。
//
// ★ 为什么写在弹窗侧, 而不是 background:
//   备份内容一半在 chrome.storage.local(配置), 一半在 localStorage(外观偏好 ——
//   settings.js 靠它做"首帧同步镜像", 见那边的注释)。而 **service worker 里没有
//   localStorage**, 只有文档侧(弹窗)能同时读到两边。好在"用户能改的配置都是从弹窗改
//   的", 于是触发点收成两处就够: 面板打开时 / 面板关掉时(pagehide), 外加开面板期间
//   chrome.storage.onChanged 即时落。代价如实记下: 只改外观(主题/突出色)又当场卸载,
//   那一次会漏 —— 下次开面板补上(丢失的也只是外观偏好, 不是规则)。
//
// 刻意**不**收进备份的键, 以及为什么:
//   archivedGroups  归档卡是"拍一下就关掉整组标签"的暂存车票, CONTEXT 里定的口径就是
//                   仅存本机、卸载即焚; 它不是配置, 不该跟着备份到处走(要改这条得先改文档)
//   manualTabIds    tabId 一重启浏览器就失效, 存下来也没有意义
//   hasArchiveUnread / groupRulesInit        运行时标记
//   autoBackupEnabled / backupState          备份自己的元数据(恢复时不该被旧机器覆盖)
import { relativeTime } from '../core/format.js';
import { showToast } from '../core/dom.js';

const BACKUP_FILE = 'tab_group_rule_bak.json';
const BACKUP_FORMAT = 'tgs-backup';
const BACKUP_VERSION = 1;
const STATE_KEY = 'backupState';
const OPT_KEY = 'autoBackupEnabled';

// 进备份的 chrome.storage.local 键(白名单 —— 恢复时也按它过滤,
// 手改过的 JSON 塞不进别的键)
const LOCAL_KEYS = ['groupRules', 'autoGroupEnabled', 'othersGroupEnabled', 'forceMotionEnabled'];
// 进备份的 localStorage 偏好键(同一份白名单口径)
const PREF_KEYS = [
  'tgs-theme', 'tgs-accent', 'tgs-accent-linear', 'tgs-deletekey',
  'tgs-showurl', 'tgs-force-motion', 'tgs-collapsed', 'tgs-view',
];

const WRITE_DEBOUNCE_MS = 1200;

// 内容指纹: 只比对 data 部分(exportedAt 每次都不同, 不能进指纹)。
// djb2 够用 —— 这里只需要"变没变", 不需要抗碰撞。
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

function download(url) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename: BACKUP_FILE, conflictAction: 'overwrite', saveAs: false },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) reject(new Error(err?.message || '下载未启动'));
        else resolve(id);
      },
    );
  });
}

// 只留最新那一条下载记录: 否则每改一次规则, 下载列表里就多一行同名记录。
// 主力是"精确删掉上一次那个 id" —— 靠文件名正则会看走眼(文件被改名/被移到别处就找不到),
// 正则那趟只当扫残渣的兜底。
//
// ⚠️ 病例(2026-10-08): 这里原本是 `erase({ id: [a, b] })` 一把删, 文档也说 id 可以是数组,
// 但运行时**只接受单个整数**, 传数组直接 TypeError: expected integer, found array ——
// 而这条又被外面的 catch 吞了, 表现成"清理悄悄失效"(下载列表里越堆越多), 一点动静都没有。
// 所以现在逐个 id 删。教训: 这种"失败也不出声"的清理逻辑, 必须有测试盯着结果(见测试 ③)。
// 另外用的是 erase 而不是 removeFile: erase 只摘历史记录, **不动磁盘上的文件**(实测确认)
async function pruneOlder(keepId, prevId) {
  const stale = [];
  if (prevId != null && prevId !== keepId) stale.push(prevId);
  try {
    const items = await chrome.downloads.search({
      filenameRegex: BACKUP_FILE.replace(/\./g, '\\.'),
    });
    for (const i of items) if (i.id !== keepId && !stale.includes(i.id)) stale.push(i.id);
  } catch { /* 扫不到就算了, 不影响备份本身 */ }
  for (const id of stale) {
    try { await chrome.downloads.erase({ id }); } catch { /* 同理 */ }
  }
}

export async function readBackupState() {
  const s = await chrome.storage.local.get(STATE_KEY);
  return s[STATE_KEY] || null;
}

// 真正落盘。返回写入后的状态(供 UI 显示"上次备份 …")
export async function writeBackup(reason = 'manual') {
  const prev = await readBackupState();   // 上一次那条下载记录, 写完就把它摘掉
  const snap = await snapshot();
  const text = JSON.stringify(snap, null, 2) + '\n';
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
  const id = await download(url);
  await pruneOlder(id, prev?.id);
  const state = {
    id, at: Date.now(), reason,
    sig: fingerprint(snap.data), bytes: text.length,
    groups: snap.counts.groups, hosts: snap.counts.hosts,
  };
  await chrome.storage.local.set({ [STATE_KEY]: state });
  return state;
}

// 内容没变就不写 —— 面板每次打开都会走到这里, 不加这道闸就是"每开一次弹窗写一个文件"
export async function maybeAutoBackup() {
  try {
    const s = await chrome.storage.local.get([OPT_KEY, STATE_KEY]);
    if (s[OPT_KEY] === false) return null;
    const snap = await snapshot();
    if (s[STATE_KEY]?.sig === fingerprint(snap.data)) return null;
    return await writeBackup('auto');
  } catch (e) {
    console.warn('[TGS] 自动备份失败:', e);
    return null;
  }
}

// 「文件位置」: 在访达里选中备份文件。下载记录被清过/从没备份过 → 退化成打开下载文件夹
export async function revealBackupFile() {
  const state = await readBackupState();
  if (state?.id != null) {
    try {
      await chrome.downloads.show(state.id);
      return 'shown';
    } catch { /* 记录没了, 走下面的兜底 */ }
  }
  await chrome.downloads.showDefaultFolder();
  return 'folder';
}

// 从备份文件恢复。返回实际写回的条目数, 供调用方提示
export async function restoreFromText(text) {
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
  const rules = patch.groupRules || {};
  return {
    groups: Object.keys(rules).length,
    hosts: Object.values(rules).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
    prefs: prefCount,
    exportedAt: parsed.exportedAt || '',
  };
}

// ---------------------------------------------------------------------------
// 设置页接线: 开关 / 文件位置 / 立即备份 / 从备份恢复
// ---------------------------------------------------------------------------
export function initBackup() {
  const optAuto = document.getElementById('optAutoBackup');
  const revealBtn = document.getElementById('backupRevealBtn');
  const stateLabel = document.getElementById('backupStateLabel');
  const nowBtn = document.getElementById('backupNowBtn');
  const restoreBtn = document.getElementById('backupRestoreBtn');
  const fileInput = document.getElementById('backupFileInput');
  if (!optAuto || !revealBtn || !stateLabel || !nowBtn || !restoreBtn || !fileInput) return;

  const render = (state) => {
    stateLabel.textContent = state?.at
      ? `上次备份 ${relativeTime(state.at)} · ${state.groups} 组 / ${state.hosts} 域名`
      : '尚未备份';
  };

  // 默认开(未设置视为开): 关掉只停自动写入, 手动「立即备份」照旧可用
  chrome.storage.local.get(OPT_KEY).then((s) => { optAuto.checked = s[OPT_KEY] !== false; });
  readBackupState().then(render);

  optAuto.addEventListener('change', async () => {
    await chrome.storage.local.set({ [OPT_KEY]: optAuto.checked });
    if (optAuto.checked) {
      // 打开开关就立刻给一份, 而不是等用户下次改配置 —— 否则"开了却看不到文件位置"
      try { render(await writeBackup('auto')); showToast('已开启自动备份, 并写入了一份'); }
      catch (e) { showToast('备份失败: ' + e.message); }
    }
  });

  revealBtn.addEventListener('click', async () => {
    try {
      const how = await revealBackupFile();
      if (how === 'folder') showToast('还没有备份文件, 已打开下载文件夹');
    } catch (e) {
      showToast('打不开位置: ' + e.message);
    }
  });

  nowBtn.addEventListener('click', async () => {
    nowBtn.disabled = true;
    try {
      const state = await writeBackup('manual');
      render(state);
      showToast(`已备份 ${state.groups} 组 / ${state.hosts} 域名 → 下载/${BACKUP_FILE}`);
    } catch (e) {
      showToast('备份失败: ' + e.message);
    } finally {
      nowBtn.disabled = false;
    }
  });

  restoreBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const res = await restoreFromText(await file.text());
      showToast(`已恢复 ${res.groups} 组 / ${res.hosts} 域名${res.prefs ? ` 与 ${res.prefs} 项外观设置` : ''}`);
      // 面板是"开的时候读一次 storage"的结构, 恢复完必须重载才会显示新规则。
      // 用 reload 而不是逐块刷新: 撤销栈/收起集合/主题都可能被换掉, 重载是唯一一致的做法
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      showToast('恢复失败: ' + e.message);
    } finally {
      fileInput.value = '';   // 同一个文件连选两次也要能触发 change
    }
  });

  // 开面板期间改配置(保存规则/切开关)即时落一次; 关面板再兜一次底
  let timer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!LOCAL_KEYS.some((k) => k in changes)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => { render(await maybeAutoBackup() || await readBackupState()); }, WRITE_DEBOUNCE_MS);
  });
  window.addEventListener('pagehide', () => { maybeAutoBackup(); });

  maybeAutoBackup().then(async (s) => render(s || await readBackupState()));
}
