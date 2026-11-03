// 滑行光标(2026-11-03 用户口径: 终端录屏里光标是**滑**过去的, 不是一格一格顿开。
// 用户随后明确否掉方块: "这个方块只是 tui 的样式, 不是要它这个方块")。
// 做法是**影子**: 输入框照旧走原生输入流(IME/选区/撤销/自动填充全部不受影响),
// 只是把原生 caret 设成透明, 再用一根 accent 细竖线贴住插入点 —— x 靠 canvas
// measureText 量"光标前文本宽"算出来, 位移交给 CSS transition 补间(90ms)。
//
// 只动 transform/opacity 两个合成器属性(项目铁律: 动画不许碰 filter/布局属性)。
// 打字时竖线保持实心不闪, 停手 420ms 后恢复慢闪。

const BLINK_IDLE_MS = 420;

export function initBlockCaret() {
  const wrap = document.querySelector('.search-wrap');
  const input = document.getElementById('search');
  const caret = document.getElementById('smoothCaret');
  if (!wrap || !input || !caret) return;

  const ctx = document.createElement('canvas').getContext('2d');
  let blinkTimer = null;
  let composing = false;

  // 用输入框当前字体量文本宽度: canvas measureText 与单行 input 的排版足够一致
  // (比例字体下逐字符宽度不同, 所以"光标前文本宽"和"光标处字符宽"各量一次)
  const setFont = () => {
    const cs = getComputedStyle(input);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return cs;
  };
  const textWidth = (str) => (str ? ctx.measureText(str).width : 0);

  const hide = () => caret.classList.remove('on', 'blink');

  const place = () => {
    if (composing || document.activeElement !== input) return hide();
    const cs = setFont();
    const wrapRect = wrap.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const boxLeft = inputRect.left - wrapRect.left + padLeft;
    const pos = input.selectionStart ?? input.value.length;
    // 量"光标前文本"得到插入点的 x; 再减 input.scrollLeft —— 长查询时输入框内部
    // 会横向滚动, 不减就会让方块飘到框外
    const x = boxLeft + textWidth(input.value.slice(0, pos)) - input.scrollLeft;
    // 滚出可视区就藏起来, 别贴在输入框边缘装成光标
    const visibleRight = inputRect.right - wrapRect.left;
    if (x < boxLeft - 1 || x > visibleRight) return hide();
    // 宽度固定 2px(CSS 给): 这是一根细竖线, 不是贴字数宽度的方块
    caret.style.transform = `translateX(${x.toFixed(2)}px)`;
    caret.classList.add('on');
    scheduleBlink();
  };

  // 打字期间不闪: 每次动光标都把闪动画推迟 420ms, 停手后才恢复终端式慢闪
  const scheduleBlink = () => {
    caret.classList.remove('blink');
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      if (caret.classList.contains('on')) caret.classList.add('blink');
    }, BLINK_IDLE_MS);
  };

  const refresh = () => requestAnimationFrame(place);

  input.addEventListener('input', refresh);
  input.addEventListener('keyup', refresh);
  input.addEventListener('keydown', refresh);   // 方向键: keydown 就动, 不等 keyup
  input.addEventListener('click', refresh);
  input.addEventListener('select', refresh);   // 选区变化(input 上会触发)
  input.addEventListener('focus', refresh);
  input.addEventListener('blur', hide);
  input.addEventListener('scroll', place);

  // 拼音组合期间交还原生 caret(方块藏起来): 组合串跟着拼音走, 影子追不上反而乱
  input.addEventListener('compositionstart', () => {
    composing = true;
    wrap.classList.add('composing');   // CSS 据此把原生 caret 还回来
    hide();
  });
  input.addEventListener('compositionupdate', hide);
  input.addEventListener('compositionend', () => {
    composing = false;
    wrap.classList.remove('composing');
    refresh();
  });

  // 弹窗重启/切主题后字体度量会变, 窗口尺寸变化时重算一次
  window.addEventListener('resize', refresh);
}

// 打开设置面板等场景会用代码改 input.value, 不会触发 input 事件 —— 这里补一个
// 供外部主动刷新的入口(目前 main.js 在命令胶囊/历史召回后调用)
export function refreshBlockCaret() {
  const input = document.getElementById('search');
  if (input) input.dispatchEvent(new Event('select'));
}
