// features/undo.js: 撤销关闭(组件)
// 单关路径 showUndo 入栈+渲染;批量清理 pushUndo 逐个入栈后 renderUndoBanner。
import { pushBanner, dismissBanner, pushStack, resultsEl } from '../core/dom.js';
import { getChromeFaviconUrl } from '../core/format.js';
import { MOD } from '../core/platform.js';
import { recentlyRestoredTabs, collapsed, saveCollapsed, searchCollapsed, state } from '../core/store.js';
import { groupOrderSnapshot, seedGroupOrder } from '../core/group-order.js';
import { expandRows } from './row-anim.js';

let actions = null; // initUndo 注入: { refreshData, render, focusCurrentTab }
export function initUndo(injected) { actions = injected; }

// ---- 撤销关闭 ----
let undoTimer = null;
let undoStack = []; // 最近关闭的标签快照,支持连续撤销
// 撤销窗口。批量关闭会连弹窗一起关掉(靶子含激活标签时),内存栈随 popup 消失,
// 所以这条路径必须先把快照落 session —— 见 ADR-0006 的 Consequences
const UNDO_WINDOW_MS = 6000;
const UNDO_SESSION_KEY = 'tgs-undo-pending';

// 批量路径入栈(cleanStaleTabs 循环里逐个入栈后统一 renderUndoBanner)
export function pushUndo(snapshot) {
  undoStack.push(snapshot);
}

// ---- 跨 popup 生死的撤销凭证 ----
// 只给批量关闭用: 单关(✕)是精确点击、风险量级不同, 不为此重做撤销模型

export async function persistUndoBatch(snapshots) {
  try {
    await chrome.storage.session.set({
      // order: 关闭前的分区次序。目标含激活标签时 popup 会当场死, 撤销发生在**新** popup 里 ——
      // 那边首帧只看得到"剩下的组", 不知道被清空的组原来站在哪。把记账本一起落下去,
      // 撤销出来的组才回得到原座位(见 core/group-order.js)
      [UNDO_SESSION_KEY]: { snapshots, order: groupOrderSnapshot(), at: Date.now() },
    });
  } catch (e) {
    console.error('撤销快照落 session 失败:', e);
  }
}

export async function clearUndoBatch() {
  try { await chrome.storage.session.remove(UNDO_SESSION_KEY); } catch {}
}

// popup 启动时调用: 上一次若走的是"关完就死"的路径, 在这里把撤销承诺接回来
// (过了撤销窗口就当从未发生过 —— 陈旧快照不能拿来复活很久以前关的标签)
export async function restoreUndoBatch() {
  try {
    const stored = await chrome.storage.session.get(UNDO_SESSION_KEY);
    const pending = stored?.[UNDO_SESSION_KEY];
    if (!pending?.snapshots?.length) return;
    const age = Date.now() - (pending.at || 0);
    if (age >= UNDO_WINDOW_MS) { await clearUndoBatch(); return; }
    // 先接回分区次序, 再让 undoStack 可撤 —— 撤销触发的那次 render 就要按这个座次落位
    if (pending.order?.length) seedGroupOrder(pending.order);
    for (const snap of pending.snapshots) {
      if (!undoStack.some(x => x.tab?.id === snap?.tab?.id)) undoStack.push(snap);
    }
    renderUndoBanner({ ms: UNDO_WINDOW_MS - age });
  } catch (e) {
    console.error('恢复撤销快照失败:', e);
  }
}

export function showUndo(snapshot) {
  undoStack.push(snapshot);
  renderUndoBanner();
}

// 撤销条: 连续删除时**叠在同一条上**(数量角标递增), 不再每删一条弹一条
// —— 旧版表现: 底部弹窗一直跳, 信息还重复。条目可点击展开成列表,
// 逐条单独撤销(用户口径: 只想撤回其中指定的 tab), 也可一键全撤。
// 跨 popup 恢复(restoreUndoBatch)时倒计时接着上一段走。
let undoBannerEl = null;

