# ST-BaiBai-Image(柏宝绘)架构说明

> 给新聊天的 AI 快速定位代码用。先读本文,再按「任务定位索引」找文件;深入设计取舍见
> `DESIGN.md`(总设计草案)、`GALLERY-STORAGE-DESIGN.md`(图库/画师串预览图存储)与
> `NAI-PRESET-DESIGN.md`(NAI 预设化方案,待定稿)。
> 面向第三方插件作者的接口文档是 `PUBLIC_API.md`(**对外契约,改接口必须同批改它**)。

## 1. 这是什么

柏宝绘是 SillyTavern(ST)的第三方生图扩展:

- 新 AI 正文落地后,**独立**发起一次 LLM 请求,判断哪些画面值得画、产出 danbooru tag,
  把 tag 以 `<bbi_image>...</bbi_image>` 形式插进正文(用户可手改);
- 楼层里 tag 位置渲染一张「生图卡片」,点生成即调用出图后端(ComfyUI / NovelAI),
  结果图片落盘到 ST 文件系统,元数据存消息 extra,支持历史翻页/重新生成/stale 提示;
- 自带一个全屏设置窗口(渠道、角色管理、设置),整个 UI 活在 **shadow DOM** 里,与 ST 样式隔离;
- 对外开放 `globalThis.STBaiBaiImage`(读角色库 / 出图),让别的插件自己决定图显示在哪(见 §9)。

技术栈:Vite + Vue 3(script setup)+ TypeScript,Vitest 单测。产物 `dist/index.js` + `dist/index.css`,
manifest.json 的版本号由 `scripts/sync-version.mjs` 在 build 前自动同步(package.json → manifest)。

## 2. 目录总览

```
src/
├── index.ts           # 入口:挂载 shadow root、注入 CSS、等 ST 就绪后依次 bind 各子系统
├── App.vue            # 主窗口(遮罩/窗口/导航/分页),弹窗 Teleport 宿主,移动端抽屉手势
├── st/                # ★ 与 ST 宿主唯一的接触面(其余目录一律经 getContext 间接用 ST)
│   ├── context.ts     # getContext() 类型封装;动态取 checkWorldInfo、ST-Prompt-Template
│   ├── imageTagRegex.ts  # 托管两条正则:<bbi_image> 显示侧→空锚点 div,提示词侧→空串
│   ├── messageEdit.ts # 写回消息正文(applyMessageText):身份 CAS + 正文落盘时现算,竞态保护
│   ├── keyboard.ts    # shadow 内编辑控件方向键不冒泡到 ST 全局快捷键
│   ├── clipboard.ts   # 复制到剪贴板统一入口(失败 toast;卡片/灯箱/历史页共用)
│   ├── images.ts      # /api/images/* 上传/删除/列举封装(user/images 子目录归类;画师串预览图、图库)
│   │                  # + probeUserImage:HEAD 探存在与体积(三态:在/不在/分不清)
│   ├── imageFile.ts   # 图片读取与 canvas 缩放(File→dataURL、makeJpegThumbnail;与网络层分开)
│   └── iconFallback.ts# 注入按钮的字体图标兜底(防美化主题清空图标)
├── state/             # 全局状态与持久化
│   ├── settings.ts    # ★ 设置模型 + hydrate/persist/迁移 + 跨插件共享渠道存储
│   ├── ui.ts          # 窗口开关/主题/导航/悬浮球;activePage 存 localStorage
│   │                  # (纯浏览态都走 localStorage:渠道页签记忆同理,在 backend/index.vue)
│   ├── history.ts     # 请求历史(LLM 推理+生图)模块级内存 store,刻意不持久化
│   ├── charTags.ts    # 角色固定外貌库:本聊天基线(chatMetadata)+ AI 楼层增量(消息 extra),
│   │                  # 全局库经 setGlobalCharTagSource 注入合并;锁定名拦截 AI changes
│   └── globalCharTags.ts # 全局角色库(extensionSettings,跨聊天/跨设备):仅手动维护的冻结模板,
│                      # AI 永不可写;提升为全局/复制回本聊天两条迁移路径
├── api/
│   └── client.ts      # LLM 请求:副 API 走 ST 服务端代理 / 跟随主 API 走 generateRaw
├── autoTag/           # ★ 链路 A:自动生 tag(独立 LLM 请求 → 协议校验 → 注入正文)
│   ├── runner.ts      # 事件监听、去重、重试、编排(入口)
│   ├── generationGate.ts # 生成门:把自动 tag 与真实生成配对(GENERATION_STARTED 武装 → 最终 RENDERED 消费)
│   ├── prompt.ts      # 组装消息:破限/角色/人设/世界书/规范/协议/思维链
│   ├── protocol.ts    # 段尾位置 ID、JSON 严格解析校验、tag 注入格式
│   ├── clean.ts       # 历史/目标正文清洗(共享排除标签;历史保留 bbi_image)
│   ├── context.ts     # 世界书激活(条目级渲染:展宏+EJS)、角色卡、user 人设
│   ├── bookMemory.ts  # 读「柏宝书」全局 API,解析成角色参考块
│   ├── charAnchors.ts # 角色库:库文本注入 → 兜底替换残留 @占位符(AI 照抄字段值,不用占位符)
│   ├── rebase.ts      # 插入位置重定位:请求时正文 → 落盘时正文(文本 LCS 骨架 + 顺延)
│   └── slotPlan.ts    # 单槽重写提示备注(只重写第 N 张 + 当前提示词锚点 + 其余画面清单)
├── backends/          # 出图后端(链路 B 的生成端)+ 共享尺寸工具
│   ├── comfyui.ts     # ComfyUI:工作流模板 %占位符% 渲染、浏览器直连/ST 转发自动回退
│   ├── comfyTemplates.ts # 简易模式:模板族(checkpoint/flux/anima/moss) + 参数组装 API JSON(无占位符)
│   ├── mossLayout.ts  # 漫画分镜:校验/序列化 0–1000 bbox、换算 MOSS 绝对居中像素坐标、拼 MOSS JSON 提示词、烤外貌
│   ├── comfyObjectInfo.ts # 拉模型/LoRA/采样器列表(直连 /object_info,回退 ST 转发四个端点)
│   ├── comfyWorkflowAssistant.ts # AI 自动定位工作流节点(片段 ID 协议,不复制原文)
│   ├── nai.ts         # NovelAI:参数构造、vibe 编码/叠加、画师串前置拼装、.naiv4vibe 导入导出;
│   │                  # 内置只读画师串库 BUILTIN_NAI_ARTISTS(bi_* 前缀,不进 settings)
│   ├── naiArtistLib.ts# 画师串库纯逻辑(搜索匹配/删除切分/无图卡片的画师串摘要,库与挑选弹窗共用)
│   ├── naiRateLimit.ts# ★ NAI 限流自愈:错误分类 + 退避重试 + 闸门级冷却/最小间隔(闸门与后端共用,按接入点分账)
│   ├── chatu8Vibe.ts  # 从智绘姬(st-chatu8)只读导入 vibe / 提示词预设
│   │                  # (collect/detect/import 纯函数三件套,绝不写回智绘姬)
│   ├── vibeGroups.ts  # Vibe 分组纯逻辑(装箱 key/归拢/搜索/启用集合判定)
│   └── size.ts        # 画幅方向归一 / 尺寸解析 / 按方向取配置 / 画幅锁(effectiveOrientation)
│                      # (刻意不 import settings)
├── generate.ts        # ★ 一次出图的共用中段:NAI 闸门 → 按后端分派 → 拿到图。
│                      # 楼层卡片与公开接口的**唯一**生成路径(不落盘/不显示/不埋点)
├── public/            # ★ 开放给第三方插件的接口(globalThis.STBaiBaiImage,见 §9)
│   ├── types.ts       # 第三方契约 DTO + apiVersion(与 pluginVersion 分开,只增不改不删)
│   ├── api.ts         # 实现层:深拷贝出参、错误归一成带 code 的普通 Error、图转 data URL
│   └── register.ts    # 挂 globalThis + ready/changed 事件 + subscribe(冻结 API 对象)
├── floor/             # ★ 链路 B:楼层生图卡片
│   ├── hydrate.ts     # 渲染事件 → 锚点×tag 配对 → 每锚点 attachShadow → Vue 卡片挂载(幂等)
│   ├── Card.vue       # 卡片本体(**纯展示层**,运行态在 genState.ts)+ 历史翻页
│   ├── genState.ts    # ★ 生成运行态 store(模块级,跨卡片重建存活)——改卡片状态先读它
│   ├── genQueue.ts    # NAI 并发闸门 + 节奏等待,每个接入点一道(ComfyUI 靠服务端队列,不经过这里)
│   ├── tagPlanState.ts # 「AI 重写提示词」请求运行态 store(模块级,与 genState 分开;
│   │                  # 存 {票据, promise}——关掉弹窗不中断重写,重开 await 回同一个接着等)
│   ├── collapseState.ts # 卡片折叠态模块级 store(按槽位 key 认领;手动折叠覆盖默认设置)
│   ├── missingImages.ts # ★ 「文件已不在」路径册(模块级 reactive):图库删文件留下的破指针,
│   │                  # 由卡片 <img> @error → HEAD 确认 404 才落册(分不清一律不记)
│   ├── Lightbox.vue   # 图片放大层(含长按保存的三条约束,改前必读顶部注释)
│   ├── lightbox.ts    # 命令式打开灯箱(挂插件 shadow root,非卡片 shadow)
│   ├── PromptEditor.vue # 改提示词的弹窗(结构化字段,非展示串;自带 Esc 捕获)——手改与
│   │                  # 「AI 重写提示词」同处一窗
│   ├── promptEditor.ts# 命令式打开编辑弹窗 + 写回正文(applyMessageText → 重水合);
│   │                  # 兼管 AI 重写的托管/续上与落盘后回填(rawTag 要一起刷新)
│   ├── download.ts    # 另存图片(卡片右上角 ⋯ 菜单与灯箱共用,同源文件走 <a download>)
│   ├── storage.ts     # 结果存储:extra 元数据(swipeId→promptHash→历史)+ 文件命名 + 侧写 json(图库提示词)
│   ├── upload.ts      # ST /api/files/upload|delete 封装(不用未公开的 uploadFileAttachment)
│   ├── autoGenerate.ts# 「写 tag 后自动出图」标记握手(runner ↔ Card onMounted)
│   ├── actionButton.ts# 楼层「生成生图 tag」按钮注入(共用 #chat 观察器,幂等对账)
│   ├── chatObserver.ts# ★ `#chat` 的**唯一** MutationObserver(多订阅者 + rAF 节流)
│   ├── slotHealth.ts  # ★ 卡片体检判据(纯函数):detached / hidden-by-host,顺序不可换
│   ├── registry.ts    # 槽位挂载记录表(chatId|mesid|swipeId|seq → shadow root/vnode)
│   ├── cardStyles.ts  # 构造共享 CSSStyleSheet(theme.css 选择器改写到 :host + card.css)
│   └── card.css       # 卡片样式(取 --bbi-* 令牌,与设置窗口同一套设计语言)
├── pages/             # 主窗口的分页(注册表在 pages/registry.ts)
│   ├── backend/index.vue      # 「渠道」页:页签(webui 已隐藏)+ 各后端面板
│   │   └── panels/            # ComfyUIPanel / NaiPanel / WebUIPanel(隐藏,代码保留)/ NaiArtistLibrary / NaiArtistPicker
│   ├── characters/index.vue   # 「角色管理」页:全局/本聊天两区卡片式外貌库 CRUD + 历史回滚
│   ├── gallery/index.vue      # 「图库」页:按角色名分组浏览 user/images/柏宝绘_<角色名>/(放大+看提示词+另存;多选删除**只删文件不碰聊天记录**,分组体积逐张 HEAD 量但 ⚠ 已暂时禁用)
│   ├── history/index.vue      # 「请求历史」页:调试辅助(LLM 提示词/响应/生图元信息)
│   └── settings/index.vue     # 「设置」页:渠道管理/自动 tag/提示词编辑/界面偏好(最大页)
├── components/       # 通用组件:BbiSelect/BbiCombo/BbiTextarea/Collapsible/ConfirmDialog/FloatingOrb/Icon/ModalMask/NavBar
│                     # (BbiCombo = 可输入可过滤下拉,与副 API 模型框同交互,菜单 Teleport 防裁剪)
├── styles/           # base.css(全局基础样式)、theme.css(主题变量,data-theme 切换)
├── bytes.ts          # 字节数 → 人读体积(1024 进制、单位写 KB/MB 与资源管理器对齐;非有限值返回空串)
├── pool.ts           # 限并发 map(mapLimit,返回顺序=输入顺序);图库量体积/批量删图用
├── generationMeta.ts # ★ 随图落盘的出图元信息 schema(画师串/vibe/采样参数)+ 只读展示格式化;叶子模块零 import,避免 settings↔nai 成环
├── menu.ts           # 魔杖菜单入口注入(轮询等懒加载)
├── topbar.ts         # ST 顶栏快速打开按钮(受 ui.showTopBar 开关控制)
└── version.ts        # 版本号(__BBI_VERSION__)+ 带 ver 的资源 URL
└── update.ts         # 更新检测:远端 manifest 版本对比 + /api/extensions/update 自动更新
```

## 3. 启动与挂载(读 index.ts)

1. `mount()`:在 body 建 `#bbi-app-host`(light DOM,`display:contents`),用 `INHERITED_RESET`
   内联 `!important` 钉死可继承排版属性,切断 ST 样式继承;Vue 应用整体挂进它的 **shadow root**;
   `dist/index.css` 以 `<link>` 注入 shadow root —— 样式双向隔离。
2. `$(() => ...)`:挂载应用、注入魔杖菜单入口、按开关同步顶栏按钮。
3. `hydrateWhenReady()`:轮询 `window.SillyTavern.getContext`(最多 ~20s),就绪后依次:
   `hydrateSettings()` → `initGlobalCharTags()` → `bindCharTagSync()` →
   `ensureImageTagRegexRegistered()` → `bindAutoTagging()` → `bindFloorHydration()` →
   `bindTagActionButtons()` → `registerPublicInterface()` → `checkForUpdate()`
   (每会话只查一次远端版本,不阻塞其余初始化)。
   各 bind 函数均**幂等**(内部 `bound` 标志),可安全重复调用。
   **顺序里有两处不能动**:`initGlobalCharTags()` 必须在 `bindCharTagSync()` 之前
   (首次重算就要把全局条目合进派生库);`registerPublicInterface()` 必须在
   `hydrateSettings()` 之后 —— 设置回灌前 `getBackendStatus()` 读的是默认值,
   会把明明配好的用户报成「未配置」,而第三方多半在 ready 事件里立刻问一次。

新增「启动时要做的绑定」→ 在 `hydrateWhenReady` 里加一行,并让绑定函数幂等。

## 4. 与 ST 宿主的接触面(st/ 目录)

**原则:除了 `st/` 目录,任何模块不得直接摸 ST 内部。** 具体接触点:

