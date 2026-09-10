// features/rules.js: 自动分组规则编辑器(组件)
// 规则存 chrome.storage.local(background 同源读取,storage.onChanged 即时生效)。
// 对外接口: loadRulesForEdit(设置面板展开时由 main 调用)。
// 域名解析/匹配函数(parseRuleEntry/ruleHostOfUrl/wildcardAllowed/siteRootOf/
// ruleChipLabel)来自 rules-match.js(classic script 全局,与 background 共享)
import { showToast } from '../core/dom.js';

// ---- 自动分组规则编辑器 ----
// 规则存 chrome.storage.local(background 同源读取,storage.onChanged 即时生效)。
// UI: 每组一个"组名输入框 + 域名芯片流",增删组,保存。
// 脏状态: 任何编辑 → 保存按钮变琥珀+脉动,标题旁圆点;保存/重载后清除
const rulesListEl = document.getElementById('rulesList');
const saveRulesBtn = document.getElementById('saveRulesBtn');
const rulesDirtyDot = document.getElementById('rulesDirtyDot');

function markRulesDirty() {
  saveRulesBtn.classList.add('dirty');
  saveRulesBtn.textContent = '保存规则 •';
  rulesDirtyDot.classList.add('show');
}
function clearRulesDirty() {
  saveRulesBtn.classList.remove('dirty');
  saveRulesBtn.textContent = '保存规则';
  rulesDirtyDot.classList.remove('show');
}
// 事件委托: 规则区内所有输入/键入都算编辑(input 覆盖打字/粘贴/删除,
// click 覆盖 chip × 删除和组删除按钮——这些不触发 input)
rulesListEl.addEventListener('input', markRulesDirty);
rulesListEl.addEventListener('click', (e) => {
  // 删除类按钮(chip ×、组删除)走这里标脏;chip 文本的通配切换在
  // createHostChip 的监听里自行标脏,不经过这个委托
  if (e.target.closest('.rule-del-btn') || e.target.closest('.host-chip button')) {
    markRulesDirty();
  }
});
// 增删组直接标脏(发生在 rulesListEl 之外)
// 设置面板展开时由 main 调用: storage → 编辑器渲染,并据实标脏/清脏
export async function loadRulesForEdit() {
  try {
    const stored = await chrome.storage.local.get('groupRules');
    const saved = (stored?.groupRules && typeof stored.groupRules === 'object') ? stored.groupRules : {};
    if (Object.keys(saved).length) {
      renderRulesEditor(saved);
      // 渲染可能改写规则(www.bilibili.com 归一成 bilibili.com、同组子域被
      // 显式通配规则收拢)。编辑器和 storage 因此不再一致——标脏让"保存规则"
      // 提示出来,而不是下一次保存时悄悄改写掉用户没看过的规则
      if (JSON.stringify(collectRulesFromEditor()) === JSON.stringify(saved)) clearRulesDirty();
      else markRulesDirty();
      return;
    }
    // storage 为空(background 首次写入还没跑): 给空态提示,
    // 用户保存任意规则后即建立 storage 数据流
    renderRulesEditor({});
  } catch (e) {
    console.error('读取规则失败:', e);
    renderRulesEditor({});
  }
}

function renderRulesEditor(rules) {
  rulesListEl.innerHTML = '';
  const entries = Object.entries(rules);
  if (!entries.length) {
    rulesListEl.innerHTML = '<div style="padding:8px 0;color:var(--text-3);font-size:11px">暂无规则,点击下方新增组</div>';
    return;
  }
  for (const [name, hosts] of entries) {
    rulesListEl.appendChild(buildRuleGroup(name, hosts || []));
  }
}

