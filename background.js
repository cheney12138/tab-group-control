// Tab Group Search 的 background:
// 1. worker 保活(QuicKey 原理): tabs/windows 事件持续重置休眠计时器
// 2. 标签快照: popup 即读即渲染
// 3. 自动分组(替代 Tabbiy): 域名规则 → 组,事件驱动 + 启动时批量归组存量
// 4. 分组整理: 同名合并 + 空组清理(唤起时触发)

// ---- 自动分组: 规则 ----
// 格式(从 Tabbiy 迁移): { 组名: [域名...], ... },域名精确匹配 host。
// 存储 chrome.storage.local,支持 popup 侧编辑(后续加设置面板)
const DEFAULT_RULES = {
  "octo": ["octo.mws.sankuai.com", "octo.mws-test.sankuai.com"],
  "raptor": ["raptor.mws.sankuai.com", "raptor-st.mws.sankuai.com", "raptor.mws-test.sankuai.com"],
  "学城": ["km.sankuai.com"],
  "测试": ["qahome.sankuai.com", "appmock.sankuai.com", "qa.train.st.sankuai.com", "mock.train.test.meituan.com"],
  "LLM": ["bailian.console.aliyun.com", "gemini.google.com", "aigc.sankuai.com", "lingguang.com", "qianwen.com", "claude.ai", "kimi.com", "chatgpt.com", "chat.deepseek.com"],
  "ones": ["ones.sankuai.com"],
  "lion": ["lion.mws.sankuai.com", "lion.mws-test.sankuai.com"],
  "codedev": ["dev.sankuai.com"],
  "雷达": ["radar.mws.sankuai.com"],
  "BCP": ["bcp.sankuai.com", "bcp.inf.test.sankuai.com", "mole.vip.sankuai.com"],
  "RDS": ["rds.mws.sankuai.com", "rds.mws-test.sankuai.com", "dms.mws.sankuai.com"],
  "arena": ["arena.sankuai.com", "arena.giant.test.sankuai.com", "arena.adp.st.sankuai.com"],
  "tbms": ["tbms-train.sankuai.com"],
  "fedo": ["fedo.sankuai.com"],
  "xproduct": ["awp.vip.meituan.com"],
  "tbms-test": ["train.tbms.inf.test.sankuai.com", "tbms.inf.train.st.meituan.com"],
};

// host → 组名 的倒排索引(规则加载时构建,匹配 O(1))
let hostIndex = new Map();

function rebuildHostIndex(rules) {
  hostIndex = new Map();
  for (const [groupName, hosts] of Object.entries(rules || {})) {
    for (const h of hosts) {
      hostIndex.set(h.replace(/\/+$/, ''), groupName);
    }
  }
}

async function loadRules() {
  try {
    // groupRulesInit 标记"写入过规则":空规则集是合法状态(用户删光了),
    // 不能再用"空 = 首次运行"启发式——否则清空后重启会被默认规则复活
    const stored = await chrome.storage.local.get(['groupRules', 'groupRulesInit']);
    if (stored?.groupRulesInit) {
      rebuildHostIndex(stored.groupRules || {});
    } else {
      // 首次运行: 写入默认规则(用户的 Tabbiy 配置迁移)并落标记
      await chrome.storage.local.set({ groupRules: DEFAULT_RULES, groupRulesInit: true });
      rebuildHostIndex(DEFAULT_RULES);
    }
  } catch (e) {
    console.error('加载分组规则失败:', e);
    rebuildHostIndex(DEFAULT_RULES);
  }
}

function matchGroup(url) {
  try {
    const host = new URL(url).host;
    return hostIndex.get(host) || null;
  } catch (e) {
    return null; // about:blank 等非标准 URL
  }
}

