# 柏宝绘 ↔ DSH 持久 Agent 会话接口 v1

本接口让柏宝绘的「生成 tag」任务进入 DSH 的持久 Agent 聊天。DSH 实现服务端，柏宝绘实现会话绑定、消息分组与发送。本文只描述接口，不包含用户私人提示词、世界书或配置。

## 插件设置

在「设置 → 副 API」创建独立渠道，并指派给「生成 tag 使用」，然后打开「DSH 持久 Agent 会话」。开关默认关闭。

- Base URL：填写 DSH 提供的地址，例如 `http://127.0.0.1:43121/v1`，端口由 DSH 决定。
- 模型：填写 DSH 提供的模型/Agent 配置标识，例如 `dsh-default`。
- API Key：按 DSH 的认证要求填写。密钥只用于 Authorization，不进入聊天会话元数据。
- 超时：覆盖整次 Agent 执行时间。此模式固定使用非流式 JSON 响应，忽略渠道的流式开关。
- 「重新发送固定规范」：仅发送当前固定组，更新会话规则，不请求图片规划。
- 「重建 DSH 会话」：请求创建并绑定一个新会话；下次生成重新初始化固定组。保留旧 DSH 会话历史。

漫画文字模式每次生成发送当前候选版式的空间、槽位及用途目录；目录受画布、方向与冷却约束。
图片模式提供不受冷却裁剪的完整图册，本轮选择权限仍由动态文字白名单决定；专属模式首次上传后保留图册，变化或失效时补发，详见 [版式示意图接口](layout-vision.md)。
通用规范、检查指导等固定规则发生修改时，仍使用「重新发送固定规范」。

原有渠道参数、温度、输出 token 上限和思考强度继续传递。DSH 模式需要明确指派副 API；不会静默退回主 API。

自动 tag 请求会从历史楼层及目标正文的发送副本中去掉 `<bbi_image>…</bbi_image>`，
包括其中的旧 Layout JSON、自然语言和尺寸信息。此清洗对普通副 API 与 DSH 共用，
不修改酒馆保存的正文、图片元数据或显示锚点；目标段落的位置映射仍使用原始行号。
当前任务的角色库、状态资料和单张重写所需的任务备注仍按原流程提供。
DSH 会话中已经存下的旧助手回答不由此清理，不能将后续发送量减少视为已压缩持久历史。

## HTTP 路由

`POST /v1/chat/completions`，`Content-Type: application/json`，可选 `Authorization: Bearer <key>`。

浏览器请求酒馆的 `/api/backends/chat-completions/generate`，通过 `custom` source 的 `custom_include_body` 透传 `dsh_session`。DSH 接收的是下列普通 OpenAI 兼容请求，不需要处理酒馆代理专用字段，也无需开放浏览器 CORS。

```json
{
  "model": "dsh-default",
  "stream": false,
  "temperature": 0.6,
  "max_tokens": 8192,
  "messages": [
    {"role":"system","content":"固定前缀"},
    {"role":"system","content":"生图提示词规范及版式清单"},
    {"role":"system","content":"宿主输出协议"},
    {"role":"system","content":"输出前检查指导"},
    {"role":"system","content":"本次激活的世界书"},
    {"role":"user","content":"本次角色库、上下文、目标正文与任务"}
  ],
  "dsh_session": {
    "protocol_version": 1,
    "chat_id": "opaque-plugin-chat-identity",
    "request_id": "9d55d2dfce15d5210fd95890c973c039a",
    "action": "generate",
    "fixed_message_count": 4,
    "fixed_message_types": ["prefix","spec","contract","check"],
    "target": {"floor":12,"swipe_id":0,"revision":"opaque-target-revision"}
  }
}
```

标准采样字段可能因渠道的「排除参数」配置而缺省。`messages`、`stream` 与 DSH 透传必需字段不能排除。上例 content 仅作接口占位示意。

## dsh_session 字段

