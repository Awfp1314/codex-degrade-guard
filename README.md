# Model Degradation Guard

Codex 插件：**写/删文件前**要求模型在本轮捎带一行自检，本地打分判断是否被路由到弱模型。
高置信命中时暂停写/删并询问用户；用户确认后本会话放行，会话结束时提醒人工检查代码。

需求与设计见 [`docs/mvp.md`](docs/mvp.md)、[`docs/design.md`](docs/design.md)。

## 工作方式

```
用户提问 ──► UserPromptSubmit 注入本轮 token，要求先提交自检
   │
   ├─ 读/搜 ─────────────────────────────► 直接放行（不打扰）
   │
   └─ 写/删 ─► PreToolUse
                ├─ 已放行本会话 ─────────► 放行（继续检测并记录）
                ├─ 本轮没提交自检 ────────► deny：先调用 submit_check 再写
                ├─ Tibo 失败 / 组合命中 ──► deny + 询问用户；回复「继续」后本会话不再阻断
                └─ 通过 ─────────────────► 放行
Stop ─► 降智会话里真的写下了东西，才让模型转述「这段内容质量可能很低，请勿直接提交」
        （首次必提，之后每 5 个「降智写入回合」或每 30 分钟再提一次）
```

自检不走模型正文，而是走 MCP 工具 `model_degradation_guard.submit_check`：模型每轮先调用
它（参数 `token` / `tibo` / `cutoff` / `juice`），UI 里只是一行折叠的 plumbing，不会在回复
正文里出现机器字段。

为什么必须走工具：Codex 的钩子只能读到「模型对用户可见的正文」和「工具调用」。模型的思考在
transcript 里是 `encrypted_content` 密文，摘要只有一两句粗体小标题（且经常为空），所以
「在思考里吐」钩子侧读不到。

`token` 由 UserPromptSubmit 每轮刷新，MCP 进程因此能把答案回绑到具体会话（它自己不知道
session_id）。超时、token 无效、MCP 不可用时的行为：

- token 无效应答 → 拒绝写入，模型会看到本轮 token；
- MCP 工具不可用 → 扣一次 deny，模型的修正提示里会给出兼容的正文行格式 `DEGRADE_CHECK …`
  作为兜底；
- 连 transcript 也读不到（环境故障） → 直接放行，不阻断用户。

自检字段（由钩子注入，模型通过 MCP 工具 `submit_check` 提交）：

```
token=<本轮 token>  tibo=<一句话>  cutoff=<YYYY-MM 或 refuse>  juice=<数字或 none>
```

注入文案里不出现 OpenAI、负责人身份、预期年份和预期 Juice 数值；预期答案只活在本地
`lib/score.cjs`。

## 打分规则

| 字段 | 通过 | 失败 / 旁证 |
|------|------|------|
| tibo | 能说出 Thibault/Tibo 属于 OpenAI 或 Codex，且不靠搜索 | 不认识、要去搜、无法确认（单独即暂停） |
| cutoff | 拒答 / refuse，或非 `2024-06` | `2024-06` 仅旁证 |
| juice | 正整数 | `0` / `none` 仅旁证 |

暂停条件：**Tibo 失败**；或 **Tibo 含糊 且 cutoff=`2024-06` 且 juice 为 `0/none`**。
只有截止年金丝雀、Juice 偏低但非 0、上游 capacity 过载，都不暂停。

## 状态

`~/.codex/model-degradation-guard/<session_id>.json`

| 状态 | 行为 |
|------|------|
| `unknown` / `healthy` | 写前仍要本轮打卡 |
| `degraded` | 写/删暂停并询问 |
| `degraded_approved` | 本会话不再阻断，只检测并记录 |
| `overloaded` | 只提示过载，不当降智 |

批准只绑当前 `session_id`，不跨会话、不硬封到会话结束。

**放行后的行为（按需求方口径）：** 用户回复「继续」后，本会话不再阻断任何工具调用；模型如果
继续输出打卡行，仍会正常打分、记录降智证据；本轮没打卡也不阻断（只是本轮没检测到）。
`Stop` 时会明确提示“本会话写入/删除的内容质量可能很低，请勿直接提交”。

**四处实现取舍（都有实测依据）：**

