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
import { showToast, confirmInPanel } from '../core/dom.js';

const BACKUP_FILE = 'tab_group_rule_bak.json';
const BACKUP_FORMAT = 'tgs-backup';
const BACKUP_VERSION = 1;
const STATE_KEY = 'backupState';
const OPT_KEY = 'autoBackupEnabled';
// 备份位置 = 下载目录下的相对子文件夹(空 = 下载目录根)
const FOLDER_KEY = 'backupFolder';
// 只用于把老版本(File System Access)留下的键清掉, 见 migrateOldStrategy
const STRATEGY_KEY = 'backupStrategy';

// 进备份的 chrome.storage.local 键(白名单 —— 恢复时也按它过滤,
// 手改过的 JSON 塞不进别的键)
const LOCAL_KEYS = ['groupRules', 'autoGroupEnabled', 'othersGroupEnabled', 'forceMotionEnabled'];
// 进备份的 localStorage 偏好键(同一份白名单口径)
const PREF_KEYS = [
  'tgs-theme', 'tgs-accent', 'tgs-accent-linear', 'tgs-deletekey',
  'tgs-showurl', 'tgs-force-motion', 'tgs-collapsed', 'tgs-view',
];

const WRITE_DEBOUNCE_MS = 1200;

// 备份落到哪: **系统下载目录**里的一个相对位置(可带子文件夹, 例如 "TGS/自动备份")。
//
// ⚠️ 2026-10-09 病例(本机): 这里原来用的是 File System Access(让用户自己挑任意路径的 JSON 文件)。
// 它能写、但**权限留不住** —— 读用户 Chrome 的 Preferences 可见:
//     file_system_access_chooser_data         有我们(选文件时点了允许写)
//     file_system_access_extended_permission  **空** ⇒ 没有"持久授权"
// 也就是说那次授权只活在**当时那个文档**里; 而弹窗每次用完就关, 于是每次备份都得重新授权
// ⇒ 用户被反复弹授权框("怎么老是弹让我重新赋权的窗")。**这不是代码能修的**, 是这套 API 的模型。
// 所以改用 downloads 的相对路径: 相对名天然落在系统"下载"里(macOS ~/Downloads、
// Windows C:\Users\<你>\Downloads), 一个字符串覆盖两端, 且**不需要任何权限、永不弹框**。
// 代价说清楚: 位置只能落在下载目录之内, 没法挑到别处 —— 想要任意路径, 那条路只有"每次弹保存框"
// (saveAs: true), 对自动备份来说不可用。

// 子文件夹名: 相对下载目录, 允许 "TGS" 或 "TGS/自动备份"; 空 = 直接放下载目录根
function normalizeFolder(raw) {
  const typed = String(raw == null ? '' : raw).trim();
  // 绝对路径要**明着拒绝**, 不能默默去掉开头的斜杠当成相对路径 —— 用户写 /Users/… 时想的是绝对路径,
  // 悄悄改写成 "Users/…" 会让他以为设置生效了(与 C:\ 那条同样待遇)
  if (/^[\\/]/.test(typed) || typed.startsWith('~') || /^[a-zA-Z]:/.test(typed)) {
    throw new Error('只能填相对下载目录的子文件夹(如 TGS)');
  }
  const v = typed.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!v) return '';
  const segs = v.split('/').filter(Boolean);
  if (segs.length > 3) throw new Error('最多三层子文件夹');
  for (const seg of segs) {
    if (seg === '.' || seg === '..') throw new Error('不能出现 . 或 ..');
    if (/[<>:"|?*]/.test(seg)) throw new Error('文件夹名不能含 < > : " | ? *');
  }
  return segs.join('/');
}

export async function readBackupFolder() {
  const s = await chrome.storage.local.get(FOLDER_KEY);
  return typeof s[FOLDER_KEY] === 'string' ? s[FOLDER_KEY] : '';
}

// 「打开下载目录」: 用系统文件管理器打开"下载", 让用户自己看清/新建要用的子文件夹 —— 再填名字。
//
// ⚠️ 2026-10-09 病例(本机): 这里原本是「选择…」(`showDirectoryPicker`)。用户实测: 选**家目录**被拒
// ("无法打开此文件夹 —— 因为其中含有系统文件"), 选**文档**被拒, **连"下载"本身也被拒** ——
// Chrome 的文件夹选择器把家目录/文稿/下载这类用户标准目录整个放进黑名单(它们"太宽"), 只允许选
// "下载"**里面**的子文件夹。而第一次配置时那个子文件夹还不存在 ⇒ 这个按钮在真实场景里走不通。
// 于是撤掉选择器: 位置用输入框填, 旁边给一个"打开下载目录"帮用户看清/建目录。**不需要任何权限。**

export async function saveBackupFolder(raw) {
  const folder = normalizeFolder(raw);            // 不合法就抛, 由调用方提示
  await chrome.storage.local.set({ [FOLDER_KEY]: folder });
  return folder;
}

// 老版本(File System Access)留下的痕迹清掉: 意图键与状态里的 needAuth/自选名。
// 不清的话, 那条"权限被收回"的提示会一直跟着用户, 而他根本没有自选位置了。
export async function migrateOldStrategy() {
  const s = await chrome.storage.local.get([STRATEGY_KEY, STATE_KEY]);
  if (!(STRATEGY_KEY in s)) return;
  await chrome.storage.local.remove(STRATEGY_KEY);
  const st = { ...(s[STATE_KEY] || {}) };
  delete st.needAuth;
  delete st.hint;
  delete st.mode;
  if (Object.keys(st).length) await chrome.storage.local.set({ [STATE_KEY]: st });
}

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

function download(url, relName = BACKUP_FILE) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      // filename 是"相对下载目录"的路径; 带子目录时 Chrome 会自动把目录建出来
      { url, filename: relName, conflictAction: 'overwrite', saveAs: false },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) reject(new Error(err?.message || '下载未启动'));
        else resolve(id);
      },
    );
  });
}

