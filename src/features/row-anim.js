// features/row-anim.js: 行收起/展开动画(纯 DOM 原语, 不碰数据层)
//
// 删除标签时, 行不是"啪"地消失, 而是先收起(量高的固定高度 → 0 + 淡出右移),
// 演完才重渲染(#results.innerHTML = '' 会直接扔掉节点, 所以调用方必须**推迟渲染**)。
// 数据层(tabs.remove)仍然第一时间执行 —— 动画只决定"节点何时退场",
// 绝不能把关闭动作押在动画后面: 弹窗随时可能被点外面关掉, 定时器一并被杀。
//
// 性能: 只写 height/opacity/transform/padding/margin。
// 读写在批内分段(先量完所有行, 再统一写), 一次强制样式结算当过渡起点,
// 避免"读一行写一行"的布局抖动; 除 height/padding 外都是合成器属性。
//
// 两个方向共用这一套原语: collapseRows(删除: 量到的高度 → 0) /
// expandRows(撤销删除: 0 → 量到的自然高度)。参数一一对应, 相对而行。
export const COLLAPSE_MS = 340; // 与 popup.html 的 .tab-item.closing 过渡时长一致
// 展开是收起的逆动作, 时长/缓动/错峰必须一一对上 —— 同一行"删掉再撤销"应该读成
// 同一段动作倒放, 而不是两套观感。CSS 侧 .closing / .expanding 共用一条过渡声明。
export const EXPAND_MS = COLLAPSE_MS;
export const EXPAND_MAX_ROWS = 14; // 最多演 14 行, 其余直接落位(大批量恢复不该演成两秒)