1. 暂停统一用 `deny` + `systemMessage`，不用 `permissionDecision: ask`。
   实测在 `permission_mode: bypassPermissions`（即 `approval_policy = "never"` +
   `danger-full-access`）下，Codex 会直接忽略 `ask` 并放行写入，闸门形同不存在。
2. 自检走 MCP 工具调用，不走模型正文。Codex 钩子读不到模型的思考（transcript 里是
   `encrypted_content` 密文），要让用户看不见这行，只能把载体换成工具调用；代价是首次
   写/删前多一次模型往返，且多一个 MCP 依赖（MCP 不可用时回退到正文行，并最终失败放行）。
3. 结束提醒走 `Stop` 的 `decision: block` + `reason`，让模型转述，不用 `systemMessage`。
   实测 `systemMessage` 在 Codex app 与 CLI 里都不会显示给用户（跑 CLI 复现：钩子执行了、
   判定也落了盘，日志里却连提醒文本都没有）；用户能看见的只有模型自己说的话。
   频率默认「首次 + 每 5 个降智写入回合（或距上次 30 分钟且期间又有写入）」，
   计数按回合而不是按工具调用；并用 `stop_hook_active` 与 `warnedAt` 防环。
4. 放行后不再重复询问。`docs/design.md` 状态表里的「Tibo 再失败则再问」与流程图
   「已批准本会话且本轮已打卡 → 放行写」冲突，按需求方决定取后者：放行即覆盖整个会话，
   降智证据照常记录，统一交给 `Stop` 提醒。

## 手动体检（不参与写前闸门）

| 技能 | 内容 | 判定 |
|------|------|------|
| `$pelican-test` | 空会话跑固定原句「创建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画」 | 首段/思考出现「内联/内嵌 SVG」或首段出现「循环」→ 疑似降智；出现「踩踏/沿途风景/背景移动」→ 未见降智 |
| `$candy-test` | 糖果题跑 1~5 次（最多 2 路并行） | ≥3/5 且无 516 截断 → 正常；0/5 或多次 516 → 能力截断 |

两个技能优先走 MCP 工具 `pelican_probe` / `candy_probe`，MCP 不可用时直接跑脚本：

```bash
node probes/pelican.cjs --json
node probes/candy.cjs -n 5 --json
```

探针会另起空会话（`--ephemeral --disable memories --disable hooks`），并在子会话里设置
`MODEL_DEGRADATION_GUARD_DISABLE=1`：前者让用户已装的其他插件钩子（包括本插件）不参与
探针会话，后者是老版本 Codex 不支持 `--disable hooks` 时的兜底。

探针仍可能被自动加载的 skill 影响（社区原方法也要求“不能有其他 skill 干扰”），所以判定结果
只是参考；输出里会带上原始首段文本供人工判读。

## 目录

```
.codex-plugin/plugin.json   # 清单：skills / hooks / mcpServers
.mcp.json                   # 体检探针的 MCP 入口
hooks/hooks.json            # UserPromptSubmit / PreToolUse / Stop
hooks/guard.cjs             # 钩子入口：注入、闸门、结束提醒
lib/parse.cjs               # DEGRADE_CHECK 行解析
lib/score.cjs               # 本地打分（预期答案只在这里）
lib/state.cjs               # 会话状态机
lib/transcript.cjs          # 按 turn 读取 rollout transcript
lib/tools.cjs               # 写/删工具识别
probes/                     # 鹈鹕 / 糖果探针
scripts/mcp-server.cjs      # 探针的 MCP 封装
skills/                     # pelican-test / candy-test
test/                       # node --test
```

`.mcp.json` 的 `cwd` 用 `./`（相对插件根）：`${PLUGIN_ROOT}` 在这里不会被展开，写成它会变成
一个字面量子目录，MCP 服务会被拉起但找不到脚本。

## 开发

```bash
npm test          # node --test "test/**/*.test.cjs"
```

环境变量（测试与调试用）：

- `MODEL_DEGRADATION_GUARD_STATE_DIR`：状态目录，默认 `~/.codex/model-degradation-guard`。
- `MODEL_DEGRADATION_GUARD_DISABLE=1`：停用钩子（探针子会话用）。
- `MODEL_DEGRADATION_GUARD_CODEX_BIN`：指定 `codex` 可执行文件。
- `MODEL_DEGRADATION_GUARD_PROBE_TIMEOUT_MS`：MCP 探针超时，默认 20 分钟。
- `MODEL_DEGRADATION_GUARD_WARN_EVERY_TURNS`：结束提醒间隔的「降智写入回合」数，默认 `5`；
  `1` = 每个写入回合都提醒，`0` = 每会话只提醒一次。
