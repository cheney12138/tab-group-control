#!/usr/bin/env python3
"""Tab Group Search 图标候选草图。

产品:Chrome 扩展,按分组搜索并切换标签页 + 按域名自动分组。
默认主题 = slate + accent `#387BE5`;组色 = Chrome 官方九色(GROUP_COLORS)。
图标要在 16px 工具条上认得出 —— 所以先出草图,放大 + 实尺寸并排看,定稿再按档位出图。
"""

import os
import subprocess

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "build")

S = 128.0
ACCENT = "#387BE5"
ACCENT_HI = "#5B9BFF"
ACCENT_LO = "#2768CC"
YELLOW = "#FDD663"   # Chrome 组色·暖黄
GREEN = "#81C995"    # Chrome 组色·草绿


def bg():
    return f'''
    <defs>
      <linearGradient id="bg" x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0" stop-color="{ACCENT_HI}"/>
        <stop offset="0.55" stop-color="{ACCENT}"/>
        <stop offset="1" stop-color="{ACCENT_LO}"/>
      </linearGradient>
      <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity=".28"/>
        <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
      <filter id="sh" x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#1b3f7a" flood-opacity=".35"/>
      </filter>
    </defs>
    <rect x="3" y="3" width="122" height="122" rx="30" fill="url(#bg)" filter="url(#sh)"/>
    <rect x="3" y="3" width="122" height="122" rx="30" fill="url(#gloss)"/>'''


def bar(x, y, w, h, r, fill="#fff", opacity=1.0):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" '
            f'fill="{fill}" opacity="{opacity}"/>')


def tabshape(x, y, w, h, r, fill="#fff", opacity=1.0):
    d = (f"M{x} {y+h} V{y+r} Q{x} {y} {x+r} {y} "
         f"H{x+w-r} Q{x+w} {y} {x+w} {y+r} V{y+h} Z")
    return f'<path d="{d}" fill="{fill}" opacity="{opacity}"/>'


def magnifier(cx, cy, rr, sw, fill="none", stroke="#fff", handle=True):
    s = (f'<circle cx="{cx}" cy="{cy}" r="{rr}" fill="{fill}" stroke="{stroke}" '
         f'stroke-width="{sw}"/>')
    if handle:
        import math
        a = math.radians(45)
        x1 = cx + rr * math.cos(a); y1 = cy + rr * math.sin(a)
        x2 = x1 + 13 * math.cos(a); y2 = y1 + 13 * math.sin(a)
        s += (f'<path d="M{x1:.1f} {y1:.1f} L{x2:.1f} {y2:.1f}" stroke="{stroke}" '
              f'stroke-width="{sw+1.4}" stroke-linecap="round"/>')
    return s


# A —— 三根标签柱 + 组色底杠(分组)
def cand_group():
    b = [bar(34, 44, 16, 40, 6), bar(56, 30, 16, 54, 6), bar(78, 44, 16, 40, 6)]
    b.append(bar(28, 90, 72, 11, 5.5, fill=YELLOW))
    return "".join(b)


