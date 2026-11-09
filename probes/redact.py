#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实截图打码: 遮盖敏感文字区域, 用相同样式写上中性文案。
策略: 从遮盖区域边缘采样背景色 -> 填充 -> 以原字号/字重/颜色重绘文字。
favicon / 布局 / 时间标签全部保留, 成品看起来就是原生截图。"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import sys

SRC = '/var/folders/db/gsfg658n5j959075my3bdwjw0000gn/T'
OUT = '/Users/qianyuchen/tab-group-search/site/shots'
PF = '/System/Library/Fonts/Hiragino Sans GB.ttc'

def font(size, weight=1):
    # Hiragino Sans GB.ttc 索引: 0=Regular(W3) 1=Semibold(W6)
    return ImageFont.truetype(PF, size, index=min(weight, 1))

def cover(draw, img, box, pad=2):
    """用区域左缘采样的背景色填充遮盖矩形(处理选中行/普通行两种底色)"""
    x0, y0, x1, y1 = box
    sx = max(0, x0 - 6)
    strip = img.crop((sx, y0, sx + 2, y1))
    colors = strip.getcolors(9999)
    bg = max(colors)[1] if colors else (255, 255, 255)
    draw.rectangle([x0 - pad, y0 - pad, x1 + pad, y1 + pad], fill=bg)
    return bg

def text(draw, xy, s, size, color, weight=1):
    draw.text(xy, s, font=font(size, weight), fill=color)

# 颜色(与截图一致)
TITLE = (8, 9, 10)
URL = (156, 163, 175)
TIME_HOT = (21, 128, 61)
TIME_INFO = (94, 106, 210)
TIME_MID = (156, 163, 175)
GROUP = (94, 106, 130)
DANGER = (220, 38, 38)

def process(src_name, out_name, ops):
    img = Image.open(f'{SRC}/{src_name}').convert('RGB')
    draw = ImageDraw.Draw(img)
    for op in ops:
        kind = op[0]
        if kind == 'cover':
            _, box, pad = op
            cover(draw, img, box, pad)
        elif kind == 'text':
            _, xy, s, size, color, weight = op
            text(draw, xy, s, size, color, weight)
    img.save(f'{OUT}/{out_name}')
    print('✓', out_name)

# ============ 1. 当前窗口视图 ============
# 行结构: 每行高约 86px, 标题 y0, URL y0+42
rows1 = [
    # (标题y, URL y, 新标题, 新URL, 时间色)
    (196, 238, 'Tab Group Search — 几百个标签页,一个弹窗管好', 'github.com/cheney12138/tab-group-control', None),
    (282, 324, 'React 官方文档 · Hooks 参考', 'react.dev', None),
    (368, 410, 'Tab Group Search — 几百个标签页,一个弹窗管好', 'github.com/cheney12138/tab-group-control', None),
    (454, 496, 'MDN · Array.prototype 方法速查', 'developer.mozilla.org', None),
    (540, 582, 'Lion', 'config · lion.dev', None),
    (626, 668, 'Herdr: no two look alike', 'herdr.dev', None),
    (712, 754, 'ELY-Open-Source/ELYTerminal: A terminal on GPU...', 'github.com', None),
    (798, 840, 'Cargo', 'crates.io', None),
    (884, 926, 'Your Repositories', 'github.com', None),
]
ops = []
for y0, y1, t, u, _ in rows1:
    ops.append(('cover', (105, y0, 870, y0 + 34), 2))
    ops.append(('text', (105, y0), t, 29, TITLE, 1))
    ops.append(('cover', (105, y1, 620, y1 + 28), 2))
    ops.append(('text', (105, y1), u, 24, URL, 1))
process('pi-clipboard-ee5df8e8-8791-40e1-9549-d4c6e01c4181.png', 'real-window.png', ops)

