# 版式互通与兼容说明

新版柏宝绘与 ComfyUI-MOSS-MangaLayout 共用 `moss-manga-layouts` 第 1 版文件封装。

- 批量文件：`format`、`version: 1`、`layouts` 数组，附带 `order` 和 `deleted`。单套文件仍可直接是版式对象。
- 单套主要结构为 `id`、`label`、`canvas`（width/height）、`panels`。坐标仍为中心原点像素，bbox 为 yxyx，shapes 的四个顶点为 xy。
- 接受旧 Skill 的 `portrait` / `landscape`、裸数组、旧 `bbi-manga-layouts` 和 `{layouts:[...]}`。两个方向都会保留；导出时补齐主画布的 panels，另一方向继续以原字段保存。相同方向的 panels 和旧字段若不同则报错，避免静默选择错误版本。
- 数组顺序是阅读顺序；`position` 是稳定别名，`layer` 是遮挡层级。`S_2` 等编号框完整保留，编号不会新增人物。
- `usage` 为用途，`description` 为共享画面描述，旧 `promptCaption` 为手填整页提示。存在不同值时各自保留。`slotNotes` 为框描述，`slotContents` 为具体人物、物体、台词。普通几何编辑保留这些内容。
- `locked` 仅锁定编辑器里的框几何；不进入 MOSS 的画面内容。`omitFullPageFrame` / `omitSmallFrames` 与 `useBboxCorners` 分别控制外框说明和实验角点。
- 新增分格只含 F。左右/上下等分以当前矩形为基础，第一格保留内容，新格不附带默认内框。斜框等分需先恢复矩形。
- 需要交给旧版插件时，选“导出旧版兼容文件”。旧 Skill 的 LLM 内容输出仍为 summary/items + panel/slot，不要求改成版式库文件；柏宝绘的 tag/nl/position 外层与独立节点的输入仍各自保留。
- 工作流快照优先于库；修改库不会自动改写旧工作流。版式库仍是一套版式一个文件。

## ComfyUI 编辑器快捷操作

- Ctrl+滚轮：以鼠标处为中心缩放；空格+拖动或鼠标中键：平移画布。
- Home：适应画布；F：聚焦选中框；Ctrl+0：100%。
- Shift+单击：多选；在空白处拖动：框选完整包含的外框。
- Ctrl+D：复制选中项；Delete：删除；方向键微调，Shift+方向键移动 10 px。
- Ctrl+Z / Ctrl+Shift+Z：撤销/重做。连续输入说明合并为一步，确认或切换框后另起一步。
- Ctrl+S：保存并留在编辑器；右上保存：保存后关闭。失败时保持当前编辑内容。
- Ctrl+拖四角：形变；普通拖角/边：缩放；Alt：暂时取消吸附。
- 右键：编辑描述、复制、删除、锁定和层级；左侧对象列表可选择被遮挡的内框。
- 多选后的底部菜单可对齐或等间距分布。左侧对象栏和右侧属性栏可收起。

## 生效边界

前端更新后刷新页面。节点 Python 编译与导入兼容更新，需要在当前生成结束后重启 ComfyUI；不会自动重启服务。
