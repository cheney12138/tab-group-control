# AI Coding 工具使用周报

- 用户：**cheney12138**
- 机器：Darwin 25.5.0 / MBP-VLQVYFHXJK-2339.local
- 统计窗口：最近 **7** 天（2026-10-26 ~ 2026-11-02）
- 生成时间：2026-11-02 16:00:38 CST

## 一、总览

| 工具 | 可用 | 会话数 | 消息数 | 用户/助手 | 活跃天 | 项目数 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Claude Code | ✅ | 8 | 8886 | 763 / 8123 | 8 | 2 |
| Codex | ✅ | 0 | 0 | 0 / 0 | 0 | 0 |
| Cursor | — | - | - | - | - | - |
| Catpaw (local) | ✅ | 3 | 61 | 24 / 37 | 1 | 2 |
| CatDesk | ✅ | 0 | 0 | 0 / 0 | 0 | 0 |
| opencode | — | - | - | - | - | - |

**合计**：11 个会话，8947 条消息，覆盖 8 个活跃日。

## 二、每日活跃

| 日期 | Claude Code | Codex | Catpaw (local) | CatDesk |
| --- | ---: | ---: | ---: | ---: |
| 2026-10-26 | 464 | 0 | 0 | 0 |
| 2026-10-27 | 2037 | 0 | 0 | 0 |
| 2026-10-28 | 2531 | 0 | 0 | 0 |
| 2026-10-29 | 1376 | 0 | 0 | 0 |
| 2026-10-30 | 1332 | 0 | 0 | 0 |
| 2026-10-31 | 553 | 0 | 0 | 0 |
| 2026-11-01 | 107 | 0 | 0 | 0 |
| 2026-11-02 | 486 | 0 | 61 | 0 |

## 三、模型分布

**Claude Code**

| 模型 | 助手消息数 |
| --- | ---: |
| `glm-5.3-flashx` | 7631 |
| `glm-5.3-flash` | 459 |
| `kimi-k3` | 18 |
| `gemini-4-argon` | 11 |
| `error` | 2 |
| `<synthetic>` | 2 |

**Catpaw (local)**

| 模型 | 助手消息数 |
| --- | ---: |
| `gemini-3.8-flash` | 1 |

## 四、Token 用量

| 工具 | 输入 | 输出 | 备注 |
| --- | ---: | ---: | --- |
| Claude Code | 25,251,502 | 2,380,831 | — |


## 五、质量信号

_说明：仅基于字段层（消息长度、tool 类型、文件数等）计算，不读取任何对话原文。用于评估**深度（提问长度/会话长度）、广度（tool 多样性、文件触达）、结构化（skill 使用占比）**。_

| 工具 | prompt 平均字符 | prompt p90 | 平均会话长度 | 长会话占比 | 触达文件数 | Skill 会话占比 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Code | 1516 | 1480 | 1110 | 88% (7/8) | 222 | 62% |
| Catpaw (local) | 127 | 288 | 20 | 33% (1/3) | 19 | 33% |

**口径说明**
- prompt 字符：单次用户消息字符数；高 p90 = 写过详细 prompt，反映结构化提问能力
- 长会话：用户消息 ≥10 的会话；占比高 = 倾向连续深度对话而非一次性问答
- 触达文件数：tool_use 中涉及的不重复文件总数（仅 Claude Code 可见）
- Skill 会话占比：调用过 skill 的会话比例；高 = 倾向使用结构化流程

### Tool 调用类型分布（Top 8）

**Claude Code**（合计 3691 次）

| 工具 | 次数 | 占比 |
| --- | ---: | ---: |
| `Bash` | 2818 | 76% |
| `Edit` | 553 | 15% |
| `Read` | 209 | 6% |
| `Write` | 77 | 2% |
| `Skill` | 7 | 0% |
| `Monitor` | 7 | 0% |
| `ToolSearch` | 4 | 0% |
| `TaskStop` | 4 | 0% |

**Catpaw (local)**（合计 169 次）

| 工具 | 次数 | 占比 |
| --- | ---: | ---: |
| `run_terminal_cmd` | 51 | 30% |
| `read_file` | 49 | 29% |
| `grep` | 24 | 14% |
| `MultiEdit` | 16 | 9% |
| `read_lints` | 14 | 8% |
| `todo_write` | 8 | 5% |
| `string_replace` | 3 | 2% |
| `fetch_pull_request` | 1 | 1% |


## 六、备注

- Cursor：未发现 /Users/qianyuchen/Library/Application Support/Cursor/User/globalStorage/state.vscdb
- Catpaw (local)：窗口外 transcript 跳过 372 个
- Catpaw (local)：transcripts 不含逐条时间戳/token；每日活跃按会话最后活动日兜底分桶；模型字段来自 ai-code-hashes.db join，未产生 AI 代码的会话 models 为空。
- CatDesk：窗口外 / 无窗口内消息的会话跳过 50 个
- CatDesk：CatDesk 数据存于 ~/Library/Application Support/catpaw-desk/catpaw-memory.db；model 字段取自 assistant 消息，token 不在本地缓存。
- opencode：未发现 /Users/qianyuchen/.local/share/opencode/opencode.db 也未发现 /Users/qianyuchen/.local/share/opencode/storage