// 单个规则组的编辑行: 组名输入 + 域名芯片流(每枚可删) + 内联追加输入
// 芯片落库/去重/查找一律以 dataset.host(归一化裸主机名)为准;
// dataset.zone 记显式通配标志——"*." 是规则语义(存储里带前缀):
// 默认精确匹配单机(bilibili.com),写 *. 或开开关才含所有子域(*.bilibili.com)
function createHostChip(hostOrEntry, insertBefore) {
  const entry = (hostOrEntry && typeof hostOrEntry === 'object')
    ? hostOrEntry : parseRuleEntry(hostOrEntry);
  if (!entry) return null;
  const canonical = entry.host;
  // 同主机名芯片已存在时: 通配覆盖精确 → 升级(去掉旧芯片接着插入);
  // 其余(相同写法 / 旧已是通配)视为重复,任何插入路径都覆盖
  const flow = insertBefore?.parentElement;
  if (flow) {
    const dup = [...flow.querySelectorAll('.host-chip')]
      .find(c => (c.dataset.host || '') === canonical);
    if (dup && !(entry.zone && dup.dataset.zone !== '1')) return null;
    if (dup) dup.remove();
  }
  const chip = document.createElement('span');
  chip.className = 'host-chip';
  chip.dataset.host = canonical;
  chip.dataset.zone = entry.zone ? '1' : '';

  const label = document.createElement('span');
  // 不可通配的芯片(IP / localhost / github.io 这类多租户平台域)不给
  // "点击切换"的引导——点击本来就无效(见下方监听),提示了做不到的事
  // 用户会以为功能坏了
  const canToggle = wildcardAllowed(canonical);
  const updateLabel = (isZone) => {
    label.textContent = isZone ? `*.${canonical}` : canonical;
    label.title = isZone
      ? `${canonical} 及所有子域都归这组 (点击切换为仅当前主机)`
      : canToggle
        ? `仅 ${canonical} 这台主机 (点击切换为整站通配)`
        : `仅 ${canonical} 这台主机`;
  };
  updateLabel(entry.zone);
  label.style.cursor = 'pointer';
  // 点击芯片文字可便捷切换 精确/整站通配 状态
  label.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!wildcardAllowed(canonical)) return;
    const nowZone = chip.dataset.zone === '1';
    const nextZone = !nowZone;
    chip.dataset.zone = nextZone ? '1' : '';
    updateLabel(nextZone);
    markRulesDirty();
  });

  const chipDel = document.createElement('button');
  chipDel.textContent = '×';
  chipDel.title = '移除该域名';
  chipDel.addEventListener('click', (e) => {
    e.stopPropagation();
    chip.remove();
    markRulesDirty();
  });
  chip.appendChild(label);
  chip.appendChild(chipDel);
  if (insertBefore?.parentElement) insertBefore.parentElement.insertBefore(chip, insertBefore);
  return chip;
}

// 编辑器里现有的芯片规则(host + 通配标志;dataset 是唯一事实,文本是兜底)
function chipEntries(groupEl) {
  return [...groupEl.querySelectorAll('.host-chip')]
    .map(c => (c.dataset.host
      ? { host: c.dataset.host, zone: c.dataset.zone === '1' }
      : parseRuleEntry(c.querySelector('span')?.textContent)))
    .filter(Boolean);
}

// 编辑器里现有的芯片主机名(供去重;同主机名只算一条)
function chipHosts(groupEl) {
  return [...new Set(chipEntries(groupEl).map(e => e.host))];
}

