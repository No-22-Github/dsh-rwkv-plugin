# RWKV Agent 实际提示词样例

13B（rwkv7-g1l-13.3b）在 RWKV Agent 预设下的真实轨迹，取自插件的轨迹目录，是插件发给 RWKV 的原始字节加上模型这一步的输出。只做了两处替换：工作区路径换成 `/home/user/project`，`ls` 里的用户名换成 `user`。

- `rwkv-agent-1-step-with-thinking.txt`：第一轮第 3 步。上一步 `read` 失败，模型带着思考重试。输出被停止符截在 `</tool_call>` 前，样例里补回了这个闭合标签。
- `rwkv-agent-2-second-turn-final-answer.txt`：第二轮最后一步，能看到跨轮的历史怎么拼。这一步模型自己输出了空思考，不要当成带思考的标注样例。

格式要点：

- 每块是 `System:` / `User:` / `Assistant:` 加内容，块之间空一行；块内不留空行。
- 生成点是 `Assistant: <think`，`>` 由模型自己写。
- 历史里的每一步助手输出都是 `<think></think>` 加工具调用或回答，之前的思维链不回传（`historyEmptyThink` 默认开）。
- 工具结果放在 `User: <tool_response>{...}</tool_response>` 里。当前这一轮每个结果后面跟一段提醒语（失败时换成失败提醒）；进入下一轮后，之前轮次的提醒语会去掉。
- DSH 的运行时上下文只保留工作目录和沙箱策略两段，作为一个 `User:` 块放在用户消息后面，内容不变就不重复发。
- JSON 里的 `< > &` 现在原样写出。这两份样例录制时插件还按 Go 的写法转义成 `<`、`>`；G1 会把这种转义抄进自己写的参数，在 HTML 和代码上让输出 token 翻倍，并误触复读检测，所以改掉了。