// 减弱动态效果(系统偏好): 直接不演, 走原路径立即重渲染。
// 显式开了「强行动效」则跟 CSS 同一口径放行(data-force-motion="on" 时 CSS 处决不生效,
// JS 侧也不能比 CSS 更保守 —— 2026-11-14 review P2-4: 旧版开关只救 CSS 动画,
// 行收起/展开这些 JS 动画照旧不演, 开关文案"动效已强制开启"名不副实)
export function reduceMotion() {
  if (document.documentElement.getAttribute('data-force-motion') === 'on') return false;
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// 按 DOM 顺序排 —— 错峰节拍的"先后"必须是屏幕上的先后。
// 调用方给的顺序往往是数据层顺序(tabs.query / 关闭栈), 与渲染顺序不一定一致,
// 不归一的话级联会读成跳着演。
function inDomOrder(rows) {
  return [...new Set(rows)].sort((a, b) =>
    a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// 批量收起。stagger: 相邻行错开的毫秒数; maxSpread: 总错峰跨度上限(大列表别演成 2 秒)。
// 返回 Promise —— 最后一行收完(或兜底超时)后 resolve, 调用方据此重渲染。
export function collapseRows(rows, { stagger = 0, maxSpread = 420 } = {}) {
  // 正在收听起的行不重复收(连按 ⌘⌫ / 批量与单删撞车时), 顺序归一到屏幕序
  const list = inDomOrder(rows).filter(r => r && !r.classList.contains('closing'));
  if (!list.length) return Promise.resolve();
  // 减弱动态效果: 不演, 调用方照旧立即重渲染
  if (reduceMotion()) return Promise.resolve();

  // ① 读: 一次性量完(此时都还没写样式, 不会触发额外布局)
  const heights = list.map(r => r.offsetHeight);
  const spread = list.length > 1 ? Math.min((list.length - 1) * stagger, maxSpread) : 0;

  // ② 写起点: 固定高度 + 裁切, 记录本行的错峰延迟
  list.forEach((row, i) => {
    const delay = spread > 0 ? Math.round((i * spread) / (list.length - 1)) : 0;
    row.classList.add('closing');
    row.style.height = `${heights[i]}px`;
    row.style.overflow = 'hidden';
    row.style.transitionDelay = `${delay}ms`;
  });
  // ③ 强制样式结算: 让"量到的高度"成为过渡起点。
  //    少了这一步, 浏览器从 auto 起跳(auto 不可插值)⇒ 直接跳变, 没有动画
  void document.body.offsetHeight;
  // ④ 写终点: 高度/内边距归零 + 淡出右移
  list.forEach((row) => {
    row.style.height = '0px';
    row.style.paddingTop = '0px';
    row.style.paddingBottom = '0px';
    row.style.marginTop = '0px';
    row.style.marginBottom = '0px';
    row.style.opacity = '0';
    row.style.transform = 'translateX(16px)';
  });

  // transitionend 要为每行挂监听且会被中间属性打断, 统一用定时器兜底:
  // 早一点 commit 只是"提前变干净", 不会有残影
  return new Promise(resolve => setTimeout(resolve, spread + COLLAPSE_MS + 40));
}

// 分组头伴随收起: 给定将被收起的行集合, 找出"整组行都在集合里"的分区头。
// 分区在 DOM 里的形态是: .group-header 后跟本组的 .tab-item(连续), 直到下一个头。
// 只收行不收头的话, 组里最后一个标签删完后, 分组头要等到重渲染才"啪"地消失 ——
// 表现是行收完之后分组头又愣了一拍(用户口径: "迟疑 0.2s 分组 cell 才消失")。
// 头跟着行一起收, 退场才读成同一段动作。
export function vanishingHeaders(rows) {
  const closing = new Set(rows.filter(Boolean));
  const headers = [];
  for (const row of closing) {
    // 本行的分区头: 向前走, 越过本组行, 直到 .group-header(收起中的行也在链上)
    let el = row.previousElementSibling;
    while (el && !el.classList.contains('group-header')) el = el.previousElementSibling;
    if (!el || headers.includes(el)) continue;
    // 本分区里的全部行都在收起集合里 → 这个头也会随重渲染消失, 收它
    let n = el.nextElementSibling, count = 0, allIn = true;
    while (n && !n.classList.contains('group-header')) {
      if (n.classList.contains('tab-item')) {
        count++;
        if (!closing.has(n)) allIn = false;
      }
      n = n.nextElementSibling;
    }
    if (count > 0 && allIn) headers.push(el);
  }
  return headers;
}

// 收起分组头(与 collapseRows 同一套四步): 量高 → 挂 .closing + 写起点 → 强制结算 → 写终点。
// delay 默认 70ms(一个错峰档): 头比行晚半拍退场, 读成"tab 先走, 分组头紧跟";
// 同一组多行时头与错峰的行一起漏下去, 不会等所有行收完才动。
export function collapseHeaders(headers, { delay = 70 } = {}) {
  const list = (Array.isArray(headers) ? headers : [headers])
    .filter(h => h && !h.classList.contains('closing'));
  if (!list.length) return Promise.resolve();
  if (reduceMotion()) return Promise.resolve();

  const heights = list.map(h => h.offsetHeight);
  list.forEach((h, i) => {
    h.classList.add('closing');
    h.style.height = `${heights[i]}px`;
    h.style.overflow = 'hidden';
    h.style.transitionDelay = `${delay}ms`;
  });
  void document.body.offsetHeight;
  list.forEach((h) => {
    h.style.height = '0px';
    h.style.paddingTop = '0px';
    h.style.paddingBottom = '0px';
    h.style.marginTop = '0px';
    h.style.marginBottom = '0px';
    h.style.opacity = '0';
    h.style.transform = 'translateX(16px)';
  });
  return new Promise(resolve => setTimeout(resolve, delay + COLLAPSE_MS + 40));
}

// 批量展开(撤销删除/⌘Z): collapseRows 的镜像 —— 从 0 高 + 淡出右移展开回自然高度。
//
// 与收起的两处关键差别:
//   ① 收起时"节点还没退场", 展开始终发生在 render() **之后**(行是这一帧才建出来的),
//      所以起点/终点必须在同一任务内写完: 浏览器不会画出"满高闪一下"的中间帧。
//   ② 收起演完节点随重渲染一起消失; 展开演完节点要**留着**, 内联样式必须自己清干净
//      (残留 height/padding 会把行钉死在某一像素高度上, 之后主题/密度变化都不再跟)。
//
// 返回 Promise —— 全部展开完(或兜底超时)后 resolve, 调用方一般不用等。
export function expandRows(rows, { stagger = 70, maxSpread = 420, maxRows = EXPAND_MAX_ROWS } = {}) {
  const list = inDomOrder(rows)
    .filter(r => r && !r.classList.contains('closing') && !r.classList.contains('expanding'));
  if (!list.length) return Promise.resolve();
  // 减弱动态效果: 直接不演, 行就按渲染出来的样子落位
  if (reduceMotion()) return Promise.resolve();
  // 入场级联还在播(body.entrance)时, 行上有 row-settle 动画 —— animation 覆盖内联的
  // opacity/transform, 展开会演成"半路跳变"。此窗口内一律落位(用户介入动效让路), 
  // 与 render.js「入场窗口内换选中不重播」同一口径
  if (document.body.classList.contains('entrance')) return Promise.resolve();

  // 超出 maxRows 的行不演: 它们直接以自然高度出现(比"演到一半收工"干净)
  const play = list.slice(0, maxRows);
  const spread = play.length > 1 ? Math.min((play.length - 1) * stagger, maxSpread) : 0;

  // ① 读: 量自然高度与自然内边距/外边距/透明度/位移(此刻行上还没有内联样式)
  const nat = play.map(r => {
    const cs = getComputedStyle(r);
    return {
      height: `${r.offsetHeight}px`,
      paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
      marginTop: cs.marginTop, marginBottom: cs.marginBottom,
      opacity: cs.opacity, transform: cs.transform,
    };
  });

  // ② 写起点: 收到 0 高 + 淡出右移(与 .closing 的终点完全一致)。
  //    这里**先不挂 .expanding**: 类一挂上过渡就生效, 浏览器会把"起点"当成一次
  //    从自然值出发的过渡(自然透明度 1 → 0), 随后的终点写入就变成"反向"并当场结束 ——
  //    表现是高度在长、淡入和位移却完全没动。先把起点写成已结算的常态, 再挂类,
  //    过渡的 before-change 才是真正的 0 高/透明/右移。
  play.forEach((row) => {
    row.style.transition = 'none'; // 行本身可能有 .active 的 transform 过渡, 先屏蔽
    row.style.overflow = 'hidden';
    row.style.height = '0px';
    row.style.paddingTop = '0px';
    row.style.paddingBottom = '0px';
    row.style.marginTop = '0px';
    row.style.marginBottom = '0px';
    row.style.opacity = '0';
    row.style.transform = 'translateX(16px)';
  });
  // ③ 强制样式结算: 让"0 高"成为过渡起点(少了这一步, 浏览器从 0 跳到自然高度,
  //    没有中间帧; 与收起侧同一条理由, 只是方向相反)
  void document.body.offsetHeight;
  // ④ 挂过渡类 + 写终点: 高度/内外边距回到自然值 + 淡入归位
  play.forEach((row, i) => {
    const delay = spread > 0 ? Math.round((i * spread) / (play.length - 1)) : 0;
    row.style.removeProperty('transition'); // 交回 .expanding 的过渡声明(含 .active 的情形)
    row.classList.add('expanding');
    row.style.transitionDelay = `${delay}ms`;
    row.style.height = nat[i].height;
    row.style.paddingTop = nat[i].paddingTop;
    row.style.paddingBottom = nat[i].paddingBottom;
    row.style.marginTop = nat[i].marginTop;
    row.style.marginBottom = nat[i].marginBottom;
    row.style.opacity = nat[i].opacity;
    row.style.transform = nat[i].transform;
  });

  // 演完清场: 摘过渡类 + 抹掉全部内联样式(不留 0 高/固定高的残影)
  return new Promise(resolve => setTimeout(() => {
    for (const row of play) {
      row.classList.remove('expanding');
      row.style.removeProperty('height');
      row.style.removeProperty('padding-top');
      row.style.removeProperty('padding-bottom');
      row.style.removeProperty('margin-top');
      row.style.removeProperty('margin-bottom');
      row.style.removeProperty('opacity');
      row.style.removeProperty('transform');
      row.style.removeProperty('overflow');
      row.style.removeProperty('transition');
      row.style.removeProperty('transition-delay');
    }
    resolve();
  }, spread + EXPAND_MS + 40));
}
