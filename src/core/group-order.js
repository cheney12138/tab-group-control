// core/group-order.js: 分组分区的次序记账本(跨渲染稳定)
//
// 为什么需要这一层: 浏览视图的分区序**过去**是数据的投影 —— 分区按组内最新标签的
// lastAccessed 排(render.js), 组内最后一根标签被关掉时该组整块消失。于是"跨分组
// 多选关闭"会连带把没关的组搬家:
//   ① 某组的最新标签被关 ⇒ 该组时间戳降级 ⇒ 掉到后面
//   ② 组被清空 ⇒ 分区消失; 撤销重建时 Chrome 给新标签 lastAccessed=now, 落点是随机的
//   ③ 关掉激活标签后 Chrome 换了激活标签 ⇒ render 的"当前组钉顶"把另一个组钉到第一位
// 三个都读成同一件事: 关了几个标签, 剩下的组跳了; 撤销的展开动画在别处演。
//
// 口径: 一次 popup 会话内, **分区的先后顺序是界面状态, 不是数据状态的投影**。
// 数据序(lastAccessed)只在"这个分区第一次出现"时决定它插在哪; 之后记账本说了算。
// 顺序该变的时机只有用户显式改结构(新建组 / 改名 / 拖拽), 而新组/改名后的组
// 走"首次出现"分支, 位置由数据序给出。
//
// 被清空的组不会立刻从记账本里划掉: 留座 ORDER_TTL_MS(撤销窗口 6s 的两倍),
// 撤销重建的同名同色组因此能回到原来的名次。宽限期一过、且它一直没再出现, 才忘掉。
//
// 键 = `${windowId}|${groupKey(group)}`: groupKey 是 组名|颜色(跨 popup 稳定),
// **不含** chrome 的 groupId —— 组被清空后 Chrome 会回收它, 重建时 id 是全新的。

import { groupKey } from './format.js';

const ORDER_TTL_MS = 12000;

let order = [];              // 分区键的次序(含宽限期内"暂时没有标签"的组)
let seenAt = new Map();      // 键 -> 最后一次出现在列表里的时刻

// 分区的稳定身份。未分组的分区按窗口分开(与 render 的分区口径一致)
export function groupOrderKey(windowId, group) {
  return `${windowId ?? ''}|${groupKey(group)}`;
}

// 把本次要渲染的分区键**排成最终次序**(返回值只含入参里的键)。
// 已在记账本里的键: 按记账本的名次; 新键: 贴住数据序里的前一格(prev + 0.5),
// 这样"刚建的组"仍然出现在数据说它该在的地方, 而不是被甩到末尾。
// 名次用整数 + 半整数, 不会撞车: 记账本里的名次恒为整数, 新键恒为 x.5。
export function arrangeGroupKeys(keys) {
  if (!keys.length) return [];
  const rank = new Map(order.map((key, i) => [key, i]));
  const assigned = new Map();
  let prev = -0.5;
  for (const key of keys) {
    const held = rank.get(key);
    const r = held == null ? prev + 0.5 : held;
    assigned.set(key, r);
    prev = r;
  }
  return [...keys].sort((a, b) => assigned.get(a) - assigned.get(b));
}

// 记账: keys = 本次实际渲染出来的分区序。
// 缺席但在宽限期内的键, 按它上一次的前邻居插回原位 —— 撤销时那一组就回到原来的座。
export function noteGroupOrder(keys) {
  const now = Date.now();
  const next = [...keys];
  for (const key of order) {
    if (next.includes(key)) continue;
    const at = seenAt.get(key) ?? 0;
    if (now - at >= ORDER_TTL_MS) continue; // 宽限期已过: 这一组是真的没了, 忘掉
    let insertAt = 0; // 它上一次排在最前(或前面的邻居全没了) ⇒ 插回最前
    for (let i = order.indexOf(key) - 1; i >= 0; i--) {
      const pos = next.indexOf(order[i]);
      if (pos >= 0) { insertAt = pos + 1; break; }
    }
    next.splice(insertAt, 0, key);
  }
  order = next;
  for (const key of keys) seenAt.set(key, now);
  for (const key of [...seenAt.keys()]) if (!order.includes(key)) seenAt.delete(key);
}

// 当前记账本(撤销凭证要把它一起落 session: popup 被关掉后重开还能按原次序落位)
export function groupOrderSnapshot() {
  return [...order];
}

// 用一份基准序覆盖记账本。撤销凭证跨 popup 恢复时用 —— 那个 popup 的首帧
// 只能看见"剩下的组", 不知道被清空的组原来站在哪。
// 记账本里已有的其它分区(基准序里没有的)接在基准序后面, 保持它们彼此的先后。
export function seedGroupOrder(keys = []) {
  const now = Date.now();
  const seeded = keys.filter(k => k != null);
  const keep = order.filter(k => !seeded.includes(k));
  order = [...seeded, ...keep];
  for (const key of order) if (!seenAt.has(key)) seenAt.set(key, now);
  for (const key of seeded) seenAt.set(key, now);
}

// 分组改名/改色: 身份变了, 座位要跟着搬(与 main.js remapGroupKey 搬收起记忆同理)。
// 传的是 groupKey(组名|颜色), 不是带窗口前缀的完整键 —— 所有窗口里的同名组一起搬。
export function remapGroupOrder(oldKey, newKey) {
  if (oldKey === newKey) return;
  const suffix = `|${oldKey}`;
  // 撞车序号后缀(#2)不属于身份, 改名时要留在末尾
  const remap = (k) => {
    const hash = k.indexOf('#');
    const head = hash >= 0 ? k.slice(0, hash) : k;
    const tail = hash >= 0 ? k.slice(hash) : '';
    return head.endsWith(suffix)
      ? `${head.slice(0, head.length - suffix.length)}|${newKey}${tail}`
      : k;
  };
  order = order.map(remap);
  const nextSeen = new Map();
  for (const [k, v] of seenAt) nextSeen.set(remap(k), v);
  seenAt = nextSeen;
}
