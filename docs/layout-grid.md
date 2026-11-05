# F 外框的 G 通用区域

每个 F 外框提供可选的九宫格区域，按画面方向排列：

```text
G1 G2 G3
G4 G5 G6
G7 G8 G9
```

这些区域自动出现在发送给规划 LLM 的动态目录中，不写入版式文件。图册用紫色虚线显示实际可用范围，灰斜纹与“不可用”标牌表示整项 G 禁用，同处其他合法槽位不受影响。文字目录、图册文字清单均受 KEEP 保护，启用每轮指定 Skill 时也能使用。

0.3.12 起，单个 G 与合法矩形合并区均支持 `character`、`object`、`text`，可承载独立人物、局部、物件或文字；`tags`、`text`、`palette` 按通用项目规则填写。只使用实际需要的区域，不要求填满。

同格人物各有独立主项，使用不同的完整槽位键。例如 `S` 放 Alice，`G2+G5+G8` 放 Bob；后者是一条覆盖中列的项目，不是三个人物项。局部描述写清所属人物与连接方向，避免复制同一具连续身体。文字仍需准确字样、说话人和与容量相符的字号。

```json
[
  {
    "panel": 1,
    "slot": "S",
    "label": "character",
    "tags": ["alice"],
    "caption": "panel 1, Alice in a blue jacket stands at the left, facing Bob."
  },
  {
    "panel": 1,
    "slot": "G2+G5+G8",
    "label": "character",
    "tags": ["bob"],
    "caption": "panel 1, Bob in a brown coat stands in the center, facing Alice."
  },
  {
    "panel": 1,
    "slot": "G1",
    "label": "text",
    "text": "你好",
    "caption": "panel 1, spoken by Alice, a white speech bubble with large black printed glyphs, naturally wrapped."
  }
]
```

示例项目需放入当前合法版式的 items，人物身份、格号和槽位以本轮输入为准。相邻且填满矩形的 G 区域允许用加号合并，例如 `G1+G2`、`G1+G2+G4+G5`、`G2+G5+G8`；对角、缺角、重复或缺失键会报错。同格独立项目应使用不同完整键；合并键调换顺序仍按同一区域看待，不应据此重复使用。

G 按 F 外接框等分，而非相对 S；遇到斜框边缘时向实际轮廓内收缩，无法安全容纳的区域不列入清单。G 位于本 panel 内，跨格主体继续使用已保存的 S/L/R 等区域。历史版式若已有同名 G 槽，保留其原坐标，不参与虚拟合并。

编译器为实际引用的项目回填 bbox，保留身份、文字与 palette，不追加固定的局部解剖或服装描述。G 不增加漫画分格或读序；图册的网格、图例、编号与箭头不进入作品。实际姿势和定位效果仍需出图检查。