| 字段 | 含义 |
| --- | --- |
| protocol_version | 固定为整数 `1` |
| chat_id | 插件生成的不透明聊天标识，包含单聊角色/群聊与聊天 ID；勿自行拆分或当作文件路径 |
| session_id | DSH 返回的会话 ID；首次没有，后续携带 |
| request_id | 单次操作 ID，网络失败自动重试时保持相同；DSH 必须幂等处理 |
| action | `generate` / `sync_rules` / `reset` |
| fixed_message_count | messages 开头有多少条属于固定组；后面的都是本次动态组 |
| fixed_message_types | 与固定组逐条对应：`prefix`、`spec`、`contract`、`check` |
| target | 生成时携带的可选目标元数据；控制操作不带 |
| target.floor | 酒馆原始消息数组索引，可能为 `0`，不是页面格号 |
| target.swipe_id | 酒馆候选回复编号，缺失时为 `null` |
| target.revision | 目标正文版本标识；当作不透明字符串，可能含 JSON 转义的控制字符 |

固定组按用途标记，不是无条件截取前四条。未配置某项时，数量可少于四条，types 与实际消息一一对应。

动态组可能包含角色卡、人设、世界书等 system 消息，以及包含角色库/记忆/上下文/目标正文的 user 消息，数量不固定。插件每次重新计算并发送动态组。已生成的图片规划回复不会再拼成 assistant 消息发回。

## 三种操作

### generate

首次没有 session_id：创建独立、可在 DSH 中查看的 Agent 会话，保存固定组，并用本次动态组执行一次生成。

后续携带 session_id：`fixed_message_count: 0`、`fixed_message_types: []`，messages 只有动态组。在对应 DSH 会话内继续执行，使用此前确认的固定规则。

规则、版式等变化不会触发插件自动重发固定组。用户点击手动按钮后才更新。DSH 保留模型回复作为本会话的历史；插件只接收本次最终回复，不回传它。

### sync_rules

messages 只有固定组，count/types 表示其组成。有 session_id 就更新该会话，没有就创建并绑定一个会话。

以用途为键更新当前有效规则，不能把旧规范与新规范作为两套并列生效的规则。可保留审计历史，但生成时使用最新确认的版本。此操作不执行模型生成，也不自动发回上一轮图片规划。

### reset

messages 为空，fixed_message_count 为 0，types 为空。创建新的空 Agent 会话并返回新的 session_id，保留旧会话。插件标记新会话尚未初始化，下次 generate 携带固定组和动态组。

## 响应

生成成功返回标准 OpenAI 非流式 JSON，额外带 `dsh_session.session_id`。`choices[0].message.content` 放 Agent 最终回复字符串，插件继续用既有解析器读取其中的图片规划。不要把工具日志、进度消息或完整内部执行记录混入 content。

```json
{
  "id":"chatcmpl-example",
  "object":"chat.completion",
  "choices":[{"index":0,"message":{"role":"assistant","content":"此处为 Agent 最终回复字符串"},"finish_reason":"stop"}],
  "dsh_session":{"session_id":"dsh-agent-chat-001"},
  "usage":{"prompt_tokens":10000,"completion_tokens":1200,"prompt_tokens_details":{"cached_tokens":8000}}
}
```

`sync_rules` 与 `reset` 完成时可返回 `choices: []`，但仍必须返回 session_id。只有成功落实会话状态后才能返回成功确认。

```json
{"choices":[],"dsh_session":{"session_id":"dsh-agent-chat-001"}}
```

usage 可省略；提供时必须是真实 token 数据。缓存可使用 `prompt_tokens_details.cached_tokens` 或 `prompt_cache_hit_tokens`。插件不根据省略的消息数量推算缓存命中。

## 重试、隔离和错误

- 对同一 request_id，DSH 必须只追加/执行一次，重复请求返回同一结果。断线、超时或响应丢失后，插件在本轮自动重试中复用原请求 ID 和消息。控制操作同样需要幂等。
- 收到有效会话确认后，即使模型最终内容未通过图片规划解析，插件仍认为固定组已发送；再次生成使用新 request_id 和动态组。
- 不同 chat_id 必须隔离；不要因为角色名字或用户账号相同就合并会话。校验 session_id 确实属于该聊天和当前调用者。
- 插件在当前页面内串行处理同一绑定的请求；DSH 仍需处理跨标签页/客户端并发，避免历史交叉追加。
- 对已失效或未知的 session_id，返回 HTTP `410`。插件清除本地绑定，在剩余自动重试次数内重新发送固定组并初始化。认证、服务异常等错误保持各自 HTTP 状态，不伪装成 410。
- 其它错误用非 2xx 状态及 `{"error":{"message":"具体原因"}}`，不要返回 HTML 或成功状态的错误文本。
- target 可帮助 DSH 处理重刷、切换 swipe 和修改旧楼；如需回溯/分支，DSH 应自行实现，插件不会替 DSH 删除或改写远程历史。第一版不得把这些元数据误当成正文或画面内容。
- 系统消息的 role、顺序、正文应保留；多条 system、中文和合法 JSON 转义都需支持。Agent 自身配置与工具由 DSH 管理，最终仍须满足柏宝绘输出协议。