## 七、扩展生态（Skills / Commands / Subagents / Plugins / MCP）

- 安装条目：**188** 条 (skills/commands/agents/plugins，含全局 + 项目级，扫描 host 目录 `.claude/.cursor/.codex/.catpaw`)
- MCP server：**13** 个声明（启用 12）

### 1. 安装总览（按 host × scope × 类别）

| host | Skills（全局/项目） | Commands（全局/项目） | Subagents（全局/项目） | Plugins（全局/项目） |
| --- | ---: | ---: | ---: | ---: |
| catpaw | 25 / 1 | 0 / 16 | — | — |
| claude | 36 / 110 | — | — | — |

### 2. 窗口内新装 / 更新

| host | scope | 类别 | 名称 | 时间 | 项目 |
| --- | --- | --- | --- | --- | --- |
| claude | global | Skills | `train-aux-income-work-report` | 2026-10-30 02:21:33 | — |
| catpaw | global | Skills | `skills-market` | 2026-10-29 09:20:14 | — |
| claude | project | Skills | `train-aux-income-work-report` | 2026-10-29 02:47:54 | /Users/qianyuchen/work/project |
| claude | global | Skills | `arena-api` | 2026-10-29 02:32:14 | — |

### 3. MCP 清单（installed + enabled）

| host | scope | server | enabled | 项目 |
| --- | --- | --- | --- | --- |
| claude | global | `gitnexus` | ✅ | — |
| claude | global | `ingee-mcp` | ✅ | — |
| claude | global | `xproduct-gateway` | ✅ | — |
| claude | project | `code-quality` | ✅ | …nyuchen/work/project/multi-repo-projects |
| claude | project | `drawio` | ✅ | /Users/qianyuchen/work/project |
| claude | project | `xproduct-gateway` | ✅ | …yuchen/work/project/xproduct-mcp-gateway |
| codex | global | `computer-use` | ❌ | — |
| codex | global | `gitnexus` | ✅ | — |
| codex | global | `node_repl` | ✅ | — |
| codex | global | `node_repl.env` | ✅ | — |
| codex | project | `code-quality` | ✅ | …nyuchen/work/project/multi-repo-projects |
| codex | project | `code-quality.env` | ✅ | …nyuchen/work/project/multi-repo-projects |
| codex | project | `drawio` | ✅ | /Users/qianyuchen/work/project |

### 4. 触发频次（Claude Code + Catpaw (local) 会话）

- 窗口内 skill/slash 调用：42 次（Skill 工具 7 + slash 命令 35，其中内置命令 21）
- 窗口内 MCP tool 调用：6 次（1 个 server）

**按 SDLC 阶段汇总**

| 阶段 | 调用次数 |
| --- | ---: |
| 其他 | 2 |
| 未分类 | 19 |

**Skill / Slash 触发 Top 25**

| 名称 | 次数 | SDLC | 类别 | 描述 |
| --- | ---: | --- | --- | --- |
| `lion-cli` | 3 | — | 已安装 | Lion 配置平台 CLI 工具 |
| `skill-metric-reporter` | 3 | — | 已安装 | Skill 指标上报工具 |
| `rkm` | 3 | — | 已安装 | 读取、编辑学城文档 |
| `db-query` | 2 | — | 已安装 | 数据库查询 — 支持两种模式：① 直接查询（搜索DB→查表结构→写SQL→执行DQL，支持 mysql/blade/oracle/milvus）② 智能取数（自然语言→Agent自动生成SQL→执行，… |
| `citadel` | 2 | 其他 | 已安装 | 学城官方Skill：学城km/wiki/citadel/km.sankuai.com 自动化操作工具，直接调用线上接口，响应速度更快 |
| `web-design-engineer` | 2 | — | 已安装 | Build or redesign polished browser-rendered visual artifacts with HTML/CSS/JavaScript/React: pages,… |
| `train-aux-income-work-report` | 1 | — | 已安装 | 火车票收入组·工作日报定时生成（学城文档，团队四段式：工作计划/业务指标/技术指标/todo） |
| `logcenter-query-cli-test` | 1 | — | 已安装 | 查询美团 **Test 环境** LogCenter 日志平台数据 |
| `arena-api` | 1 | — | 已安装 | Arena 实验平台 HTTP API 直连查询/操作工具(基于 mtcurl 自动 SSO) |
| `goal` | 1 | — | 项目级/外部 | — |
| `avatar` | 1 | — | 已安装 | Avatar 是美团内网一站式技术资源管理运维平台，负责管理服务（Appkey）、主机（服务器/机器）、域名（DNS）等核心资源，以及围绕这些资源的功能：服务权限管理、服务高峰期管理、服务资源利用率治… |
| `gitnexus-debugging` | 1 | — | 已安装 | Use when the user is debugging a bug, tracing an error, or asking why something fails |

**MCP server 调用频次**

| server | 调用次数 |
| --- | ---: |
| `gitnexus` | 6 |


---
_本报告仅含聚合指标，不包含任何对话原文。由 `ai-coding-usage` skill 本地生成。_