| 接触点 | 位置 | 说明 |
|---|---|---|
| `SillyTavern.getContext()` | st/context.ts | 唯一上下文入口,ST 未就绪返回 null,调用方轮询/降级 |
| `extensionSettings['baibai_image']` | state/settings.ts | 本插件设置(全局,跨设备同步) |
| `extensionSettings['baibai_api_channels']` | state/settings.ts | 跨「柏宝」插件共享的副 API 渠道(revision + 广播事件同步) |
| `extensionSettings.regex` | st/imageTagRegex.ts | 托管两条正则(固定 id,幂等注册/覆盖) |
| `chatMetadata['baibai_image_char_tags']` | state/charTags.ts | 角色库**本聊天手动基线**;AI 自动变化存各消息 extra `bbiCharChanges` |
| `extensionSettings['baibai_image_char_global']` | state/globalCharTags.ts | **全局角色库**(跨聊天,revision + 广播事件);仅手动维护,AI changes 按锁定名丢弃 |
| ST 事件 | 各 bind 处 | `CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_DELETED / CHAT_CHANGED` |
| `generateRaw` | api/client.ts | 跟随主 API 的一次性补全(ST 稳定 API) |
| `getWorldInfoPrompt` / 动态 import `checkWorldInfo` | autoTag/context.ts | 世界书激活(后者拿条目对象可逐条渲染;取不到自动降级前者) |
| `globalThis.EjsTemplate`(ST-Prompt-Template) | autoTag/context.ts | 世界书条目 EJS 执行(未装则降级) |
| `globalThis.STBaiBaiBook` | autoTag/bookMemory.ts | 柏宝书角色状态(apiVersion 1;不可用返回 null 降级) |
| `globalThis.STBaiBaiImage` + window 事件 | public/register.ts | **我们自己挂出去的**公开接口(§9);`st-baibai-image:ready` / `:changed` 派发在 window 上 |
| HTTP 代理 | api/client.ts、backends/comfyui.ts、floor/upload.ts、st/images.ts | `/api/backends/chat-completions/generate`、`/api/backends/chat-completions/status`、`/api/sd/comfy/*`、`/api/files/upload|delete`、`/api/images/upload|delete|folders|list` |
| 扩展更新 API | src/update.ts | `GET /api/extensions/discover`(查类型)+ `POST /api/extensions/update`(自动更新);远端版本读 GitHub raw manifest.json(8s 超时,失败静默) |
| 注入 DOM | menu.ts、topbar.ts、floor/actionButton.ts | 魔杖菜单 / 顶栏按钮 / 楼层按钮(不进 shadow) |

注意:三处 UI 的隔离层次不同,样式约定各不一样 ——
- 设置窗口:整个 Vue 应用挂在一个大 shadow root(`#bbi-app-host`),样式走 dist/index.css;
- 楼层卡片:每个锚点各自 attachShadow(见 §6),样式走 cardStyles.ts 的共享 CSSStyleSheet;
- 注入按钮(魔杖/顶栏/楼层按钮):纯 DOM、无 shadow,样式直接吃 ST 的。

## 5. 链路 A:自动生 tag(autoTag/)

触发:与 ST 真实生成配对,不信任渲染类型字符串 —— `GENERATION_STARTED` 时 `beginGeneration`
(过滤 dryRun/quiet/impersonate,记 chatId+type),最终 `CHARACTER_MESSAGE_RENDERED` 时
`consumeGeneration` 同 run 同聊天才消费并调度 `runForFloor`(setTimeout 0 等 ST 内部同步完,
期间换聊天则作废)。
**坑:GENERATION_ENDED 不得清 gate**——ST 会在最终 `CHARACTER_MESSAGE_RENDERED` 之前先发
ENDED,清了 gate 自动 tag 就永不触发(0.1.15 修);只有 `GENERATION_STOPPED`(用户中断)/
`CHAT_CHANGED` 才清。runner 内所有跳过路径都有 `[BBI][AutoTagDebug]` 诊断日志,排查触发
问题时看控制台即可定位是哪一步拦的;**手动路径(楼层按钮)每条跳过还必须给 toast**——
手动点击是显式意图,静默 return 在用户那里就是「按钮点了没反应」(0.1.26 修)。

**「谁算可插图的楼」只有一份判据**:`st/context.ts` 的 `isStoryMessage` /
`isAiStoryMessage`,楼层按钮的显隐、runner 的目标闸门、prompt 的历史取舍共用。判据只看
`is_system && typeof extra.type === 'string'`(ST 只给 narrator/comment/sys 盖这个戳),
故**被 `/hide` 隐藏的普通楼算剧情楼、照给按钮照能重新生成**——ST 自己也这么认
(messageFormatting 对隐藏楼强行把 isSystem 置回 false,我们的锚点正则才在隐藏楼生效)。
旧版 actionButton 另写一份、直接读 DOM 的 `is_system` 属性,隐藏楼一律没按钮,而属性变更
又不在 observer 监听范围里,于是同一条聊天里「隐藏前渲染过的楼留着按钮、之后重渲染的楼
没有按钮」(0.1.26 修)。同理,「正文里有没有 tag」的探测收敛到
`imageTagRegex.hasImageTagTrace`:按钮层曾只认开标签、runner 层认开也认闭,正文里只剩
一个 `</bbi_image>` 的楼就卡成「点了永远没反应」。

```
runForFloor(floor, opts)
  1. 过滤:仅 AI 故事楼;已有 <bbi_image> 且非手动 replace 则跳过
  2. 身份去重:chatId\0floor\0swipeId\0textHash → processed Set;手动(manual)绕过
  3. 每楼一个 AbortController:同楼新任务 abort 旧任务;CHAT_CHANGED 全量取消
  4. 装配上下文:
     - bookMemory.readBookMemory  → 柏宝书角色参考块(可 null)
     - charAnchors.resolveCharAnchors → 库文本(纯本地渲染,无请求;空库返回 text=null)
     - prompt.buildAutoTagMessages → 消息数组(见下)
  5. 请求:getTagGenChannel() 有指派渠道 → requestCompletion(服务端代理);
     否则 requestViaMainApi(generateRaw)。**每楼只此一次请求** —— 建档与选图同属一次
     推理:先在 changes 里确立新角色外貌,再在同一次输出的 tag 里 @引用它并围绕它补
     其余 tag。(旧版另有一次「中文外貌 → 字段」转换请求,已删:柏宝书的中文 desc 本就
     随角色参考块发给主请求,主请求还多了世界书/角色卡/正文佐证,判断更准。
     渠道设了思考强度时请求体改走 custom 源,见 §7 副 API 渠道。)
  6. 重试循环:retryCount 次(请求异常 / 解析抛错都重试;abort 不消耗;「无画面」不算失败)
  7. protocol.parseImagePlan 严格校验(JSON 结构/目标位置 ID/禁含子标签/size 宽容降级竖屏);
     changes 全程宽容:单条坏只丢这条,绝不连累 images —— 漏一个角色档案只是它本轮没锚定,
     为它作废整次输出会连图一起没有。图片数按 `minImages～maxImages` 范围:超上限本地硬截断,
     少于下限(>0 时)抛错交给重试循环 —— 下限是用户明确要求,宁可重试也不交残缺结果。
     每图可选 `characters`(NAI 4.5/V5 原生多角色提示,≤32 条,name/tag/nl,宽容解析单条坏只丢这条),
     注入时序列化进 `<characters>…</characters>` 子标签;4.5/V5 下建档(new)必须带 nl,否则 runner 抛错重试
  8. changes 与柏宝书建档一起转成楼层增量 ops(extra 的 bbiCharChanges),不提前落库
  9. @占位符兜底替换:applyPositionedCharRefs 把 tag/nl 里残留的 @角色名 换成「基线 + 本楼
     ops 重放」后的库 tag。**建档(new)全楼生效**——新角色的固定外貌是本楼全程成立的事实;
     **永久变化(set)才按位置门控**,染发之前的图片用旧档。未知占位符剥除并 toast 告警。
     (v0.1.2 起主路径已撤:AI 改为直接照抄库中字段值,见 §7 角色库段——多角色多次展开
     会重复外貌导致重叠躯干,tag 预算也无法执行;applyCharRefs 系函数保留为兜底)
 10. rebase.rebaseImagePositions 把插入位置从「请求开始时的正文」平移到「落盘那一刻的正文」
     (清洗后叙事行按文本 LCS 求骨架,空隙按序号比例配对,整句消失的顺延到上一锚点),
     再由 protocol.injectImageTags 在新物理行后插入
     <bbi_image>tag<nl>…</nl><negative>…</negative><size>…</size></bbi_image>
 11. 若 autoGenerate 开:先 markForAutoGenerate 每个新槽位(见链路 B 握手)
 12. messageEdit.applyMessageText 写回(正文 + extra 增量一体)。身份 CAS:聊天/消息/swipe
     任一变化即放弃;**正文内容不参与比对**——分析期间别的插件对正文的修改(翻译、润色、
     追加状态栏、改写八股句)全部保留,tag 重定位后照常注入。仅当当前正文清洗后一条叙事行
     都不剩、或写回前发现已存在 bbi_image 时才放弃(build-failed)。
     成功才 recomputeCharTags;失败撤销标记;仅 changes 无图片也走写回。
```

消息顺序(prompt.ts 固定):破限 system → 角色卡 system → persona system → 世界书 system →
后端规范 system(ComfyUI/NAI 内置 spec,`{{nl}}` 宏与 `{{#nl}}`/`{{^nl}}` 条件段按「生成自然语言」开关展开)→ 固定协议
(身份定义 + 输出契约:一个 `<thinking>` 块和一个 JSON 对象,JSON 含 images + changes)→ 思维链 system → user(角色参考 + 角色库 + 清洗后的最近 N 个 AI 故事楼及其间 user 楼 + 带段尾位置 ID 的目标正文)。

**协议形态只算一次(prompt.ts 的 `autoTagProfile()`)**:`{naiCharPrompts, nl, lockedSize}` 按默认后端
与其开关算出,写协议(prompt.ts)与验收/收尾(runner.ts,每次开跑快照一份)共用同一份——两边各算各的
迟早会漂:协议说只写 tag,验收却还在要 nl。
- `nl`:ComfyUI 取当前工作流的「生成自然语言」,NAI 取当前出图方案的 `naturalLanguage`(仅 4.5/V5 有意义)。
  两个开关同一口径,**只管 AI 写不写**:关掉时 runner 丢弃模型照写的 nl(留着就会照常发送,开关等于没关)、
  跳过「4.5/V5 建档必带 nl」的校验;**已写进 tag 的 nl 照常发送**(tag 原文是真源,不回头改)。
- 条件段(`expandNlSections`):`{{#nl}}…{{/nl}}` 开启时保留、`{{^nl}}…{{/nl}}` 关闭时保留,两个后端的
  规范与思维链都展开(含用户自定义的)——一份文本在开关两侧各自自洽,不必维护两份会漂的副本。
  不支持嵌套;配不上对的标记原样留着(写错了在请求历史里看得见,比静默吞掉好查)。
- `lockedSize`(`activeOrientationLock()`,见 §6 画幅锁):锁定时协议的 size 规则改成「每张都填锁定值」,
  示例 JSON 也填它——让 AI **按锁定画幅构图**,而不是照竖图写完再被出图端强转横图;
  未锁照旧「拿不准就填 portrait」。runner 收尾再把 size 统一改记锁定值,tag 里记的方向与实际画幅一致。

全部可编辑提示词(破限/规范/思维链)在 `state/settings.ts` 有内置默认常量
(`DEFAULT_*_PROMPT`/`DEFAULT_*_SPEC`),留空回落默认 —— 改默认提示词内容先看这里。

⚠ **设置页只暴露两对规范/思维链:ComfyUI 与 NAI**,后者存在 `naiV5Spec` / `naiV5Thinking`
(键名带 V5 是历史命名,内容对 4.5 同样适用,面板标签已改成不提代数的「NAI 规范/思维链」)。
另有 `naiSpec` / `naiThinking` 是 4.5 以下的单串 tag 版本,随旧模型下线(见 §6 `NAI_MODELS`)
**已无 UI 入口**:可选模型只剩 4.5/V5 → `naiCharPromptsOn` 恒真 → 那两份永远走不到。
键与常量都刻意保留(不动存量 settings、不动旧模型标识的协议分支与回归锁),
但**改 NAI 规范/思维链一律改 `DEFAULT_NAI_V5_*` 那一对**,别去改看着名字更正的那份。

## 6. 链路 B:楼层卡片与出图(floor/ + backends/)

**显示原理(st/imageTagRegex.ts)**:托管正则 `bbi-image-tag-slot`(markdownOnly)把
`<bbi_image>…</bbi_image>` 在显示路径替换成空锚点 `<div data-bbi-slot=""></div>`;
`bbi-image-tag-hide`(promptOnly)在提示词路径替换成空串 —— tag 永不进 DOM、永不进提示词。

**placement 必须含 3(SLASH_COMMAND)**:显示侧 placement 由 `script.js` 的 `getRegexPlacement`
按消息类型派发 —— 用户楼 1、AI 楼 2,而 **`extra.type==='narrator'` 的旁白楼是 3**。
`/narrator`、`/sys` 造出的楼是 `is_system:false` + `extra.type:'narrator'`,于是
`isAiStoryMessage` **认它是剧情楼**、自动 tag 会往里写 tag;只写 `[1,2]` 时锚点正则整条不命中,
tag 原文被 DOMPurify 剥壳后当正文显示出来(用户直接看见一串 danbooru tag),且没有锚点 = 没有卡片
—— 「tag 永不进 DOM」在这一类楼上是破的。提示词侧 ST 只用 1/2,hide 规则带上 3 是无操作,
但两条规则 placement 保持一致更好推理(replaceString 是空串,多覆盖一个 placement 无副作用)。

**水合(hydrate.ts)**:渲染事件(CHARACTER/USER_MESSAGE_RENDERED、MESSAGE_UPDATED、MESSAGE_SWIPED)→
定位 `.mes[mesid] .mes_text` → `parseImageTags(message.mes)` 与 DOM 锚点**按序配对** →
每个锚点 `attachShadow` 后 `render(h(Card,...), shadowRoot)`,记录进 `SlotRegistry`(key = chatId|mesid|swipeId|seq)。
重水合前先 `render(null, container)` 显式卸载,全程幂等。MESSAGE_DELETED / CHAT_CHANGED 全量重建。
事件后的水合走 `scheduleHydration`:setTimeout 0 先水合一次、~100ms 后再查一次——其他 ST 监听器
可能在事件后替换 `.mes_text`(晚班时锚点未变只走 props patch,零重建);换聊天则作废。

