# Changelog

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.5] - 2026-09-15

### Added

- 开源发布材料：MIT 许可证、CHANGELOG、GitHub Actions CI、仓库自带 marketplace（克隆即可安装）
- `docs/background.md`：只保留结论、出处链接与免责，不转载原文

### Changed

- README 改为故事优先：为什么做、对比截图、命令安装 / 丢给 Codex 的提示词、贡献入口
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
