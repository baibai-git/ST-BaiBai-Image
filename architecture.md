# 柏宝绘代码定位

先按本页找到负责模块，再读相关代码与测试。这里记录现行边界，历史设计草案不作为实现依据。

## 链路与职责

| 改动 | 唯一入口或主要模块 |
|---|---|
| 启动、页面挂载 | `src/index.ts`、`src/App.vue`、`src/pages/registry.ts` |
| 酒馆事件、正文写回 | `src/st/context.ts`、`src/st/messageEdit.ts` |
| 自动配图流程、取消、重试 | `src/autoTag/runner.ts`、`src/autoTag/generationGate.ts` |
| 世界书与角色材料 | `src/autoTag/context.ts`、`src/autoTag/bookMemory.ts` |
| 发送内容清洗与位置映射 | `src/autoTag/clean.ts`、`src/st/imageTagRegex.ts` |
| 输出协议、提示词装配 | `src/autoTag/protocol.ts`、`src/autoTag/prompt.ts` |
| HTTP/SSE、错误、usage | `src/api/client.ts`、`src/api/errors.ts` |
| DSH 分组、绑定、图册复用 | `src/api/dsh.ts`、`src/api/dshImages.ts` |
| 版式 JSON 互通 | `src/manga/portable.ts`、`src/manga/library.ts` |
| 版式编译与校验 | `src/manga/layouts.ts`、`src/manga/mossSchema.ts` |
| 图形编辑、图册 | `src/manga/editor.ts`、`src/manga/atlas.ts` |
| 并发、出图、下载 | `src/generate.ts`、`src/floor/genQueue.ts`、`src/backends/comfyui.ts` |
| NAI 请求与限流 | `src/backends/nai.ts`、`src/backends/naiRateLimit.ts` |
| 图片落盘、侧写、显示锚点 | `src/floor/storage.ts`、`src/floor/slotAnchors.ts` |
| 卡片、图库、提示词编辑 | `src/floor/Card.vue`、`src/pages/gallery/index.vue`、`src/floor/promptEditor.ts` |
| 公开接口 | `src/public/api.ts`、`src/public/register.ts`；契约见 [PUBLIC_API.md](PUBLIC_API.md) |
| 设置运行态、持久化与迁移 | `src/state/settings.ts` |
| 设置类型 | `src/state/settings/types.ts`、`src/state/settings/naiTypes.ts` |
| 内置默认文案 | `src/state/prompts/`；仍从 `settings.ts` 原路径重导出 |
| Base64 与画幅输入 | `src/base64.ts`、`src/backends/size.ts` |

## 按任务阅读

- DSH：先读 [会话协议](docs/dsh-session-bridge.md)、[Skill 来源](docs/dsh-rule-source.md)；桥接运行时代码在独立 ST-bridge 仓库，本仓库只改客户端。
- 版式：先读 [文件协议](docs/layout-format.md)、[图册复用](docs/layout-vision.md)、[冷却白名单](docs/layout-cooldown.md)。不要把 LLM 内容 JSON 与版式库 JSON 混为一谈。
- 世界书：先读 [专用与叠加书单](docs/dedicated-worldbooks.md)。宿主扫描补丁在 `scripts/patch-worldbook-scanner.mjs`。
- 整理、提交及安装：见 [维护约定](docs/maintenance.md)。

## 容易混淆的边界

- `message.mes` 的生图标签决定位置；图片及结果状态存于消息扩展和图库。清洗只处理发送副本，不删除正文图片。
- 请求历史的“成功”以调用方验收通过为准。DSH 的请求 ID、session_id、规范确认和图册确认分别管理，不能因一次请求失败一起清空。
- 角色外貌是随剧情位置派生的状态；遵循 `charTags.ts` 的生效区间。公开角色库变更通知只观察派生结果，避免重复通知。
- 同步共享设置前须先 hydrate，不能拿空默认值覆盖其他插件已经存下的渠道或排除名单。
- 编辑器自动对齐输入尺寸；旧版式导入继续保留既有偶数坐标，不能为整理代码而重新缩放。
- 图库体积扫描是明确暂停的功能；本轮保留相关逻辑和跳过用例，不自动恢复大量 HEAD 请求。
- `src/manga/table.ts` 是生成的内置表。新增版式走设置和导入流程，不手改这张表。

## 验证边界

类型检查和单测证明代码路径及协议行为；不证明个人 ComfyUI 工作流或上游模型已成功运行。
安装前比较源文件哈希，发现并发修改即停止覆盖；构建后核对实际服务返回的版本与 bundle。