// Chrome 9 色轮转,新组按组名 hash 选色保证同名组颜色稳定
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
function colorForGroup(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

// 归组: 找同名现有组 → 有则并入,无则新建(带规则色)。
// 按窗口隔离(组不可跨窗口),在目标 tab 所在窗口找。
// 总开关: storage.autoGroupEnabled(false 时完全不归组,默认开)。
// 状态就绪 Promise: worker 冷启动时 storage 读取是异步的,事件若在读取完成前
// 到达会读到默认值 true(曾导致"关了开关仍归组")——归组前 await 就绪标记
let autoGroupEnabled = true;
// Others 兜底开关: 未命中规则的散标签是否归入 Others 组。
// 关闭时规则只管命中的域名,其余标签保持散着(可选配置,默认开保持旧行为)
let othersEnabled = true;
let switchReady = chrome.storage.local.get(['autoGroupEnabled', 'othersGroupEnabled'])
  .then((s) => {
    autoGroupEnabled = s?.autoGroupEnabled !== false;
    othersEnabled = s?.othersGroupEnabled !== false;
  })
  .catch(() => {}); // 读取失败保持默认开
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoGroupEnabled' in changes) {
    autoGroupEnabled = changes.autoGroupEnabled.newValue !== false;
    switchReady = Promise.resolve(); // onChanged 已是最新的,无需再等
    console.log('[TGS] 自动分组:', autoGroupEnabled ? '开启' : '关闭');
  }
  if (area === 'local' && 'othersGroupEnabled' in changes) {
    othersEnabled = changes.othersGroupEnabled.newValue !== false;
    console.log('[TGS] Others 兜底:', othersEnabled ? '开启' : '关闭');
    // 开关即时生效: 开 → 散标签收进 Others;关 → 存量 Others 组解散。
    // 挂 onChanged(浏览器投递,worker 活着必达),不依赖 popup 消息
    if (othersEnabled) {
      groupExistingTabs();
    } else {
      ungroupAllOthersGroups();
    }
  }
});

async function autoGroupTab(tab) {
  await switchReady; // 确保 storage 状态已加载(worker 冷启动竞态)
  if (!autoGroupEnabled) return;
  if (!tab || !tab.url || tab.url.startsWith('chrome')) return;
  // 命中规则 → 规则组;未命中 → Others 兜底组(可配置: othersGroupEnabled
  // 关闭时未命中域名保持散着,规则只管命中的)
  const hit = matchGroup(tab.url);
  if (!hit && !othersEnabled) return;
  const groupName = hit || 'Others';
  try {
    // 已在同名组里则跳过(避免 onUpdated 反复触发时抖动)
    if (tab.groupId && tab.groupId !== -1) {
      const current = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      if (current && current.title === groupName) return;
    }
    // 同窗口找同名组
    const existing = await chrome.tabGroups.query({ title: groupName, windowId: tab.windowId });
    if (existing.length) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: existing[0].id });
    } else {
      const newGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(newGroupId, {
        title: groupName, color: colorForGroup(groupName),
      });
    }
  } catch (e) {
    console.error(`归组失败(${groupName}):`, e);
  }
}

// 启动/安装/规则保存时: 批量归组存量标签。
// 规则优先: 命中规则的标签无论当前在哪个组(含 Others/旧规则组)都迁入规则组——
// "已在组里"只代表历史状态,不代表用户意志(全自动管理场景没有手动分组)。
// 未命中规则的: 散着的归入 Others 兜底,已在其他组里的不动(避免规则外乱迁)
async function groupExistingTabs() {
  await switchReady;
  if (!autoGroupEnabled) return;
  try {
    // 先从 storage 重读规则重建索引——归组消息可能与 storage.onChanged
    // (重建索引)竞态:消息先到时用的还是旧索引,新保存的规则对存量不生效。
    // 这里自读自建,不依赖外部时序
    const stored = await chrome.storage.local.get('groupRules');
    if (stored?.groupRules) rebuildHostIndex(stored.groupRules);
    const tabs = await chrome.tabs.query({});
    let grouped = 0;
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome')) continue;
      const hit = matchGroup(tab.url);
      if (hit) {
        // 命中规则: 任何状态都归入规则组(autoGroupTab 内部会跳过已在同名组的)
        await autoGroupTab(tab);
        grouped += 1;
      } else if (tab.groupId === -1 || !tab.groupId) {
        // 未命中且散着: Others 兜底
        await autoGroupTab(tab);
        grouped += 1;
      }
      // 未命中且已在某组: 不动
    }
    if (grouped > 0) console.log(`[TGS] 存量归组: ${grouped} 个标签`);
    refreshSnapshot();
  } catch (e) {
    console.error('存量归组失败:', e);
  }
}

