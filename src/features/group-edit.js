// features/group-edit.js: 分组编辑卡(建组 / 改名改色 / 解散) —— 手动给标签一个"身份"
//
// 定位(ADR-0002): 管理能力只作用于有分组身份的对象, 而"身份"此前只由规则引擎发。
// 本模块补上**手动**的那一半: 给一批散标签起个名(建组)、改这个名字/颜色、
// 或者把身份还回去(解散)。未分组散标签照样不参与归档 —— 建组不是"管理散标签",
// 而是"先给它一个身份", 与 ADR-0002 的门槛同一句话。
//
// 为什么是"卡片"而不是就地改: 右键菜单是纯文字条目, 且**故意不夺焦点**
// (搜索框恒持焦, 见 contextmenu.js); 而改名需要一个真能收键盘的输入框(还得过中文输入法)。
// 所以菜单只放入口, 输入收进一张卡片。
// 为什么改名与改色合成一张卡: 这是 Chrome 原生分组编辑器的形态(名字+颜色一起改),
// 用户已经会这一套, 也少一个入口。
//
// 键盘归属: 卡片自己吃掉全部按键(stopPropagation) —— 否则焦点一旦落到色块按钮上,
// ↑↓/Tab/Enter 就会穿透到后面的列表去导航(面板的全局路由在 document 上)。
// 例外: 中文输入法组合中的按键一律放行(见 openCard 里的 keydown), 回车要留给输入法上屏。
// 遮罩点击也 preventDefault 保持输入框持焦, 与菜单同一条理由。
//
// 两条契约边界(判定与执行都在 background 的 renameOrRecolorGroup, 这里只呈现):
//   ① 目标名撞车 ⇒ **拒绝**并就地报错 —— 改名不是合并, 静默并组会让用户以为只换了个
//      名字, 实际整组标签被搬走;
//   ② 规则组的名字是规则键 ⇒ 提供「同时重命名域名规则」(默认勾)。不勾即与规则脱钩,
//      下次自动分组会照旧建一个旧名组(重复组的经典来源)。
//
// 颜色一律取主题资产表(groupColors), 与分组头/归档卡共用同一份 9 色映射 ——
// 这里不准再写一套色值(ADR-0003)。

import { showToast } from '../core/dom.js';
import { themeAssets } from '../core/colors.js';
import { escapeHtml, groupKey } from '../core/format.js';

let actions = null; // initGroupEdit 注入: { refreshData, render, focusInput, getAllTabs, remapGroupKey }
let layer = null;

// Chrome 九色 + 中文名(顺序即 Chrome 调色板顺序)
const COLOR_ORDER = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const COLOR_LABEL = {
  grey: '灰', blue: '蓝', red: '红', yellow: '黄', green: '绿',
  pink: '粉', purple: '紫', cyan: '青', orange: '橙',
};

export function isGroupEditOpen() { return !!layer; }

export function closeGroupEdit() {
  if (!layer) return;
  layer.remove();
  layer = null;
  actions?.focusInput?.(); // 归还架构约定: 搜索框恒持焦
}

// 规则键集合(建组/改名都要知道"这个名字是不是规则组的")。storage 是唯一真源,
// background 的 currentRuleGroupNames 也是从它重建的
async function loadRuleNames() {
  try {
    const s = await chrome.storage.local.get('groupRules');
    return new Set(Object.keys(s?.groupRules || {}));
  } catch (e) {
    return new Set();
  }
}

// 与 background 通信的统一入口。**必须把"后台说不行"和"后台根本没答"分开** ——
// 病例(2026-09-23, 用户截图): 改完 background.js 没重载扩展, 弹窗文件是每次打开即读磁盘
// (新卡片照常出现), 而 service worker 还在跑旧代码 —— 旧后台没有 create-group 分支
// ⇒ 无人 sendResponse ⇒ sendMessage 竟然**resolve undefined**(不是 reject!)
// ⇒ 掉进 `|| '建组失败'` 这种兜底文案。症状是干干净净四个字"建组失败", 完全指不到病根。
// 这里把它翻成一句能照着做的话。
// 注: 不在这里做"直调建组"的兜底 —— 建组必须过 background 队列, popup 直调会与
// autoGroupTab 双 query 双 miss 各建一个组(ADR-0007)。宁可不做, 不能做错。
async function sendToBackground(msg) {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { ok: false, error: `与后台通信失败(${e?.message || e})` };
  }
  if (!resp || typeof resp !== 'object') {
    return {
      ok: false,
      error: '后台没有响应。请在 chrome://extensions 点「重新加载」——'
        + '改过 background.js 之后必须重载(弹窗文件是即读的, 所以新界面会出现、新消息却没人接)',
    };
  }
  return resp;
}

