---
name: pelican-test
description: 手动账号体检：用固定原句生成「鹈鹕骑自行车」动画，把未见降智参考图和本次画面一起给用户自己比对。当用户说 $pelican-test、鹈鹕测试、体检是否降智时使用。只做体检，不参与写前闸门。
---

# 鹈鹕骑车测试（手动体检）

这是账号体检，不是写前闸门。写/删前的降智检查由插件钩子自动完成，不要在这里重复。

## 原则

- 必须使用固定原句，不能添油加醋，也不能有其他 skill 干扰会话。
- 空会话、不带历史记忆。
- **你不要判定降智还是没降智。** 模型看图会胡说。把参考图和本次画面一起交给用户自己比对。
- 未见降智通常要约 **8 分钟** 才画完；探针超时默认 12 分钟。先告诉用户「会比较久」，再调用工具。

## 参考图

未见降智的标准画面在插件里：

`${PLUGIN_ROOT}/docs/screenshots/pelican-art-healthy.png`

GitHub 备份：

https://raw.githubusercontent.com/Awfp1314/codex-degrade-guard/master/docs/screenshots/pelican-art-healthy.png

那是一张完整插画（排版、海、车筐、播放条）。贴纸风、简笔画、人车分离，都算差很多。

## 怎么做

1. 先告诉用户：这次会另起空会话作画，未见降智大约 8 分钟，请等。画完后会把参考图和本次画面一起给你看，由你自己判断。
2. 调用 MCP 工具 `model_degradation_guard.pelican_probe`。默认就是 `gpt-6-astra` + `medium`，**不要改成当前对话里的模型**。只有用户明确要求换模型或思考强度时才传 `model` / `reasoning_effort`。
3. 如果 MCP 不可用，直接运行：

```bash
node "${PLUGIN_ROOT}/probes/pelican.cjs"
```

Windows PowerShell：

```powershell
node "$env:PLUGIN_ROOT\probes\pelican.cjs"
```

4. 探针返回后，**必须**用 Markdown 连续贴两张图（绝对路径），顺序固定：

```
未见降智参考：
![未见降智参考](<参考图绝对路径>)

本次生成：
![本次生成](<截图绝对路径>)
```

参考图路径优先用探针返回的 `referenceImage`；没有就用上面的 `${PLUGIN_ROOT}/docs/screenshots/pelican-art-healthy.png`。本次生成用探针返回的截图路径；没有截图就把 HTML 路径给用户。

5. 贴图之后只说这一句，不要改写、不要补判定：

「请自己对比两张图。差很多就是降智。我不再替你判定。」

可以附带模型名、思考强度、用时。禁止输出「判定：未见降智」或「判定：疑似降智」。不要根据「内联 SVG / 循环 / 踩踏」下结论。

6. 单次结果只作参考，不能当作「必须停手」的鉴定。