// ---- worker 保活 + 快照(原有) ----
let tabSnapshot = null;

function refreshSnapshot() {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    tabSnapshot = { tabs, ts: Date.now() };
    chrome.tabGroups.query({}, (groups) => {
      if (chrome.runtime.lastError) return;
      tabSnapshot.groups = groups;
    });
  });
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  refreshSnapshot();
  trackRecentTab(activeInfo.tabId);
  foldOtherGroups(activeInfo.tabId);
});

// ---- Chrome 标签栏分组自动折叠 ----
// 切换标签时: 当前标签所在的组保持展开,同窗口其他组全部折叠。
// 标签栏不再"全部展开太乱"——永远只有正在用的组是开的。
// 检查 tabGroups.onUpdated 用户手动展开的时序成本高,不做冲突处理:
// 用户手动展开某组 → 切走标签时会被再次折叠(这是"自动管理"的语义,
// Tabbiy 同类功能亦如此)。要临时看别的组就点开,切走自动收
let foldingBusy = false;
async function foldOtherGroups(activeTabId) {
  if (foldingBusy) return; // onActivated 高频触发,防重入
  foldingBusy = true;
  try {
    const tab = await chrome.tabs.get(activeTabId).catch(() => null);
    if (!tab) return;
    // 仅折叠当前窗口的组(其他窗口不动)
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
    const activeGroupId = tab.groupId !== -1 ? tab.groupId : null;
    for (const g of groups) {
      if (g.id === activeGroupId) continue;
      if (!g.collapsed) {
        await chrome.tabGroups.update(g.id, { collapsed: true }).catch(() => {});
      }
    }
  } catch (e) {
    // 静默: 折叠失败不影响任何功能
  } finally {
    foldingBusy = false;
  }
}

// ---- 返回上一个标签(MRU 栈) ----
// onActivated 每次标签切换时压栈;快捷键触发时跳到栈顶(上一个使用的标签)。
// 跳转本身也会触发 onActivated(新条目入栈),所以 A→B→快捷键→A→快捷键→B
// 天然形成互跳循环——与 Tabbiy 的 "recent tab" 行为一致
let recentTabIds = []; // 最近使用的 tabId 序列,[0] 是上一个(最新的已切走)
const MAX_RECENT = 30;

// 防抖: 一次跨窗口跳转会连发两个事件——onFocusChanged(此时 tabs.update
// 可能尚未生效,query 到的是目标窗口的旧 active)和 onActivated(时序最准)。
// 只认最后一次,避免旧 active 被错误提升到栈顶污染 MRU 顺序
let trackTimer = null;
function trackRecentTab(tabId) {
  if (trackTimer) clearTimeout(trackTimer);
  trackTimer = setTimeout(() => {
    trackTimer = null;
    // 从栈中移除该 id(避免重复),再压到已活跃端
    recentTabIds = recentTabIds.filter(id => id !== tabId);
    recentTabIds.unshift(tabId);
    if (recentTabIds.length > MAX_RECENT) recentTabIds.length = MAX_RECENT;
    // 持久化到 storage.session(worker 被杀后 MRU 不丢,
    // 否则重启空栈→⌥E 空转——两台机器都复现的根因)
    chrome.storage.session.set({ recentTabs: recentTabIds }).catch(() => {});
  }, 150);
}