// 卡片骨架。cfg: { heading, sub, name, color, ruleTip, showRuleCheck, showMergeHint }
function buildCard(cfg) {
  const assets = themeAssets();
  const el = document.createElement('div');
  el.className = 'ge-layer';
  const swatches = COLOR_ORDER.map((c) => {
    const hex = assets.groupColors[c] || assets.groupColors.grey;
    return `<button type="button" class="ge-swatch${c === cfg.color ? ' active' : ''}"`
      + ` data-color="${c}" tabindex="-1" title="${COLOR_LABEL[c] || c}"`
      + ` style="--sw:${hex}"></button>`;
  }).join('');
  el.innerHTML = `
    <div class="ge-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(cfg.heading)}">
      <div class="ge-head">${escapeHtml(cfg.heading)}</div>
      ${cfg.sub ? `<div class="ge-sub">${escapeHtml(cfg.sub)}</div>` : ''}
      <input class="ge-input" type="text" maxlength="60" autocomplete="off"
             autocorrect="off" autocapitalize="none" spellcheck="false"
             placeholder="分组名称" value="${escapeHtml(cfg.name || '')}">
      <div class="ge-swatches">${swatches}</div>
      <div class="ge-hint"></div>
      ${cfg.showRuleCheck ? `
        <div class="ge-ruletip">「${escapeHtml(cfg.name || '')}」是域名规则组。不改规则名的话，规则会与新名字脱钩 —— 以后出现该域名的标签会重新建一个「${escapeHtml(cfg.name || '')}」组。</div>
        <label class="ge-check"><input type="checkbox" class="ge-rule-check" checked>
          <span>同时重命名域名规则</span></label>` : ''}
      <div class="ge-error" role="alert"></div>
      <div class="ge-actions">
        <button type="button" class="ge-cancel">取消</button>
        <button type="button" class="ge-ok">确定</button>
      </div>
    </div>`;
  return el;
}

// 打开卡片(所有入口共用): cfg 见 buildCard, onSubmit(name, color, ruleCheck) => Promise<string|null>
// 返回错误文案则留在卡内报错, 返回 null 视为成功(调用方自己关)
async function openCard(cfg, onSubmit) {
  closeGroupEdit();
  const ruleNames = await loadRuleNames();
  let color = cfg.color || 'grey';
  const el = buildCard(cfg);
  layer = el;
  document.body.appendChild(el);

  const card = el.querySelector('.ge-card');
  const inputEl = el.querySelector('.ge-input');
  const errEl = el.querySelector('.ge-error');
  const ruleCheck = el.querySelector('.ge-rule-check');
  const hintEl = el.querySelector('.ge-hint');

  // 名称与规则键的实时对照: **只在建组卡**上提示"会并入已有规则组" ——
  // 免得用户以为新建了一个新组。编辑卡不挂它: 那里名字本来就该是它自己的
  // (规则组的当前名就是规则键, 挂上去会读成"确定后要并入自己", 纯噪声)
  // 同时把上一次的报错**实时**抹掉: 报错描述的是"上一次那个名字", 用户一改就不再成立; 
  // 留在屏幕上就等于拿旧结论回话(病例: 截图里"fedo"与「分组名不能为空」同时出现 ——
  // 那个报错是空名那一下留下的, 打字并不清它)
  const refreshHint = () => {
    if (errEl.textContent) errEl.textContent = '';
    if (!hintEl || !cfg.showMergeHint) return;
    const name = inputEl.value.trim();
    hintEl.textContent = name && ruleNames.has(name) ? '已有同名规则组，确定后会并入它' : '';
  };
  inputEl.addEventListener('input', refreshHint);
  refreshHint();

  el.querySelectorAll('.ge-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      color = btn.dataset.color;
      el.querySelectorAll('.ge-swatch').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  // 遮罩/卡片空白处按下: 不让焦点离开输入框(与右键菜单同一条防线)
  el.addEventListener('mousedown', (e) => {
    if (e.target !== inputEl) e.preventDefault();
  });
  // 遮罩点击 = 取消(点卡片内部不算)
  el.addEventListener('click', (e) => { if (e.target === el) closeGroupEdit(); });
  el.querySelector('.ge-cancel').addEventListener('click', () => closeGroupEdit());

  let busy = false;
  const submit = async () => {
    if (busy) return;
    const name = inputEl.value.trim();
    if (!name) {
      errEl.textContent = '分组名不能为空';
      inputEl.focus();
      return;
    }
    busy = true;
    errEl.textContent = '';
    const err = await onSubmit(name, color, ruleCheck ? ruleCheck.checked : false);
    busy = false;
    if (err) {
      errEl.textContent = err;
      inputEl.focus();
      return;
    }
    closeGroupEdit();
  };
  el.querySelector('.ge-ok').addEventListener('click', submit);

  // 键盘全归卡片: Enter 确定 / Esc 取消, 其余一律不让穿透(见文件头"键盘归属")
  card.addEventListener('keydown', (e) => {
    // 中文输入法组合中(拼音未上屏)的按键全部让位给输入法 —— 回车是"拼音串上屏",
    // 不是"确定"。这条已在 main.js 的全局键盘路由里写过一次(那里还配了 keyCode 229
    // 双保险), 卡片自己吃的键也必须过同一道门:
    //   病例(2026-09-23, 用户截图): 输完拼音直接回车 ⇒ 被当成确定 ⇒ 某些输入法
    //   此刻 value 还是空的 ⇒ 报「分组名不能为空」, 而屏幕上看得到那个拼音串。
    // 实测(CDP Input.imeSetComposition)该回车确实带 isComposing = true。
    // 不 preventDefault 也不 stopPropagation: 让输入法照常上屏, 让 main 的正常处理
    // (它自己也会在 isComposing 时提前 return)
    if (e.isComposing || e.keyCode === 229) return;
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeGroupEdit();
    }
  });

  inputEl.focus();
  inputEl.select();
}

