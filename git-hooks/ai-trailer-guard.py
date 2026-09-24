#!/usr/bin/env python3
# 铁律执行器: 提交信息里不准出现 AI 助手的署名尾注(见 docs/adr/0008)。
#
# 为什么值得写成代码而不是"注意一下":
#   病例(2026-09-24): 早前工具链往提交里塞了 `Co-Authored-By: Claude ...`。事后用
#   改写历史 + force-push 清掉了提交图里的署名(按提交图重算的 /stats/contributors 已干净),
#   但 GitHub 首页侧栏读的是仓库记录上那份**只增不减的累加名单**, 改写历史动不了它 ——
#   加缓存破除参数也没用(响应头 cache-control: no-cache 照样返回旧名)。最终只能**删库重建**。
#   ⇒ 唯一可靠的防线是**在写下的那一刻就拦住**。
#
# 两种模式:
#   strip <COMMIT_EDITMSG>   commit-msg 钩子用: 就地删掉署名行, 打印提示, 退出 0
#   check <rev-range...>     pre-push 钩子用: 扫将要推送的提交, 命中则列出并退出 1
#
# 只认"署名", 不认"内容": 正文里提到 AI 名字(比如本文件、ADR)一律不管。
# 也不误伤人类共同作者 —— 名单只放 AI 专有的名字/邮箱域。

import re
import subprocess
import sys

# ---- 名单: 要加/减 AI, 只改这一处 --------------------------------------------
# 名字: 用词边界匹配。刻意**不**收有歧义的短词(Cody / Cline / Zed / Continue),
# 它们撞真人姓名, 改由下面的邮箱域兜住。
AI_NAMES = r"""claude|anthropic|openai|chatgpt|copilot|codex|gemini|windsurf|codeium|
tabnine|qodo|aider|devin|sourcegraph|qwen|deepseek|doubao|comate|catpaw|cursor|
augmentcode|poolside|magic\.dev|sweep|junie|trae|bolt\.new|v0\.dev|lovable"""

# 邮箱域: 只有邮箱、没写名字的写法(如 `Co-Authored-By: <noreply@anthropic.com>`)靠这里认出来
AI_DOMAINS = r"""anthropic\.com|openai\.com|cursor\.(?:com|sh)|aider\.chat|continue\.dev|
sourcegraph\.com|zed\.dev|cline\.bot|kilo\.ai|roocode|codeium\.com|tabnine\.com|qodo\.ai|
windsurf\.com|devin\.ai|cognition\.ai|augmentcode\.com|poolside\.ai|sweep\.dev|
google\.com/gemini|amazonaws\.com/amazon-q"""

# 署名尾注行: **冒号前允许空白**(git 与 GitHub 都认 `Co-authored-by : X` —— 旧钩子漏的写法之一)
TRAILER = re.compile(r'^\s*co-authored-by\s*:', re.I)
NAME_HIT = re.compile(r'\b(?:%s)\b' % re.sub(r'\s+', '', AI_NAMES), re.I)
DOMAIN_HIT = re.compile(r'@(?:%s)\b' % re.sub(r'\s+', '', AI_DOMAINS), re.I)
# "Generated with ..." 家族(有的工具不写 co-author, 写这一行)
GENERATED = re.compile(r'^\s*(?:🤖\s*)?(?:generated with|made with|written by)\b', re.I)


def is_ai_trailer(line: str) -> bool:
    if TRAILER.match(line):
        return bool(NAME_HIT.search(line) or DOMAIN_HIT.search(line))
    if GENERATED.match(line):
        # "Generated with" 后必须真的点名某个 AI, 免得误伤"Generated with make"
        return bool(NAME_HIT.search(line) or DOMAIN_HIT.search(line))
    return False


def strip(msg_file: str) -> int:
    with open(msg_file, encoding='utf-8') as f:
        lines = f.read().splitlines()
    kept = [l for l in lines if not is_ai_trailer(l)]
    while kept and not kept[-1].strip():
        kept.pop()
    if kept != lines:
        with open(msg_file, 'w', encoding='utf-8') as f:
            f.write('\n'.join(kept) + '\n')
        print('[commit-msg] 已移除 AI 助手署名尾注(铁律见 docs/adr/0008)', file=sys.stderr)
    return 0


def check(ranges: list) -> int:
    shas = []
    for rng in ranges:
        try:
            out = subprocess.run(['git', 'rev-list', rng], capture_output=True, text=True, check=True)
        except subprocess.CalledProcessError as e:
            print(f'[pre-push] 无法解析范围 {rng}: {e.stderr.strip()}', file=sys.stderr)
            continue
        shas.extend(out.stdout.split())
    bad = []
    for sha in shas:
        body = subprocess.run(['git', 'log', '-1', '--format=%B', sha],
                              capture_output=True, text=True).stdout
        hit = [l for l in body.splitlines() if is_ai_trailer(l)]
        if hit:
            subject = body.splitlines()[0] if body else ''
            bad.append((sha, subject, hit[0]))
    if not bad:
        return 0
    print('\n[pre-push] 拒绝推送: 以下提交带 AI 助手署名尾注(铁律见 docs/adr/0008)\n', file=sys.stderr)
    for sha, subject, line in bad:
        print(f'  {sha[:9]}  {subject}', file=sys.stderr)
        print(f'            问题行: {line.strip()}', file=sys.stderr)
    print('\n  修法(任选其一):', file=sys.stderr)
    print('    1) 只改最新提交:  git commit --amend  (钩子会自动删掉署名行)', file=sys.stderr)
    print('    2) 改历史里某一笔: git rebase -i <base> 然后 edit 那一笔重写', file=sys.stderr)
    print('    3) 批量清洗:      git filter-repo --message-callback ...', file=sys.stderr)
    print('  确认要带署名推上去(不推荐): git push --no-verify\n', file=sys.stderr)
    return 1


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'strip' and len(sys.argv) > 2:
        sys.exit(strip(sys.argv[2]))
    if mode == 'check':
        sys.exit(check(sys.argv[2:]))
    print('用法: ai-trailer-guard.py strip <COMMIT_EDITMSG> | check <rev-range...>', file=sys.stderr)
    sys.exit(0)