// worker 冷启动: 恢复上次会话的 MRU 栈
chrome.storage.session.get('recentTabs').then((s) => {
  if (Array.isArray(s?.recentTabs)) {
    recentTabIds = s.recentTabs.filter(id => Number.isInteger(id));
    console.log(`[TGS] MRU 栈已恢复: ${recentTabIds.length} 条`);
  }
}).catch(() => {});

async function gotoPreviousTab() {
  // 栈顶(最新)是当前标签,跳到 [1];若 [1] 不存在(刚启动只有一次切换)则跳 [0]
  let targetIdx = recentTabIds.length > 1 ? 1 : 0;
  // 目标标签可能已被关闭,循环往后找第一个还活着的
  while (targetIdx < recentTabIds.length) {
    const targetId = recentTabIds[targetIdx];
    try {
      const tab = await chrome.tabs.get(targetId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(targetId, { active: true });
      return; // 激活成功(trackRecentTab 会被 onActivated 重新压栈)
    } catch (e) {
      // 标签已关闭,从栈里移除,继续往后找(同步持久化,防死 id 复活)
      recentTabIds.splice(targetIdx, 1);
      chrome.storage.session.set({ recentTabs: recentTabIds }).catch(() => {});
    }
  }
}
chrome.tabs.onRemoved.addListener(refreshSnapshot);
// 切换窗口不触发 tabs.onActivated——这里补压 MRU 栈,否则窗口间的
// 来回切换全不进栈,⌥E 互跳会跳过它们(多窗口下"失灵"的主因)。
// WINDOW_ID_NONE = 所有窗口失焦(切去了别的 app),不压
chrome.windows.onFocusChanged.addListener((windowId) => {
  refreshSnapshot();
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    if (!chrome.runtime.lastError && tabs?.length) trackRecentTab(tabs[0].id);
  });
});
// tab 被 Chrome 自动丢弃(discard,内存紧张时后台 tab 会发生)时 id 会
// 重新分配——栈里原位换新 id,否则留死 id,⌥E 会跳到比预期更早的标签
chrome.tabs.onReplaced.addListener((newTabId, oldTabId) => {
  const idx = recentTabIds.indexOf(oldTabId);
  if (idx > -1) {
    recentTabIds[idx] = newTabId;
    chrome.storage.session.set({ recentTabs: recentTabIds }).catch(() => {});
  }
});

// onCreated/onUpdated: 保活 + 自动归组(新标签/页面跳转到规则域名)
chrome.tabs.onCreated.addListener((tab) => {
  refreshSnapshot();
  autoGroupTab(tab); // 新建时 url 可能还未就绪,onUpdated 的 url 变化会兜底
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title || changeInfo.url) refreshSnapshot();
  if (changeInfo.url) autoGroupTab(tab); // 导航到新域名时归组
});

// worker 冷启动: 加载规则 → 快照 → 存量归组(跳过已在组里的)
loadRules().then(() => {
  refreshSnapshot();
  groupExistingTabs();
});
// Chrome 启动: 预热快照(MRU 栈在下方冷启动恢复)。
// worker 本身随 Chrome 拉起,不需要"唤醒";但启动期磁盘忙,
// 首次 tabs.query 可能拿到"恢复中"的中间态(标题/图标未定型)。
// 延迟 2s 再刷一次快照,等会话恢复基本完成后用最终态覆盖,
// 弹窗首唤起时快照即新鲜
chrome.runtime.onStartup.addListener(() => {
  setTimeout(refreshSnapshot, 2000);
});
// 安装/更新: 规则重载(用户可能在设置面板改过 storage,storage 变化自动生效)
chrome.runtime.onInstalled.addListener(() => {
  loadRules().then(groupExistingTabs);
});
// 规则变更(popup 设置面板写入 storage)时: 重建索引 + 立即存量归组。
// 之前只重建索引、依赖 popup 发 group-existing 消息触发归组——但 worker
// 休眠时消息会直接丢失(receiving end not exist),且 storage 写入不依赖
// worker,导致"规则保存成功但存量永远不归"。onChanged 由浏览器投递,
// worker 活着时必达,归组挂在这里才是可靠路径
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.groupRules) {
    const oldRules = changes.groupRules.oldValue || {};
    const newRules = changes.groupRules.newValue || {};
    rebuildHostIndex(newRules);
    console.log('[TGS] 分组规则已更新,触发存量归组');
    // 串行链: 清理规则删除的遗留(被删的组、被移出的域名 → Others)
    // → 存量归组(新规则命中的迁入) → 整理(收掉搬空的旧组)。
    // 清理与归组处理的集合不相交,但整理必须等清理完成才能看到空组
    cleanupRemovedRules(oldRules, newRules)
      .then(() => groupExistingTabs())
      .then(() => tidyGroups());
  }
});