// 建组入口(标签行右键)。tabIds = 这一**行**的成员(代表 + 同组副本, ADR-0005 行语义),
// windowId 必传: 组不可跨窗口, 建组必须落在该标签所在窗口
export async function openNewGroupCard({ tabIds, windowId, rowTitle }) {
  const sub = rowTitle ? `把「${rowTitle}」${tabIds.length > 1 ? `等 ${tabIds.length} 个标签` : ''}放进新分组` : '';
  await openCard({
    heading: '新建分组',
    sub,
    name: '',
    color: 'blue',
    showMergeHint: true,
  }, async (name, color) => {
    const resp = await sendToBackground({
      type: 'create-group', title: name, color, tabIds, windowId,
    });
    if (!resp.ok) return resp.error || '建组失败';
    showToast(resp.merged ? `已并入同名分组「${name}」` : `已新建分组「${name}」`);
    await actions.refreshData({ forceFresh: true });
    actions.render();
    return null;
  });
}

// 编辑入口(组头右键)。group 是运行时分组实例(title/color/id/windowId 都要用)
export async function openEditGroupCard(group) {
  if (!group || !group.id) return;
  const ruleNames = await loadRuleNames();
  const isRuleGroup = !!group.title && ruleNames.has(group.title);

  await openCard({
    heading: '编辑分组',
    sub: '改名 / 改颜色',
    name: group.title || '',
    color: group.color || 'grey',
    showRuleCheck: isRuleGroup,
  }, async (name, color, renameRule) => {
    const resp = await sendToBackground({
      type: 'edit-group', groupId: group.id, title: name, color, renameRule,
    });
    if (!resp.ok) {
      return resp.error === 'dup' ? `本窗口已有同名分组「${name}」` : (resp.error || '修改失败');
    }
    // 分组身份 = 组名 + 颜色(groupKey): 身份变了, 收起记忆的键也要跟着搬 ——
    // 否则"收起着的组改个名就自己弹开了"(身份变了, 旧键再也匹配不上)。
    // 键必须用 groupKey() 生成, 不自己拼 —— 未命名组的键是 '(未命名)' 不是 ''
    const oldKey = groupKey(group);
    const newKey = groupKey({ title: name, color });
    if (newKey !== oldKey) actions.remapGroupKey?.(oldKey, newKey);
    const renamed = name !== (group.title || '');
    showToast(resp.ruleRenamed
      ? `已重命名为「${name}」并同步规则名`
      : (renamed ? `已重命名为「${name}」` : '已更新分组颜色'));
    await actions.refreshData({ forceFresh: true });
    actions.render();
    return null;
  });
}

// 解散分组(组头右键): 成员退回未分组, 空组由 Chrome 回收。不关任何标签 ——
// 它不是破坏性动作, 但会丢掉这个"身份", 所以在菜单里与编辑分组并列、不与关闭类混色。
// 组名是规则键时提醒一句: 规则还在, 新标签会另建一个同名组
export async function dissolveGroupAction(group) {
  if (!group || !group.id) return;
  const resp = await sendToBackground({ type: 'dissolve-group', groupId: group.id });
  if (!resp.ok) {
    showToast(`解散失败: ${resp.error || '未知错误'}`);
    return;
  }
  const ruleNames = await loadRuleNames();
  const isRuleGroup = !!group.title && ruleNames.has(group.title);
  showToast(isRuleGroup
    ? `已解散「${group.title}」(${resp.count} 个标签退回未分组); 规则仍在, 以后该域名的标签会另建同名组`
    : `已解散「${group.title || '分组'}」(${resp.count} 个标签退回未分组)`);
  await actions.refreshData({ forceFresh: true });
  actions.render();
}

// 移出分组(标签行右键): 行整体移出(代表 + 同组副本)。单个标签的移出走拖拽,
// 但拖拽只能"拖进"组, 没有"拖出去"的手势 —— 菜单补上这个缺口
export async function removeFromGroupAction(tabIds) {
  const ids = (tabIds || []).filter(id => id > 0);
  if (!ids.length) return;
  try {
    await chrome.tabs.ungroup(ids);
  } catch (e) {
    showToast('移出分组失败');
    return;
  }
  await actions.refreshData({ forceFresh: true });
  actions.render();
}

export function initGroupEdit(injected) {
  actions = injected;
}