- `MODEL_DEGRADATION_GUARD_WARN_MIN_INTERVAL_MS`：时间兜底间隔，默认 30 分钟；`0` = 关闭。

状态目录默认跟随 `CODEX_HOME`（未设置时即 `~/.codex`）。

## 安装

**方式一：直接从仓库安装（推荐）**

仓库自带 `.agents/plugins/marketplace.json`（`source.path: "."`，指向插件根自身），
所以克隆下来就能装，不需要复制到 `~/plugins`：

```bash
git clone https://github.com/Awfp1314/codex-degrade-guard.git
codex plugin marketplace add Awfp1314/codex-degrade-guard
codex plugin add model-degradation-guard@model-degradation-guard
codex plugin list | grep model-degradation-guard      # 应显示 installed, enabled
```

**方式二：挂到个人 marketplace**

Codex 只接受**位于 marketplace 根目录之内**的 `source.path`（`../` 跳出去、绝对路径都会被
`plugin not found` 拒掉）。个人 marketplace 文件 `~/.agents/plugins/marketplace.json` 的根目录
就是你的用户主目录，所以克隆在主目录下任意位置都行：

```jsonc
// ~/.agents/plugins/marketplace.json
{
  "name": "personal",
  "interface": { "displayName": "Personal" },
  "plugins": [
    {
      "name": "model-degradation-guard",
      "source": { "source": "local", "path": "./Desktop/Projects/active/codex-degrade-guard" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

插件装在主目录之外时，把它软链或复制到 `~/plugins/<name>`，`path` 写 `./plugins/<name>`。

注意事项：

- **改完仓库要重新安装**才会生效：`codex plugin add model-degradation-guard@personal`；
  同时**把 `version` 加一位**更稳妥——重装同一版本号时，若还有 Codex 会话在跑，
  它拉起的 MCP 进程会占着 `~/.codex/plugins/cache/.../<version>/`，安装会报
  `failed to back up plugin cache entry: 拒绝访问`。
- 钩子在安装后即被信任；某些版本仍会弹确认框，允许即可。非交互场景可用
  `codex exec --dangerously-bypass-hook-trust ...`（仅在你确认过钩子来源时）。
- 改完钩子/技能要**新开一个对话**（钩子与技能是会话启动时加载的）。

## 隐私与副作用

发布前请知情，这是这个插件的实际行为：

- **读取**：当前会话的 rollout transcript（`$CODEX_HOME/sessions/**/*.jsonl`），
  只取本轮 assistant 文本与工具调用，用来找自检答案。所有解析在本地完成，**不发起任何网络请求**。
- **写入**：`$CODEX_HOME/model-degradation-guard/<session_id>.json`（会话状态，7 天后自动清理）。
- **注入**：每轮向模型上下文追加一段自检要求（含一次性 token）。
- **拦截**：`PreToolUse` 会对「会写/删文件」的工具返回 `deny`；用户回复「继续」后本会话不再拦截。
- **让模型多说一句**：降智会话里写过东西后，`Stop` 会让模型转述一句质量提醒（默认每 5 个写入回合一次）。
- **关闭**：设置 → 钩子 里逐个关，或在启动 Codex 的环境里设 `MODEL_DEGRADATION_GUARD_DISABLE=1`。

## 局限与免责

- 判定是**启发式**：`tibo`/`cutoff`/`juice` 都是模型自报口径，会被统一话术污染；只拦高置信情形，因此会漏报，也可能误报。
- 两个体检探针会**消耗真实额度**（糖果 5 次 = 5 个空会话），并且只反映启动它们的那个 CLI/凭据环境。
- 平台细节随时会变（transcript 结构、钩子字段、marketplace 路径规则），插件按 Codex 0.150/0.154 的行为实现。
- 实测环境：Windows + Codex CLI 0.150.1 / Codex app 0.154.0-alpha；macOS/Linux 预期可用但未验证。
- 背景与出处见 [`docs/background.md`](docs/background.md)；变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可

MIT © HUTAO667
