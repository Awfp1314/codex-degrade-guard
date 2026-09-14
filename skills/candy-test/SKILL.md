---
name: candy-test
description: 手动账号体检：用糖果数学题跑 5 次统计正确率与推理 token 截断，判断能力是否被截断。当用户说 $candy-test、糖果测试、体检是否降智时使用。只做体检，不参与写前闸门。
---

# 糖果题测试（手动体检）

这是账号体检，不是写前闸门。写/删前的降智检查由插件钩子自动完成，不要在这里重复。

## 怎么看

- 正确答案是 `21`：回答里出现独立的 `21` 即算对。
- 未降智：正确率 ≥ 3/5，且没有出现推理 token 为 516 的截断。
- 疑似能力截断：0/5，或多次出现 516 截断。

## 怎么做

1. 优先调用 MCP 工具 `model_degradation_guard.candy_probe`（可选参数 `runs` 1~5、`model`、`reasoning_effort`）。
2. 如果 MCP 工具不可用，直接运行探针脚本：

```bash
node "${PLUGIN_ROOT}/probes/candy.cjs" -n 5
```

Windows PowerShell：

```powershell
node "$env:PLUGIN_ROOT\probes\candy.cjs" -n 5
```

3. 把表格和结论如实转述给用户，不要美化数据。
4. 多次运行或换 reasoning effort 复测时，明确说明参数，避免把不同档位的成绩混在一起比较。

## 注意

- 最多 5 次、最多 2 路并行；不要为了凑结论反复重跑。
- 这个结果只说明「能力是否被截断」，不区分具体换成了哪个模型。