**自愈层(hydrate.ts 的 healSlots + floor/chatObserver.ts)—— 事件驱动兜不住的那一半**:
锚点活在 `.mes_text` **里面**,而 ST 自己有好几条重写 `.mes_text` 的路径**不发任何事件**:
`updateMessageBlock` 的 `.mes_text.html(...)`(script.js:1988)、`messageEditCancel/Done` 的
`.empty()`、右滑生成时的 `.mes_text.html('...')`;第三方(提示词模板类)也会在自己的渲染钩子里
`container.html(newContent)`。这些路径把锚点连同 shadow root 一起删掉,纯事件驱动的水合完全无感
—— 而 genState 是模块级的,在途生成照样跑完。用户报的**「图在生成,楼层里看不到界面」**就是它。
相邻的柏宝书没这毛病不是因为更结实,是它的宿主挂在 `.mes_text` **外面**当兄弟节点,
`.html()`/`.empty()` 只清 innerHTML;而本插件的卡片必须落在 tag 的行内位置(多 tag 楼层按位置
分别成图),搬不出去 —— 同一条约束当初也否掉了官方 `extra.media` 方案(见 §6)。故自愈是
位置约束下的唯一解。判据抽在 `floor/slotHealth.ts`(纯函数,仓里没 jsdom,靠鸭子类型假节点单测):
- `detached`(锚点脱离文档)→ 只重水合**受影响的那一楼**(按楼去重);
- `hidden-by-host`(锚点在、但祖先 `.mes_text` 带 `inline_media` = ST 的 `display:none`)
  → **只 console.warn,不强改**。那条隐藏是 ST 有意为之(`extra.inline_image===false` 的语义
  就是「这楼只看图不看正文」),强行解除会把人家特意藏起来的正文一并翻出来;且行内样式钉上就
  撤不掉(ST 之后按 extra 重算 class,管不到我们写的 style),正是「改不了又一直在生效」的暗格。
- 顺序不可换:脱离文档的元素 `closest()` 仍会沿**已断开的子树**往上走、可能真找到带
  `inline_media` 的那份 `.mes_text`;先判 hidden 就会把「已被删掉的楼」误诊成「只是被藏了」,
  于是不重挂、只去改一个不在文档里的节点,卡片永远回不来(slotHealth.test.ts 锁了这条)。

**`#chat` 观察器只有一个(floor/chatObserver.ts)**:楼层按钮对账与卡片自愈盯的是同一棵树、
同样的 `childList+subtree`,故合成一个多订阅者的观察器。**这也是「加自愈会不会常驻卡顿」的答案**:
不会 —— 开销在浏览器收集 MutationRecord 那一侧,而这笔钱从楼层按钮上线那天起就在付了,
新增订阅者的边际成本只是回调里多跑一个函数。约束:订阅者回调必须是**便宜的对账**
(healSlots 是 O(已挂载卡片数),每张只做 `isConnected` 属性读 + 一次 `closest()`,
只有真发现异常才碰 DOM);**绝不在回调里跑 `hydrateVisible`** —— 那会对每条消息跑
`parseImageTags`+`readStore`+`promptHash`,那才是真卡顿。**只订阅 childList,不订阅 attributes**:
否则自愈/主题写属性的动作会反过来唤醒自己,变成自激循环。

**卡片为什么在 shadow DOM 里**:楼层活在 ST 的 light DOM,ST 全局样式与用户装的美化主题
会直接改到卡片上。每个锚点各自 `attachShadow` → 样式双向隔离(与 index.ts 主窗口同构,
只是从「一个大 host」变成「每槽位一个小 host」)。两点注意:
- **可继承属性**(font/color/line-height…)仍穿透 shadow 边界 → `CARD_INHERITED_RESET` 在 host 上钉死;
- **自定义属性**也穿透 → 故 `theme.css` 的 `data-theme='st'` 仍能取到宿主 `--SmartTheme*`。
  样式经 `adoptedStyleSheets` 共享**同一个** CSSStyleSheet 对象(cardStyles.ts),N 张卡零重复。
  设置页 0.1.9 起移除「楼层卡片主题」选择项(卡片无边框化后恒跟随 ST 主题),但
  `settings.ui.cardTheme` 字段与 hydrate 的读取保留 —— 旧用户已设的值继续生效,别当死代码删。

**卡片状态机(Card.vue + genState.ts)**:
- **运行态**(genState.ts 的模块级 reactive Map,key 同上):`queued / generating / error`
  —— **必须放在组件外**。差分水合下同锚点卡片是 props patch 不重挂,但锚点一旦被 ST 重渲染
  重建,组件照样整体重建;reconcileGen 也因此从 onMounted 挪到 `watch(hash, immediate)`
  (旧版重挂式水合里 onMounted 必跑,差分下不一定)。运行态若存组件 ref,一被重建就清零 →
  兄弟卡片的「生成中…」集体消失并退回 pending(标记已消费不会重跑)。这是历史 bug 的根因。
- **票据(token)不可省**:key 只认槽位,不认「第几次任务」。同槽位可先后跑多个任务
  (取消后重绘、reconcile 后重来),旧任务迟到的回调必须凭 token 认领 ——
  否则 A 被 abort 后以非 AbortError 失败(HTTP 500/429 与 abort 撞车)会把**正在跑的 B**
  标成 error。`failGen/clearGen/setGenPhase/setQueueAhead` 全部要 token;
  落盘前还要 `isCurrentGen` 自检,别把旧任务的图写进 extra。
- **槽位消失要剪枝**:`reconcileGen` 只能由挂载着的卡片触发,而用户删 tag / swipe 到
  tag 更少的一版时槽位整个没了,记录会永久留存并被日后同 key 的新卡片误认领。
  `hydrateMessage` 调 `pruneGenSlots(…, tags.length)` 只删 `seq >= tag 数` 的越界槽位
  —— **不能连在途兄弟一起清**,那等于把本次重构修掉的 bug 换个形式复现(有单测锁定)。
- **派生态**(props 算出):`ready`(有本提示词历史)/ `stale`(仅有旧提示词结果)/ `pending`。
- 图片展示**刻意不看运行态**:失败/重绘中都继续显示上一张,避免「点重绘失败 → 图凭空消失」。
- onMounted:先 `reconcileGen`(hash 变了作废旧任务),再消费 autoGenerate 标记自动开跑;
  **标记一律先消费再判断该不该跑**——留着它会在日后同槽位重现(如用户删掉旧图)时被新卡片
  误认领,凭空开跑一次用户没点过的生成。判定抽成 `autoGenerate.ts` 的 `shouldAutoGenerate`
  纯函数(Card.vue 无单测:仓里没装 jsdom,vitest 跑 node 环境,留在组件里锁不住)。
  `'auto'` 放过 `pending` 与 **`stale`**:stale 的语义正是「tag 变了、当前提示词还没有图」,
  恰恰该出图——旧版只放 pending,导致楼层「重新生成 tag」在已出过图的楼层上静默失效
  (新 tag 写进去了、卡片却停在旧图),多 tag 楼层更怪:有旧图的槽位被拦、纯新增的照跑。
  `'force'`(用户点「应用并重新生成」)无条件跑——来回改回旧提示词时该桶可能已有历史。
- generate():输入就地取值存 `job`(在途时组件很可能已销毁,再读 props 不可靠)→ 定种子 →
  调 `generate.ts` 的 `generateImage`(闸门与后端分派都在里面)→ `saveImageResult` 落盘 →
  清运行态 → `hydrateMessage`。
  **灯箱回调同理**:灯箱挂插件 shadow root、活得比卡片长,楼层坐标必须快照后传参
  (`removeEntry(target, at)`),不能在回调里读 props。

**出图中段抽在 `src/generate.ts`(卡片与公开接口共用)**:一次出图被切成三段——
前(登记运行态/校验参数)、**中(闸门 → 后端分派 → 拿到图)**、后(落盘/显示/埋点)。
公开接口要的恰恰是掐头去尾的中段:第三方自己决定图显示在哪。
- **闸门不可绕过,这是抽出它的首要理由**:直接调 `generateNaiImage` 会跑在 genQueue 闸门与
  naiRateLimit 节奏之外,0.2.0 整版的限流自愈当场失效——第三方并发调用是常态,
  绕过去的症状是用户 NAI 账号吃一串密集 429,而用户只会认为柏宝绘坏了。故两条路共用本函数,
  `release` 包在 `finally` 里(`generate.test.ts` 锁「抛错也要还槽」)。
- `backendStatus()` 是「能不能出图」的**唯一判据**:卡片按钮的 `configured`、公开接口的
  `not_configured` 同源,避免「卡片能点、出图才报错」。
- **埋点刻意留给调用方**:一条历史记录的「成功」判据各家不同——楼层卡片要等落盘成功才算成,
  还要把「图拿到了却因任务被取代而丢弃」记成已取消;本模块只知道请求本身的成败,
  替调用方下结论会把那两种情形谎报成成功。故 `decideSeed` 单独导出,调用方先定种子再传进来。

**画幅锁(`OrientationLock` = `'auto' | 'portrait' | 'landscape'`)**:「只出横图 / 只出竖图」的旧办法是把横竖
两格尺寸填成一样——能出,但 AI 写 tag 时仍按竖图/横图各自构图,出图端再硬塞进同一格尺寸。
- **放在各渠道的尺寸旁边**:NAI **每套出图方案各一份**(`NaiPlan.orientationLock`),ComfyUI **每套工作流各一份**
  (`ComfyWorkflowPreset.orientationLock`,与横竖尺寸同属底模属性,切工作流即切走锁)。
  判据只此一处 `activeOrientationLock()`(按当前后端取对应那份,其余后端 `'auto'`),
  协议(§5 `autoTagProfile`)、出图(generate.ts)、卡片、编辑弹窗四处共用。
- **只在出图那一刻生效**:`generateImage` 里 `effectiveOrientation(lock, input.size)` 决定这一次用哪格尺寸,
  卡片与公开接口同走这里(锁定时公开接口传的 size 不算数),`GenerateOutput.size` 回报实际方向——
  卡片的历史记录/无图占位比例与公开接口的图库侧写都按它记,如实描述这张图。
  **tag 原文不改**:promptHash 吃原文,改写会让老图无辜变 stale;渠道改回「自动」,老 tag 记的方向原样生效。
  新写的 tag 由 runner 直接记成锁定值(§5),老 tag 不回头改写。
- 默认 `'auto'`(= 升级前行为):老配置缺字段、脏值一律落 `'auto'`,不做迁移。

**并发是后端属性,不是全局设置**:
- **ComfyUI 一次性全发**:`POST /prompt` 拿到 `prompt_id` 即入**服务端**队列,轮询各查各的
  `history/{id}`,ComfyUI 自己顺序执行。客户端再加队列纯属多余。轮询期间查 `/queue` 上报
  排队位置(`onQueue`),卡片显示「排队中(前面 N 个)」而非一律「生成中」。
- **NAI 要闸门**(genQueue.ts):`generate-image` 是阻塞式 POST、服务端不排队,并发压过去吃 429。
  **每个接入点一道闸门**(gate id = 接入点 id,上限取该条的 `NaiEndpoint.concurrency`,默认 1;
  hydrate.ts 监听接入点库逐条 `setNaiConcurrency`)。限流是各站各账号的事:官方站压 1、公益站
  能开 3,共用一道闸门就只能取最小值;A 站吃 429 也不该把走 B 站的图一起冻住。
  `generate.ts` 按 `activeNaiEndpoint().id` 取槽,`effectiveNai()` 带出 `endpointId` 交给
  nai.ts 的重试,两边记在同一本账上。
- **取消必须分流**(comfyui.ts 的 `cancelPrompt`):任务在排队 → `POST /queue {delete:[id]}`;
  正在执行 → `POST /interrupt`(带 prompt_id)。**无脑 /interrupt 会打断正在跑的别的任务**
  ——旧实现如此,并发下必现。有单测锁定这两条路径。

**NAI 限流自愈(backends/naiRateLimit.ts)**:闸门只管「同时几个」,管不了「多快一个」。
release 后立刻 `pump()`,下一个任务在同一 tick 就发出去;而错误是**按槽位隔离**的,于是被
限流时会打出一串密集失败(429 → release → 立刻再来 → 429),那正是最像滥用的形状。
策略层收口在一处,时间戳全可注入(故不用假时钟就能单测):
- **错误分类**(`shouldRetryNai`):408/429/5xx(除 501)与 fetch 的 `TypeError` 才重试;
  400/401/402 这类配置错误、以及自家的校验/解析错误立刻抛。**不分类的话,一个填错的 key
  会被退避重试放大成四倍请求量**。取消(AbortError)一律不重试。
- **退避重试**(`runNaiWithRetry`,共 4 次尝试):指数退避 + 50%–100% 抖动(多张卡不会同时
  醒来又撞一起),`Retry-After` 当**下界**、单次等待夹到 60s。只包「发请求 + 解包」那一段
  ——拼参数、读 vibe 数据是一次性的,重跑会白费功夫并重复弹 vibe 警告。
- **闸门级冷却**(冷却与上次发起时刻按闸门分账,`DEFAULT_NAI_GATE = ''` 供老调用与测试):
  429 除了让当前请求退避,还给**该接入点的整个闸门**上冷却(`noteNaiRateLimited`,
  默认 15s 或按 `Retry-After`,**只延后不提前**)。`acquireNaiSlot` 取槽后循环等完
  `naiPacingDelayMs(now, gate)` 才返回 —— 循环是因为等待期间别的槽位可能又把冷却推后了。
- **最小间隔** 1500ms(同一闸门内相邻两次发起之间):给「出图耗时撑不出间隔」的场合兜底(小图/低步数/快速失败重发)。
- 两条纪律:节奏等待**持槽进行**(否则上限内的 N 个任务会一起等完同一段再一起发,节流形同
  虚设);等待期间被取消**必须还槽**(漏一格就永久少一格并发,漏满就再也发不出请求)。
- 卡片要看得见退避(`GenRecord.retry` → 「请求受限,稍后第 N/M 次重试…」)。否则「生成中…」
  一动不动几十秒,用户以为卡死了再点一次,白白多压一个请求。
- `encodeVibeImage` 同样带重试,并由 NaiPanel 取闸门槽位(`encodeVibeGated`)——它也是一次
  真实 NAI 请求,不然「一边出图一边编码」在账号上就是两条并发。`testNaiConnection`
  **刻意不进闸门**:诊断按钮多半是在被限流时点的,拦住它只会让人没法排查。

**手动编辑提示词(PromptEditor.vue + promptEditor.ts)**:提示词的**唯一真源是正文里的 tag 原文**
(不在 extra、不在 store),故「编辑提示词」本质是一次正文写回:序列化新 tag →
`replaceImageTagAt` 原位替换第 seq 条 → `applyMessageText` → 重水合。新 tag 换出新 promptHash,
老图自动落进 stale 桶(卡片已有「旧提示词」角标与提示行),故「应用」无需任何额外落地逻辑。
四条要点:
- **序列化只有一份**(`st/imageTagRegex.ts` 的 `serializeImageTag`,`injectImageTags` 也调它)。
  两处漂移 = 「解析出的字段」与「落进正文的原文」对不上,而 promptHash 吃的是原文,
  表现为「什么都没改却全变 stale」。同理「改动检测」按**字段值**比对,不比对序列化结果:
  解析是容忍式的、序列化是规范式的,非规范的手写 tag 打开再原样保存,原文会变。
- **子标签字面量必须拦**(`containsTagMarkup`,与 AI 侧共用 `FORBIDDEN_SUBTAG`):查找正则
  非贪婪,内容里混进一个 `</bbi_image>` 会让 tag 提前截断、**后半截漏进 DOM 与提示词**。
- **不可编辑 Card.vue 的 `promptText`**:那是带「角色: 」「Negative: 」前缀的展示串,
  不可逆解析。编辑结构化五字段,没给编辑的也原样带回,否则会静默吃掉 characters。
- 弹窗挂**插件** shadow root(同灯箱),活得比卡片长 → 楼层坐标全部开窗时快照;
  身份 CAS 拦不住「tag 数变了」,故写回前自己按 `rawTag` 核对 seq 还指向同一条。