// ---- 规则删除的遗留清理 ----
// "编辑完分组之后,规则和分组没有消失"的核心根因: 归组逻辑单向(只拉进
// 不踢出),删掉规则后旧 Chrome 组原封不动。这里用变更前后差集反向清理:
//   1. 组名被删(old 有 new 无)→ 组内标签全部迁入 Others
//   2. 域名被移出某组(组还在)→ 该域名的标签不再命中任何规则,
//      若当前组名是被编辑过的规则组名 → 迁入 Others
// 保护: 只清理"当前组名在 old 规则组名集合里"的标签——用户手动建的组
// (组名不在规则里)不动。且只挂在规则变更路径,不进启动路径,避免每次
// 重启都拆手动组
async function cleanupRemovedRules(oldRules, newRules) {
  await switchReady;
  if (!autoGroupEnabled) return;
  try {
    // 差集: old 里有、new 里没有/已移出的 host → 所属标签应离开旧组
    const removedHosts = new Map(); // host → 旧组名
    for (const [name, hosts] of Object.entries(oldRules)) {
      for (const h of hosts) {
        removedHosts.set(String(h).replace(/\/+$/, ''), name);
      }
    }
    for (const [name, hosts] of Object.entries(newRules)) {
      for (const h of hosts) {
        removedHosts.delete(String(h).replace(/\/+$/, ''));
      }
    }
    if (!removedHosts.size) return;
    // 旧规则组名集合(重命名也算"删旧组":旧名组里的标签若域名仍命中
    // 新规则会被 groupExistingTabs 迁走,这里只负责没被迁走的部分)
    const oldGroupNames = new Set(Object.keys(oldRules));

    const tabs = await chrome.tabs.query({});
    let moved = 0;
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome')) continue;
      if (tab.groupId === -1 || !tab.groupId) continue; // 散标签没有遗留
      let host;
      try { host = new URL(tab.url).host; } catch { continue; }
      if (!removedHosts.has(host)) continue;
      // 当前组名须是被编辑过的规则组(手动组不动)
      const current = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      if (!current || !oldGroupNames.has(current.title)) continue;
      await moveTabFromRemovedRule(tab, current.title);
      moved += 1;
    }
    if (moved > 0) console.log(`[TGS] 规则删除清理: ${moved} 个标签迁入 Others`);
  } catch (e) {
    console.error('规则删除清理失败:', e);
  }
}

// 规则删除后标签去向: Others 兜底开 → 迁入所在窗口的 Others 组(没有则新建);
// 关 → 解散成散标签。旧组搬空后由 tidyGroups 收尸
async function moveTabFromRemovedRule(tab, fromTitle) {
  try {
    if (!othersEnabled) {
      await chrome.tabs.ungroup(tab.id);
      return;
    }
    const existing = await chrome.tabGroups.query({ title: 'Others', windowId: tab.windowId });
    if (existing.length) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: existing[0].id });
    } else {
      const newGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(newGroupId, { title: 'Others', color: colorForGroup('Others') });
    }
  } catch (e) {
    console.error(`规则删除后迁移失败(${fromTitle}):`, e);
  }
}