function buildRuleGroup(name, hosts) {
  const groupDiv = document.createElement('div');
  groupDiv.className = 'rule-group';

  // 组名行
  const nameRow = document.createElement('div');
  nameRow.className = 'rule-group-name';
  const nameInput = document.createElement('input');
  nameInput.value = name;
  nameInput.placeholder = '组名';
  nameInput.className = 'rule-name-input';
  // 重名拦截: 组名唯一是自动分组的前提(Chrome 无删组 API,同名组靠 tidy 兜底)。
  // 失焦时与其他组比对,撞名则闪烁+toast 提示——不打断编辑(用户可继续改名),
  // 真带着重名保存时由 collectRulesFromEditor 合并域名兜底,数据不丢
  nameInput.addEventListener('blur', () => {
    const n = nameInput.value.trim();
    if (!n) return;
    const dup = [...rulesListEl.querySelectorAll('.rule-group')]
      .filter(g => g !== groupDiv)
      .some(g => g.querySelector('.rule-name-input')?.value.trim() === n);
    if (dup) {
      nameInput.classList.remove('invalid-flash');
      void nameInput.offsetWidth; // 重启动画
      nameInput.classList.add('invalid-flash');
      setTimeout(() => nameInput.classList.remove('invalid-flash'), 1400);
      showToast(`已存在同名组「${n}」,保存时将合并为一组`);
    }
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'rule-del-btn';
  delBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
  delBtn.title = '删除该组规则';
  delBtn.addEventListener('click', () => {
    groupDiv.remove();
    markRulesDirty();
  });
  nameRow.appendChild(nameInput);
  nameRow.appendChild(delBtn);
  groupDiv.appendChild(nameRow);

  // 域名芯片流
  const chipFlow = document.createElement('div');
  chipFlow.className = 'rule-hosts';
  const addHostChip = (host) => createHostChip(host, addInput);
  // 内联追加输入: 回车/失焦确认(逗号分隔可批量)
  const addInput = document.createElement('input');
  addInput.className = 'host-add-input';
  addInput.placeholder = '添加域名…';
  addInput.title = '默认精确匹配单机;要含所有子域请写 *.bilibili.com;\n粘贴完整网址、带端口都能识别';
  // 无效闪烁动画播完自摘类(reduced-motion 下动画被压成 1ms,animationend
  // 不可靠,setTimeout 兜底): 类挂着 animation 就持续存在,不摘的话下一次
  // 触发无法重启,正常输入看起来也"在闪"
  let invalidAnimTimer = null;
  addInput.addEventListener('animationend', (e) => {
    if (e.animationName === 'invalid-flash') {
      clearTimeout(invalidAnimTimer);
      addInput.classList.remove('invalid-flash');
    }
  });
  const commit = () => {
    // 逐片段解析: 无效的留在输入框(toast 提示),有效的进芯片。
    // 之前无效输入静默清空——用户以为加上了,保存后目标站点不归组,
    // 全程零反馈无法自查。
    // 每次提交先清上一次的无效闪烁: 重新提交 = 无效状态翻篇
    clearTimeout(invalidAnimTimer);
    addInput.classList.remove('invalid-flash');
    const raw = addInput.value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
    const parts = [];
    const invalid = [];
    for (const piece of raw) {
      const entry = parseRuleEntry(piece);
      if (entry) parts.push(entry);
      else invalid.push(piece);
    }
    let added = 0;
    let blocked = null;
    for (const e of parts) {
      const owner = [...rulesListEl.querySelectorAll('.rule-group')]
        .find(g => g !== groupDiv && chipHosts(g).includes(e.host));
      if (owner) {
        const ownerName = owner.querySelector('.rule-name-input')?.value.trim() || '某组';
        blocked = { host: e.host, ownerName };
        continue;
      }
      if (addHostChip(e)) added += 1;
    }
    if (invalid.length) showToast(`没识别到有效域名: ${invalid.join('、')}`);
    else if (blocked) showToast(`${blocked.host} 已在「${blocked.ownerName}」中,一个域名只能归属一个分组`);
    else if (parts.length && !added) showToast('这些域名已经在这组里了');
    if (added > 0) markRulesDirty();
    // 无效片段保留待改;全部处理完才清空。
    // 输入框红边脉动 = 内容没被收下(无效片段挡在这),与 chip 的 dup-flash
    // 同一视觉语言: 闪烁 = "这里出了点问题,看一眼"
    if (invalid.length) {
      clearTimeout(invalidAnimTimer);
      addInput.classList.remove('invalid-flash');
      void addInput.offsetWidth; // 重启动画
      addInput.classList.add('invalid-flash');
      clearTimeout(invalidAnimTimer);
      invalidAnimTimer = setTimeout(() => addInput.classList.remove('invalid-flash'), 1400);
      addInput.focus(); // 内容被拦下了,焦点留在框里等修改
    }
    addInput.value = invalid.length ? invalid.join(', ') : '';
  };
  addInput.addEventListener('keydown', (e) => {
    // 组合输入(拼音未上屏)时回车让位给输入法,不提交
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') addInput.blur();
    e.stopPropagation(); // 不触发全局快捷键
  });
  addInput.addEventListener('blur', commit);
  chipFlow.appendChild(addInput);

  // 存量规则里同组的子域芯片可能被同组的显式通配规则覆盖(*.bilibili.com 在,
  // live.bilibili.com 冗余)。同组内被覆盖 = 匹配结果完全一样,渲染时收拢
  const own = [...new Map((Array.isArray(hosts) ? hosts : [])
    .map(h => ((h && typeof h === 'object') ? h : parseRuleEntry(h)))
    .filter(Boolean).map(e => [e.host, e])).values()];
  const coveredBy = (h) => own.find(x => x.zone && x.host !== h.host && h.host.endsWith(`.${x.host}`));
  own.filter(h => !coveredBy(h)).forEach(addHostChip);
  groupDiv.appendChild(chipFlow);
  return groupDiv;
}

document.getElementById('addRuleBtn').addEventListener('click', () => {
  // 追加一个空模板组(不动已有内容)
  rulesListEl.appendChild(buildRuleGroup('', []));
  rulesListEl.scrollTop = rulesListEl.scrollHeight;
  markRulesDirty();
  // 聚焦新组的组名输入
  const groups = rulesListEl.querySelectorAll('.rule-group');
  groups[groups.length - 1]?.querySelector('.rule-name-input')?.focus();
});

// ---- 把当前标签页域名添加到分组(弹层: 新建 或 选已有) ----
const currentHostBtn = document.getElementById('addCurrentHostBtn');
let groupPop = null;
// 弹层状态查询/关闭: 全局键盘路由(main)的 ESC 分支需要,export 查询函数
// 而非可变变量本身,语义更清晰
export function isGroupPopOpen() { return !!groupPop; }
export function closeGroupPop() { if (groupPop) { groupPop.remove(); groupPop = null; } }
// 添加域名走「编辑器草稿」路径,不直写 storage:
//   ① 直写会绕过「保存规则」按钮——用户还没保存,background 的
//      storage.onChanged 已触发 groupExistingTabs,Chrome 标签栏的组
//      真的被建出来了(与 JSON 导入「导入后仍需保存」的契约矛盾);
//   ② 直写后 loadRulesForEdit 整刷编辑器,会覆盖用户正在进行的未保存
//      编辑(改名/删域名瞬间被弹回),storage.onChanged 的清理链还会把
//      编辑器里未保存的组当成"已删除"去迁移真标签。
// 合并进 DOM + 标脏,让「保存规则」保持唯一落库口,与手工编辑/导入一致
async function addHostToRuleGroup(hostOrEntry, groupName) {
  const entry = (hostOrEntry && typeof hostOrEntry === 'object')
    ? hostOrEntry : parseRuleEntry(hostOrEntry);
  if (!entry) { showToast('未识别到有效域名'); return; }
  const host = entry.host;
  const groups = [...rulesListEl.querySelectorAll('.rule-group')];
  // 按输入框当前值匹配组名(编辑器草稿即事实,不读 storage)
  const target = groups.find(g => g.querySelector('.rule-name-input')?.value.trim() === groupName);
  // 域名只能绑定一个分组规则: 已在任何一组存在则拦截(跨分组去重)。
  // 例外: 目标组里已有同主机名的精确芯片、这次开的是通配 → 原地升级
  const dupGroup = groups.find(g => chipHosts(g).includes(host));
  if (dupGroup) {
    const dupChip = [...dupGroup.querySelectorAll('.host-chip')]
      .find(c => (c.dataset.host || '') === host);
    const upgradable = target && dupGroup === target && entry.zone
      && dupChip && dupChip.dataset.zone !== '1';
    if (upgradable) {
      dupChip.remove();
    } else {
      closeGroupPop();
      // 定位到已存在的那个域名芯片,微黄闪烁示意“它已经在这里”,不做置灰
      const flash = dupChip || dupGroup;
      flash.scrollIntoView({ block: 'center' });
      flash.classList.add('dup-flash');
      setTimeout(() => flash.classList.remove('dup-flash'), 1300);
      const dupName = dupGroup.querySelector('.rule-name-input')?.value.trim() || '某组';
      showToast(`该域名已在「${dupName}」中,一个域名只能归属一个分组`);
      return;
    }
  }
  if (target) {
    createHostChip(entry, target.querySelector('.host-add-input'));
  } else {
    // 新组: 清掉"暂无规则"占位再追加整组模板(组名+首枚域名),
    // 行为与 JSON 导入追加新组一致
    if (!groups.length) rulesListEl.innerHTML = '';
    rulesListEl.appendChild(buildRuleGroup(groupName, [entry]));
    rulesListEl.scrollTop = rulesListEl.scrollHeight;
  }
  markRulesDirty();
  closeGroupPop();
  // 添加即保存,省去再点"保存规则"
  await saveRules({ silent: true });
  showToast(`已将 ${ruleChipLabel(entry)} 加入「${groupName}」并保存`);
}
try {
currentHostBtn.addEventListener('click', async () => {
  closeGroupPop();
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [null]);
  // 当前页完整主机(去 www): 默认只精确匹配这一台,通配交给开关显式声明
  const rawHost = active ? ruleHostOfUrl(active.url) : '';
  if (!rawHost) { showToast('未获取到当前标签域名'); return; }
  // 列表与落点同源: 添加动作合并进编辑器草稿,列表也从编辑器现取。
  // 编辑器存在同名组(失焦拦截后未处理)时列表去重,不列重复按钮
  const groups = [...new Set([...rulesListEl.querySelectorAll('.rule-name-input')]
    .map(el => el.value.trim()).filter(Boolean))];
  const pop = document.createElement('div');
  pop.className = 'group-pop';
  const rect = currentHostBtn.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.right - 240, document.body.clientWidth - 250));
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 275)}px`;
  const head = document.createElement('div');
  head.className = 'group-pop-head';
  const tt = document.createElement('div');
  tt.className = 'group-pop-title';
  const x = document.createElement('button');
  x.className = 'group-pop-close';
  x.textContent = '✕';
  head.appendChild(tt);
  head.appendChild(x);
  pop.appendChild(head);

  // 通配开关(默认关): 关 = 只加当前主机(精确匹配);
  // 开 = *.站点根(整站及所有子域一起归组)
  const zoneRow = document.createElement('label');
  zoneRow.className = 'group-pop-zone';
  zoneRow.title = '关闭只添加当前主机(精确匹配);打开按 *.站点根 添加,整站及所有子域一起归组';
  const zoneText = document.createElement('span');
  zoneText.className = 'group-pop-zone-text';
  zoneText.textContent = '整站通配(含所有子域)';
  const zoneSwitch = document.createElement('span');
  zoneSwitch.className = 'zone-switch';
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  const knob = document.createElement('span');
  knob.className = 'zone-switch-knob';
  zoneSwitch.appendChild(chk);
  zoneSwitch.appendChild(knob);
  zoneRow.appendChild(zoneText);
  zoneRow.appendChild(zoneSwitch);
  pop.appendChild(zoneRow);

  // 开关状态 → 将添加的规则; 标题实时同步显示实际形式
  const entryOf = () => {
    const host = chk.checked ? siteRootOf(rawHost) : rawHost;
    return { host, zone: chk.checked && wildcardAllowed(host) };
  };
  const syncTitle = () => {
    const entry = entryOf();
    tt.textContent = `添加 ${ruleChipLabel(entry)}`;
    tt.title = entry.zone
      ? `${entry.host} 及它的所有子域都归这组`
      : '只匹配这一台主机;开"整站通配"可含所有子域';
  };
  chk.addEventListener('change', syncTitle);
  syncTitle();

  const list = document.createElement('div');
  list.className = 'group-pop-list';
  if (groups.length) {
    groups.forEach(g => {
      const b = document.createElement('button');
      b.className = 'group-pop-item';
      b.textContent = g;
      b.addEventListener('click', () => addHostToRuleGroup(entryOf(), g));
      list.appendChild(b);
    });
  } else {
    const empty = document.createElement('div');
    empty.className = 'group-pop-empty';
    empty.textContent = '还没有分组规则';
    list.appendChild(empty);
  }
  pop.appendChild(list);
  const newRow = document.createElement('div');
  newRow.className = 'group-pop-new';
  const inp = document.createElement('input');
  inp.placeholder = '新建分组名';
  inp.value = siteRootOf(rawHost); // 组名默认用站点根,比完整主机干净
  const add = document.createElement('button');
  add.className = 'group-pop-add';
  add.textContent = '添加';
  add.addEventListener('click', () => { const name = inp.value.trim(); if (name) addHostToRuleGroup(entryOf(), name); });
  // 组合输入(拼音未上屏)时回车让位给输入法,不提交
  inp.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { const n = inp.value.trim(); if (n) addHostToRuleGroup(entryOf(), n); }
  });
  newRow.appendChild(inp);
  newRow.appendChild(add);
  pop.appendChild(newRow);
  document.body.appendChild(pop);
  groupPop = pop;
  inp.focus();
  const remove = () => { closeGroupPop(); document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  const onDoc = (e) => { if (!pop.contains(e.target)) remove(); };
  const onEsc = (e) => { if (e.key === 'Escape') remove(); };
  x.addEventListener('click', (e) => { e.stopPropagation(); remove(); });
  document.addEventListener('mousedown', onDoc);
  document.addEventListener('keydown', onEsc);
});
} catch (e) { console.error('添加域名弹层初始化失败', e); }

// ---- 规则 JSON 导入/导出 ----
// 从当前编辑器 DOM 收集规则(与保存共用同一收集逻辑,导入合并以此为基底)
function collectRulesFromEditor() {
  const rules = {};
  let dupMerged = 0; // 被合并的同名组数(供 saveRules 提示)
  rulesListEl.querySelectorAll('.rule-group').forEach(g => {
    const name = g.querySelector('.rule-name-input')?.value.trim();
    // 通配规则落库为 "*.host",精确规则存裸主机名——与导入/导出同一格式
    const hosts = chipEntries(g).map(e => (e.zone ? `*.${e.host}` : e.host));
    if (!name || !hosts.length) return;
    if (rules[name]) {
      // 同名组兜底(失焦闪烁提示后用户仍保存): 合并域名不覆盖,数据不丢
      const set = new Set(rules[name]);
      for (const h of hosts) set.add(h);
      rules[name] = [...set];
      dupMerged += 1;
    } else {
      rules[name] = hosts;
    }
  });
  collectRulesFromEditor.lastDupMerged = dupMerged;
  return rules;
}

// 解析导入 JSON → { 组名: [域名] }。容忍两类格式:
// 1. 本插件/Tabbiy 导出的扁平格式 { "组名": ["域名", ...] }
// 2. [{ name/group, domains/hosts/urls: [...] }] 数组格式(手写常见)
// 域名解析与芯片输入同一套(parseRuleEntry): "*." 通配跟着导入文本走,
// 同主机名 "*.x" 与 "x" 只留先出现的
function parseRulesJson(text) {
  const data = JSON.parse(text);
  const raw = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const name = (item.name ?? item.group ?? item.title ?? '').toString().trim();
      const list = item.domains ?? item.hosts ?? item.urls ?? [];
      // 同名条目合并域名,不覆盖丢数据(后续清洗循环会组内去重)
      if (name && Array.isArray(list)) raw[name] = raw[name] ? [...raw[name], ...list] : list;
    }
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = (data.rules && typeof data.rules === 'object' && !Array.isArray(data.rules))
      ? data.rules : data;
    for (const [k, v] of Object.entries(obj)) {
      // key trim 归一: " 工作 " 与 "工作" 是同一组——不 trim 会在编辑器里
      // 落成两行,保存时 trim 撞车触发覆盖丢失。撞车合并,不覆盖
      const name = k.trim();
      if (name && Array.isArray(v)) raw[name] = raw[name] ? [...raw[name], ...v] : v;
    }
  } else {
    throw new Error('JSON 顶层须是对象或数组');
  }
  const rules = {};
  let hosts = 0;
  for (const [name, list] of Object.entries(raw)) {
    if (!name) continue;
    const seen = new Set();
    const cleaned = [];
    for (const x of list) {
      if (typeof x !== 'string') continue;
      const e = parseRuleEntry(x);
      if (!e || seen.has(e.host)) continue;
      seen.add(e.host);
      cleaned.push(e.zone ? `*.${e.host}` : e.host);
    }
    if (cleaned.length) { rules[name] = cleaned; hosts += cleaned.length; }
  }
  return { rules, hosts };
}

document.getElementById('importRulesBtn').addEventListener('click', () => {
  // 轻量弹层: 文本域粘贴 JSON → 解析合并进编辑器(不直接写 storage,
  // 用户可在保存前检查/修改,保存动作与手工编辑完全一致)。
  // 类名 rules-import-layer 供全局焦点兜底监听器豁免(见文件末尾),
  // 否则点击弹层内任何位置焦点都会被抢回搜索框,textarea 打不了字
  const layer = document.createElement('div');
  layer.className = 'rules-import-layer';
  layer.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center';
  const box = document.createElement('div');
  box.style.cssText = 'width:min(420px,92vw);background:var(--surface);border:1px solid var(--hairline);border-radius:12px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:12px';
  box.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px">导入规则 JSON</div>
    <div style="color:var(--text-3);margin-bottom:8px;line-height:1.5">
      粘贴 <code>{ "组名": ["域名", …] }</code> 格式(Tabbiy 导出兼容),
      域名写 <code>bilibili.com</code> 精确匹配该主机, 写 <code>*.bilibili.com</code> 含所有子域, 完整网址也认。
      与当前编辑器内容<b>同名组合并域名、新组追加</b>,导入后仍需点「保存规则」。
    </div>
    <textarea class="import-json-area" style="width:100%;height:180px;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;padding:8px;border:1px solid var(--hairline);border-radius:8px;background:var(--bg);color:var(--text);resize:vertical;outline:none"></textarea>
    <div class="import-json-error" style="color:var(--danger,#e0457b);font-size:11px;margin-top:6px;min-height:14px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="io-cancel" style="padding:5px 14px;border:1px solid var(--hairline);background:var(--surface);color:var(--text);border-radius:6px;cursor:pointer;font-size:11.5px">取消</button>
      <button class="io-confirm" style="padding:5px 14px;border:none;background:var(--accent);color:#fff;border-radius:6px;cursor:pointer;font-size:11.5px;font-weight:600">导入</button>
    </div>`;
  layer.appendChild(box);
  document.body.appendChild(layer);
  const area = box.querySelector('.import-json-area');
  const errEl = box.querySelector('.import-json-error');
  area.focus();
  const close = () => layer.remove();
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
  box.querySelector('.io-cancel').addEventListener('click', close);
  area.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 不触发全局快捷键
    if (e.key === 'Escape') close();
  });
  box.querySelector('.io-confirm').addEventListener('click', () => {
    let parsed;
    try {
      parsed = parseRulesJson(area.value);
    } catch (e) {
      errEl.textContent = '解析失败: ' + (e.message || '不是合法 JSON');
      return;
    }
    if (!Object.keys(parsed.rules).length) {
      errEl.textContent = '没解析到任何有效规则(需要 { "组名": ["域名"] } 结构)';
      return;
    }
    // 合并: 同名组域名并入(去重),新组按现有渲染顺序追加
    const existing = collectRulesFromEditor();
    const merged = { ...existing };
    let addedGroups = 0, addedHosts = 0;
    for (const [name, hosts] of Object.entries(parsed.rules)) {
      if (merged[name]) {
        const set = new Set(merged[name]);
        for (const h of hosts) if (!set.has(h)) { set.add(h); addedHosts += 1; }
        merged[name] = [...set];
      } else {
        merged[name] = hosts;
        addedGroups += 1;
        addedHosts += hosts.length;
      }
    }
    renderRulesEditor(merged);
    markRulesDirty();
    close();
    showToast(`已导入: 新增 ${addedGroups} 组${addedHosts ? `,共 ${addedHosts} 个域名` : ''},记得保存`);
  });
});