// 渲染/更新撤销通知条 + 启动 6s 倒计时。undoStack 由调用方维护:
// 单关路径 showUndo 已 push;批量清理(cleanStaleTabs)在循环里已 push
// 全部快照,直接调用本函数即可——之前 cleanStaleTabs 误调
// showUndo(targets[last].tab)(传了裸 Tab 而非快照对象),既重复 push
// 又因 snapshot.tab 为 undefined 抛 TypeError,导致清理后不刷新/不提示/
// 不能撤销。拆出本函数后批量路径只渲染不重复入栈
export function renderUndoBanner(opts = {}) {
  const ms = opts.ms || UNDO_WINDOW_MS; // 跨 popup 恢复时, 倒计时接着上一段走
  const count = undoStack.length;
  if (!count) return;
  // 叠加: 条还活着就直接换内容(文案/角标/列表), 不重推动画 ——
  // 弹窗不再跳。条被 toast 顶掉/已被兑现过则重新建
  if (undoBannerEl && undoBannerEl.isConnected) {
    buildUndoBannerContent(undoBannerEl, ms);
  } else {
    undoBannerEl = pushBanner((banner) => {
      banner.classList.add('undo-banner');
      buildUndoBannerContent(banner, ms);
    }, { autoDismiss: 0 }); // 生命期由 undoTimer 管, 不走 pushBanner 的自动消失
  }
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoStack = [];
    // 撤销窗口一过, session 里的凭证也一并作废; 条目一并退场
    clearUndoBatch();
    if (undoBannerEl?.isConnected) {
      dismissBanner(undoBannerEl);
      undoBannerEl = null;
    }
  }, ms);
}

// 条目内容(收起态 + 展开列表)整体重建。新关闭进来时回到收起态
// (展开态看列表正滚动时突然插行, 观感比收起更乱)
function buildUndoBannerContent(banner, ms) {
  banner.textContent = '';
  banner.style.position = 'relative';
  const count = undoStack.length;
  const last = undoStack[count - 1]?.tab;
  const title = (last?.title || last?.url || '').toString().slice(0, 24);

  // ① 收起态主体: 文案 + 撤销按钮 + 数量角标(≥2 才亮, 即"叠加"信号)
  const msg = document.createElement('span');
  msg.className = 'push-msg undo-msg';
  msg.textContent = count > 1 ? `已关闭 ${count} 个标签页` : `已关闭「${title}」`;
  const btn = document.createElement('button');
  btn.className = 'push-action';
  btn.textContent = '撤销全部';
  btn.title = `撤销刚才关闭的 ${count} 个标签 (${MOD}Z)`;
  btn.addEventListener('click', doUndo);
  banner.appendChild(msg);
  banner.appendChild(btn);
  if (count > 1) {
    const badge = document.createElement('button');
    badge.className = 'undo-badge';
    badge.textContent = `+${count}`;
    badge.title = '展开列表, 可逐条单独撤销';
    badge.addEventListener('click', () => toggleUndoList(banner, ms));
    banner.appendChild(badge);
  }

  // ② 倒计时进度条: 剩余可撤销时间(条目相对定位收窄置底)。
  // 时长必须跟本次的 ms 走 —— CSS 里的 6s 是首次关闭的满格值; 跨 popup 恢复时
  // ms 只剩一段余额, 若沿用 6s 进度条会从头跑(表现: 每次开弹窗都重新读秒)。
  const progress = document.createElement('span');
  progress.className = 'push-progress';
  progress.style.animationDuration = `${ms}ms`;
  banner.appendChild(progress);
}

// 展开/收起列表。展开 = 条内附一个可滚动列表, 每条带独立的「撤销」
function toggleUndoList(banner, ms) {
  const existing = banner.querySelector('.undo-list');
  if (existing) { existing.remove(); return; } // 再点角标 = 收起
  const list = document.createElement('div');
  list.className = 'undo-list';
  // 新的在上(关闭时间倒序, 与撤销直觉一致: 最近关的排最上)
  for (const snap of [...undoStack].reverse()) {
    const t = snap?.tab;
    if (!t?.url) continue;
    const item = document.createElement('div');
    item.className = 'undo-item';
    const icon = document.createElement('span');
    icon.className = 'undo-item-icon';
    const fav = t.favIconUrl || getChromeFaviconUrl(t.url);
    if (fav) {
      icon.style.backgroundImage = `url("${fav}")`;
    } else {
      icon.textContent = (t.title || t.url || '?').trim().charAt(0).toUpperCase() || '?';
    }
    const label = document.createElement('span');
    label.className = 'undo-item-title';
    label.textContent = (t.title || t.url || '').toString().slice(0, 60);
    label.title = t.title || t.url;
    const one = document.createElement('button');
    one.className = 'push-action secondary';
    one.textContent = '撤销';
    one.title = '只撤销这一个标签';
    one.addEventListener('click', () => doUndoOne(snap));
    item.appendChild(icon);
    item.appendChild(label);
    item.appendChild(one);
    list.appendChild(item);
  }
  banner.appendChild(list);
}