# ============ 2. 分组视图 ============
ops = [
    # 组头: mlt -> 工作, 学城 -> 学习, lion -> 娱乐, github 保留
    ('cover', (120, 296, 260, 336), 2), ('text', (120, 296), '工作', 29, TITLE, 2),
    ('cover', (120, 383, 260, 423), 2), ('text', (120, 383), '学习', 29, TITLE, 2),
    ('cover', (120, 470, 260, 510), 2), ('text', (120, 470), '娱乐', 29, TITLE, 2),
    # lion 组内三行(标题 Lion 保留, 改 URL)
    ('cover', (140, 570, 660, 596), 2), ('text', (140, 568), 'music.163.com', 24, URL, 1),
    ('cover', (140, 656, 660, 682), 2), ('text', (140, 654), 'bilibili.com', 24, URL, 1),
    ('cover', (140, 742, 660, 768), 2), ('text', (140, 740), 'youtube.com', 24, URL, 1),
]
process('pi-clipboard-a5578db9-ff54-40eb-8910-1692f75aa663.png', 'real-group.png', ops)

# ============ 3. 右键菜单 ============
ops = [
    # 组头: 学城 -> 工作
    ('cover', (120, 383, 260, 423), 2), ('text', (120, 383), '工作', 29, TITLE, 2),
    # 菜单项: 学城 -> 工作 (两处)
    ('cover', (498, 786, 800, 822), 2), ('text', (498, 786), '关闭「工作」全部标签 (29)', 27, DANGER, 1),
    ('cover', (498, 868, 720, 904), 2), ('text', (498, 868), '归档「工作」分组', 27, TITLE, 1),
    # 左侧文档标题逐行替换(标题区, 保留 favicon 和 URL 行)
    ('cover', (140, 438, 470, 472), 2), ('text', (140, 436), '保险协议列表页与协议详情页外部接入文档', 26, TITLE, 1),
    ('cover', (140, 524, 470, 558), 2), ('text', (140, 522), '20261027-火车票意外险保单', 26, TITLE, 1),
    ('cover', (140, 610, 470, 644), 2), ('text', (140, 608), '面向团队交付的智能体协作平台', 26, TITLE, 1),
    ('cover', (140, 696, 470, 730), 2), ('text', (140, 694), '11月保险优化方案规划及落地', 26, TITLE, 1),
    ('cover', (140, 1004, 470, 1038), 2), ('text', (140, 1002), '第二节:设计实践-下', 26, TITLE, 1),
]
process('pi-clipboard-2e240865-dda5-4259-9ae5-f5e112391c92.png', 'real-contextmenu.png', ops)

# ============ 4. 已归档 ============
ops = [
    ('cover', (108, 240, 200, 276), 2), ('text', (108, 240), '工作', 27, TITLE, 2),
]
process('pi-clipboard-7aed08a7-3773-41ce-a81d-07842024f141.png', 'real-archives.png', ops)

# ============ 5. 规则编辑器 ============
ops = [
    # 组名: 1024 -> 工作, BCP -> 学习
    ('cover', (96, 582, 260, 618), 2), ('text', (96, 580), '工作', 27, GROUP, 2),
    ('cover', (96, 744, 260, 780), 2), ('text', (96, 742), '学习', 27, GROUP, 2),
    # chip 文字替换(覆盖 chip 内部文字区, chip 是圆角灰底, 用 chip 底色填充)
    ('cover', (96, 634, 296, 668), 1), ('text', (96, 636), 'github.com', 24, (94, 106, 130), 1),
    ('cover', (96, 800, 330, 834), 1), ('text', (96, 802), 'zhihu.com', 24, (94, 106, 130), 1),
    ('cover', (340, 800, 640, 834), 1), ('text', (340, 802), 'douban.com', 24, (94, 106, 130), 1),
    ('cover', (96, 862, 330, 896), 1), ('text', (96, 864), 'wikipedia.org', 24, (94, 106, 130), 1),
]
process('pi-clipboard-2460464e-15ac-4ca6-a18d-7a28924cb178.png', 'real-rules.png', ops)

print('done')
