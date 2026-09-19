# Changelog

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.2] - 2026-09-16

### Fixed

- 修复 Codex Desktop 重启后 hook 不注册：将 `UserPromptSubmit`、`PreToolUse`、`Stop` 从外部路径字符串改为 `.codex-plugin/plugin.json` 内嵌清单对象。
- 修复 Codex 未提供 `turn_id` 时状态答案读不回来、打卡成功也把写/删永久拦住：缺 `turn_id` 时状态答案退回只比 token，transcript 兜底仍要求回合归属，不重新引入父子回合串用。
- 同步提升 `package.json` 与插件清单版本，避免同版本缓存覆盖。

## [0.2.1] - 2026-09-16

### Fixed

- 人名与错误归属词同时出现时直接 fail，独立暂停并记录 `tibo_wrong_affiliation`；覆盖 Anthropic/Claude、Google/DeepMind/Gemini 等指定名单，优先于正确公司关键词，不依赖 cutoff 或 Juice。
- 新增两条实测错误归属、完整名单、三种 cutoff 模式和正确真实回答回归，以及 hook deny 与状态落盘断言。

### Changed

- 包与清单同步升级 0.2.1，通过新版本目录安装，禁止同版本覆盖。
- README 增加“安装与生效校验”：验证实际 cache 的 mtime、concrete 行数、直接评分、配置指向与文件哈希；本地源避免远端 upgrade 覆盖，GitHub 源必须先 push 再 upgrade。

## [0.2.0] - 2026-09-16

### Breaking

- 推翻“仅 2024-06 是截止金丝雀”：cutoff 改为 concrete / grounded / vague / missing；任何具体截止日期默认独立暂停，原因 `cutoff_concrete_date`。拒答不再等同通过，含糊 + 自发当天日期才是 grounding 健康证据，且不能抵消其他失败或单独解封。
- 使用本地日期 YYYY-MM-DD，完整日期容差 ±1 天；提取全部日期，年月/年份仍算具体日期。注入文案不要求模型填写当天日期。
- 降智状态不再由单次非暂停结果洗白；明确用户批准，或连续 N 个不同回合均非暂停且 Tibo pass（默认 3）才解封。批准后仍须本轮打卡，无法归属回合的旧答案不再作为当前答案。
- 0.x 开发阶段将破坏性口径升级为 0.2.0；package.json 与插件清单版本同步。

### Fixed

- 修复 0.1.19 对整条命令做裸词匹配导致 `.patch.mjs` 只读误报：先分段及保护引号/路径，再匹配命令位置；全段只读且无重定向才优先放行，混合命令先判删再判写。补全 PowerShell 管道白名单、cmd 入参和 stderr 文件重定向。
- 修复 degraded 被后续自报或 capacity 洗白：持久化恢复进度、批准依据与恢复时间，同轮工具重试不重复计数，Stop 提醒附解封依据。
- 修复父线程/上一轮答案跨 turn_id 复用：状态答案匹配 token 与当前回合；子回合缺打卡 deny 并发新 token；transcript 切片和 JSON 工具参数解析保证只读当前回合答案。

### Added

- `MODEL_DEGRADATION_GUARD_CONCRETE_CUTOFF_MODE=pause|flag|off`：默认暂停，flag 记录新信号用于人工估计误报率，off 恢复旧 cutoff 口径；既有 Tibo 和组合规则保留。
- `MODEL_DEGRADATION_GUARD_RECOVERY_PASSES` 配置恢复阈值；`checkHistory.cutoffConcrete` 用于统计，`recoveredAt` 记录自动恢复依据。
- 原始 Windows 组合命令、混合写删、回合绑定、恢复中断、日期各形态、配置回滚、异常放行回归。改写旧评分断言并注明原因，保留低 Juice 单变量和旧组合模式覆盖。

### Security Boundary

- 未知命令保持默认放行；本插件只覆盖显式写/删特征，不作为安全边界。README 和设计文档明确动态脚本、别名、缓存写入的漏报取舍。钩子异常/超时/不可读 transcript 仍 fail-open，拦截仍使用 deny。

## [0.1.18] - 2026-09-15

### Changed

- 发布新的缓存版本，用于验证 Agent 收到更新提示后能直接代用户完成插件更新

## [0.1.17] - 2026-09-15

### Fixed

- 用户明确要求更新插件时，Agent 必须直接执行升级和重装命令，不再拒绝或只让用户手动运行

## [0.1.16] - 2026-09-15

### Fixed

- 更新提醒必须写在模型最终答复的第一段，不能只放在会被折叠的 commentary、思考或进度消息中

## [0.1.15] - 2026-09-15

### Changed

- 提升版本号，用于验证本地版本落后时模型会立即提醒更新

## [0.1.14] - 2026-09-15

### Fixed

- 鹈鹕体检会把未见降智参考图复制到探针临时目录，避免插件缓存目录中的图片无法在客户端加载
- 移除更新检查的 24 小时缓存；本地版本落后时，每个用户回合都由模型提醒更新，包含“继续”放行回合

## [0.1.13] - 2026-09-15

### Changed

- 鹈鹕体检不再让模型判定：把仓库里的未见降智参考图和本次画面一起展示，由用户自己比对

## [0.1.12] - 2026-09-15

### Changed

- 鹈鹕体检默认固定为 **gpt-6-astra / medium**，不再跟随当前对话里选的模型

## [0.1.11] - 2026-09-15

### Changed