- ⚠ stale 态只显示**一张**(`latestStaleEntry` 返回单条,且 `pageable` 要求
  `history.length > 1`,翻页器整个不出现)。旧提示词下有 N 张时改提示词 → 只剩最新一张可见
  (文件与指针都没删,改回原样即全部找回)。弹窗里据此给了明确提示。
- 渠道锁了画幅方向(`activeOrientationLock()`)时,方向按钮显示锁定值并禁用 + 一行说明:出图一律
  按锁走,再让人选只是个不起作用的开关。**草稿里的 size 不动**——正文记下的方向原样保留
  (也就不会凭空换 promptHash),渠道改回「自动」即恢复按各张自己的方向出图。

**「AI 重写提示词」(入口在编辑弹窗里;runner.ts 的 `requestSlotTag` + slotPlan.ts)**:与「重绘」
的区别——重绘用**同一条提示词**再出一张,这里是让 AI 重读本楼正文、**重写这一条 tag 的内容**。
画的还是原来那个瞬间,只是提示词写得更准、更全。这条纪律的落点是写回侧
硬按 seq 原位替换、**模型返回的 position 压根不参与写回**,所以「换不换画面」实际只由
`buildSlotTaskNote` 的措辞决定——旧版那句「另选一个与它们明显不同的瞬间」正是让按钮
(写着"重写提示词")与模型收到的指令(其实是"换个画面")对不上的根因。
分析与写回都只围着一个槽位转,不碰本楼其它 tag 与图片:
- 分析基底是 `stripImageTags(整楼)`(AI 不该把 tag 当正文),并靠 `buildSlotTaskNote` 把**该槽位
  当前的提示词原样喂回去当锚点**(不截断:不给全文,模型只能从正文猜这张画的是哪个瞬间,
  猜偏就又成了换画面);其余槽位摘要仍然带上,但用途是「别抢它们的画面」而非「别选中它们」;
- 强制 `min=max=1`(build 的规则文案与 `parseImagePlan` 校验要同时覆盖,只改一处自相矛盾);
- 库文本取 `charTagsBeforeFloor(floor + 1)`（含本楼已落档增量),否则 AI 会把首轮建档的角色
  当新人重写;**本次 AI 的 changes 一律丢弃**(首轮全量分析已为整楼建档,重复应用只会污染历史);
- 写回是 `replaceImageTagAt` 原位替换第 seq 条(同 PromptEditor),写前按 `rawTag` 核对 seq
  还指着同一条;成功后 `markForAutoGenerate(..., 'force')` 让本槽位自动按新提示词出图,
  旧图落进该槽位 stale 桶,其余槽位走差量水合、图片零重建;
- **入口在提示词编辑弹窗里,不是独立按钮**:手改与 AI 改是同一件事的两种手段,放一起用户
  才能「让 AI 写一版 → 看着不顺手就手动接着改」。三条约束(用户明确要求)及其落点:
  - **弹窗不自动关**——点一下就闪退像是崩了。跑完只回填输入框 + 面上给一行说明;
  - **仍然直接落盘**——落盘与出图是 runner 干的,与弹窗无关,关不关窗都照做;
  - **关窗不中断、重开能续上**——请求交给 `floor/tagPlanState.ts` 的 `runTagPlan` 托管,
    生命周期归 store 不归弹窗;重开时 `awaitTagPlan(key)` 取回**同一个在途 promise** 接着等
    (存的是 {票据, promise} 而非布尔,就是为了这个)。收尾后从**当前正文**重读第 seq 条,
    同时刷新 `content`(回填草稿)与 `rawTag`(否则用户接着点「应用」会撞上「这条 tag 已被
    改动」——而改动它的正是我们自己)。
  - ⚠ **卸载后绝不能再 render**(`closed` 闸门,0.3.0 开发期踩过的真实回归):重写活得比弹窗长,
    它的收尾回调必然在关窗之后才到,而 `paint()` 是无条件 `render(...)` 的。关键在于
    **容器 `remove()` 了并不等于看不见**——`ModalMask` 把内容 `<Teleport>` 到 `modalHost`,
    往脱档容器里渲一次,弹窗就原地复活贴回屏幕;复活的还是**全新实例**(`closing` 的 watch
    没有 `immediate`,顶着 `closing=true` 挂载也不会自行隐藏),而 `requestClose` / `onApply`
    又都在 `closing` 上早退 → 叉、取消、应用**全部点不动,窗再也关不掉**。
    故 `paint()` 首行 `if (closed) return;`,且 `closed = true` 必须排在 `render(null)` **之前**
    (两者之间插进一次迟到的 paint,卸载掉的就是它刚挂上的新实例,等于白关)。
- 卡片这边仍然显示「AI 重写提示词…」遮罩并留取消钮:关了弹窗重写照跑,没有这个口子
  就只剩一张悄悄变化的图、没处叫停。展示态读 `isTagPlanning`,取消走 `cancelFloorTags`
  (与全量分析共用「每楼一把」的在途锁)。
  ※ 想**换一个画面**(而不是重写同一画面的提示词)走的是另一个入口:ST ⋯ 菜单里的
  调色盘按钮(`floor/actionButton.ts` → `requestFloorTags({replace})`),整楼重新分析。

**卡片折叠(collapseState.ts + Card.vue)**:折叠态是「临时遮蔽」性质的 UI 态,不是数据——
存模块级 store、**不写 message.extra**(每次折叠都 saveChat 落盘,代价与语义都不合适),刷新后
回落设置项 `settings.ui.autoCollapseImages`(「楼层图片默认折叠」)。与 genState 同理必须放
组件外:swipe/编辑/ST 重渲染都会重挂卡片,放组件 ref 里用户折好的图会自己弹开;key 与
genState 同构(chatId|messageId|swipeId|seq),重建后按 key 认领。手动折叠/展开过的槽位
覆盖默认值(`isCollapsed` 取 `Map ?? 默认`);不主动清理(一个槽位只占一个布尔,旧聊天残留
可忽略,切回来还在反而是期望行为)。折叠时卡片收成一条细条,生成中/出错在条上直接给状态,
整条点击展开。

**卡片版面(card.css)**:卡片是**聊天内嵌**元素,不是独立面板——每多一像素都在推散正文。
故头部与底部按「一行的高度」定死:头部 `4px padding + 26px 按钮 = 34px`,底部折叠入口
`5/6px padding + 22px` 一行。**所有按钮同一条基线**:`.bbi-btn` 高 26,`.bbi-btn--icon`
必须 `width == height == 26` 且图标统一 15px —— 只写 width 不写 height 时,图标按钮会
比文字按钮矮一截,同一行里一眼看得出参差(历史 bug)。图标本身也要光学对齐:
`trash/copy/download` 的墨迹范围须接近,否则像素尺寸相同仍显大小不一。
操作分工:**头部只放「对当前这张图」的操作**(下载/删除/重绘),提示词的操作(复制)
跟着提示词放进展开区——展开区里的复制按钮**绝对定位**,并排 flex 会让它随长文本高度飘到中间。

**楼层图片显示大小(`settings.ui.imageDisplaySize`,设置页「楼层图片显示大小」)**:只管**聊天里显示多大**,
不碰出图分辨率、不改图片文件。小/中/大 = 显示高度封顶 400/600/800px(默认「中」),「铺满」= 旧版
铺满楼层宽度。Card.vue 按 `imageDisplayMaxHeight()` 挂 `data-capped='1'` + `--bbi-figure-max-h`:
- **封高度不封宽度**:PC 上嫌大的是竖图铺满楼层宽后比一屏还高;按宽度封顶,竖图照样高、横图反被压小。
- 舞台 `width: fit-content` 收成图片本身的宽——⋯ 钮、翻页器、角标都以舞台绝对定位,舞台不收窄
  它们就飘在图片旁的空白里。宽度仍 `max-width: 100%`,窄屏照旧按宽缩放。
- 无图占位没有内容可撑宽(fit-content 会塌成 0),按画幅比例反推「高度恰好顶到上限」的宽。
- 默认「中」而不是「铺满」是刻意的:老配置缺这个字段就落「中」,不做迁移——旧行为正是要修的问题,
  想要回去在下拉里选「铺满」。

**楼层图片沉浸显示(`settings.ui.immersiveImages`,默认关)**:有图时 ⋯ 与翻页器整组藏起(舞台挂
`data-hide-ui='1'`),点一下图浮现,点卡片外任意处收起;浮现时再点图才进灯箱——代价是开启后进灯箱要点两下。
- 只在有图时生效:无图时占位区就是操作区,藏了没处点。生成中/重写中的遮罩与「旧提示词」角标不藏(是状态,不是操作)。
- 浮现态是 Card.vue 的临时 ref,不进 store:重水合重建后回到藏起,正合沉浸的默认。
- 收起靠 document 捕获阶段的 `pointerdown`,只在浮现期间挂(一屏几十张卡不该各自常驻全局监听);
  卡片在锚点的 open shadow root 里,判「点在卡片外」用 `composedPath().includes(root)`——`contains` 不跨 shadow 边界。
- 藏用 `visibility` 而非只降 `opacity`:opacity:0 的按钮仍可命中,会在图上留隐形热区。

**⋯ 菜单全平台横排(card.css 的 `.bbi-figure__actions`)**:菜单在 ⋯ 左侧横向排开,放不下就折行
(`max-width` 不越过舞台左缘,`row-reverse` + `align-items: flex-start` 让 ⋯ 在展开/折行时都钉在右上角)。
触屏曾在 ⋯ 下方竖排展开:横图在手机上只有两百来像素高,六七颗钮竖排越出舞台底边、被 `overflow:hidden`
裁掉,后面几个按不到。桌面 hover 浮现、触屏点 ⋯ 展开的交互分工不变。

**图片放大与长按保存(Lightbox.vue)**:ST 原生灯箱够不着——入口 `.mes_img` 只是 class,
`expandMessageMedia` 读 `chat[mesid].extra.media[data-index]` 且模块私有未导出;走官方
`extra.media` 会把图挂到 `.mes_media_wrapper`(`.mes_text` 的兄弟),脱离 tag 行内位置。故自建。
**长按保存靠三条约束**(改前务必读 Lightbox.vue 顶部注释):只监听 `click` 不拦 touch;
不加 `user-select:none`/`-webkit-touch-callout:none`;显式 `touch-action:auto` 抵消 ST 的
`body{touch-action:none}`(css/mobile-styles.css:251)。灯箱挂**插件** shadow root 并 Teleport
到 `modalHost`(需要 `--bbi-*` 变量),不能挂卡片自己的 shadow——会被 `.mes_text` 的层叠上下文裁掉。

**存储(floor/storage.ts)**,三层:
- 新图片二进制 → ST 文件系统 `user/images/柏宝绘_<角色名>/bbi_<角色名哈希>_<swipeId>_<promptHash>-<genId>.<ext>`
  (角色名优先取消息发言者,其次取当前聊天角色名,空值回退「未命名角色」;
  `st/images.ts` 上传时由服务端清洗目录名,文件名保留 promptHash 稳定哈希);
- 元数据 → `message.extra.bbiImage = { [swipeId]: { [promptHash]: BbiImageEntry[] } }`
  (历史时间正序,卡片翻页;`slotSeq` 隔离同楼多 tag;`meta` 存出图元信息,供图库当前聊天免抓侧写)。
- 侧写(sidecar)→ `user/files/<与图片同名>.json`,存 tag 原文 + seed + `meta`(出图元信息),
  **只为图库服务**:
  图库跨全部聊天按目录列图,而提示词只在某一个聊天的 extra 里,扫全库 JSONL 反查不可行
  (单角色 chats 目录可达 GB 级、`/api/chats/get` 整文件返回无分页)。
  文件名由 `sidecarFileName` 纯函数从图片名推出,不维护索引(`/api/files/upload` 原样落盘只校验不清洗)。
  json 进不了 `user/images`(上传接口的 format 必须是媒体扩展名),故落 `user/files`。
  **写失败只 warn 不抛** —— 图已存好,不能因附属 json 丢图;老图没有侧写属正常。
- **出图元信息(GenerationMeta)** 随图落盘,填的是「不在 tag 文本里」的溯源信息:画师串(名字+正文快照)、
  实际叠加的 vibe(名字/配置强度/归一后的实际强度)、模型、画幅像素、实际发送的正/负面词、采样参数
  (以及 ComfyUI 简易模式的模板/底模/VAE/CLIP/LoRA)。**必须在出图那一刻从后端冒泡出来**
  (NAI 的 `generateNaiImage` 返回 `usage`,经 `generate.ts` 组装成 `GenerateOutput.meta`),不能落盘时再读设置:
  一是并发下会张冠李戴,二是只有后端才知道「哪些 vibe 实际没被跳过」。自定义工作流正文一律不存。
  侧写 `v` 升到 2 以标记新增 `meta`,读侧对老 `v:1` 文件与无 `meta` 的旧 entry 自然降级。
- 写回用 CAS 循环(`mutateStore`,引用比对 + `saveChat`);保存顺序:先文件后指针 / 删时先指针后文件。
- 旧 `user/files` 图片不迁移、不删除,按原路径显示;删除旧记录仅移除指针,只对 `user/images` 图片调用文件删除接口(连同它的侧写)。
- **图库删图是另一条路**(`deleteImageFileOnly`):没有指针可摘——图库按**目录**列图,指针散在
  各个聊天的 extra 里,两者之间没有反向索引,而扫全库反查不可行(同侧写那条的实测数据)。
  故它**只删文件+侧写、不碰任何聊天记录**,必然留下破指针,由卡片侧运行时降级兜底(见下)。

**破指针降级(floor/missingImages.ts + Card.vue)**:模块级 `reactive(Set)` 记「已确认不在的路径」。
- **必须放组件外**:卡片生命周期由水合决定(任一兄弟槽位出图就重建整楼),
  标记若在组件 ref 里,重建后破图原地复活。同 `genState.ts` / `collapseState.ts`。
- **必须先确认再落册**:`<img>` 的 `error` 分不清「文件没了」和「网断了/500」,
  故 `confirmImageMissing` 补一次 HEAD(`st/images.ts` 的 `probeUserImage`),
  只有服务端明确 404 才记;分不清(返回 `null`)一律不记,破图占位留着下次重挂自然重试。
  把掉线记成删除,用户网一抖就满屏「文件已删除」且刷新前好不了。
- **不写回 extra**:那要 `saveChat()`,而「文件没了」是磁盘的客观状态不是聊天数据,
  且用户完全可能把文件恢复回来。会话内记住即可。
- 卡片一律用 `liveHistory`/`liveStale`(过滤掉已确认缺失的)算 phase、翻页器、张数:
  不过滤则翻页器多出翻得到却是空的格子、折叠条张数虚高;删光则退回 pending 给出「生成图片」
  入口(而非顶着 ready 显示破图、连重新生成都点不了),并加一行「图片文件已删除」说明。
- 路径归一化(`normalizeImagePath`)是**读写两侧唯一口径**:extra 存的是服务端原样返回的
  未编码中文路径,图库拼的是逐段 `encodeURIComponent` 的,前导斜杠也有无不定;
  两套写法不对账,图库删完图卡片照样显示破图。删除入口(`deleteImageFileOnly`)同样先走
  这一归一化再发请求——ST 的 `/api/images/delete`、`/api/files/delete` 都是把 `body.path`
  直接 `path.join` 到根目录、**不做 URL 解码**,编码路径传过去只会 404。