# B —— 标签页 + 放大镜(搜索)
def cand_search():
    b = [tabshape(22, 26, 62, 66, 12)]
    b.append(f'<rect x="34" y="38" width="24" height="9" rx="4.5" fill="{ACCENT}" opacity=".55"/>')
    b.append(f'<rect x="34" y="55" width="38" height="9" rx="4.5" fill="{ACCENT}" opacity=".38"/>')
    b.append(f'<rect x="34" y="72" width="30" height="9" rx="4.5" fill="{ACCENT}" opacity=".38"/>')
    b.append(f'<circle cx="88" cy="84" r="17" fill="{ACCENT}"/>')
    b.append(magnifier(88, 84, 16, 6))
    b.append(f'<path d="M85 84l2.4 2.4 4.6-5" stroke="{ACCENT}" stroke-width="3.4" '
             f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
    return "".join(b)


# C —— 三张标签页扇形叠放(多标签/切换)
def cand_fan():
    b = [tabshape(20, 40, 44, 52, 10, opacity=.42)]
    b.append(tabshape(42, 32, 44, 52, 10, opacity=.7))
    b.append(tabshape(64, 24, 44, 52, 10, fill="#fff"))
    b.append(f'<rect x="76" y="38" width="20" height="7" rx="3.5" fill="{ACCENT}" opacity=".5"/>')
    return "".join(b)


# D —— 放大镜里三根标签柱(搜索 + 标签)
def cand_lens():
    b = [magnifier(60, 58, 34, 8, fill="#ffffff", handle=False)]
    b.append(f'<path d="M84 82 L100 98" stroke="#fff" stroke-width="12" stroke-linecap="round"/>')
    b.append(bar(46, 42, 10, 20, 4, fill=ACCENT, opacity=.9))
    b.append(bar(60, 36, 10, 32, 4, fill=ACCENT))
    b.append(bar(74, 42, 10, 20, 4, fill=ACCENT, opacity=.9))
    return "".join(b)


# E —— 标签页 + 组色底条(分组),搜索用"选中高亮"暗示
def cand_tabgroup():
    b = [tabshape(24, 30, 38, 46, 9, opacity=.5)]
    b.append(tabshape(48, 22, 38, 46, 9, opacity=.75))
    b.append(tabshape(72, 30, 32, 46, 9, opacity=.5))
    b.append(bar(26, 86, 76, 12, 6, fill=GREEN))
    return "".join(b)


# F —— 浏览器标签页(圆顶)+ 放大镜
def cand_tabsearch():
    b = [tabshape(16, 22, 66, 68, 13)]
    b.append(f'<rect x="28" y="34" width="42" height="8" rx="4" fill="{ACCENT}" opacity=".30"/>')
    b.append(f'<rect x="28" y="50" width="30" height="8" rx="4" fill="{ACCENT}" opacity=".22"/>')
    b.append(f'<rect x="28" y="66" width="36" height="8" rx="4" fill="{ACCENT}" opacity=".22"/>')
    b.append('<circle cx="88" cy="88" r="21" fill="#fff"/>')
    b.append(f'<circle cx="88" cy="88" r="16" fill="{ACCENT}"/>')
    b.append('<path d="M78 88l3.4 3.4 6.6-7" stroke="#fff" stroke-width="3.6" fill="none" '
             'stroke-linecap="round" stroke-linejoin="round"/>')
    b.append('<path d="M101 101 L112 112" stroke="#fff" stroke-width="13" stroke-linecap="round"/>')
    b.append(f'<path d="M101 101 L112 112" stroke="{ACCENT}" stroke-width="7" stroke-linecap="round"/>')
    return "".join(b)


# G —— 放大镜里装一组标签(搜索 + 分组)
def cand_lensgroup():
    b = [magnifier(58, 54, 34, 8, fill="#fff", handle=False)]
    b.append('<path d="M83 79 L99 95" stroke="#fff" stroke-width="14" stroke-linecap="round"/>')
    b.append(f'<path d="M83 79 L99 95" stroke="{ACCENT}" stroke-width="7" stroke-linecap="round"/>')
    b.append(tabshape(41.5, 43, 9, 18, 3, fill=ACCENT, opacity=.72))
    b.append(tabshape(53.5, 35, 9, 26, 3, fill=ACCENT))
    b.append(tabshape(65.5, 43, 9, 18, 3, fill=ACCENT, opacity=.72))
    b.append(bar(40, 65, 36, 7, 3.5, fill=GREEN))
    return "".join(b)


CANDIDATES = {
    "A-group": cand_group,
    "B-search": cand_search,
    "C-fan": cand_fan,
    "D-lens": cand_lens,
    "E-tabgroup": cand_tabgroup,
    "F-tabsearch": cand_tabsearch,
    "G-lensgroup": cand_lensgroup,
}


def svg(body, px=S):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" '
            f'viewBox="0 0 {S} {S}">{bg()}{body}</svg>')


def _render(name, body, px, path):
    html = (f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{{margin:0;'
            f'background:transparent;overflow:hidden}}</style></head><body>'
            f'{svg(body, px)}</body></html>')
    hp = os.path.join(OUT, f"_{name}_{px}.html")
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
        p128 = os.path.join(OUT, f"lg_{name}_128.png")
        p32 = os.path.join(OUT, f"lg_{name}_32.png")
        p16 = os.path.join(OUT, f"lg_{name}_16.png")
        _render(name, body, 128, p128)
        _render(name, body, 32, p32)
        _render(name, body, 16, p16)
        rows.append(
            f'<div class="row"><span class="lbl">{name}</span>'
            f'<img src="lg_{name}_128.png" width="96">'
            f'<img class="pix" src="lg_{name}_32.png" width="64">'
            f'<img class="pix" src="lg_{name}_16.png" width="48">'
            f'<img class="pix" src="lg_{name}_16.png" width="16">'
            f'</div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
            'body{margin:0;background:#f2f4f7;font:11px -apple-system;color:#5a616b;padding:18px}'
            '.row{display:flex;align-items:flex-end;gap:20px;margin-bottom:12px}'
            '.lbl{width:80px}.pix{image-rendering:pixelated}img{display:block}'
            '</style></head><body>' + "".join(rows) + '</body></html>')
    p = os.path.join(OUT, "logo_sheet.html")
    open(p, "w").write(html)
    png = os.path.join(OUT, "logo_sheet.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=560,780",
                    "--default-background-color=ffffffff", f"--screenshot={png}",
                    f"file://{p}"], check=True, capture_output=True)
    print(png)


if __name__ == "__main__":
    main()
