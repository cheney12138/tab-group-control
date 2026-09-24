# 铁律:提交信息里禁止 AI 助手署名尾注

**本仓库的提交、以及由本仓库协作产生的任何提交,禁止出现 AI 助手的署名尾注。** 一个都不准 —— 不限于 Claude,任何 AI 工具的自称署名(`Co-authored-by:` 尾注里出现 AI 厂商名/邮箱域,或 `Generated with <AI>` 一类行)都不准进提交信息。

这条不是"偏好",是**铁律**:它有一条真实的、代价很重的病例。

## 病例(2026-09-24):署名能删,名单删不掉

早前的工具链往提交里塞了 `Co-authored-by:` + AI 署名。发现后用改写历史 + force-push 清洗过,`main` 的 61 个提交里确实**一个署名都不剩**了。但 GitHub 首页侧栏的「Contributors」**照样挂着那个 AI 名字**。

挖下去才发现 GitHub 有**两份**贡献者数据:

| 数据源 | 怎么算的 | 改写历史之后 |
|---|---|---|
| `/repos/…/stats/contributors`、`/graphs/contributors-data` | 按**提交图重算** | 立刻干净 ✅ |
| **`/<owner>/<repo>/_sidebar`**(首页侧栏读的那份) | 仓库记录上的**累加名单** | **纹丝不动** ❌ |

那份累加名单**只增不减**:提交被改写没了,它也不会把人去掉。而且它**不是 HTTP 缓存** —— 加全新查询串、带 `Cache-Control: no-cache`,响应头也写着 `cache-control: no-cache`,返回的仍是旧名单。所以"再改写一次历史"这条路是死的。

最后能用的手段只有**换一个仓库对象**。当时的账:0 star / 0 fork / 0 watcher / 0 issue / 0 PR / 0 release / 无 Pages / wiki 为空 —— 于是删库重建,代价为零。**如果这个仓库有 star、issue、PR,这就是一笔真损失。**

⇒ 结论写成本条铁律的根据:**这类署名一旦落进远端,就没有"事后清干净"的可靠办法。唯一的防线是写下的那一刻就拦住。**

## 执行(三层,都在 `git-hooks/`)

| 层 | 文件 | 时机 | 动作 |
|---|---|---|---|
| 一 | `commit-msg` | 每次 `git commit` | **就地删掉**署名行,打印提示,提交照常成功(消息干净) |
| 二 | `pre-push` | 每次 `git push` | 扫**将要推上去的每一个提交**,命中则**拒绝推送**并列出行号与修法 |
| 三 | `install.sh` | 换机器时手动跑一次 | 装到 `~/.githooks` 并设 `core.hooksPath`,换电脑后一条命令复原 |

判定逻辑只有一份:`ai-trailer-guard.py`(`strip` / `check` 两模式)。名单(要加要减的 AI 名与邮箱域)集中在文件顶部的 `AI_NAMES` / `AI_DOMAINS`,**只改那一处**。

**为什么必须有第二层**:第一层只在"这台机器用它自己的 `git commit`"时生效。`--no-verify`、别的电脑上没装钩子、IDE 内置提交、GitHub 网页端提交 —— 这些路径第一层都够不着,所以推送前必须再扫一遍。

装/卸:

```bash
./git-hooks/install.sh                              # 装(会备份 ~/.githooks 里的旧文件)
git config --global --unset core.hooksPath          # 卸
```

## 边界(避免把铁律执行成误伤)

- **只管署名,不管内容。** 正文、注释、文档里提到 AI 名字(包括本文件)一律不管 —— 那是技术信息,不是署名声明。
- **不误伤人类共同作者。** `Co-Authored-By: 张三 <zhangsan@example.com>` 原样保留。名单里刻意不收 `Cody` / `Cline` / `Zed` / `Continue` 这类**会撞真人姓名**的短词,把它们交给邮箱域去认。
- **已知取舍**:按邮箱域识别时,`@sourcegraph.com`、`@zed.dev` 这类域下的**真人**同事也会被删。它只作用于 `Co-authored-by` 行,而本仓库不存在这类人类共同作者,所以接受。名单可随时按需增删。
- **逃生门**:`git push --no-verify` 能绕过第二层。它是留给"确实要带署名推上去"的极其罕见场景的,不是日常开关 —— 用了就等于把这条铁律作废一次。

## 自检(想确认守卫还活着)

```bash
printf 'x\n\nCo-authored-by: <AI 名> <noreply@<厂商>.com>\n' > /tmp/m.txt
~/.githooks/commit-msg /tmp/m.txt && cat /tmp/m.txt      # 第 3 行应被删掉
git log origin/main..HEAD --format='%B' | grep -nEi '^\s*co-authored-by\s*:'   # 应无输出
```