**出图后端(backends/)**:
- `comfyui.ts`:两种互斥模式在 `generateComfyImage` 里分叉,汇合点是「拿到可提交 JSON」:
  - **custom**:API 格式工作流模板,支持 `%prompt% %negative_prompt% %seed% %nl% %width% %height%`
    占位符(不支持即报错);
  - **simple**(comfyTemplates.ts):选模型/LoRA + 填参数,按架构模板族组装 JSON,**无占位符**。
    模板族刻意收敛为 checkpoint 系 / Flux / Anima(Qwen 链路),新架构 = 加一条模板数据 + 一个组装分支;
    正向 = 固定正面 + (nl 优先 || tag),负面 = 固定负面 + AI 动态负面(Flux 无真实负面输入,恒空)。
  请求通道自动选择 —— **浏览器直连优先,仅网络级失败(CORS/拒连)回退 ST 服务端转发**;
  排队拿到 prompt_id 后轮询失败不重发(避免重复生图)。
  入参类型是收窄后的 `ComfyRunConn`(url + 单套预设的 mode/workflow/simple + 横竖尺寸),
  **不认整个 `ComfyUISettings`**——后端层只该知道「这一次出图用什么」,不该知道用户存了几套。
- `comfyObjectInfo.ts`:简易模式的候选列表。直连 `GET /object_info` 一次拿全(含 LoRA/CLIP);
  回退 ST 转发只有 `/api/sd/comfy/models|samplers|schedulers|vaes`(服务端摘 object_info 字段,
  **没有 loras/clips 端点**),转发通道下这两组降级为手输。session 级缓存,「刷新」强制重拉。
- `nai.ts`:协议与官方一致(浏览器直连,url 可指第三方兼容站,自动补 `/ai` 前缀);v4 系走
  `v4_prompt` 结构 + vibe 编码缓存;NAI3 直接发参考原图;质量词/负面词按「当前画师串 → 模型官方词」
  分别回落(画师串对应字段存空串 = 跟随官方),方案里展示并编辑同一份画师串数据;正向拼装顺序为
  **画师串 → 画面 tag → 质量词**(方案引用画师串库里的一条,见 §7);
  `.naiv4vibe` 导入导出与官方互通。
  **NAI 4.5/V5 走「Base + 原生 Character Prompts」分支**:谓词是 `naiSupportsCharacterPrompts`
  (= `isNai45 || isNai5`),`v4_prompt` 结构里 `char_captions` 填来自协议的 characters
  (每角色一条,库数量 tag `1girl→girl` 降级、tag+**英文** nl 拼一条 caption,负面侧给空 caption 占位)。
  ⚠ 边界在 **4.5** 而不是 V5,也不是整个 v4 系:`char_captions` 所在字段本就叫 `v4_prompt`,
  这套结构是 V4 时代的协议、V5 只是继承,而自然语言是 **4.5 才引入**的(原版 NAI4 只吃 tag)。
  曾按 `isNai5` 卡过,导致 4.5 明明支持却一条角色提示都发不出去,角色外貌全糊进 Base
  (`nai.test.ts` 有回归锁)。nl 一律写**英文**:生图模型读英文自然语言更可靠,中文还要多花
  几倍 token(4.5 的 base + 全部 character prompts 合计约 512 T5 token)。**角色名是唯一例外**:
  characters[].name / changes[].name 与 tag/nl 里出现的角色名必须逐字保持原文(中文名写
  中文,不音译不意译)——插件按名字逐字匹配库条目做替换,名字对不上档案/正文锚定就断。
  **「生成自然语言」开关(`NaiPlan.naturalLanguage`,每套方案一份,默认开 = 升级前行为)**:就是为这 512 token
  的预算加的——4.5 上 nl 与 tag 抢同一份预算,超出部分被截掉,画面就开始走样;4.5 读自然语言也不如 V5。
  口径与 ComfyUI 的同名开关一致(§5 `autoTagProfile`):关掉后协议/规范/思维链改成纯 tag 版
  (`{{^nl}}` 条件段)、runner 丢弃模型照写的 nl 并跳过「建档必带 nl」校验;**已写进 tag 的 nl 照常发送**,
  多角色 Character Prompts 照常拆分(只是每条 caption 只剩 tag)。开关在方案编辑弹窗的模型选择下方,
  不按模型隐藏:可选模型只剩 4.5/V5(见下),开关恒有效。新建方案仍默认 V5 + 开;仅在用户从非 4.5
  模型手动切进 4.5 且开关当前为开时自动关闭并 toast 告知(可在下方重开)。已有 4.5 方案、切方案、
  加载设置与 4.5 家族内换档都不经过这段自动修改,不覆盖用户已有选择。
  **真正的 V5 专属差异只有三处**:`params_version: 4`、采样器限子集(列表随模型过滤,面板同步)、
  varietyBoost 无效(`skipCfgAboveSigma` 对 V5 返回 null,4.5 用 magic 58)。
  **V5 Full Medium(`nai-diffusion-5-full-medium`,官方「Medium Effort」)**:V5 Full 的省点数档,
  `isNai5` / `vibeModelKey`(→ v5full,与官方同口径)/ Character Prompts 都按子串自然覆盖;唯一不同是
  **官方锁死参数**(官方前端模型能力表的 `fixedSettings`,`naiFixedSettings` 照抄):步数 14、采样器
  Euler Ancestral、不支持 CFG Rescale(发 0)、负面词恒为官方 Heavy 预设——官方前端对它隐藏这几项,
  发请求时连用户自填的负面词都清空,插件同口径,不赌服务端收不收自定义值。`naiUndesiredContent` 对它
  无视画师串里的值(条目里存的负面词不动,换回别的模型照常生效);面板把这几项换成「官方固定」字样。
  它的默认负面词是**官方 Heavy 原文**,不串 5-full 那层插件精选缺陷词(官方定死的就是这一份)。
  **V5 不支持 Vibe**(`naiSupportsVibes` 只认 NAI3 与 v4 系):早先文档写「V5 同样可用」是错的——
  只因 `vibeModelKey` 有 v5full/v5curated 键就当成支持。那两个键现在只为读写官方 .naiv4vibe 不丢数据;
  V5 下勾选的 vibe 出图时整组跳过并 toast 提示,面板禁用上传编码。
  方案的 `vibeIds` **不随模型清空**:方案切到 V5 时勾选原样保留,方案编辑与 Vibe 库都提示「官方暂不支持,勾选保留、出图跳过」;
  日后 V5 支持 Vibe,只需改 `naiSupportsVibes`(再补 `vibeModelKey` 的编码 key 映射),老方案的勾选当场生效。
  正向串在 4.5/V5 且带 nl 时拼成 `tags. nl`(句点分隔)。
  **可选模型只有 4.5 与 V5 五条**(`NAI_MODELS`,同时是 `normalizeNai` 的白名单):4.5 以下
  已下线,存量配置(每套方案)里的旧模型会被**改写**成出厂方案的模型(5-full)并打一条
  `console.warn` —— 画风、Anlas 消耗与 vibe 编码 key 都会跟着变,这是有意接受的代价
  (`settings.naiModelRetire.test.ts` 锁住「在列的不动、下线的必留痕」)。
  ⚠ `NaiModel` 类型比 `NAI_MODELS` 宽,`isNai3` / 原版 NAI4 的协议分支也都还在:留着是为了
  不动回归锁,也留一条回退余地。**它们从 UI 已不可达**,别再按「这分支还活着」去推断产品行为。
- `chatu8Vibe.ts`:只读智绘姬的 extension_settings + IndexedDB,逐条导入 vibe(内容指纹去重、读取超时、迁移进度)。
  另有提示词预设三件套(collectChatu8ArtistRefs / detectChatu8Artists / importArtistsFromChatu8):
  读 `yushe` 表 + `yusheid_novelai` 当前选中,每条预设三个字段按**位置对应**迁移——
  前置固定正向(fixedPrompt)→ 画师串(正向最前)、后置固定正向(fixedPrompt_end)→ 正面质量词
  (正向最后)、固定负向(negativePrompt)→ 负面提示词,且负向非空时把**当前模型官方基线**烤在
  前面(智绘姬口径 = 官方 UCP + 用户负向;空则留空走回落链,基线跟随模型)。**同名即同一配方**:
  内容不同 → 覆盖更新(旧版迁移把正向整体塞进画师串的条目,重导即修好)、完全相同 → 跳过;
  active 预设映射到目标 id 由调用方决定是否选中。结果逐条带 plans(state: import/overwrite/skip
  + 目标 id + 落盘值),纯函数不落盘;UI 在 NaiPanel「从智绘姬迁移」折叠区:入口常驻,
  点开弹窗算一次预览(徽标:将导入/将覆盖/已存在),确认后 push/覆盖 + 可选切换。
- `vibeStore.ts`:Vibe 原图/编码正文与缩略图分文件存 ST `user/files`，文件存储不可用时回退本机 IndexedDB。
  `extensionSettings['baibai_image']` 只留路径、模型键、指纹等小型索引，禁止再放 Base64。

### 漫画方案(MOSS-Image)

出图方案有类型(`ComfyKind`:illustration / comic);NAI 恒为插画。漫画方案把**整楼剧情**精选改编成若干页,
页数与每页分格由 AI 按内容定,**不设硬上限**,协议只给「每页 3～5 格、一楼通常 1～2 页」的参考量。
早先协议要求「从头到尾覆盖、不跳过中间剧情」,实测两千多字一楼画出 7 页——全覆盖谓词会逼模型逐段开页,
改成「只画关键瞬间,过渡/重复对话/心理描写直接略去」才压得住(协议、内置规范、思维链三处同口径)。

- **tag 形态**:`<bbi_image><type>comic</type><layout>{紧凑 JSON}</layout><size>…</size></bbi_image>`。
  `<type>` 由插件按当前方案写,AI 不参与;**插画 tag 永不写 `<type>`**(promptHash 吃原文,
  给存量 tag 补字段会让老图全变 stale)。没有 `<type>` 的一律是插画。bbox 存 0–1000 的 `[y0,x0,y1,x1]`,
  出图时才按实际像素换算(`toAbsCentralized`),故漫画方案**必须填好横竖尺寸**,且须为 16 的倍数。
- **生成 tag**:`autoTagProfile().comic` 切换协议——`prompt.ts` 发 `comicContract`(`pages` 形状,
  建档/永久变化/锁定规则与插画共用同一段文本),`protocol.ts` 的 `parseComicPlan` 校验(≥1 页、按位置排序)。
  角色外貌**由 runner 烤进 caption**(`bakeComicAppearance`:按 item.name 查该页位置生效的库,
  口径 `entriesAtPosition`),不让 AI 照抄——跨页一致性靠插件,不靠模型记性。
  外貌拼成**带主语的句子**(`comicAppearance`:`a girl with …, wearing …`),AI 的 caption 以动作开头接在后面。
  早先烤的是 `1girl, 黑发, …` 逗号 tag 流,实测一页四个人物框就串人(台词格画成另一个角色、动作安错人);
  每页 character 框也在规范里压到 4 个以内。
  外貌**只认字段,nl 仅在字段全空时兜底**:插画时期建的档 nl 常是中文概述(没有瞳色之类),
  且永久变化只改对应字段、nl 不跟着改——优先 nl 会把含糊或过期的外貌烤进漫画。
- **出图**:`generate.ts` 遇 `input.comic` 时用 `buildMossPrompt` 现算正向 JSON;简易模式的固定正面
  并进 summary 并从 conn 里清掉(否则 composePositive 会拼在 JSON 前面,整串就不是 JSON 了)。
- **类型不符**:`tagBlockReason`(纯函数,有单测)判定 tag 与当前方案对不上、或分镜损坏。卡片据此禁用生成、
  静默跳过自动出图,只给「按当前方案重新生成本楼」(`requestFloorTags(floor, { replace: true })`);
  generateImage 自己也兜底拒绝。漫画 tag 不给手改、不给单张 AI 重写(runner 的 `slot-comic` 闸门);
  插画 tag 遇漫画方案时编辑弹窗里的重写与「应用并重新生成」禁用。公开接口把漫画方案报成未配置
  (第三方只会递插画提示词)。

## 7. 状态与持久化

- **settings(全局,跨设备)**:`state/settings.ts`。import 阶段以默认值建 reactive;
  ST 就绪后 `hydrateSettings()` 从 `extension_settings['baibai_image']` 载入
  (**normalize 逐字段容错 + 存量迁移**,如 resolution→横竖两格、webui 隐藏迁移);
  `ready` 守门标志防默认值覆盖服务器设置;deep watch → 防抖 `saveSettingsDebounced()`。
  订阅者用 `onSettingsReady(cb)` 等 hydrate 完成(如 ui.ts 回灌主题)。
- **ComfyUI 工作流库**:`settings.comfyui.workflows`(`ComfyWorkflowPreset[]`)+ `activeWorkflowId`。
  - 一条预设 = 名字 + `mode`(custom/simple 互斥)+ 工作流 JSON + `simple` 参数 + `naturalLanguage` + 横竖尺寸
    + `orientationLock`(画幅锁,见 §6;老预设缺字段落 `'auto'`)。
    这些跟着工作流走而非留在渠道级,因为它们是**底模的属性**(Illustrious 要短 tag + 832×1216,
    Flux 要自然语言 + 1024 方图);留在渠道级的话每次切工作流还得手改两处。
    `url` 反过来仍是渠道级(一台服务器跑所有工作流)。
    两模式的字段都常驻(切模式不丢另一边的配置),只是出图时只生效一边;
    存量预设没有 mode/simple 字段,normalize 补 `custom` + 简易默认值。
  - **不变式:`workflows` 恒非空**。`comfyDefaults()` 出生即带一条空预设(只用一套的人感觉不到「库」的存在),
    `normalizeComfyUI()` 收尾再兜一次;`activeWorkflowId` 悬空时回落第一条。
    消费方一律走 `activeComfyPreset()` / `effectiveComfyConn()`,不直接摸数组,故无需到处判空。
  - **存量迁移**:老配置的平铺 `workflow` / `naturalLanguage` 加渠道级横竖尺寸,由 `foldLegacyWorkflow()`
    原样折成第一条「默认工作流」(口径同 `foldLegacyNegative` / `migrateSize`:用户特意设过的值绝不被默认值顶掉);
    `workflow` 为空串也照样建这一条。靠字段有无判断,无 schemaVersion。
  - 工作流 JSON 随设置整体进 `settings.json`(单套数 KB–数十 KB)。刻意**没有**像 Vibe 那样搬去 `user/files`:
    量级差两个数量级。若日后设置保存变慢,这里是第一嫌疑人。
