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

## 病例三(2026-10-08):装了下载管理器,文件名被抢走

**症状**:用户每次 `⌘E` 唤起面板,下载目录就多一个 `下载.json` / `下载 (1).json` / `下载 (2).json`……

查的顺序(每一步都是实测,不是推断):

1. **文件内容是我们的**(`format: tgs-backup`,18 组 / 47 域名)⇒ 确实是备份写出来的,不是别的东西在下载。
2. **Chrome 的下载历史**(拷一份 `History` 库读 `downloads` 表):那一条 `state=1`(完成)、目标路径就是
   `~/Downloads/下载 (2).json` ⇒ **是 Chrome 自己写的**这个文件,不是外部 App 落盘的。
3. **用户的下载偏好是默认值**(`Preferences` 里没有 `download.*`、没有 `prompt_for_download`)⇒ 排除"另存为对话框"一类解释。
4. **用户的 `Secure Preferences` 里有 NeatDownloadManager**(`cpcifbdmkopohnofedkjghjiclmhdah`,带 `downloads` + `webRequest` + `<all_urls>`)。
5. **直接读它的源码**(`Extensions/<id>/1.9.92_0/bg.js`)—— 关键两行:

   ```js
   chrome.downloads.cancel(a.id), chrome.downloads.erase({ id: a.id })   // onCreated: 取消 + 抹掉记录
   b.fileName = b.K || b.l || ""                                        // 名字只认 Content-Disposition / URL 末段
   ```

   它把每一次下载都取消掉、抹掉记录,然后**按 URL 自己重下一遍**;而重下的那一次**没有 filename**
   —— `data:` URL 既没有 Content-Disposition 也没有路径末段。于是 Chrome 用本地化的兜底名
   「下载」+ MIME 后缀 `.json`,并且 `conflictAction: 'overwrite'` 也一起丢了 ⇒ 每备份一次堆一个 `(1)/(2)`。
6. **本地复现**:写一个"复刻 NeatDM 行为"的假拦截者(只做 cancel + erase + 重下不带文件名),
   与 Chrome 155 一起跑 ⇒ 得到一模一样的 `下载.json`。同一个 Chrome 版本、干净环境 ⇒ 文件名正确。
   (顺带确认:这**不是** Chrome 版本行为变化 —— 用和用户同版本的 155 在干净环境里是对的。)

**修法(两层,都不重写下载管线)**:

| 层的 | 文件 | 做什么 |
|---|---|---|
| 抢回名字 | `background.js` 的 `onDeterminingFilename` | 只对"URL 是我们的备份载荷"那一条 `suggest({filename, conflictAction:'overwrite'})` —— 这样**不管是谁发起**的那次落盘,名字与覆盖语义都在。别人的下载**不调 suggest()**,不干扰下载管理器自己的命名 |
| 认准记录 | `features/backup.js` 的 `settleOwnItem` / `ownDownloadItems` | 被接管时真正落盘的是**另一条 id**。所以写完等一小会儿反查"最新的同名记录",用它去清理旧记录、去指向「文件位置」;`revealBackupFile` 每次现查,不迷信存下来的 id |

抢回名字这件事必须在**下载那一刻**做(所以放 `background.js`,它在下载事件上);而"哪条记录才算数"
是弹窗侧的账(所以放 `backup.js`)。文件名常量因此在两个文件里各有一份 —— **用测试钉住两者必须相等**。

**教训**:下载管线不是扩展的地盘 —— 任何装了下载管理器的用户,`filename` / `conflictAction` 都可能
被第三方改写或丢弃。所以别把"文件名对不对"当成理所当然,也别试图跟下载管理器抢控制权(只对自己那条表态)。
更不能像最初那样,把"清理旧记录"这种**失败也不出声**的逻辑写成一把 `erase({id:[...]})`(见病例二)。

## 什么时候会写(没有定时器)

| 时机 | 说明 |
|---|---|
| **面板打开** | 每次都走一遍, 但先对内容指纹 —— 一致就一个字节都不写 |
| **配置变更** | `groupRules` / `autoGroupEnabled` / `othersGroupEnabled` / `forceMotionEnabled` 任一变化 ⇒ 防抖 1.2s 后写一次 |
| **面板关闭** | `pagehide` 再兜一次(异步不保证送达, 但下一次开面板会补) |
| 手动 | 设置页「立即备份」 |
| **手动** | 「更改位置…」「用回默认」也会立刻写一份到新位置 |

**不是定时的** —— 没有"每 N 分钟备份一次"这种东西。刻意如此:内容没变就没有理由写盘。
唯一的空档是**外观类偏好**(主题/突出色等住 `localStorage`, 不走 `chrome.storage.onChanged`),
要等下次开/关面板才会落 —— 丢的也只是外观, 不是规则(理由见文件头)。

## 备份位置: 默认系统下载目录, 也可以自己挑

- **默认 = 系统下载目录**。`chrome.downloads.download` 的 `filename` 是**相对名**, 由 Chrome 自己落到"下载":
  macOS 是 `~/Downloads/…`, Windows 是 `C:\Users\<你>\Downloads\…` —— **一个相对名覆盖两端, 不需要扩展判平台**,
  这就是选它当默认的理由。
- **可选 = 自己挑文件**。设置页「备份位置 → 更改位置…」调系统原生保存框(`showSaveFilePicker`),
  句柄存 IndexedDB, 此后每次备份**直接写那个文件**。这条路的额外好处不只是"能放别处":
  完全**不经过下载管线** ⇒ 没有下载记录、不会有「已删除」、下载管理器(病例三)也插不进手。
- **自选模式下「文件位置」按钮收起**。原因写在代码里也说在这里: 浏览器**不把完整路径交给扩展**
  (`FileSystemFileHandle` 只有 `name`), 没有"在访达里选中它"的余地 —— 宁可把按钮换成「用回默认」,
  也不摆一个点了没用的按钮。位置本来就是用户自己挑的。
- **权限会掉回 `prompt`**: 此时 `createWritable()` 会被拒。自动备份**没有用户手势**, 不能弹授权, 于是
  **退回系统下载目录**并在 UI 上留一句人话(`state.hint`);手动点「立即备份 / 更改位置…」时借这次点击
  重新申请(`requestPermission`)即可继续写自选文件。**绝不静默失败**。
- 句柄住 IndexedDB ⇒ 它同样随卸载消失(**文件不会**)。重装后重新选一次, 或用「从备份恢复」。

### 下载记录里的「已删除」是什么意思

默认模式反复用同一个相对名覆盖同一个文件, Chrome 每次会新建一条下载记录, 我们随即把旧记录 `erase`
掉(只留最新一条, 免得下载页越堆越多)。于是当你把那个文件挪走或删掉(比如清理下载目录), Chrome 会在
下载页里把对应记录标成**「已删除」** —— 它标的是"这条记录指向的文件不在了", **不是"备份丢了"**。
实测对照: 同一列表里一个被清理过的 CSV 也显示「已删除」, 而它的文件确实已不在下载目录; 备份文件本身
(`counts` 是当时的 18 组 / 47 域名)则在原处、时间戳比那条记录更新。
嫌这些记录碍眼就切到自选位置 —— 那条路一条下载记录都不产生。

## 「文件位置」这个口子

设置页「功能」里一行:**备份文件 → 〔文件位置〕**,点一下 `chrome.downloads.show(id)` 在访达里选中该文件。
下载记录被清过、或从没备份过 → 退化成 `showDefaultFolder()` 打开下载文件夹,并提示"还没有备份文件"。
自选位置模式 → 明确回一个"定位不了"(见上节), 不假装能定位。

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