document.getElementById('exportRulesBtn').addEventListener('click', () => {
  const rules = collectRulesFromEditor();
  if (!Object.keys(rules).length) {
    showToast('当前没有可导出的规则');
    return;
  }
  // 导出编辑器当前内容(含未保存修改),扁平 Tabbiy 兼容格式,键排序便于 diff
  const ordered = {};
  for (const k of Object.keys(rules).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    ordered[k] = rules[k];
  }
  const blob = new Blob([JSON.stringify(ordered, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tab-group-rules.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

async function saveRules(opts = {}) {
  // 保护: 若用户输入完域名未按回车直接点击保存, 主动触发输入框失焦以完成 commit
  rulesListEl.querySelectorAll('.host-add-input').forEach(inp => {
    if (inp.value && inp.value.trim()) {
      inp.dispatchEvent(new Event('blur'));
    }
  });
  const rules = collectRulesFromEditor();
  const dupMerged = collectRulesFromEditor.lastDupMerged || 0;
  // 无效组 = 无名或无域名(被忽略);同名组不算无效——域名已合并,没丢数据
  const invalid = [...rulesListEl.querySelectorAll('.rule-group')].filter(g => {
    const n = g.querySelector('.rule-name-input')?.value.trim();
    return !n || !chipEntries(g).length;
  }).length;
  if (!Object.keys(rules).length) {
    // 空集是合法状态(用户删光了所有规则)——存 {},让 storage.onChanged
    // 走清理路径解散旧组。background 以 groupRules 键的存在性区分
    // "从没设置过"和"刻意为空",不会回填默认规则
    await chrome.storage.local.set({ groupRules: {} });
    clearRulesDirty();
    if (!opts.silent) showToast('已清空全部规则');
    chrome.runtime.sendMessage({ type: 'group-existing' }).catch(() => {});
    return;
  }
  try {
    await chrome.storage.local.set({ groupRules: rules });
    clearRulesDirty();
    if (!opts.silent) showToast(`规则已保存(${Object.keys(rules).length} 组)${dupMerged ? `,${dupMerged} 个同名组已合并` : ''}${invalid ? `,${invalid} 个无效组被忽略` : ''}`);
    // 同名合并后编辑器与落库不一致(DOM 里仍是两行同名),重渲染对齐真实状态
    if (dupMerged) renderRulesEditor(rules);
    chrome.runtime.sendMessage({ type: 'group-existing' }).catch(() => {});
  } catch (e) {
    showToast('保存失败:' + e.message);
  }
}
document.getElementById('saveRulesBtn').addEventListener('click', () => saveRules());