- **NAI 出图方案库**(0.3.5):`settings.nai.plans`(`NaiPlan[]`)+ `activePlanId`,形状对齐 ComfyUI 工作流库。
  一套方案 = 名字 + 接入点引用(`endpointId`)+ 模型 + 画师串引用(`artistId`,空 = 不用)
  + 采样参数 + 叠加的 vibe(`vibeIds`)+「生成自然语言」+ 画幅锁 + 横竖尺寸。起因是用户反馈
  「换风格要改好几处、设置散、覆盖关系看不懂」:换一套画风原本要分别动模型、画师串、vibe 开关、质量词,
  现在一个下拉整套切换。三个库(接入点 / 画师串 / vibe)仍是全局的,方案只存引用。
  - **并发不进方案,跟接入点走**(`NaiEndpoint.concurrency`):它是 genQueue 的闸门,管的是「这个站/账号同时几张」,
    不属于任何一套画风;按方案存会让切方案顺手改了限流。
  - **正/负面词跟画师串走**:当前画师串对应字段有值就只用它,留空才回落模型官方词
    (`naiQualityTags` / `naiUndesiredContent`);正/负面分别判断。方案里的两个框直接读写画师串条目,
    未选画师串时只读展示官方词。方案化初期短暂存在的 `plan.qualityTags` / `plan.undesiredContent`
    仅为兼容保留存储,不再参与出图,也不需要「套用」复制。
  - **vibe 勾选按方案存**(`vibeIds`,老数据的逐张 `enabled` 已删除)。模型不支持 vibe 时(V5)勾选**原样保留**、
    出图跳过 —— 见 §6 nai.ts 的「V5 不支持 Vibe」。删 vibe 时从所有方案的 vibeIds 里一并移除。
  - **引用修复**(normalizeNai 收尾,三种口径各不相同):`endpointId` 悬空回落 `endpoints[0]`;
    `artistId` 悬空清成 `''`(内置 `bi_*` 不算悬空);`vibeIds` 逐条剔除不存在的 id 并去重。
    `activePlanId` 悬空回落 `plans[0]`;`plans` 恒非空(空数组补一套出厂方案)。
  - **存量迁移**(`foldLegacyNaiPlan`,靠 `plans` 键有无判断;空数组按脏数据处理、不重迁):老的渠道级
    平铺字段原样折成唯一一套「默认方案」,`activeEndpointId` / `activeArtistId` 成为方案的引用;
    正/负面旧值也保留在方案兼容字段中,画师串条目本身的绑定词不丢,但实际出图只按「画师串 → 官方」取值;
    `enabled === true` 的 vibe 成为 vibeIds。
    迁移后老平铺字段一概不留(`settings.naiPlans.test.ts` 锁住)。⚠ 代价:回滚到 0.3.2 及以前,
    老版本读不到平铺参数,会落回出厂值(回滚到 0.3.0–0.3.2 时接入点库仍在、key 不丢;更老的版本只认平铺 key,要重填)。
  - 消费方一律走 `activeNaiPlan()` / `effectiveNai(plan?)`。`effectiveNai` 产出 `NaiRunConfig`:方案参数 +
    解开的引用(接入点 url/key、画师串快照、按 vibeIds 过滤后的 vibe 列表,保持库内顺序)。
    `backends/nai.ts` 只吃 `NaiRunConfig`,不认识「方案」这个概念 —— 同 `effectiveComfyConn()` 的理由。
- **NAI 接入点库**:`settings.nai.endpoints`(`NaiEndpoint[]`),由方案的 `endpointId` 引用。
  一条接入点 = 名字 + 接口地址 + 该站的 API Key + 同时出图数(`concurrency`,1–4,默认 1)。起因是「公益站换着用」:
  出图参数都在方案里,接入点只管出口 —— 换站只改方案里的接入点下拉,参数不用重配;
  多套方案可共用一个接入点。key 随条目走而非共用一份,因为各站各有各的 key。
  - **不变式:`endpoints` 恒非空,且恒含内置官方那条**(`OFFICIAL_NAI_ENDPOINT_ID = 'nep_official'`,
    url 恒为 `NAI_OFFICIAL_URL`)。方案的 `endpointId` 悬空时回落 `[0]`。这三条**与工作流库同侧、
    与画师串库相反**:地址是必需品(空了直接出不了图),回落只是换个出口且出错会当场报连接失败,
    不像画师串回落那样静默改变每张图的样子。
  - **官方条只读**:UI 禁掉改名/改址/删除,`normalizeNaiEndpoint` 遇 `nep_official` 一律重建成内置值
    (手改 settings.json 也拗不过);只有 key 保留 —— 内置的是地址与名字,不是别人的密钥。
    要用官方镜像就新建一条普通条目(地址框以官方地址作 placeholder),那条随便改。
  - **UI**:列表只放名字(点开即编辑),增改都在弹窗里做草稿、点「完成」才写回 —— 照副 API 渠道的样子。
    连接测试测的是草稿,不必先保存;删除按钮在弹窗里,官方条与被方案引用的条目禁用并以 title 说明原因。
  - **同时出图数迁移**:老的全局 `nai.concurrency` 分给当时已有的每一条(条目自带值优先,夹回 1–4);
    老平铺第三方地址场景下事后补的官方条从 1 起步(它从没跑过那个并发,官方站并发高最易 429)。
    迁移后不留顶层 `concurrency`。
  - **存量迁移**(`migrateNaiEndpoints`,靠字段有无判断,无 schemaVersion):老配置的平铺
    `url`/`key` 收成第一条。url 为空或就是官方地址(绝大多数)→ key 直接折进官方那条,不多出重复行;
    是第三方站 → 建一条「我的接入点」放**首位**并保持选中,官方条**追加在后**(官方排前面会把
    用户正在用的出口挤到第二行,看起来像被换掉了)。老的 `activeEndpointId` 随方案化折进默认方案,
    老平铺 `nai.url`/`nai.key` 迁移后不再保留。`settings.naiEndpointMigration.test.ts` 锁住全部上述口径。
  - 消费方一律走 `activeNaiEndpoint()` / `effectiveNai()`(= 方案全部参数 + 它引用的接入点 url/key),
    不直接摸数组。`backends/nai.ts` 三个入口(`testNaiConnection` / `generateNaiImage` /
    `encodeVibeImage`)签名不变,吃的就是这个窄化结果 —— 同 `effectiveComfyConn()` 的理由。
    ⚠ 漏走一处的症状很隐蔽:那处若直接取 `endpoints[0]`,只用一个接入点的人仍然是通的,
    只有切到第二个接入点的人才会发现某个功能还在往老地址发。
  - ⚠ `backendStatus().reason` **刻意不带接入点名字**:它经 `getBackendStatus()` 原样递给第三方,
    而名字是用户自己敲的 —— 有人就拿站点域名当名字,带上等于把地址漏进公开返回值
    (`public/api.ts` 的白名单正是为挡这个)。面板自己的 toast 标题不受此限,那是本地 UI。
- **NAI 画师串库**:`settings.nai.artistPresets`(`NaiArtistPreset[]`),由方案的 `artistId` 引用。
  一条 = 名字 + 画师串(prompt,拼在正向提示词**最前面**)+ 可选的正面质量词(quality)
  与负面提示词(negative)。拼装顺序:画师串 → 画面 tag → 质量词(画师串放最前是因为它定整幅画的
  基调,NAI 对靠前 tag 权重更高)。
  - **正/负面随画师串生效**:对应字段有值就只使用它,空串或纯空白才回落当前模型官方词;
    两个字段各自独立回落,方案旧值不参与也不叠加。智绘姬导入的提示词预设同样选中即生效。
    `nai.test.ts` 锁住优先级、逐字段回落、空白处理与方案旧值隔离。
  - **不按模型分表**(与质量词/负面词相反):官方质量词是**模型的属性**,切模型必须跟着换;
    画师串是**用户自己的配方**,跨模型复用才是常态,故做成可增删的库而非 `Record<model, …>`。
  - **与工作流库刻意相反的三处**:①`artistPresets` **允许为空**(工作流恒非空);
    ②`naiDefaults()` **不播种**任何一条(工作流出生即带一条);③方案的 `artistId` 悬空时
    `normalizeNai` **清成空串**而非回落 `[0]`。根因是必需品与可选项的差别:不给工作流就
    出不了图,不给画师串只是不加画风;回落 `[0]` 会在用户删掉当前条目后**静默套上一套
    他没选过的画风**,而下拉显示的正是那一条(看起来就是自己设的),几乎无法排查。
    有单测锁定这条对照(`settings.naiArtistMigration.test.ts`)。
  - 空串是「不使用」的哨兵。preset id 恒为 `art_*` 形状(normalize 保证非空),故空串不会
    与任何 id 相撞,无需像 `vibeGroups` 的 `g:` 那样装箱(那里组名由用户输入、会撞名)。
    清成空串也让 `artistId ∈ {'', 用户库 ∪ 内置库的 id}` 成为不变式,面板无需再判悬空。
  - 解析只在 settings.ts 一处:`naiArtistFor(plan)` 查用户库 → 内置库,悬空返回 null(刻意只读——
    在 computed 里被调用);`effectiveNai()` 把解出的条目快照进 `NaiRunConfig.artist`。
    `backends/nai.ts` 的 `naiArtistPrompt(nai)` 只读这个快照(纯函数,可单测),不自己查库 ——
    settings.ts 已 import nai.ts 的 `naiDefaultUndesired`,反向值依赖会成运行时环。
  - ⚠ `fullPositivePrompt` 在 `buildNaiParameters`(v4_prompt 来源)与 `generateNaiImage`
    的顶层 `input` 处**各调一次**,两处必须同源。拼装改动一律留在函数内部——在某个调用点
    单独加料会让 NAI3(读 input)与 NAI4/4.5(读 v4_prompt)拿到不同提示词,且只在 NAI3
    上暴露(现有测试全是 4.5 模型,一个都不会红)。有同源断言锁定。
  - **内置只读库**:`BUILTIN_NAI_ARTISTS`(backends/nai.ts,id 恒为 `bi_*` 前缀,与用户
    `art_*` 永不撞)随插件版本更新、**不进 settings**(否则默认值冻在用户设置里,升级不跟进)。
    新装的默认方案引用第一条(见 naiDefaults);老用户的选择随迁移折进默认方案,不受影响。
    只读:库与挑选弹窗都不给改名删除,自定义只能「复制」成用户条目再改 —— 这是内置条唯一的
    自定义路径。要下线内置条至少留一个版本:正选中它的用户会走「id 悬空 → 清成不使用」,
    画风静默变掉,需慎重。
  - **预览图**:`NaiArtistPreset.previewPath` 可选(老数据无此键;很多条目始终不传图,是常态不是缺损)。
    库的编辑弹窗上传时压成最长边 512 的 jpeg,落 `user/images/柏宝绘_画师串/<条目id>.jpg`
    (st/images.ts 的 `/api/images/*`,路径记条目上、不维护额外索引)。换图同名覆盖不攒孤儿,
    URL 不变,故用 `panels/artistPreview.ts` 的会话级版本号破缓存(库与挑选弹窗共用一份);
    删条目 best-effort 连带删文件(删不掉不阻塞删条目);**复制条目不带走 previewPath** ——
    两条目共指一个文件,删一边另一边破图。
  - **「选」与「管」分两处**,按「条目很多、有图没图混杂」设计:
    - **挑选弹窗**(NaiArtistPicker.vue):方案编辑里的「画师串」一行是个入口(有图带小缩略图 +
      名字),点开是 3:4 卡片网格 + 常驻搜索,首格恒为「不使用」;无图卡片把画师串本身
      (`artistPromptGist` 去掉 `artist:` 前缀)铺在色块上当封面,与有图卡片同几何,网格才齐。
      **只做选**:点一张即写入方案并关窗,卡片上不放编辑钮;另有「新建」= 建空白条目并直接选上
      (库空时不至于无路可走,回方案里在画师串框填内容)。
    - **画师串库**(NaiArtistLibrary.vue,内嵌在面板的折叠区,不再另开大窗):与挑选弹窗**同一种卡片**
      (`ArtistTile.vue`;内置排前、带「内置」小字),网格限高自滚;超过 6 条才出搜索框。
      曾做成只放名字的列表,传了预览图也看不到,被指「不直观」——画师串是视觉资产,预览图就是它的名字。
      点卡片开编辑弹窗
      (名称/画师串/正面质量词/负面提示词草稿,「完成」才写回;预览图即传即落盘;复制/删除)。
      方案里的正/负面框与这里读写同一条目,共用该画师串的方案一起生效。新建 = 先推进库再开编辑,
      取消即撤回。「多选」只服务批量删除,内置条不可勾。**库里没有「启用」**——它不在任何方案的
      上下文里,选用一律去方案编辑。
    - 纯逻辑在 naiArtistLib.ts:`matchArtist` 按名字 + 画师串内容搜索(绑定的正/负面词不参与——
      匹配面铺得越广误伤越多);`planArtistRemoval` 只按 id 切分去留,**不再有接位**:删除发生在库里,
      没有「当前方案」可接,引用被删条目的方案一律清成 `''`(与悬空口径一致,**不**回落 [0]),
      删除确认框会先列出受影响的方案。写回时按 id 现过滤当前库,而非用开删时的快照——
      等删预览文件期间库可能又被新建/复制改过。
  - **存量迁移**:库本身纯加法;老的 `activeArtistId` 折成默认方案引用,各条目的绑定词原样留在库中并直接生效。
- **Vibe 大文件**:
  - `extensionSettings['baibai_image'].nai.vibes`:仅存 `NaiVibe` 小型索引，不存原图、缩略图 dataURL 或编码正文;
  - `user/files/bbi-vibe-*.json`:原图与各模型编码正文;
  - `user/files/bbi-vibe-thumb-*`:列表缩略图;
  - IndexedDB `baibai_image_vibes`:ST 文件写入失败时的本机回退，不跨设备同步。
- **旧版 Vibe 自动修复**:`hydrateSettings()` 在 normalize 前直接扫描旧条目，按顺序逐条落盘;
  每条成功后立即原地替换并释放该条 Base64，不等整库完成。全部成功后只保存一次轻量设置。
  首次升级可能需要等待搬迁，刷新后恢复正常;若某条文件与 IndexedDB 都写失败，则保留原条目并报错，
  已成功条目不会退回大对象，下次刷新继续重试。
- **智绘姬迁移**:`chatu8Vibe.ts` 顺序读取并立即调用 `vibeStore.ts` 落盘，不在内存或设置中积累整库大对象;
  导入项不会被任何方案勾选，避免生成时一次读取全部 Vibe 正文。
- **Vibe 强度唯一口径**:一律走 `vibeStore.ts` 的 `clampVibeStrength`(夹 0–1,认不出数回落
  默认 0.6)。曾有四份各自为政的实现,其中三份写作 `Number(v)`——`Number(null)`/
  `Number('')` 都是 0,「字段缺失」被静默判成「强度 0」,vibe 挂了却没效果,极难排查。
  只认真数字和可解析字符串;面板数字框 step="any" 自由填值,夹取后回写 input
  (防「填 5 被夹到 1、框里却留着 5」的骗人显示)。
- **Vibe 分组**:`NaiVibe.group` 是扁平字符串(空串 = 未分组),无独立 groups 数组——组只是
  「一起启用/一起折叠」的标签,没有自身属性,改名/删组都是对成员 group 字段的批量赋值,
  不会产生悬空引用。`backends/vibeGroups.ts` 纯逻辑:组名一律 `g:` 前缀装箱(防与
  「未分组/新建」哨兵撞名)、`groupVibes` 归拢 + 搜索、`isGroupActive` 启用集合判定
  (等于组内全部成员才生效,搜索期间仍按全量成员算)。出图只看当前方案的 vibeIds,
  组的批量动作本质是对 vibeIds 的批量改写,不引入第二套真相。
  智绘姬迁移时若旧名带「组名 · 原名」前缀(`planPrefixGroups`),还原成分组并去掉前缀。
