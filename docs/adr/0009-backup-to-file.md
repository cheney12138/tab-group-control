# 配置备份:把规则落成磁盘上的一个文件

规则与设置都住在 `chrome.storage.local`。**那个库是按扩展 id 隔离、卸载时连库一起删的**,所以"卸载/重装插件之后规则全没了"不是 bug,是它的默认行为。本决定给出唯一能活过卸载的载体:**下载目录里的一份 JSON**,并在设置页开一个「文件位置」的口子,点一下在访达里选中它。

## 病例(2026-10-08):"重装之后规则全没了"

用户的直觉是"没落盘吧?是不是写在插件目录里跟着一起被删了"。查下来的事实是:**落盘了,但落在 Chrome 自己的扩展存储里** ——

```
~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/<扩展id>/
```

插件目录对扩展**只读**:Chrome 没有任何 API 能让扩展往自己目录里写文件,所以"跟着卸载被删"这个猜测不成立,真正发生的是**Chrome 把上面那个 `<扩展id>/` 整个删掉**。

用探针扩展实测过一轮(装 → 写三个区 → 卸载 → 重装):

| 存储区 | 卸载后 |
|---|---|
| `chrome.storage.local` | **清空** |
| `chrome.storage.sync` | **清空** —— 所以"挪到 sync 就安全了"是条不成立的路 |
| `localStorage`(扩展 origin) | **清空** |

还有一个更阴的机制:**扩展 id = 目录路径的哈希**(`sha256(真实路径)` 前 16 字节映射到 `a-p`;`/tmp` 是软链要先解析成 `/private/tmp`,这点对着探针实测的 id 反推验证过)。于是**换个文件夹 Load unpacked、或者换台电脑,就是另一个 id、另一个空库** —— 表现出来一模一样是"规则全没了",其实数据还在原抽屉里。

⇒ 结论:**唯一能活过"卸载 / 清 profile / 换机器"的载体,是磁盘上一个普通文件。**

## 决定

### 落点与格式

- 文件:`~/Downloads/tab_group_rule_bak.json`(名字是用户指定的),固定文件名 + `conflictAction: 'overwrite'`。
  选它是因为**同名原地覆盖**:不会堆出 `backup (1).json`,也不必每次弹保存框(实测:文档里用 `data:` URL 就能触发下载,无手势要求)。
- 格式:`{ format: "tgs-backup", version: 1, app, exportedAt, counts, data: { local, prefs } }`。
  `counts` 是冗余的,只为"人肉打开文件时一眼看出这份备份里有多少东西"。
- 内容 = **用户配出来的东西**,两份来源都要收:
  | 来源 | 键 |
  |---|---|
  | `chrome.storage.local` | `groupRules` / `autoGroupEnabled` / `othersGroupEnabled` / `forceMotionEnabled` |
  | `localStorage` | `tgs-theme` / `tgs-accent` / `tgs-accent-linear` / `tgs-deletekey` / `tgs-showurl` / `tgs-force-motion` / `tgs-collapsed` / `tgs-view` |
- **刻意不收**(每条都有理由,不是漏):
  | 键 | 为什么不收 |
  |---|---|
  | `archivedGroups` | 归档卡是"拍一下就关掉整组标签"的暂存车票,ADR-0001/CONTEXT 定的口径就是仅存本机、卸载即焚。它不是配置。**要改这条得先改文档** |
  | `manualTabIds` | tabId 一重启浏览器就失效,存下来没有意义 |
  | `hasArchiveUnread` / `groupRulesInit` | 运行时标记 |
  | `autoBackupEnabled` / `backupState` | 备份自己的元数据,恢复时不该被旧机器覆盖 |

### 写在弹窗侧,不写进 background

备份内容一半在 `chrome.storage.local`、一半在 `localStorage`(settings.js 靠它做首帧同步镜像)。而 **service worker 里没有 `localStorage`** —— 只有文档侧(弹窗)能同时读到两边。好在"用户能改的配置都是从弹窗改的",触发点于是收成两处就够:**面板打开时** + **面板关掉时**(`pagehide`),外加开面板期间 `chrome.storage.onChanged` 即时落。

**代价如实记下**:只改外观(主题/突出色)又当场卸载,那一次会漏 —— 下次开面板补上(丢的也只是外观偏好,不是规则)。

### 免打扰的三道闸

1. **内容指纹**:只比对 `data` 部分(djb2),一致就不写 —— 面板每次打开都会走到这里,不加闸就是"每开一次弹窗写一个文件"。
2. **防抖**:开面板期间改配置延迟 1.2s 落一次。
3. **只留最新一条下载记录**:否则每改一次规则,下载列表里就多一行同名记录。

## 病例二(2026-10-08):一把删不掉, 而且它不出声

第 3 道闸原本是 `erase({ id: [a, b] })` 一把删。文档说 `id` 可以给数组,**运行时却只接受单个整数**:

```
Error in invocation of downloads.erase(...): Error at property 'id':
Invalid type: expected integer, found array.
```

坏在它被外面的 `catch` 吞了 —— 表现成"清理悄悄失效"(下载列表越堆越多),没有任何动静。现在逐个 id 删。
**教训:这种"失败也不出声"的清理逻辑,必须有测试盯着结果**(测试 ③ 里那条"只留最新一条"就是为它写的)。

另外用的是 `erase` 而不是 `removeFile`:`erase` 只摘历史记录,**不动磁盘上的文件** —— 这点单独实测过(同名写两次 → 删掉前一条 → 文件还在,内容是第二次的),否则"清理下载记录"会把备份本身删掉。

## 「文件位置」这个口子

设置页「功能」里一行:**备份文件 → 〔文件位置〕**,点一下 `chrome.downloads.show(id)` 在访达里选中该文件。
下载记录被清过、或从没备份过 → 退化成 `showDefaultFolder()` 打开下载文件夹,并提示"还没有备份文件"。

为了这一行,manifest 新增 `"downloads"` 权限(提示语是"管理您的下载内容")。**这是整个功能的唯一新增权限** —— 没有它,既不能自动写文件,也不能在访达里定位文件。

## 恢复

设置页「功能」→「从备份恢复」→ 选文件。规则/开关/外观一起写回,随后 `location.reload()`——
面板是"开的时候读一次 storage"的结构,而恢复可能连带换掉主题、收起集合、撤销栈,逐块刷新很难一致,**重载是唯一一致的做法**。

写入走**白名单**:只认上表里的键。手改过的、或者别人塞进来的 JSON 无法往库里写别的键(测试里用 `野生键` / `tgs-evil` 验过)。

## 边界

- **不是同步,也不碰账号。** 不登录 Chrome 账号、不做云端、不做多机合并;整个备份只用到
  `chrome.storage.local` + `chrome.downloads` 两个本地 API,**不发任何网络请求**
  (全仓库没有 `fetch` / `XMLHttpRequest` / `WebSocket`,也没有 `chrome.identity`,
  `storage.sync` 一处都没用)。要跨机器就自己把那个 JSON 拷过去。
- **不是归档的备份。** 见上表。
- **恢复会覆盖,不合并。** 规则以备份为准(与规则编辑器里"导入 JSON"的合并语义不同 —— 那是编辑器内的操作,这是整库恢复)。

## 自检

```bash
# 当前库里有什么(离线读 Chrome 的 leveldb, 取每个键最后一次写入)
# 备份文件在不在、内容对不对
cat ~/Downloads/tab_group_rule_bak.json | head -20
```
