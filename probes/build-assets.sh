#!/bin/bash
# 重新生成展示页用的真实样式资产: DOM 快照 + CSS + 图标
set -e
cd "$(dirname "$0")"
node snapshot.mjs
python3 - <<'PY'
import json, re, hashlib, os, shutil
root = '/Users/qianyuchen/tab-group-search'
p = root + '/site/assets/states.json'
d = json.load(open(p, encoding='utf-8'))
favs = {}
def repl(m):
    uri = m.group(1)
    k = hashlib.md5(uri.encode()).hexdigest()[:10]
    favs[k] = uri
    return f'__FAV:{k}__'
for name, st in d.items():
    st['html'] = re.sub(r'src="(data:[^"]+)"', lambda m: 'src="' + repl(m) + '"', st['html'])
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump(favs, open(root + '/site/assets/favicons.json', 'w', encoding='utf-8'), separators=(',', ':'))
# 产品样式表 / 图标
html = open(root + '/popup.html', encoding='utf-8').read()
open(root + '/site/assets/popup.css', 'w', encoding='utf-8').write(re.search(r'<style>(.*?)</style>', html, re.S).group(1))
os.makedirs(root + '/site/img', exist_ok=True)
for f in os.listdir(root + '/img'):
    if f.endswith('.png'): shutil.copy(root + '/img/' + f, root + '/site/img/' + f)
# 浅色锁定(从 popup.css 的浅色 token 搬出)
css = open(root + '/site/assets/popup.css', encoding='utf-8').read()
body = re.search(r':root\[data-theme="linear"\]\s*\{(.*?)\n    \}', css, re.S).group(1).replace('color-scheme: light dark;', 'color-scheme: light;')
m2 = re.search(r':root,\s*\n\s*:root\[data-theme="linear"\]\s*\{(.*?)\n    \}', css, re.S)
accents = re.findall(r':root\[data-theme="linear"\]\[data-accent="(\w+)"\]\s*\{([^}]*)\}', css)
lock = ['/* 由 popup.css 提取: 展示环境强制浅色(站点本身是浅色主题), 不改产品任何一处样式 */',
        'html[data-scheme="light"] { color-scheme: light; }',
        'html[data-scheme="light"][data-theme="linear"] {' + body + '\n}']
if m2: lock.append('html[data-scheme="light"][data-theme="linear"] {' + m2.group(1) + '\n}')
for n, v in accents: lock.append(f'html[data-scheme="light"][data-theme="linear"][data-accent="{n}"] {{{v}}}')
open(root + '/site/assets/light-lock.css', 'w', encoding='utf-8').write('\n'.join(lock))
print('states', os.path.getsize(p)//1024, 'KB | favicons', len(favs), '| css', os.path.getsize(root+'/site/assets/popup.css')//1024, 'KB')
PY