- **副 API 渠道(跨插件共享)**:真身存 `extensionSettings['baibai_api_channels']`(带 revision),
  本插件设置里只是镜像;写入后广播 `st-baibai-api-channels:changed`,他端监听重读。
  与柏宝书共用,任一端增删改实时同步。
  - **思考强度**(`ApiChannel.reasoningEffort`,空串 = auto = 不发参数,老渠道零变化):ST
    代理对 openai 源的 `reasoning_effort` 卡**模型名白名单**(OPENAI_REASONING_EFFORT_MODELS),
    模型名对不上就静默丢弃、还照样返回 200 —— 用户设了却看不出来。故非空时整条请求改走
    custom 源(api/client.ts 的 `buildRequestBody`,纯函数有单测):`custom_include_body` 由
    服务端直接 merge 进上游请求体,不过白名单。两个坑已规避:custom 源**不读 proxy_password**,
    key 靠 `custom_include_headers` 注入 Authorization;`custom_include_*` 是 YAML 字符串且
    解析失败会静默忽略,一律 JSON.stringify 生成(key 里带 `:` `#` 等会炸 YAML)。取值不做
    白名单校验原样透传(各家词汇不统一)。⚠ 跨插件:柏宝书 ≤ 当前版本的 normalizeChannel
    是「逐字段重建对象」,在书里新增/编辑/测试渠道会回写共享存储、**抹掉本字段**(绘独有),
    等书那边补同名字段后风险消失。
- **排除设置(跨插件共享)**:真身存 `extensionSettings['baibai_exclude_settings']`(带 revision),
  镜像在 `settings.excludes`(四张名单:excludedChars / excludedWorldNames /
  excludedWorldInfoPatterns / customStripTags);协议与渠道同构(指纹防回环 + revision 取 max),
  事件 `st-baibai-exclude-settings:changed`。与柏宝书共用同一份名单、同一套匹配口径:
  排除角色 → 自动 tag 全流程停用(楼层按钮也在下一次对账时撤掉);整本/条目名排除 → 副 API 世界书过滤
  (autoTag/excludes.ts);清洗标签 → 扫描/正文清洗整块删除(autoTag/clean.ts)。
  共享存储创建时播种默认条目名规则 `\[mvu[\s\S]*?\]`(只发一次,删了不补回)。
- **ui(本机 + 同步)**:窗口开关/当前页(activePage 存 localStorage)是纯本机态;
  主题/导航/悬浮球/楼层图片默认折叠(autoCollapseImages)/楼层图片显示大小(imageDisplaySize,§6)/楼层图片沉浸显示(immersiveImages)
  属真设置,写入 `settings.ui` 走跨设备同步。
  图库分组默认折叠,仅将手动展开的目录名存入本机 `bbi.ui.galleryExpanded.v1`;
  旧 `galleryCollapsed.v1` 不反推展开态,未记录的新目录默认收起。`v-if` + Transition
  使图片仅在展开时挂载、收起动画结束后卸载,保留原生 `loading="lazy"`。
  每组首次显示 24 张,之后每次最多追加 24 张;追加数量仅本页面内保留,刷新页面后重置,
  同页面内收起再展开保留进度。目录/文件名仍全量读取,不影响角色搜索和总数统计。
  **多选删除**:独立的「选择」开关(不做长按进入——浏览是主用途,点图=放大必须是默认行为),
  分组头的复选框选的是**整组**而非当前渲染的那批(懒加载只是渲染策略)。删除逐张容错
  (单张失败不中断其余,失败的留在列表里且仍勾着),删完 `markImagesMissing` 让已打开的
  楼层卡片立刻降级,并**就地**从列表摘掉而非重新 `load()`(否则展开态与已加载批次全被重置)。
  **分组体积(⚠ 暂时禁用)**:原方案逐张 HEAD 读 `Content-Length`——`/api/images/list`
  只返回文件名(服务端 `util.js getImages` 只 map 出 `dirent.name`),既无 size 也无 mtime,
  只能一张张问(静态路由 `res.sendFile`,实测 1~2ms 且无 body,比图库直接加载原图当缩略图
  便宜得多)。**作者不满意这一方案(请求数随图库规模线性增长),`index.vue` 的 `load()` 中
  `measureSizes` 调用已注释**,计算/模板/CSS/测试原样保留,恢复时解注即可;`probeUserImage`
  仍供 `missingImages.ts` 的 404 确认使用。原设计:后台限并发(`src/pool.ts` 的 `mapLimit`,
  6 路——ST 单进程,压太狠会卡住用户自己的聊天)且不阻塞首屏;量不到的**不计入**而非当 0
  累加,未量全的文案带「≥」;返回三态(`exists:true` / `exists:false` / `null`=分不清),
  `null` 让网络抖动不会被当成删除。
- **charTags(三层真源:全局库 + 本聊天手动基线 + AI 楼层增量)**:
  - **全局库**:存 `extensionSettings['baibai_image_char_global']`(globalCharTags.ts,
    协议同共享渠道:revision + 指纹 + 广播事件),跨聊天/跨设备。定位是**冻结模板**:
    只由用户手动增删改或「提升为全局」写入,不记 history;AI 的 changes 对锁定名
    (全局独有、本聊天无同名条目的角色)一律丢弃——重放(applyCharTagOps)与
    @替换(applyPositionedCharRefs)双侧拦截,runner 写楼层增量前也先滤一遍;
    库文本里锁定条目带 [locked] 标记,提示词声明其不可变。本聊天手动建同名条目
    即覆盖全局并解锁(「复制到本聊天」按钮走的就是这条);「提升为全局」把当前生效值
    快照进全局后删本聊天副本、清同名楼层 ops,由全局接管。
  - **本聊天手动基线**:存 `chatMetadata['baibai_image_char_tags']`,手动编辑/回滚/旧版快照落这里,
    不随楼层删除。
  - **AI 楼层增量**:自动建档与 changes 写进目标消息 `extra['bbiCharChanges']`
    (CharTagFloorDelta: v/swipe/ops;op 分 new/set 两种),与正文同一 CAS 写回成功才落盘,
    楼层/swipe 删除时自然失效(增量带 swipe 匹配)。
  - `charTagLib` 只是响应式派生缓存:合并种子(本聊天优先,全局补同名空缺,
    mergeCharTagSeed)+ 按楼层物理顺序重放增量(deriveCharTags,带锁定名过滤);
    `charTagsBeforeFloor(floor)` 取楼层时刻快照;MESSAGE_DELETED/MESSAGE_SWIPED 后重算。
  - 手动编辑/删除 = 用户接管:detachFromExistingFloors 清掉该角色在旧楼层里的同名操作
    (压进手动基线),之后新楼层仍可继续被 AI 变更。
  - 建档与后续维护都归主请求(changes 的 field="new"/字段更新),与选图同属一次推理;
    外貌按字段(fandom/sex/hair/eyes/skin/body/extra/outfit)记录,拼接顺序即最终 tag,
    fandom(同人身份 tag,character name (copyright name))拼在首位;旧整串以 raw 兼容。
    建档必须带 hair 与 eyes(二次元身份锚点),缺任一项该条丢弃。
    同人身份 tag 必须写进档案:判定为同人的角色,field:"new" 建档时写 fields.fandom;
    已建档但缺 fandom 的用 field:"fandom" 的 changes 补档;画图时从档案照抄放首位。
    原创角色不写 fandom。ComfyUI 侧不照抄 fandom(括号转义规则不同,身份 tag 仍按
    comfy 规范现场判定并转义)。
    柏宝书的中文外貌随角色参考块发给主请求作依据;角色管理页另有「按柏宝书最新外貌
    生成」按钮(generateCharTags),那是用户主动点的一次性转换,不在自动流程里。
  - AI 引用走**直接照抄**(v0.1.2 起):提示词要求把库中字段值一字不改写进 tag/nl(库里写
    long black hair 就写 long black hair),不用 @角色名 占位符。撤回原因:同一角色被引用
    多次时逐次展开,一张图里出现多份完整外貌 + 多个 1boy,模型据此画出重叠躯干;且
    「40 tag 以内」的预算无法执行(AI 数 @小雪 是 1 个,展开成 6 个);库脏数据也会被
    无条件放大。库文本本就在同一上下文里,照抄可见文本比凭记忆复述可靠。
    applyCharRefs 系函数保留为兜底:模型偶发写出 @名字 时仍会被替换,不至于把字面量
    送进生图。同一角色的固定外貌一张图里只写一遍,再次提到用简短指代承接。
    名字一致性写进提示词:首次建档的 name = 角色卡/世界书/柏宝书/正文里的原名(中文名写
    中文);已建档角色的引用(含 nl 里的名字) = 档案名,逐字相同,禁止音译/变体——
    插件所有锚定与替换都按名字精确匹配,名字不一致即断链。**作用域限定在有档案(或本次
    建档)的角色**:这套规则的全部目的是保护逐字匹配,一次性角色不参与任何匹配,不受此约束。
    页面提供历史查看与逐条回滚(建档记录回滚 = 删条目)。
  - **建档资格 ≠ 入画资格(0.2.3,仅 4.5/V5 路径)**:两者挂**互相正交**的谓词——
    进不进库看「有名 + 有设定/持续参与」(规则未变);占不占 `characters[]` 看**本图取景框内
    是否可见**,与档案无关。故一次性无名角色照常入画,拿一条**仅本图有效**的 Character
    Prompt(name = 正文指称原词,外貌一次性补全),不建档、不写 changes、不进库。
    起因:实跑中模型把「一次性无名路人不建」读成「无名者不能入画」,连续放弃了核心互动
    另一方是无名对手的全部瞬间,改挑能把他裁出镜头的景别。根因不是「规范少一种状态」,
    而是**造名单的谓词写错了**——思维链第一层 B 只清点「有名有姓」,那人从未上册,下游
    规则根本看不见他。修法是统一谓词(清点「谁在场」)+ 逐人标注三类身份
    (【已建档】/【本次建档】/【一次性】),第三种状态由三条正交定义自然推出,不作为例外授权。
    配套必须同批改,缺一处那人就在某一环被判死刑:第一层 B 名单与身份标注、第二层槽位块
    (块名允许正文指称、**固定外貌槽给【一次性】留合法填法**——旧口径「照抄库中/刚建档的
    字段」是唯一来源,无名者在这个槽位上无路可走)、第三层自查「二选一 → 三选一」、
    C 段服装时间线排除【一次性】(否则给一次性对手维护跨图服装账本,反过来诱发建档)。
    **选图与描述分开**:任务协议要求优先表现玩家主角和主要角色的表情、状态、行动及关系,
    主要角色不等于所有已建档角色,也不要求玩家每张出现。NAI 的 E 段先定主体与核心互动,
    再取景;不损失画面内容时优先排除无关在场者,必要的无名互动对象或人群照常保留,
    不以有无名字/档案给候选加减分。B 段清点名单不是入画名单,槽位与自查按本图可见
    范围书写,不能把镜头外的人补进 Base。
    **入画后的落位才看可数性**:正文当作个体的(对手、店主)给角色块,当作一团的(人群、
    士兵们)留 Base,拿不准按一团。此规则只管已选入镜头的人,不是鼓励加入路人或人群。
    **禁止为一次性角色编人名**:`name` 虽不发给 NAI(见 §6 characterCaption),却会随
    `<characters>` 序列化进正文,而 cleanHistoryText 保留 bbi_image → 下一楼原样读回;
    一个假人名与真档案在回灌文本里无法区分,会被下一楼误判为正式角色而建档。
    同批修掉的还有**人数口径**:Base 人数 = 取景框内可见人数(不是场景在场人数),不得
    因缺档裁掉核心互动参与者,但允许排除无关在场者。旧口径只说「必须与正文一致」,模型于是自创
    「镜头外存在合理」的旁注来自我说服。规范示例也一并改掉:旧例 Base 写 `2girls` 却只给
    一条 Character Prompt,恰好演示了「另一个人没有落位」这一反面行为。
    ⚠ 这是纯提示词改动,`prompt.test.ts` 锁的是**措辞**不是行为,能否真的修好只能实跑验证。

## 8. 贯穿全项目的约定

- **降级优先**:任何宿主能力取不到(柏宝书/EJS/checkWorldInfo/渠道)→ 返回 null/空串,不阻断主流程;
- **幂等**:所有 bind*/inject*/ensure* 可重复调用;水合/按钮注入都靠内部标志或 DOM 检查;
- **CAS 写回**:改正文(messageEdit)、改 extra(storage)都先比对基准再落盘,失败放弃;
  正文的基准只含**身份**(聊天/消息/swipe),内容差异由 autoTag/rebase.ts 重定位而非放弃——
  与别的改正文插件共存的关键;
- **abort 贯通**:AbortController 从 runner 一路传到 fetch/轮询(comfyui 的 abortableDelay);
- **纯函数可测**:解析/协议/参数构造均为纯函数,配 `*.test.ts`(vitest,与被测文件同目录)。
  改协议/后端参数时跑 `pnpm test` 保底;
- **渠道二选一**:`getTagGenChannel()` 有指派 → 副 API(服务端代理);否则跟随主 API(generateRaw)。
- **随机段一律走 `randomUuid()`**(src/randomUuid.ts):ST 常在非安全上下文(http)下运行,
  那里 `crypto.randomUUID` 直接抛错;vibe 缓存键/文件名随机段只是防撞,不需要密码学强度。
- **文本转 base64 一律走 `utf8ToBase64()`**(src/base64.ts):`btoa` 的入参是 latin1 二进制串,
  码点 > 255 直接抛 InvalidCharacterError —— 提示词、角色名全是中文,直接 btoa 会当场炸。
  必须先 `TextEncoder` 编码成字节再逐字节转(且分块拼接防栈溢出)。

## 9. 公开接口:开放给第三方插件(public/)

`globalThis.STBaiBaiImage`(0.2.5 起,`apiVersion: 1`)。对外文档是仓根的 **`PUBLIC_API.md`**
—— 那是写给第三方作者看的,**改接口必须同批改它**,否则第三方照着旧文档写出来的代码会静默错。
形制照抄隔壁柏宝书(`globalThis.STBaiBaiBook`,本插件自己就是它的消费方):第三方学一套约定即可。

开三件事:`getCharacters()` 读角色库、`getBackendStatus()` 问后端就绪、`generate()` 出图,
外加 `subscribe()` 与 `st-baibai-image:ready` / `:changed` 两个 window 事件。
**生成的图不进任何聊天记录**:不占楼层、不写 extra,第三方自己决定显示在哪
(动机就是这个——柏宝绘自己的图画在楼层正文里,有的插件想画在侧边栏/自己的弹窗里)。

分层:`types.ts` 只有契约 DTO,`api.ts` 是实现层(跨边界的脏活全在这),`register.ts` 管挂载与事件。

**五条纪律,每条都对应一类真会咬人的问题**:
- **一切出去的数据深拷贝**(`clonePublic`)。`charTagLib.entries` 是 Vue reactive 数组,
  原样递出去 = 把角色库的写权限一起给了:轻则被下一次 `recomputeCharTags()` 静默冲掉
  (用户看见「我改的东西又没了」),重则 reactive 代理进了对方的响应式系统两边互相触发。
  `capabilities` 是 getter、每次返回新副本;通知也给**每个订阅者各一份**
  (否则第一个订阅者改坏 detail,后面的全遭殃,有单测锁)。