// 解散所有窗口的 Others 兜底组(兜底开关关闭时): 组内标签退回未分组,
// 组随最后一个标签移出自动删除。"Others"是扩展保留组名(不支持自定义),
// 解散不会碰用户手动建的规则组
async function ungroupAllOthersGroups() {
  try {
    const groups = await chrome.tabGroups.query({ title: 'Others' });
    if (!groups.length) return;
    const groupIds = new Set(groups.map(g => g.id));
    const tabs = await chrome.tabs.query({});
    const memberIds = tabs.filter(t => groupIds.has(t.groupId)).map(t => t.id);
    if (memberIds.length) {
      await chrome.tabs.ungroup(memberIds);
      console.log(`[TGS] Others 兜底关闭: 解散 ${memberIds.length} 个标签`);
    }
    refreshSnapshot();
  } catch (e) {
    console.error('解散 Others 组失败:', e);
  }
}

// 快捷键命令: 返回上一个标签(A/B 互跳)
chrome.commands.onCommand.addListener((command) => {
  if (command === 'previous-tab') {
    gotoPreviousTab().catch(e => console.error('返回上一标签失败:', e));
  }
});

// popup 消息: 快照 / 整理触发
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'get-snapshot') {
    const fresh = tabSnapshot && (Date.now() - tabSnapshot.ts < 2000)
      ? tabSnapshot : null;
    sendResponse({ snapshot: fresh });
    return;
  }
  if (msg?.type === 'tidy-groups') {
    tidyGroups();
    sendResponse({ ok: true });
  }
  if (msg?.type === 'group-existing') {
    // 存量归组(把未分组的散标签按规则+Others兜底收进组),
    // 完成后顺带跑一次整理(合并可能产生的同名组)
    groupExistingTabs().then(() => tidyGroups());
    sendResponse({ ok: true });
  }
});

// ---- 分组整理: 同名合并 + 空组清理 ----
let tidying = false;
async function tidyGroups() {
  if (tidying) return;
  tidying = true;
  try {
    const [groups, tabs] = await Promise.all([
      chrome.tabGroups.query({}),
      chrome.tabs.query({}),
    ]);
    if (!groups.length) return;

    const byWindow = new Map();
    for (const g of groups) {
      if (!byWindow.has(g.windowId)) byWindow.set(g.windowId, []);
      byWindow.get(g.windowId).push(g);
    }

    let tabsMoved = 0;
    const emptyGroups = [];

    for (const [windowId, winGroups] of byWindow) {
      const sameName = new Map();
      for (const g of winGroups) {
        const key = g.title || '';
        if (!sameName.has(key)) {
          sameName.set(key, g);
        } else {
          const members = tabs.filter(t => t.groupId === g.id);
          if (members.length) {
            try {
              await chrome.tabs.group({
                tabIds: members.map(t => t.id),
                groupId: sameName.get(key).id,
              });
              tabsMoved += members.length;
            } catch (e) {
              console.error('合并分组失败:', g.title, e);
            }
          }
          emptyGroups.push(g);
        }
      }
      for (const g of winGroups) {
        const has = tabs.some(t => t.groupId === g.id);
        if (!has && !emptyGroups.find(x => x.id === g.id)) {
          emptyGroups.push(g);
        }
      }
    }

    let removed = 0;
    for (const g of emptyGroups) {
      try {
        const [tmp] = await chrome.tabs.create({
          url: 'about:blank', active: false, windowId: g.windowId,
        });
        await chrome.tabs.group({ tabIds: [tmp.id], groupId: g.id });
        await chrome.tabs.remove(tmp.id);
        removed += 1;
      } catch (e) { /* 组可能已被合并顺带删除 */ }
    }

    if (tabsMoved > 0 || removed > 0) {
      console.log(`[TGS] 分组整理: 合并 ${tabsMoved} 个标签, 删除 ${removed} 个空组`);
      refreshSnapshot();
    }
  } catch (e) {
    console.error('分组整理失败:', e);
  } finally {
    tidying = false;
  }
}