// ⌘Z / Ctrl+Z 撤销最近关闭(等价于点击撤销按钮)
export function isUndoAvailable() {
  return undoStack.length > 0;
}

// 单条撤销(展开列表里的「撤销」): 只恢复指定的那一个, 栈里移掉它,
// 条目角标 -1; 栈空了整条退场
export async function doUndoOne(snap) {
  const idx = undoStack.indexOf(snap);
  if (idx < 0) return; // 已被单独撤销过/快照失效
  undoStack.splice(idx, 1);
  if (!undoStack.length) {
    // 全部逐条撤完: 与整条撤销同款收尾
    clearPushBanners();
    clearUndoBatch();
    clearTimeout(undoTimer);
  } else if (undoBannerEl?.isConnected) {
    // 叠加条仍在: 重建内容(角标/文案/进度条), 展开列表一并刷新
    // 单撤不重置窗口: 整条的生命期还是最初那次 6s
    buildUndoBannerContent(undoBannerEl, UNDO_WINDOW_MS);
    // 剩余的快照继续留在内存栈; session 凭证是批量的, 单撤不动它
  } else {
    // 条被顶掉了(如 toast)但栈还有货: 重建一条
    renderUndoBanner();
  }
  await restoreSnapshots([snap]);
}

// 撤销: 使用 active: false 在后台静默恢复被关闭的标签页,
// 坚决不使用 chrome.sessions.restore (后者会强制激活新标签并导致弹窗失焦关闭/页面跳走)。
// 恢复后把标签移回原分组并直查实时数据刷新分组视图。
export async function doUndo() {
  if (!undoStack.length) return;
  const snapshots = undoStack;
  undoStack = [];
  await doUndoRestore(snapshots);
}

// 兑现撤销的公共收尾(全部撤销路径): 清条目/清凭证, 再恢复
async function doUndoRestore(snapshots) {
  clearPushBanners(); // 通知条主动关闭(不等动画)
  clearUndoBatch();   // 已兑现, 跨 popup 的凭证作废
  await restoreSnapshots(snapshots);
}