- **后端状态按白名单出**,不是「整个 status 递出去再删敏感字段」——后者日后往内部结构加字段时
  会静默泄漏。NAI 接入点的 key 与各后端 url **永不出现在任何公开返回值里**
  (`api.test.ts` 直接 dump JSON 断言不含 key/域名/端口)。`history` 同理刻意不给:
  给出去就删不掉了(删字段要升 apiVersion)。
- **错误归一成带 `code` 的普通 Error**(`toPublicError`)。`NaiError`/`ComfyUIError`/`DOMException`
  的 instanceof 跨 bundle 必然失效(两份构造函数),第三方只能匹配中文文案。故统一挂
  `aborted / not_configured / invalid_args / rate_limited / backend_error`。
  取消判定看 `name === 'AbortError'` 而非 instanceof:abort 多半由第三方**自己的**
  AbortController 触发,那个 DOMException 来自它的 realm。
  `rate_limited` 与 `backend_error` 分开是因为处置方式不同(前者该等,后者重来也一样错)。
- **图一律转 data URL**。ComfyUI 直连返回 blob: URL 要配对 `revokeObjectURL`:第三方忘了就泄漏,
  我们替它 revoke 它的 `<img>` 就变空白。原始 blob 在 `finally` 里撕掉。
- **不降级、不猜**:ComfyUI 不支持 `characters`(全链路不读该字段),回报 `charactersApplied: false`
  而**不**把角色拼进 prompt —— 那正是 0.2.3 修掉的重叠躯干问题。第三方的 `onProgress`
  抛错只记 console,不连累生成。

**`apiVersion` 与 `pluginVersion` 分开**:前者是公开数据结构的版本(固定 1),后者天天涨。
结构**只增不改不删** —— 加可选字段安全,改含义或删字段一律升 apiVersion。

**落盘(`save`,默认 `true`)**:外部图照常进图库,走 `storage.ts` 的 `saveExternalImage`
→ `user/images/柏宝绘_<角色名>/` + 同名侧写 json(与楼层图同一套目录与文件名规则,
图库据此分组并读出提示词)。侧写存的是 **tag 原文**(`serializeImageTag`,含 `<bbi_image>` 壳)
而非展示文本,否则图库反解析出一团糊在一起的裸 tag。**落盘失败只 warn 不抛**:图已经在
`dataUrl` 里了,因为存不进图库就让第三方连图都拿不到是本末倒置(`path` 返回 null 让它看得出来)。
⚠ 文件名必须过 `sidecarPathFor` 的正则,否则图库压根不去请求侧写——症状是**图在、提示词空白、
且没有任何报错**(`storage.test.ts` 把上传用的真实文件名喂回 `sidecarPathFor` 锁这条)。
侧写里的 size 记**实际出图方向**(`GenerateOutput.size`):用户锁了画幅(§6)时它与请求的 size 不同,
图库里的 tag 要如实描述这张图。返回值结构不变(不加字段,apiVersion 仍为 1)。

**变更通知**:`register.ts` 只 `watch(() => charTagLib.entries, …, {deep:true})` —— 角色库是
**响应式派生结果**,一律 watch 它本身,不去逐个订阅那些**导致**它变的事件(切聊天/删楼/滑动/
手动改档/AI 建档),漏订一个就是一类静默不通知。同一批变更用 `queueMicrotask` 攒成一条
(否则一次重算能刷出十几条一样的通知,每条都可能引第三方做一次全量刷新)。

**注册时机**:必须排在 `hydrateSettings()` 之后(见 §3)。`registerPublicInterface()` 幂等,
API 对象 `Object.freeze`,一个插件改不动下一个插件拿到的东西。

## 10. 任务定位索引(改需求先查这里)

| 想改什么 | 去哪个文件 |
|---|---|
| 启动流程 / 新子系统挂载 | src/index.ts |
| 开放/修改第三方接口 | src/public/(types 契约 + api 实现 + register 挂载)+ **PUBLIC_API.md 必须同批改**;结构只增不改不删,改含义要升 apiVersion |
| 出图链路中段(闸门 / 后端分派 / 就绪判据) | src/generate.ts(卡片与公开接口共用;**绕过它就绕过了 NAI 闸门**) |
| 设置项(新增字段/默认值/迁移) | src/state/settings.ts(类型 + defaults + normalize 三处) |
| 设置窗口 UI | src/pages/settings/index.vue |
| 提示词内置默认(破限/规范/思维链) | src/state/settings.ts 的 `DEFAULT_*` 常量(NAI 那对是 `DEFAULT_NAI_V5_*`) |
| 自动 tag 触发条件 / 去重 / 重试 | src/autoTag/runner.ts + generationGate.ts(生成门配对) |
| 发给 LLM 的消息组装(顺序/内容) | src/autoTag/prompt.ts(NAI 一律走 DEFAULT_NAI_V5_SPEC:Base+Character 双提示) |
| LLM 输出协议(JSON 形状/位置 ID/tag 格式) | src/autoTag/protocol.ts |
| 世界书/角色卡/persona 装配 | src/autoTag/context.ts |
| 柏宝书状态读取 | src/autoTag/bookMemory.ts |
| 角色库 v3(基线+楼层增量/changes ops/@占位符兜底/历史回滚) | src/autoTag/charAnchors.ts + src/state/charTags.ts + src/autoTag/runner.ts |
| Vibe 分组 / 搜索 / 启用集合判定 | src/backends/vibeGroups.ts(纯逻辑)+ NaiPanel.vue(交互) |
| 副 API 请求(代理/SSE/超时/测试) | src/api/client.ts |
| 思考强度(渠道弹窗 + custom 源请求体) | src/state/settings.ts 的 `ApiChannel.reasoningEffort` + api/client.ts 的 `buildRequestBody`(UI 在 settings/index.vue) |
| 跟随主 API | src/api/client.ts 的 requestViaMainApi |
| ComfyUI 工作流 / 出图 / 通道回退 | src/backends/comfyui.ts |
| ComfyUI 简易模式(模板组装/校验) | src/backends/comfyTemplates.ts(UI 在 ComfyUIPanel.vue) |
| ComfyUI 模型/LoRA 列表拉取 | src/backends/comfyObjectInfo.ts |
| ComfyUI 工作流库(多套保存/切换) | src/state/settings.ts 的 `ComfyWorkflowPreset` + `activeComfyPreset` / `effectiveComfyConn`(UI 在 ComfyUIPanel.vue) |
| 工作流 AI 自动配置(节点定位) | src/backends/comfyWorkflowAssistant.ts(+ 面板按钮在 ComfyUIPanel.vue) |
| NAI 参数 / vibe / .naiv4vibe / 智绘姬提示词预设导入 | src/backends/nai.ts + vibeStore.ts + chatu8Vibe.ts(NaiPanel 提供 UI) |
| NAI 出图方案库(整套参数切换 / 迁移) | src/state/settings.ts 的 `NaiPlan` + `activeNaiPlan` / `effectiveNai` / `foldLegacyNaiPlan`(UI 在 NaiPanel.vue「出图方案」区 + 方案编辑弹窗) |
| NAI 接入点库(多站地址+密钥切换) | src/state/settings.ts 的 `NaiEndpoint` + `naiEndpointFor` / `activeNaiEndpoint`(内置官方条 `nep_official` 只读,UI 在 NaiPanel.vue「接入点」区,方案里选用) |
| NAI 画师串库(多套保存/拼在最前) | src/state/settings.ts 的 `NaiArtistPreset` + `naiArtistFor`(拼装在 backends/nai.ts 的 `naiArtistPrompt` / `fullPositivePrompt`,UI 在 NaiPanel.vue,方案里选用) |
| 画师串库(列表/编辑/预览图/批量删除)与方案里的挑选弹窗 | src/pages/backend/panels/NaiArtistLibrary.vue、NaiArtistPicker.vue(共用卡片 ArtistTile.vue;预览图破缓存 artistPreview.ts;纯逻辑在 backends/naiArtistLib.ts;内置只读库在 backends/nai.ts 的 `BUILTIN_NAI_ARTISTS`) |
| 画师串预览图(user/images 上传/删除) | src/st/images.ts + imageFile.ts(文件夹常量 `ARTIST_PREVIEW_FOLDER`) |
| 图库页(按角色名分组列图) | src/pages/gallery/index.vue(目录/文件列举在 st/images.ts 的 `listUserImageFolders` / `listUserImages`) |
| 图库多选删除 / 分组体积(体积**已暂时禁用**,代码保留待恢复) | src/pages/gallery/index.vue + src/floor/storage.ts 的 `deleteImageFileOnly`(只删文件不碰聊天记录)+ st/images.ts 的 `probeUserImage`(HEAD 三态返回;现供 404 确认,原亦量体积)+ src/pool.ts / src/bytes.ts |
| 图被删后卡片不显示破图 | src/floor/missingImages.ts(模块级 reactive 册,HEAD 确认 404 才落册)+ Card.vue 的 `liveHistory` / `liveStale` / `@error` |
| 图库点图看提示词 | src/floor/storage.ts 的 `sidecarFileName` / `sidecarPathFor`(存图时写侧写)+ gallery/index.vue(当前聊天读 extra、其余取侧写;展示口径 `formatPromptText`) |
| 漫画方案(MOSS 分镜协议 / 外貌烤入 / 出图换算 / 类型不符处理) | 见 §6「漫画方案」:prompt.ts 的 `comicContract` + protocol.ts 的 `parseComicPlan` + runner.ts 的 `bakeComicAppearance` + backends/mossLayout.ts + generate.ts 的 `tagBlockReason`;内置规范/思维链在 settings.ts 的 `DEFAULT_COMFY_COMIC_*` |
| 画幅方向 / 尺寸解析 | src/backends/size.ts(刻意不依赖 settings) |
| 画幅锁(固定横/竖,各渠道尺寸旁) | src/state/settings.ts 的 `activeOrientationLock`(NAI `nai.orientationLock` / ComfyUI 每套预设的 `orientationLock`)+ size.ts 的 `effectiveOrientation`;出图生效在 generate.ts,协议改口在 prompt.ts 的 `sizeRule`(UI 在 NaiPanel / ComfyUIPanel) |
| 「生成自然语言」开关(ComfyUI 每套预设 / NAI 每套方案) | src/autoTag/prompt.ts 的 `autoTagProfile`(协议与 runner 共用)+ `expandNlSections`(`{{#nl}}`/`{{^nl}}` 条件段);NAI 字段 `NaiPlan.naturalLanguage` |
| 楼层图片显示大小(聊天里显示多大,不是出图分辨率) | src/state/settings.ts 的 `IMAGE_DISPLAY_SIZES` / `imageDisplayMaxHeight` + Card.vue(`data-capped`)+ card.css「显示大小封顶」段(UI 在 settings/index.vue) |
| 楼层卡片显示 / 水合 / 状态机 | src/floor/hydrate.ts + Card.vue |
| 手动编辑生图提示词(卡片 ⋯ 铅笔) | src/floor/PromptEditor.vue + promptEditor.ts(序列化在 st/imageTagRegex.ts) |
| 「AI 重写提示词」(只重写某一槽位的提示词,画的仍是原来那个瞬间) | src/autoTag/runner.ts 的 `requestSlotTag` + src/autoTag/slotPlan.ts;入口在编辑弹窗(PromptEditor.vue + promptEditor.ts);运行态与「关窗不中断/重开续上」src/floor/tagPlanState.ts |
| 写 tag 后自动出图的握手 / 判定 | src/floor/autoGenerate.ts 的 `shouldAutoGenerate`(纯函数,Card 无单测) |
| 卡片折叠(默认折叠 / 手动折叠态) | src/floor/collapseState.ts + Card.vue(默认值 = settings.ui.autoCollapseImages) |
| 卡片「生成中」状态 / 取消 / 并发 | src/floor/genState.ts(运行态)+ genQueue.ts(NAI 闸门与节奏等待,每接入点一道) |
| NAI 429 / 重试 / 退避 / 闸门级冷却 | src/backends/naiRateLimit.ts(策略与节奏状态唯一口径;genQueue 取槽后等待,nai.ts 包住请求) |
| 图片放大 / 长按保存 / 保存删除按钮 | src/floor/Lightbox.vue + lightbox.ts(另存走 download.ts) |
| 卡片版面 / 按钮尺寸基线 / 卡片主题 | src/floor/card.css + cardStyles.ts(令牌来自 styles/theme.css) |
| 结果存储 / 文件命名 / CAS | src/floor/storage.ts + src/st/images.ts(外部图落盘走同文件的 `saveExternalImage`,与楼层图共用目录/文件名/侧写规则) |
| 显示/提示词两侧的正则 | src/st/imageTagRegex.ts(提示词展示全文口径 `formatPromptText`,卡片与图库共用) |
| 楼层按钮 / 顶栏按钮 / 魔杖入口 | src/floor/actionButton.ts / src/topbar.ts / src/menu.ts |
| 正文写回(含竞态) | src/st/messageEdit.ts |
| 请求历史(LLM/生图,内存不持久化) | src/state/history.ts(store)+ src/pages/history/index.vue(页面)+ src/api/client.ts 埋点 |
| 复制到剪贴板 | src/st/clipboard.ts 的 copyText |
| 主窗口 UI(遮罩/导航/动画/抽屉) | src/App.vue + state/ui.ts + components/ |
| 主题 | src/styles/theme.css + state/ui.ts 的 THEMES |
| 图标 | src/components/Icon.vue(新增图标 + PATHS) |
| 新增页面 | src/pages/<id>/index.vue + pages/registry.ts 注册 + Icon.vue 加图标 |
| 版本号 | package.json(build 自动同步到 manifest.json;更新对比源 = 远端 GitHub manifest.json 的 version) |
| 更新检测 / 自动更新 | src/update.ts(红点/按钮在 NavBar.vue + settings/index.vue;仅 `isNewer` 有单测) |

## 11. 测试与构建

```bash
pnpm test        # vitest 单测(与源码同目录 *.test.ts)
pnpm typecheck   # vue-tsc
pnpm build       # 产物 dist/(build 前自动 sync manifest 版本)
```

单测重点覆盖:autoTag 的协议解析/提示词组装(快照)、backends 的参数构造与工作流渲染、
floor 的存储结构/自动生成标记/运行态与闸门(genState/genQueue 的 token 认领、剪枝、并发)、
size 归一化、公开接口(`public/*.test.ts` + `generate.test.ts`:深拷贝不外泄、
key/url 不出现在返回值里、错误 code 归一、闸门抛错也还槽)。UI 层(Vue 组件)无测试。

**vitest 跑的是 node 环境,仓里没装 jsdom**:没有 `window`、没有 `document`。要测「浏览器里
才有」的东西就得自己造替身——如 `register.test.ts` 用 `vi.stubGlobal('window', new EventTarget())`
(且必须**在 import 被测模块之前**建好,否则模块拿到的还是那个不存在的 window);
slotHealth 那类 DOM 判据则靠鸭子类型假节点。这也是 Card.vue 等组件逻辑要往纯函数里抽的原因
(`shouldAutoGenerate`、`slotHealth`),留在组件里就锁不住。