当前绑定持久化在酒馆聊天元数据 `baibai_dsh_sessions`，按聊天身份、渠道、URL 和模型隔离；不保存固定消息正文或密钥。浏览器刷新后可继续。更换模型/地址/渠道会建立独立绑定；改规范后使用手动补发。

## 模型列表与渠道测试

建议同时实现 `GET /v1/models`，例如 `{"object":"list","data":[{"id":"dsh-default","object":"model"}]}`，便于插件拉取模型。

现有「测试渠道」是一个不带 dsh_session 的普通一次性补全。DSH 可将其视为独立健康测试并返回标准 choices；不要因此创建或污染正式持久会话。若服务只支持持久协议，应明确报错；可直接用实际首次生成验证会话路线。

## 联调验收

1. 首次生成收到固定组+动态组，返回 session_id；DSH 中出现对应会话。
2. 第二次生成收到相同 session_id，仅动态组；没有插件回传的 assistant 回复。
3. 刷新酒馆页面后重复第 2 步。
4. 编辑规范不自动重发；点击「重新发送固定规范」仅收到固定组，无模型生成。
5. 点击「重建 DSH 会话」返回新 ID，下次生成收到固定组+动态组。
6. 切换聊天独立绑定；网络重试同 ID 不重复执行；410 后重新初始化。
7. 确认实际有效规则、目标正文与 Agent 最终输出，及 usage 与真实账单一致。

省略固定组减少的是柏宝绘到 DSH 的重复传输。DSH 执行 LLM 时仍需提供有效规范和所需历史；实际输入 token、缓存命中和上下文压缩由 DSH 与模型服务决定，不能据此承诺推理成本降低。


## 可选的柏宝绘专属会话

在「设置 → 副 API → DSH 持久 Agent 会话」内开启「柏宝绘专属会话」。默认关闭，原有按酒馆聊天独立绑定的模式继续保留。
专属模式的绑定存入插件设置 autoTag.dshDedicatedState，按插件实例、渠道/地址/模型及输出格式隔离；切换酒馆聊天、刷新后继续复用。
角色资料、版式冷却、楼层及正文版本仍属于原酒馆聊天，真实来源校验不变。关闭专属模式恢复聊天绑定，不删除任何一种模式的已有绑定。

协议扩展（旧模式不发送这些字段）：

- session_mode: "dedicated"；client_id: "baibai-image"；task_id 为当前输出格式。
- source_chat_id: 真实来源聊天标识，只用于归属与幂等核对，不用作专属会话绑定。
- 专属模式第一次生成前先执行 sync_rules，桥接确认 capabilities 包含 "dedicated-v1" 后再发送动态任务。此握手不执行模型生成；旧桥接未确认能力时明确报错，不静默降级。
- 固定组使用 SHA-256 指纹，首次或指纹改变时同步到同一专属会话；未改变不重传。普通聊天模式仍使用原来的手动同步方式。
- 专属模式每次任务使用完整动态快照，不对其做依赖旧历史的差量裁剪。桥接在送出新任务前通过 DSH 原生 surface 替换隔离旧上下文，原始事件留在日志中；不删除旧会话。
- 同一专属绑定的生成、规范同步和重建串行处理。网络歧义重试复用原始请求与 request_id，已完成请求不重复生成。
- 手动同步和重建可以在未打开聊天时执行；生成仍要求有效的目标聊天。

### Skill 规范来源

选择 DSH Skill 后，插件从桥接能力接口查询当前接入项的绑定，发送 `dsh_session.skill_id` 并核对响应回显；主规范与检查指导不再由插件重复发送，前置提示词与宿主输出协议继续保留。详见 [DSH 规范来源](dsh-rule-source.md)。
桥接当前只加载 SKILL.md 正文，不自动展开 references 或执行脚本；Skill 名称回显不代表分册已被读取。绑定或正文变化后按桥接提示重建会话。