// 恢复核心: 创建标签 + 归组 + 展开 + 刷新 + 展开动画 + 光标回当前
// (doUndo 全量 / doUndoOne 单条 共用)
async function restoreSnapshots(snapshots) {
  if (!snapshots?.length) return;
  const restoredTabIds = [];
  const newlyCreatedIds = [];
  const groupsToExpand = new Set();
  // 兜底时间戳: 快照缺 lastAccessed 时也不许让恢复的标签顶到全场第一
  const oldestAccess = state.allTabs[state.allTabs.length - 1]?.tab?.lastAccessed || 1;

  for (const snap of snapshots) {
    const t = snap?.tab;
    if (!t?.url) continue; // 防御: 跳过脏/残缺快照

    const createProps = {
      url: t.url,
      active: false,
    };
    if (snap.windowId) createProps.windowId = snap.windowId;
    if (typeof t.index === 'number') createProps.index = t.index;
    if (typeof t.pinned === 'boolean') createProps.pinned = t.pinned;

    let created = null;
    try {
      created = await chrome.tabs.create(createProps);
    } catch {
      // 容错兜底: 若指定 windowId/index 失败(例如原窗口已关或 index 越界), 在当前窗口创建
      try {
        created = await chrome.tabs.create({ url: t.url, active: false });
      } catch (err) {
        console.error('撤销创建标签页失败:', err);
      }
    }

    if (created?.id) {
      restoredTabIds.push({ tabId: created.id, snap });
      newlyCreatedIds.push(created.id);

      // 恢复的标签带回**原始** lastAccessed —— 组内名次与组的相对时间原封不动地复原。
      // 旧版把它压到"不超过本组已有最大值, 否则不超过全场第一"(safeLastAccessed):
      // 那是分组序还从数据推出来的年代留下的补丁, 压一条够用, 压一批就两面崩 ——
      //   ① 同组多条一起恢复时全被压到同一个上限值 ⇒ 组内名次全乱(谁前谁后看运气)
      //   ② 整组被清空(Chrome 已回收该组)时只剩"不超过全场第一"这条,
      //      重建的组一路被压到最底部 ⇒ 撤销后整组跳到列表末尾, 展开动画也在错的地方演
      // 现在分区序由 core/group-order.js 的记账本掌管(组不乱搬家), 这里只要如实还原,
      // 组内次序就与关闭前逐行对齐。缺失时间戳的脏快照才走兜底(垫到列表最旧之后)。
      const restoredAccess = (typeof t.lastAccessed === 'number' && t.lastAccessed > 0)
        ? t.lastAccessed
        : oldestAccess;

      recentlyRestoredTabs.set(created.id, {
        title: t.title || t.url,
        url: t.url,
        favIconUrl: t.favIconUrl || '',
        lastAccessed: restoredAccess,
      });
      if (snap.groupTitle) {
        groupsToExpand.add(`${snap.groupTitle}|${snap.groupColor || 'grey'}`);
      }
    }
  }

  // 10s 后清理临时快照, 防内存泄漏
  if (newlyCreatedIds.length) {
    setTimeout(() => {
      for (const id of newlyCreatedIds) recentlyRestoredTabs.delete(id);
    }, 10000);
  }

  // 补归组: 优先找同名同色组; 若原分组因标签清空已销毁则重建
  await regroupRestored(restoredTabIds);

  // 自动展开目标分组, 避免恢复的标签被原收起状态遮挡
  let collapseChanged = false;
  for (const gKey of groupsToExpand) {
    if (collapsed.has(gKey)) {
      collapsed.delete(gKey);
      collapseChanged = true;
    }
    if (searchCollapsed.has(gKey)) {
      searchCollapsed.delete(gKey);
    }
  }
  if (collapseChanged) saveCollapsed();

  // 强制 forceFresh 直查最新标签/分组, 绕过 background 2s 旧快照缓存
  await actions.refreshData({ forceFresh: true });
  actions.render();

  // 展开动画: 在 render **之后**演 —— 恢复的行是这一帧才建出来的, 从 0 高展开
  // 回自然高度(与删除时的收起同一套参数, 同一行"删掉再撤销"读成同一段倒放)。
  // 不 await: 演不演不影响后面的光标落位; 减弱动效/入场窗口内 expandRows 自己会落位。
  expandRows(restoredTabIds
    .map(({ tabId }) => resultsEl.querySelector(`.tab-item[data-tab-id="${tabId}"]`))
    .filter(Boolean));

  // 保持高亮停留在 [当前tab] (当前激活的标签页), 绝不定位到刚刚 undo 恢复出来的标签
  if (actions.focusCurrentTab) {
    actions.focusCurrentTab();
  }
}

// 把恢复的标签移回原分组: 优先在同窗口找同名同色组; 找不到(组已随关闭销毁)则重建原分组
async function regroupRestored(restored) {
  if (!restored.length) return;
  try {
    const groups = await chrome.tabGroups.query({});
    for (const { tabId, snap } of restored) {
      if (!snap.groupTitle) continue; // 原本就未分组
      let target = groups.find(g =>
        g.windowId === snap.windowId &&
        (g.title || '') === snap.groupTitle &&
        g.color === snap.groupColor
      ) || groups.find(g =>
        (g.title || '') === snap.groupTitle &&
        g.color === snap.groupColor
      );

      if (target) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: target.id }).catch(() => {});
      } else {
        // 原分组已随最后一条标签关闭而自动销毁, 重建同名同色分组
        try {
          const newGroupId = await chrome.tabs.group({
            tabIds: [tabId],
            ...(snap.windowId ? { createProperties: { windowId: snap.windowId } } : {}),
          });
          const updateProps = { title: snap.groupTitle };
          if (snap.groupColor) updateProps.color = snap.groupColor;
          await chrome.tabGroups.update(newGroupId, updateProps);
          groups.push({
            id: newGroupId,
            title: snap.groupTitle,
            color: snap.groupColor,
            windowId: snap.windowId,
          });
        } catch (e) {
          console.error('重建原分组失败:', e);
        }
      }
    }
  } catch (err) {
    console.error('补归组失败:', err);
  }
}

// 关闭栈里全部条目(撤销执行后/清理类操作切换提示时)
export function clearPushBanners() {
  for (const b of [...pushStack.children]) dismissBanner(b);
  clearTimeout(undoTimer);
  undoBannerEl = null; // 叠加条引用一并作废(下次关闭重建)
}
