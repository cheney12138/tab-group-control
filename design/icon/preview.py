#!/usr/bin/env python3
"""预览:尺寸梯度 + 工具条实景(读 `icons/` 里的真图)。"""

import os
import subprocess

from mark import svg, render, OUT, CHROME   # noqa: E402

REPO = os.path.abspath(os.path.join(OUT, "..", "..", ".."))
ICONS = os.path.join(REPO, "icons")


def url(name):
    return "file://" + os.path.join(ICONS, name)


def main():
    os.makedirs(OUT, exist_ok=True)
    # 确保 icons/ 是最新的定稿
    for px in (16, 32, 48, 128):
        render(svg(px=px), px, os.path.join(ICONS, f"icon{px}.png"))

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{{margin:0;width:820px;background:#eef1f5;font:12px -apple-system;color:#4b5563}}
.card{{padding:28px 32px}} h1{{font:600 15px -apple-system;margin:0 0 3px}}
p{{margin:0 0 20px;color:#7b8494}} .sizes{{display:flex;align-items:flex-end;gap:30px}}
figure{{margin:0;text-align:center}} img{{display:block}} .cap{{color:#98a1ad;font-size:10.5px;margin-top:6px}}
.bars{{display:flex;flex-direction:column;gap:12px;margin-top:22px}}
.bar{{height:38px;border-radius:8px;display:flex;align-items:center;justify-content:flex-end;padding:0 14px;gap:16px}}
.dark{{background:#202124}} .light{{background:#fff;border:1px solid #dadce0}}
.ph{{width:16px;height:16px;border-radius:3px}} .dark .ph{{background:#5f6368}} .light .ph{{background:#c4c8cd}}
.mg{{image-rendering:pixelated}}
</style></head><body><div class="card">
<h1>Tab Group Search · 图标</h1>
<p>黑白色 + 拟物:三张等高标签坐在标签栏上,最左那张最亮 = 当前。灰阶渐变 / 高光 / 斜面 / 投影</p>
<div class="sizes">
<figure><img src="{url('icon128.png')}" width="128"><div class="cap">128</div></figure>
<figure><img src="{url('icon48.png')}" width="48"><div class="cap">48</div></figure>
<figure><img src="{url('icon32.png')}" width="32"><div class="cap">32</div></figure>
<figure><img class="mg" src="{url('icon16.png')}" width="64"><div class="cap">16 · 8x</div></figure>
<figure><img src="{url('icon16.png')}" width="16"><div class="cap">16 实尺寸</div></figure>
</div>
<div class="bars">
<div class="bar dark"><span class="ph"></span><span class="ph"></span><img src="{url('icon32.png')}" width="16" height="16"><span class="ph"></span></div>
<div class="bar light"><span class="ph"></span><span class="ph"></span><img src="{url('icon32.png')}" width="16" height="16"><span class="ph"></span></div>
</div>
</div></body></html>"""
    p = os.path.join(OUT, "preview.html")
    open(p, "w").write(html)
    out = os.path.join(OUT, "preview.png")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--allow-file-access-from-files", "--virtual-time-budget=4000",
                    "--force-device-scale-factor=2", "--window-size=820,450",
                    "--default-background-color=ffffffff", f"--screenshot={out}",
                    f"file://{p}"], check=True, capture_output=True)
    print(out)


if __name__ == "__main__":
    main()
