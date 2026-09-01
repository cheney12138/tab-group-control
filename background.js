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
    const stored = await chrome.storage.local.get('groupRules');
    if (stored && stored.groupRules && Object.keys(stored.groupRules).length) {
      rebuildHostIndex(stored.groupRules);
    } else {
      // 首次运行: 写入默认规则(用户的 Tabbiy 配置迁移)
      await chrome.storage.local.set({ groupRules: DEFAULT_RULES });
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
let switchReady = chrome.storage.local.get('autoGroupEnabled')
  .then((s) => {
    autoGroupEnabled = s?.autoGroupEnabled !== false;
  })
  .catch(() => {}); // 读取失败保持默认开
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoGroupEnabled' in changes) {
    autoGroupEnabled = changes.autoGroupEnabled.newValue !== false;
    switchReady = Promise.resolve(); // onChanged 已是最新的,无需再等
    console.log('[TGS] 自动分组:', autoGroupEnabled ? '开启' : '关闭');
  }
});

async function autoGroupTab(tab) {
  await switchReady; // 确保 storage 状态已加载(worker 冷启动竞态)
  if (!autoGroupEnabled) return;
  if (!tab || !tab.url || tab.url.startsWith('chrome')) return;
  // 命中规则 → 规则组;未命中 → Others 兜底组(自动分组开启时所有标签都归组,
  // 未匹配域名不再散落在未分组——"Others"是固定的,暂不支持自定义)
  const groupName = matchGroup(tab.url) || 'Others';
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

// 启动/安装时: 批量归组存量标签(一次性,逐个归组复用上面的组逻辑)。
// 未命中规则的散标签也归入 Others(与事件路径一致);已在组里的不动(尊重手动分组)
async function groupExistingTabs() {
  await switchReady;
  if (!autoGroupEnabled) return;
  try {
    const tabs = await chrome.tabs.query({});
    let grouped = 0;
    for (const tab of tabs) {
      // 已在组里的不动(尊重手动分组)
      if (tab.groupId && tab.groupId !== -1) continue;
      // chrome:// 等内部页面 autoGroupTab 内部会跳过,此处不重复判断
      await autoGroupTab(tab);
      grouped += 1;
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

function trackRecentTab(tabId) {
  // 从栈中移除该 id(避免重复),再压到已活跃端
  recentTabIds = recentTabIds.filter(id => id !== tabId);
  recentTabIds.unshift(tabId);
  if (recentTabIds.length > MAX_RECENT) recentTabIds.length = MAX_RECENT;
}

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
      // 标签已关闭,从栈里移除,继续往后找
      recentTabIds.splice(targetIdx, 1);
    }
  }
}
chrome.tabs.onRemoved.addListener(refreshSnapshot);
chrome.windows.onFocusChanged.addListener(refreshSnapshot);

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
// 安装/更新: 规则重载(用户可能在设置面板改过 storage,storage 变化自动生效)
chrome.runtime.onInstalled.addListener(() => {
  loadRules().then(groupExistingTabs);
});
// 规则变更(popup 设置面板写入 storage)时重建索引
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.groupRules) {
    rebuildHostIndex(changes.groupRules.newValue);
    console.log('[TGS] 分组规则已更新');
  }
});

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