// 反查"我们自己那条下载记录"。为什么不能直接用 download() 回调给的 id ——
// 装了下载管理器(NeatDM 之类)时, 它会把我们这条 cancel + erase 掉再按 URL 重下一遍,
// 于是真正落盘的是**另一条 id**; 名字虽然已被 background.js 的 onDeterminingFilename 抢回来了,
// 但记着旧 id 会让「文件位置」点不开。所以按"同名记录里最新的一条"来找。
async function ownDownloadItems(url) {
  const hit = new Map();
  try {
    const byName = await chrome.downloads.search({
      filenameRegex: BACKUP_FILE.replace(/\./g, '\\.'),
    });
    for (const i of byName) hit.set(i.id, i);
    // 再按 URL 捞一遍: 名字可能被别人改掉(--> 见 docs/adr/0009 病例三), URL 不会。
    // 两条都查、按 id 去重, 谁先谁后无所谓
    if (url) {
      const byUrl = await chrome.downloads.search({ url });
      for (const i of byUrl) hit.set(i.id, i);
    }
  } catch { /* 查不到就当没有 */ }
  return [...hit.values()].sort((a, b) => b.id - a.id);
}

// 等"真正落盘的那条"出现。下载管理器(NeatDM 之类)会把我们这条 cancel + erase 掉,
// 再按 URL 重下一遍 —— 那条记录的 id 才是真正落盘的。这里给它一小会儿:
//   正常环境: 250ms 后查到的仍是自己那条, 这点延迟可以忽略(写备份本来就在防抖之后跑);
//   被接管环境: 等到"另一条同名记录"出现就用它(名字已由 background.js 的
//               onDeterminingFilename 抢回来, 两条会同名, 所以认得出来)。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settleOwnItem(fallbackId, url) {
  const taken = async () => (await ownDownloadItems(url)).find((it) => it.id !== fallbackId) || null;
  await sleep(250);
  let other = await taken();
  for (let i = 0; !other && i < 5; i++) {
    if ((await ownDownloadItems(url)).some((it) => it.id === fallbackId)) break;   // 自己那条还在 ⇒ 没被接管
    await sleep(200);
    other = await taken();
  }
  return other;
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
async function pruneOlder(prevId, keepId, url) {
  const items = await ownDownloadItems(url);
  const stale = [];
  if (prevId != null && prevId !== keepId) stale.push(prevId);
  for (const i of items) if (i.id !== keepId && !stale.includes(i.id)) stale.push(i.id);
  for (const id of stale) {
    try { await chrome.downloads.erase({ id }); } catch { /* 扫不到就算了, 不影响备份本身 */ }
  }
  return keepId;
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
  const folder = await readBackupFolder();
  const rel = folder ? `${folder}/${BACKUP_FILE}` : BACKUP_FILE;
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
  const id = await download(url, rel);
  const keepId = (await settleOwnItem(id, url))?.id ?? id;
  await pruneOlder(prev?.id, keepId, url);
  const state = {
    id: keepId, at: Date.now(), reason,
    sig: fingerprint(snap.data), bytes: text.length,
    groups: snap.counts.groups, hosts: snap.counts.hosts,
    folder, name: rel,
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
  // 现查一遍(下载管理器重下的那条也算), 查不到才退回记录里的 id —— 后者可能已被拦截至失效
  const id = (await ownDownloadItems())[0]?.id ?? state?.id;
  if (id != null) {
    try {
      await chrome.downloads.show(id);
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
  const folderInput = document.getElementById('backupFolderInput');
  const openFolderBtn = document.getElementById('backupOpenFolderBtn');
  const hintBtn = document.getElementById('backupHintBtn');
  const hintLine = document.getElementById('backupHintLine');
  const stateLabel = document.getElementById('backupStateLabel');
  const nowBtn = document.getElementById('backupNowBtn');
  const restoreBtn = document.getElementById('backupRestoreBtn');
  const fileInput = document.getElementById('backupFileInput');
  if (!optAuto || !revealBtn || !folderInput || !openFolderBtn || !hintBtn || !hintLine
      || !stateLabel || !nowBtn || !restoreBtn || !fileInput) return;

  const pathText = (folder) => (folder ? `下载目录/${folder}` : '下载目录');
  // 当前生效的位置缓存一份: Esc 要**还原**它(直接清空 = "改成下载目录根" —— 一按 Esc 就把设置改了, 真实踩到)
  let savedFolder = '';

  // 一次渲染交代两件事: 上次备份的时间/规模, 以及"这份东西放到哪了"
  const render = (state) => {
    stateLabel.textContent = state?.at
      ? `上次备份 ${relativeTime(state.at)} · ${state.groups} 组 / ${state.hosts} 域名`
      : '尚未备份';

  };

  // 默认开(未设置视为开): 关掉只停自动写入, 手动「立即备份」照旧可用
  chrome.storage.local.get(OPT_KEY).then((s) => { optAuto.checked = s[OPT_KEY] !== false; });
  // 老版本用 File System Access 选过位置的话, 这里把痕迹清掉(含状态里那条"权限被收回"的提示),
  // 否则用户明明已经没有自选位置了, 还会一直被那条提示跟着
  migrateOldStrategy().then(async () => {
    savedFolder = await readBackupFolder();
    folderInput.value = savedFolder;
    folderInput.title = `${pathText(savedFolder)}/${BACKUP_FILE}`;
    render(await readBackupState());
  });

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

  // 备份位置: 直接在这儿填"下载目录下的子文件夹"(可留空 = 放下载目录根)。
  // 为什么不是"挑一个任意路径": 那条路要 File System Access, 权限留不住、每次备份都要重新授权
  // (见文件头 2026-10-09 病例), 用户会被反复弹框。相对路径这条**不需要任何权限**。
  // 统一入口: 校验 → 存库 → 立刻写一份 → 提示。输入框与「选择…」都走它 ——
  // 之前「选择…」只改了输入框的值, 没落库, 于是备份还是写到老位置(测试抓到的)
  const applyAndSave = async (raw) => {
    let folder;
    try {
      folder = await saveBackupFolder(raw);
    } catch (e) {
      folderInput.value = savedFolder;                  // 打回当前生效值
      folderInput.classList.add('invalid-flash');
      setTimeout(() => folderInput.classList.remove('invalid-flash'), 1300);
      showToast('位置没改成: ' + e.message);
      return;
    }
    folderInput.value = folder;
    savedFolder = folder;
    folderInput.title = `${pathText(folder)}/${BACKUP_FILE}`;
    try {
      render(await writeBackup('manual'));
      showToast(`备份位置: ${pathText(folder)}/${BACKUP_FILE} · 已写入`);
    } catch (e) {
      showToast('写备份失败: ' + e.message);
    }
  };

  // 行内说明: 点一下展开/收起(不用 hover 气泡 —— 它在卡片底部会被裁掉且跑出屏幕, 见 popup.html 那条病例)
  const setHint = (open) => {
    hintLine.hidden = !open;
    hintBtn.setAttribute('aria-expanded', String(open));
  };
  hintBtn.addEventListener('click', () => setHint(hintLine.hidden));
  hintBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); setHint(false); hintBtn.blur(); }
  });

  // 打开"下载"目录(系统文件管理器): 让用户看清里面有什么、要建哪个子文件夹
  openFolderBtn.addEventListener('click', async () => {
    try {
      await chrome.downloads.showDefaultFolder();
    } catch (e) {
      showToast('打不开下载目录: ' + e.message);
    }
  });

  const applyFolder = async () => applyAndSave(folderInput.value);

  folderInput.addEventListener('change', applyFolder);
  folderInput.addEventListener('keydown', (e) => {
    // 注意 IME: 中文输入法回车确认候选词时不能当成"提交"(同 group-edit.js 的口径)
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); folderInput.blur(); }   // blur → change → applyFolder
    // Esc = 放弃编辑(还原成当前生效的值)。这里必须是**还原**而不是清空: 清空等于"改成下载目录根",
    // 跟着 blur 触发的 change 会真的把它存下来 —— 一按 Esc 把设置改掉了(真实踩到)
    if (e.key === 'Escape') { e.stopPropagation(); folderInput.value = savedFolder; folderInput.blur(); }
    e.stopPropagation();     // 别让弹窗的全局快捷键(↑↓/Enter/搜索)吃走这里的按键
  });

  nowBtn.addEventListener('click', async () => {
    nowBtn.disabled = true;
    try {
      const state = await writeBackup('manual');
      render(state);
      const where = state.mode === 'file' ? state.name : `下载目录/${BACKUP_FILE}`;
      showToast(`已备份 ${state.groups} 组 / ${state.hosts} 域名 → ${where}`);
      if (state.hint) showToast(state.hint);
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
