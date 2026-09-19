<div align="center">

<img src="assets/logo.svg" width="96" height="96" alt="Model Degradation Guard">

# Model Degradation Guard

写/删前拦住偷偷换弱模型

[![CI](https://github.com/Awfp1314/codex-degrade-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Awfp1314/codex-degrade-guard/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.2.2-0B1220?style=flat-square)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg?style=flat-square)](package.json)
[![Codex Plugin](https://img.shields.io/badge/Codex-plugin-111827?style=flat-square)](https://developers.openai.com/codex/plugins)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/Awfp1314/codex-degrade-guard/issues)
[![X](https://img.shields.io/badge/X-@HUTAO667-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/HUTAO667)

[安装](#安装) · [效果](#实际效果) · [体检](#手动体检) · [贡献](#欢迎贡献)

</div>

Codex 插件。读、搜不打扰；第一次要改文件时先本地自检，高置信命中弱模型路由就暂停问你。确认后本会话放行，结束时提醒人工检查。另带 `$pelican-test` / `$candy-test` 两套手动体检。

## 为什么做这个

最近这段时间，很多人的 GPT / Codex 都在降智。

**明着降智还好办**——跑一遍体检就能看出来，换个号或者换个模型就行。

麻烦的是另一种：**会话还显示原来的模型名，实际已经被静默路由到更弱的模型。** 你以为在用 Astra，它已经在用一条明显更笨的路。表现通常不是直接报错，而是：

- 把能跑的项目改坏
- 写出一堆低质量、能编译但逻辑不对的代码
- 你过很久才发现，再回滚已经晚了

社区里已经有糖果题、鹈鹕骑车这类检测方法，但它们是**事后体检**。真正改文件的时候，没有人站在闸门前面。

所以做了这个插件：写/删发生之前先打卡，命中弱模型路由就停手。

判定口径来自社区公开观察，是启发式，不是鉴定。出处见 [`docs/background.md`](docs/background.md)。

## 功能

| 能力 | 说明 |
|---|---|
| **写前闸门** | 高置信命中弱模型路由时，暂停写/删并询问 |
| **不打扰阅读** | 读、搜直接放行，不插入体检题 |
| **手动体检** | `$pelican-test` / `$candy-test`，空会话对照正常号和降智号 |
| **本地判定** | 打分在本机完成，不上传代码，不发网络请求 |
| **结束提醒** | 降智会话里真写过东西，才提醒不要直接提交 |

## 实际效果

同一件「更新当前分支版本号」的任务：

**未降智：闸门放行，任务照常做完。**

![未降智模型执行任务](docs/screenshots/guard-healthy.png)

**命中弱模型：写/删暂停，先问你要不要继续。**

![检测到模型降智停止任务](docs/screenshots/guard-paused.png)

上面这张里，模型已经把版本号核对完了，但文件一行都没改——插件拦在写之前。回复「继续」本会话放行，或先检查 / 切换模型。

就算开着「完全访问」，闸门仍然有效。Codex 在 `bypassPermissions` 下会忽略 `ask`，所以本插件用的是 `deny`，不是权限询问框。

## 安装

### 命令安装

```bash
codex plugin marketplace add Awfp1314/codex-degrade-guard
codex plugin add model-degradation-guard@model-degradation-guard
codex plugin list
```

列表里应能看到 `model-degradation-guard`，状态为 `installed, enabled`。

**必须信任钩子，否则写前闸门不会运行。** 安装或启用都不会自动信任。没点信任时，技能和 MCP 还在，但 `UserPromptSubmit` / `PreToolUse` / `Stop` 会被跳过，等于没装闸门。

1. **CLI：** 新开会话若出现 `Hooks need review`，选 Review 或 Trust all。也可以输入 `/hooks`，把本插件三条钩子标成信任。
2. **Codex App：** 打开 **设置 → 钩子**，找到 `model-degradation-guard` 的三条（写前检查、本轮自检注入、结束提醒），全部允许 / 信任。App 不一定弹窗，不进设置就可能被静默跳过。

然后**新开一个对话**（钩子和技能是会话启动时加载的）。右侧「来源」里应出现 `model-degradation-guard`。

本地克隆后再装也可以：

```bash
git clone https://github.com/Awfp1314/codex-degrade-guard.git
codex plugin marketplace add ./codex-degrade-guard
codex plugin add model-degradation-guard@model-degradation-guard
```

### 丢给 Codex 让它帮你装

把下面整段复制进 Codex（CLI 或 App 都行）：

```
请帮我安装 GitHub 上的 Codex 插件 Model Degradation Guard。

仓库：https://github.com/Awfp1314/codex-degrade-guard
插件名：model-degradation-guard

按顺序执行，每步看输出，失败就根据报错修好再继续：

1. codex plugin marketplace add Awfp1314/codex-degrade-guard
2. codex plugin add model-degradation-guard@model-degradation-guard
3. codex plugin list

确认 list 里这一项是 installed 且 enabled。
不要改我的项目代码。

装完后你必须单独提醒我去信任钩子，不能只说「装好了」。用下面这段原话（可略作换行），不要省略：

⚠️ 还没完：必须信任钩子，写前闸门才会生效。
安装不会自动信任。请立刻去设置：
- Codex App：设置 → 钩子，把 model-degradation-guard 的 UserPromptSubmit、PreToolUse、Stop 全部点允许/信任。
- CLI：新开会话若出现 Hooks need review，选 Trust all；或输入 /hooks 把这三条标成信任。
不点的话技能还在，但拦不住写/删。信任后再新开一个对话。
```

### 重装注意

改完仓库要重新安装才生效。重装**同一版本号**时，若还有 Codex 会话在跑，它拉起的 MCP 进程会占着 `~/.codex/plugins/cache/.../<version>/`，安装会报 `拒绝访问`。把 `version` 加一位再装更稳妥。

### 更新

```bash
codex plugin marketplace upgrade model-degradation-guard
codex plugin add model-degradation-guard@model-degradation-guard
```

然后**新开对话**，并重新信任钩子。装过带通知的版本之后，仓库有新版本时对话里会说一句（每个版本一次；几天没更新会再补一句）。不自动安装。设 `MODEL_DEGRADATION_GUARD_UPDATE_CHECK=0` 可关掉检查。已经装了更早版本、钩子里还没有这段逻辑的，只能按上面两条命令手动升一次。

## 手动体检

写前闸门是自动的。想主动看当前号正不正常，在对话里说：

| 技能 | 测什么 | 怎么看 |
|------|--------|--------|
| `$pelican-test` | 固定原句「鹈鹕骑自行车」，默认 **gpt-6-astra / medium**，约 8 分钟 | 并排展示**未见降智参考图**和本次画面，由你自己比对；差很多就是降智 |
| `$candy-test` | 同一道排列组合题跑 5 次 | **正确 ≥ 3 次 → 未见降智；少于 3 次 → 疑似降智** |

两个技能都会**另起空会话、消耗真实额度**（糖果 5 次 = 5 个空会话）。结果只是参考，不能单独当作「必须停手」的鉴定。

**鹈鹕：自己对照参考图。差很多就是降智。**

| 未见降智参考（仓库里这一张） | 差很多的例子：人车分离 | 差很多的例子：贴纸风 |
|---|---|---|
| ![未见降智参考](docs/screenshots/pelican-art-healthy.png) | ![人车分离](docs/screenshots/pelican-art-degraded.png) | ![贴纸风](docs/screenshots/pelican-art-degraded-crude.png) |

**糖果：正常号 vs 降智号**

| 5/5 正确（≥3 即未见降智） | 0/5 正确（少于 3 次即疑似降智） |
|---|---|
| ![正常号糖果测试](docs/screenshots/candy-healthy.png) | ![降智号糖果测试](docs/screenshots/candy-degraded.png) |

CLI 直接跑：

```bash
node probes/pelican.cjs --json
node probes/candy.cjs -n 5 --json
```

## 工作方式

```
用户提问 ──► 每轮注入一次性 token，要求先提交自检
   │
   ├─ 读 / 搜 ──────────────────────────► 直接放行（不打扰）
   │
   └─ 写 / 删 ─► PreToolUse
                  ├─ 本轮没提交自检 ────► deny：先调用 submit_check 再写
                  ├─ 已批准且本轮已打卡 ► 放行（继续检测并记录）
                  ├─ Tibo 失败 / 具体日期 / 组合命中 ► deny + 询问
                  ├─ 已 degraded ───────► 保持 deny，直到明确批准或连续三轮 Tibo pass
                  └─ 未暂停 ────────────► 放行
Stop ─► 降智会话里真的写下了东西，才提醒「这段内容质量可能很低，请勿直接提交」
        （首次必提，之后每 5 个降智写入回合或每 30 分钟再提一次）
```

自检走 MCP 工具 `model_degradation_guard.submit_check`，不出现在回复正文里。钩子读不到模型思考（transcript 里是密文），所以不能「让它在思考里偷偷打卡」。

### 打分

| 字段 | 健康证据 / 无证据 | 暂停证据 / 旁证 |
|------|------|------|
| tibo | 能回答 Tibo 是谁、在哪家公司、做什么，且不靠搜索 | 人名与错误公司/模型词同时命中则 `tibo_wrong_affiliation`；不认识、要去搜、无法确认或回避身份为 `tibo_fail`。两者单独即暂停 |
| cutoff | `grounded`：含糊/拒绝自述 + 自发提及当天日期（±1 天）；`vague`：仅拒答/含糊，无证据；空值为 `missing` | `concrete`：任何具体截止日期，包括直接把今天当截止日期；默认单独暂停 |
| juice | 正整数 | `0` / `none` 仅旁证；同一会话前后不一致时当前值不可信 |

暂停条件：**Tibo 失败**或 **cutoff 为 concrete**，各自独立生效；同一会话第二个不同回合仍未解决 Tibo 时累计升级。旧的 Tibo 含糊 + 截止金丝雀 + juice 为 `0/none`（或历史矛盾）的组合规则保留，尤其用于回滚模式。`vague` 和 `grounded` 都不能抵消失败，也不能单独解封。

评分先提取答案中的全部日期。任一日期不是当地今天（完整日期容差 ±1 天）即为 `concrete`；仅年份/年月不能精确锚定今天，也算具体截止。所有日期都在容差内且有拒绝/含糊语义才是 `grounded`。例如 `2024-12`、单独的 `2026-09-16` 都暂停；以今天为 `2026-09-16` 时，“我不确定，但今天是 2026-09-16”不因 cutoff 暂停。`refuse` 只是无证据，不加分、不解封。

`MODEL_DEGRADATION_GUARD_CONCRETE_CUTOFF_MODE=pause|flag|off`，默认 `pause`。`flag` 只记录新日期信号，供收集误报率，其他旧暂停规则仍生效；`off` 恢复旧 cutoff 口径。每条 `checkHistory` 都记录 `cutoffConcrete` 布尔值。模型如实报告了真实知识截止日期也可能被拦，这是本次保守口径的误报风险，并非已验证的路由鉴定。

Juice 偏低但非 0 不单独暂停；上游 capacity 不当降智，也不能清除已有 degraded。预期答案不进入注入文案；**不提示模型填写当天日期**，grounding 必须自发提供。

### 状态

`~/.codex/model-degradation-guard/<session_id>.json`

| 状态 | 行为 |
|------|------|
| `unknown` / `healthy` | 写前仍要本轮打卡 |
| `degraded` | 写/删持续 deny，直到明确批准或满足连续恢复条件 |
| `degraded_approved` | 本轮打卡后豁免评分暂停，继续记录 |
| `overloaded` | 只提示过载，不当降智 |

批准只绑当前 `session_id`。回复「继续」沿用 `approveSession`，记录 `approval.basis` 与时间；每轮仍须自己的打卡。自动恢复要求连续 N 个不同回合均 `verdict.pause=false` 且 `tibo=pass`，默认 N=3，环境变量 `MODEL_DEGRADATION_GUARD_RECOVERY_PASSES` 可覆盖；含糊、失败或缺失打卡会中断累计。同轮重试不加次数。cutoff 任何档位都不充当恢复分数；Tibo pass 配合非暂停结果才计一轮。恢复写入 `recoveredAt`（原因、回合列表、阈值、时间），后续再次命中仍会暂停。

状态答案在 Codex 提供 `turn_id` 时必须同时匹配 token、答案 turnId、check.turnId 和工具调用 turn_id；缺少 `turn_id` 时退回只比 token，避免打卡成功也读不回来。子回合缺打卡时 deny 并签发该回合 token；父会话或上一回合答案不能复用。transcript 备用答案只在有 `turn_id` 时按当前回合切片。降智后实际放行过写删才由 `Stop` 提醒，并附解封依据。

## 安装与生效校验

**改完必须验证 cache 里就是新代码**，不能用 work 目录的测试或安装成功提示代替。每次发布同步 bump `package.json` 和 `.codex-plugin/plugin.json`，禁止同版本覆盖安装；旧会话可能仍持有旧插件路径，版本切换后应重开会话或重启 Desktop 加载新版。本版本采用内嵌对象写在 `.codex-plugin/plugin.json` 的 `hooks.hooks` 下，便于在当前 Codex Desktop 安装链路中自检注册结果；`hooks/hooks.json` 保留为源码参考，不作为本版本的清单入口。

本地开发版本用本地 marketplace，示例 PowerShell（目录必须保留）：

```powershell
codex plugin marketplace add C:/Users/hhuwl/Documents/Codex/2026-09-16/model-degradation-guard-0-1-19/work/model-degradation-guard --json
codex plugin add model-degradation-guard@model-degradation-guard --json
codex plugin list | Select-String 'model-degradation-guard' -Context 0,4
Select-String -Path "$env:USERPROFILE/.codex/config.toml" -Pattern '^\[marketplaces\.model-degradation-guard\]','^\[plugins\."model-degradation-guard@model-degradation-guard"\]' -Context 0,3
```

确认 marketplace 为 `source_type = "local"` 且 source 为上述目录，plugin 为 enabled。该本地源的 marketplace upgrade 不会从 GitHub 拉取；若以后重新注册为 git 源，则此保障不再成立。若采用 GitHub 源，**push 之前不要执行 marketplace upgrade**，必须先 push 包含新版本的提交，再 upgrade、安装并验证 cache。

安装返回的 installedPath 才是本次应检查的目录。以 0.2.2 为例（CODEX_HOME 自定义时使用对应目录）：

```powershell
$cache = "$env:USERPROFILE/.codex/plugins/cache/model-degradation-guard/model-degradation-guard/0.2.2"
Get-Item "$cache/lib/score.cjs" | Select-Object FullName,LastWriteTime
rg -c concrete "$cache/lib/score.cjs"
node -e 'const s=require(process.argv[1]); for(const tibo of ["Tibo 是 Anthropic 的一名研究人员，负责 Claude 模型相关工作。","Tibo 是 Google DeepMind 的研究员。","Thibault Sottiaux 是 OpenAI 的 Codex 团队负责人。"]) { const v=s.evaluateCheck({tibo,cutoff:"refuse",juice:"10"}); console.log(JSON.stringify({tibo,result:v.tibo,pause:v.pause,reason:v.reason})); }' "$cache/lib/score.cjs"
Push-Location $cache
npm test
Pop-Location
```

`rg -c` 等价于本次需要的 `grep -c concrete`，结果必须非 0。前两例应为 fail、pause=true、reason=tibo_wrong_affiliation；第三例应 pass、pause=false。用 refuse 隔离身份信号，避免由具体日期拦截掩盖身份漏报。另比较源与 cache 的 hook、库、package 和清单 SHA-256；任何加载异常、空文件或不一致都不算安装验证通过。

错误归属规则覆盖 Anthropic/Claude、Google/DeepMind/Gemini、Meta/LLaMA、Mistral、xAI/Grok、Cohere、Stability、阿里、字节、百度、腾讯、月之暗面、智谱、DeepSeek。按当前策略，人名与这些词共现优先 fail，即使同时出现 OpenAI；提及别家公司作否定或对比也可能误报，这是关键词策略的局限。

## 欢迎贡献

降智的表现会变，社区口径也会过期。这个插件要靠大家一起把它补全、跑快、少误报。

特别欢迎这几类贡献：

1. **新的检测规则**  
   你发现了可复现的弱模型特征（稳定、能本地判定、不靠搜答案），请带到 [Issues](https://github.com/Awfp1314/codex-degrade-guard/issues) 或直接开 PR。写清楚：信号是什么、正常模型怎么答、弱模型怎么答、误报风险。主打分在 [`lib/score.cjs`](lib/score.cjs)，社区背景在 [`docs/background.md`](docs/background.md)。
2. **误报 / 漏报样本**  
   带上 `codex plugin list`、相关会话里插件说了什么、以及 `node probes/pelican.cjs --json` / `candy.cjs -n 5 --json` 的输出。有样本才能收紧规则。
3. **性能**  
   写前闸门目标是热路径 **不到 50ms**、超时 5s、失败放行。探针已经是最多 2 路并行；还能再稳、再快、少占额度的改动都欢迎。
4. **平台验证**  
   目前实测是 Windows + Codex CLI 0.150.1 / Codex app 0.154.0-alpha。macOS / Linux 上跑通或踩坑，请开 issue。

本地开发：

```bash
git clone https://github.com/Awfp1314/codex-degrade-guard.git
cd codex-degrade-guard
npm test
```

提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)，摘要用中文，例如 `fix(score): 收紧 tibo 含糊判定`。设计说明见 [`docs/design.md`](docs/design.md)。

## 隐私与副作用

- **读取**：当前会话 rollout transcript，只取本轮 assistant 文本与工具调用。打分全部本地解析。
- **联网**：每次用户消息触发时访问 GitHub 上的 `plugin.json` 看有没有新版本；只要本地版本落后，就让模型在回复里持续提醒。失败则静默，不自动安装。`MODEL_DEGRADATION_GUARD_UPDATE_CHECK=0` 可关。
- **写入**：`$CODEX_HOME/model-degradation-guard/<session_id>.json`（7 天后清理），以及同目录 `update.json`。
- **注入**：每轮向模型上下文追加一段自检要求（含一次性 token）；有新版本时另加一句请模型转述。
- **拦截**：会对写/删工具返回 `deny`；回复「继续」后豁免本会话评分暂停，但仍须本轮自检。
- **关闭**：设置 → 钩子里逐个关，或设 `MODEL_DEGRADATION_GUARD_DISABLE=1`。

## 局限

- 判定是启发式，会被统一话术污染；只拦高置信，所以会漏报，也可能误报。
- **本插件只覆盖显式写/删特征，不作为安全边界。** shell 分类先保护引号和路径参数，再按命令位置判断；无法识别的命令默认放行。别名、动态拼接、复杂 shell 语法及未覆盖的脚本写入 API 可能漏报；`npm test` 等也可能写缓存。钩子异常、超时或 transcript 不可读仍 fail-open。
- 体检探针消耗真实额度，只反映启动它们的那个 CLI / 凭据环境。
- 平台细节会变。插件按 Codex 0.150 / 0.154 的行为实现。

## 开发备忘

```
.codex-plugin/plugin.json   # 清单：skills / hooks / mcpServers
.mcp.json                   # 体检探针的 MCP 入口
hooks/guard.cjs             # 注入、闸门、结束提醒
lib/score.cjs               # 本地打分（预期答案只在这里）
lib/state.cjs               # 会话状态机
lib/update.cjs              # 限频查版本，只通知不安装
probes/                     # 鹈鹕 / 糖果
scripts/mcp-server.cjs
skills/                     # pelican-test / candy-test
test/
```

环境变量：`MODEL_DEGRADATION_GUARD_STATE_DIR`、`MODEL_DEGRADATION_GUARD_DISABLE`、`MODEL_DEGRADATION_GUARD_UPDATE_CHECK`（`0` 关掉版本检查）、`MODEL_DEGRADATION_GUARD_CODEX_BIN`、`MODEL_DEGRADATION_GUARD_PROBE_TIMEOUT_MS`、`MODEL_DEGRADATION_GUARD_PELICAN_TIMEOUT_MS`（默认 12 分钟）、`MODEL_DEGRADATION_GUARD_WARN_EVERY_TURNS`、`MODEL_DEGRADATION_GUARD_WARN_MIN_INTERVAL_MS`、`MODEL_DEGRADATION_GUARD_RUN_TIMEOUT_MS`。状态目录跟随 `CODEX_HOME`（默认 `~/.codex`）。

`.mcp.json` 的 `cwd` 必须写 `./`。`${PLUGIN_ROOT}` 在这里不会被展开。

实现上几处取舍（都有实测依据）：暂停用 `deny` 不用 `ask`；自检优先 MCP，正文行作备用；结束提醒用 `Stop` 的 `block` 让模型转述；用户批准豁免本会话评分暂停，但每轮仍须打卡。细节见 [`docs/design.md`](docs/design.md)。

变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可

MIT © [HUTAO667](https://x.com/HUTAO667)

---

<div align="center">

[GitHub](https://github.com/Awfp1314/codex-degrade-guard) · [Issues](https://github.com/Awfp1314/codex-degrade-guard/issues) · [X @HUTAO667](https://x.com/HUTAO667)

如果这个插件帮你拦住过一次偷偷换模，欢迎点 Star，也欢迎把新的检测规则开过来。

</div>
