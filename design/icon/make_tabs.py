#!/usr/bin/env python3
"""以「浏览器标签页」为主体的扁平化草图。

上一版把放大镜当主体、镜中三根柱当标签 —— 实读成"图表/图标工具",跑偏。
这一版:标签页本身是绝对主体;分组靠"多张标签并排 / 放在同一个组板里 / 共用一条组杠"表达。

扁平三戒:无渐变、无光泽、无投影。底色 = 纯色圆角方块,标记 = 白 + 挖空。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from make_flat import CHROME   # noqa: E402

OUT = os.path.join(HERE, "build")
S = 128.0
ORANGE = "#E66A28"


def tab(x, y, w, h, r, fill="#fff", opacity=1.0):
    """浏览器标签页:顶角圆、底角方。"""
    d = (f"M{x} {y+h} V{y+r} Q{x} {y} {x+r} {y} "
         f"H{x+w-r} Q{x+w} {y} {x+w} {y+r} V{y+h} Z")
    return f'<path d="{d}" fill="{fill}" opacity="{opacity}"/>'


def rr(x, y, w, h, r, fill="#fff", opacity=1.0):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" '
            f'fill="{fill}" opacity="{opacity}"/>')


def tile(color=ORANGE):
    return f'<rect x="2" y="2" width="124" height="124" rx="28" fill="{color}"/>'


# 1 —— 一排三张标签,中间那张是当前(实心),两侧半透
def c_strip3():
    return (tab(16, 44, 28, 46, 8, opacity=.5)
            + tab(50, 44, 28, 46, 8, opacity=1)
            + tab(84, 44, 28, 46, 8, opacity=.5))


# 2 —— 三张标签 + 一条组杠(整组共用底杠)
def c_strip3_bar():
    return (tab(16, 38, 28, 42, 8, opacity=.5)
            + tab(50, 38, 28, 42, 8, opacity=1)
            + tab(84, 38, 28, 42, 8, opacity=.5)
            + rr(16, 84, 96, 10, 5, opacity=.95))


# 3 —— 白色组板里装三张橙色标签(小组容器)
def c_plate3():
    return (rr(12, 34, 104, 62, 16, opacity=.18)
            + tab(26, 46, 22, 40, 7, fill=ORANGE)
            + tab(53, 46, 22, 40, 7, fill=ORANGE)
            + tab(80, 46, 22, 40, 7, fill=ORANGE))


# 4 —— 两张标签叠放(经典的"多标签"),前面一张实心
def c_two():
    return (tab(24, 40, 52, 52, 11, opacity=.45)
            + tab(48, 30, 56, 58, 12, opacity=1))


# 5 —— 扇形三张(标签叠放、逐级抬起),最前一张最大
def c_fan3():
    return (tab(18, 50, 46, 46, 10, opacity=.34)
            + tab(34, 38, 46, 50, 10, opacity=.58)
            + tab(52, 24, 54, 58, 11, opacity=1))


# 6 —— 竖向排布三张标签(标签列表),中间一张是当前
def c_stack():
    return (tab(22, 24, 84, 26, 8, opacity=.45)
            + tab(22, 54, 84, 26, 8, opacity=1)
            + tab(22, 84, 84, 26, 8, opacity=.45))


# 7 —— 标签条:三张标签嵌在一条底槽上(标签栏本体)
def c_tabbar():
    return (rr(14, 70, 100, 14, 7)          # 底槽 / 工具栏
            + tab(22, 34, 26, 38, 8, opacity=.55)
            + tab(50, 34, 26, 38, 8, opacity=1)
            + tab(78, 34, 26, 38, 8, opacity=.55))


# 8 —— 一组标签用一个"括号容器"框住(组)
def c_bracket():
    return (rr(12, 40, 104, 56, 16, opacity=.16)
            + tab(24, 34, 22, 42, 7, opacity=.55)
            + tab(52, 34, 22, 42, 7, opacity=1)
            + tab(80, 34, 22, 42, 7, opacity=.55))


CANDIDATES = {
    "1-strip3": c_strip3,
    "2-strip3+bar": c_strip3_bar,
    "3-plate3": c_plate3,
    "4-two": c_two,
    "5-fan3": c_fan3,
    "6-stack": c_stack,
    "7-tabbar": c_tabbar,
    "8-bracket": c_bracket,
}


def svg(body, px=S):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" '
            f'viewBox="0 0 {S} {S}">{tile()}{body}</svg>')


def render(markup, px, path):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{{margin:0;'
            f'background:transparent;overflow:hidden}}</style></head><body>{markup}</body></html>')
    hp = os.path.join(OUT, "_" + os.path.basename(path) + ".html")
    open(hp, "w").write(html)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=1", f"--window-size={px},{px}",
                    "--default-background-color=00000000", f"--screenshot={path}",
                    f"file://{hp}"], check=True, capture_output=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    rows = []
    for name, fn in CANDIDATES.items():
        body = fn()
        for px in (128, 32, 16):
            render(svg(body, px), px, os.path.join(OUT, f"tb_{name}_{px}.png"))
        rows.append(
            f'<div class="row"><span class="lbl">{name}</span>'
            f'<img src="tb_{name}_128.png" width="92">'
            f'<img class="pix" src="tb_{name}_32.png" width="64">'
            f'<img class="pix" src="tb_{name}_16.png" width="48">'
            f'<img class="pix" src="tb_{name}_16.png" width="16"></div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#eef1f5;font:11px -apple-system;color:#5a616b;padding:16px}'
            '.row{display:flex;align-items:flex-end;gap:18px;margin-bottom:10px}'
            '.lbl{width:92px}.pix{image-rendering:pixelated}img{display:block}'
            '</style></head><body>' + "".join(rows) + '</body></html>')
    p = os.path.join(OUT, "tabs_sheet.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "tabs_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=520,780",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