- 鹈鹕体检收紧画质口径：贴纸/简笔画即使骑在车上也判疑似降智，不再把「在车上 + 有天空」当成未见降智

## [0.1.10] - 2026-09-15

### Fixed

- 版本检查改为会话开头同步查询（最多约 3 秒），避免第一句话时后台还没查完、以及当天缓存卡住旧版本号

## [0.1.9] - 2026-09-15

### Changed

- 版本号 bump，方便验证更新通知

## [0.1.8] - 2026-09-15

### Added

- 版本通知：每天最多查一次 GitHub 上的 `plugin.json`。有新版本时会话开头让模型转述一句更新命令，每个版本一次；几天未更新则在 Stop 再补一句。不自动安装。`MODEL_DEGRADATION_GUARD_UPDATE_CHECK=0` 可关。

## [0.1.7] - 2026-09-15

### Changed

- **糖果体检口径收成一句**：跑 5 次，正确少于 3 次 → 疑似降智；≥3 次 → 未见降智。不再把 1/5、2/5 说成「无法判断」或「能力截断」

## [0.1.6] - 2026-09-15

### Changed

- **鹈鹕体检改看画面**：判定「鹈鹕是否骑在车上、构图是否完整」，不再用首段「内嵌 SVG / 循环 / 踩踏」定罪
- 单次超时从 5 分钟提到 **12 分钟**（未见降智通常约 8 分钟才画完）

### Added

- 生成后尝试用本机 Chrome/Edge 截图，方便当前会话看图判定

### Fixed

- Linux CI 跳过依赖本机浏览器的截图测试；无图形环境里 Edge 会超时挂死

## [0.1.5] - 2026-09-15

### Added

- 开源发布材料：MIT 许可证、CHANGELOG、GitHub Actions CI、仓库自带 marketplace（克隆即可安装）
- `docs/background.md`：只保留结论、出处链接与免责，不转载原文

### Changed

- README 改为故事优先：为什么做、对比截图、命令安装 / 丢给 Codex 的提示词、贡献入口；补上 CI / 版本 / 许可证 / X 徽标与项目图标
- 安装说明写明必须信任钩子，否则闸门不运行；Codex 代装提示词会强制提醒用户去设置里点信任
- 发布者信息改为 **HUTAO667**

### Removed

- 抓取稿与本地调试产物，不随仓库发布

## [0.1.4] - 2026-09-15

### Fixed

- **糖果探针的 2 路并行失效**：`probes/lib.cjs` 用 `spawnSync` 会阻塞事件循环，两个 worker 实际退化成串行
  （5 次要等 5 倍时间）。改为异步 `spawn` 后实测 5 次约 2.5 分钟跑完。
- 单次 `codex exec` 增加超时（默认 5 分钟，`MODEL_DEGRADATION_GUARD_RUN_TIMEOUT_MS` 可调），
  超时只记该题失败，不再把整个探针拖到 MCP 超时上限。

### Added

- CLI 探针每次跑完输出进度行（`--json` 时走 stderr，保持 stdout 是纯 JSON）。
- 测试：并发确实重叠、超时能被杀掉、并发上限为 2。

## [0.1.3] - 2026-09-15

### Changed

- 结束提醒频率：**首次必提**，之后每 5 个「降智写入回合」或距上次提醒 ≥30 分钟（取先到者）再提一次；
  计数按回合而不是按工具调用。
- 新增开关 `MODEL_DEGRADATION_GUARD_WARN_EVERY_TURNS`（`1` = 每轮、`0` = 每会话一次）、
  `MODEL_DEGRADATION_GUARD_WARN_MIN_INTERVAL_MS`。

## [0.1.2] - 2026-09-15

### Fixed

- 结束提醒改用 `Stop` 的 `decision: block` + `reason`，让模型转述。
  实测钩子的 `systemMessage` 在 Codex app 与 CLI 都不会显示给用户，之前的提醒等于写在空气里。
- 只有「降智会话里确实落下过写/删」才提醒；`stop_hook_active` 与状态里的 `warnedAt` 双重防环。
- 说明：重装同一版本号时会因 MCP 进程占用 cache 目录而失败，改为换版本号安装。

## [0.1.1] - 2026-09-15

### Changed

- **自检改走 MCP 工具通道**：模型不再在回复正文里输出 `DEGRADE_CHECK` 行，而是调用
  `model_degradation_guard.submit_check`；UI 里只是一行折叠的 plumbing，正文保持干净。
  （钩子读不到模型思考，思考里是 `encrypted_content` 密文，所以要让用户看不见只能换成工具调用。）
- `UserPromptSubmit` 每轮刷新一次性 token，MCP 进程据此把答案回绑到会话。
- 取答案优先级：状态里的本轮答案 → transcript 里的工具调用 → 兼容旧正文行（MCP 不可用时兜底）。

## [0.1.0] - 2026-09-14

### Added

- 写/删前的自检闸门：`UserPromptSubmit` 注入要求，`PreToolUse` 只拦写/删。
- 本地打分：`tibo` 为主信号，`cutoff=2024-06` 与 `juice=0/none` 作旁证；只拦高置信情形。
- 会话状态机：`unknown` / `healthy` / `degraded` / `degraded_approved` / `overloaded`，
  批准只绑当前 `session_id`，放行后不再阻断、只继续记录。
- `Stop` 结束时提醒「本会话内容质量可能很低，请勿直接提交」。
- 手动体检技能 `$pelican-test`、`$candy-test` 与对应 MCP 工具。
