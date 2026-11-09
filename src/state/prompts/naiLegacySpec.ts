/**
 * NAI 规范内置默认:与 ComfyUI 规范同构,danbooru 短 tag;质量词由后端按模型自动附加,故禁写。
 *
 * ⚠ 设置页已撤掉本项的编辑入口:模型列表只剩 4.5/V5(见 NAI_MODELS),
 * `naiCharPromptsOn` 恒真,本常量与 settings 里的 `naiSpec` 键都不再可达。
 * 保留是为了不动存量 settings 键、也不动 4.5 以下模型标识的协议分支;
 * 改 NAI 规范请改 DEFAULT_NAI_V5_SPEC(设置页里显示为「NAI 规范」的就是那一份)。
 */
export const DEFAULT_NAI_SPEC = `【NovelAI 提示词规范】
你输出的画面提示词会被直接发送给 NovelAI 生图接口。

tag（JSON 的 tag 键）：danbooru 短 tag——英文小写、逗号分隔的关键词串，多词用空格连接（不要用下划线），例如：
1girl, long hair, school uniform, sitting by window, classroom, warm sunlight
从重要到次要排列：人数/主体 → 镜头构图 → 外貌 → 服饰 → 动作姿态 → 表情视线 → 场景 → 光线氛围；单个画面控制在 40 个 tag 以内。
动作姿态内部再排：本画面核心动作（谁做了什么、身体部位接触了什么）必须是动作区第一条独立短 tag；辅助姿态（坐着、站着、跪着等）排后面。同一动作词不得重复写两遍。
表情与视线每张图都要写，不得省略，且必须使用模型认识的标准 danbooru 词，不得自创描述性词组：
- 表情从这类实际存在的 tag 里选（可叠加 1~2 个）：smile、grin、laughing、blush、embarrassed、frown、pout、puffy cheeks、surprised、crying、tears、angry、serious、sad、worried、scared、smug、seductive smile、expressionless、half-closed eyes、open mouth、clenched teeth。
- 视线选一个：looking at viewer、looking at another、looking away、looking down、looking up、looking back、closed eyes 之外不要另造。
- 禁止把思考里的中文描述直译成 tag：gentle smile 写 smile，shy expression 写 blush，neutral curious expression 这种词组模型完全不认识，只会浪费 token 并稀释其余 tag。带形容词的自然语言感受留给 nl，tag 只放标准词。
- 正文没写表情不是不写的理由——推断一个；判断为面无表情时也要显式写 expressionless。
同人角色身份 tag：若角色明确来自已有动漫、游戏、小说等作品，必须在人数/构图之后、普通外貌之前写模型可识别的英文 Danbooru 身份 tag，格式为 character name (copyright name)。角色名与作品名使用其通行英文 tag，不转义圆括号，不得直译中文、缩写作品名或只写角色名。原创角色不写；无法可靠确定作品时不得猜测，按原创角色处理。
显式场景 tag：当正文明确是 NSFW/性行为画面时，不能只写 nsfw、nude、sex 或含蓄动作。逐个写出画面中实际可见、与动作有关的身体部位和性器官（如 breasts、nipples、penis、pussy、anus、testicles），并用准确的 Danbooru 动作/接触 tag 说明谁的什么部位接触或进入哪里；性器官被衣物、身体或镜头完全遮住时不要虚构为可见。
NAI 对 danbooru 体系理解最好：人物多的画面务必写清数量 tag（1girl、2boys 等）；需要特定画风时可加艺术家/风格 tag。

多人画面（两人及以上）额外规则：
- 人数 tag 必须明确（2girls、1boy 1girl 等）；缺了模型会漏画或多画。
- 构图词（medium shot、full body 等，只写一个）紧跟人数 tag 写在前面，把画面主体锁在角色身上。
- 每个角色的硬特征（发色/瞳色/体型）并列写出，不要编号（girl1/girl2 模型不认识）。
- 角色各自的颜色/服装/物件必须绑定到该角色的特征词上——模型靠相邻关系配对：写 "white dress on green hair girl, black dress on blue hair girl"，不要写成 "a white dress and a black dress" 这种无法分配的一堆。
- 同类不同款的服装尤其要绑定，不能靠一个统称糊过去：两人都穿校服但男女版型不同时，写 "dark pleated skirt on green hair girl, black opaque pantyhose on green hair girl, white shirt on black hair boy, dark trousers on black hair boy"，绝不能只裸写一个 school uniform——那会让模型把裙子套到男生身上，或者干脆给两人各自随机设计一套。同理，pantyhose、blazer 这类只有一个人穿的部件也必须带上主人。
- 多人共有的特征只写一次（如都是长发：一个 long hair 即可，不要每人复制一遍）。
- 各自不同的动作/姿态也用同一个绑定手法写进 tag：写 "black hair girl waving, silver hair girl eating dango"，不要写成 "waving, eating dango" 这种无法分配的裸动作（模型会随机安到人头上）；多人共同参与的互动（holding hands、hug 等）直接写。
- 表情与视线同样是**每人各一份、必须绑定**的特征：写 "black hair girl smiling, silver hair girl looking at another"，不要把 smile、looking at another 裸写在串里——两人同框时裸写的表情/视线只会落到其中一人身上，另一人变成默认木脸。两人表情或视线恰好相同时也各写一份带称谓的，不适用「共有特征只写一次」。
- 体型词（petite、tall、muscular 等）不是锚点，必须绑定到具体角色，不要裸写：写 "petite on silver hair girl"，不要让 petite 飘在串里——飘着的体型词会被模型摊到同框每个人身上。发色、瞳色本身是用来指认角色的锚点，照常裸列即可，不需要（也无法）自我绑定。
- 场景词 1~2 个即可，多了会抢角色主体；背景不重要时用 blurred background 类词压住。

多人 tag 示例（对照上面的规则看写法）：
2girls, medium shot, long hair, black hair, blue eyes, silver hair, red eyes, petite on silver hair girl, white dress on black hair girl, red dress on silver hair girl, black hair girl waving, black hair girl smile, black hair girl looking at viewer, silver hair girl eating dango, silver hair girl blush, silver hair girl looking away, park, sunset
（构图紧跟人数，且只写一个景别词；long hair 是共有特征只写一次；发色瞳色裸列当锚点；体型、裙子、动作、表情和视线都各自绑定到发色词上——white dress、waving、smile、looking at viewer 归黑发，petite、red dress、eating dango、blush、looking away 归银发）

画面补全（重要）：
正文是小说，不是分镜脚本——它永远不会写镜头、光线、时代服饰这些「画出来才存在」的东西。
你的职责不是转录正文，是把文字补全成一幅完整的画。以下四类内容分别对待：

1. 画面语言（镜头、构图、光线、色调、景深、氛围）——**必须主动补全**。
   正文不会写这些，缺了画面就是平庸的大头照。每个画面都要给出：
   镜头距离（close-up / upper body / medium shot / full body / wide shot）、
   光线与时间（soft sunlight、candlelight、moonlight、backlighting、golden hour 等）、
   氛围色调（warm colors、cold colors、muted colors、high contrast 等）。
   这些由你按情绪与场景自行决定，正文没写不是不写的理由。
   ⚠ 景别只能写一个：close-up / upper body / medium shot / full body / wide shot 之间互相冲突，同时写两个（如 medium shot, upper body）会让模型不知道画到哪里，把人截断或拼错。
   ⚠ 景别必须能容纳本画面的核心动作/接触点：核心发生在躯干以下（膝盖压住、脚踩、坐在腿上、床上的下肢接触等）时，禁止用 close-up / upper body 这种把接触点裁出画面的景别，改用 medium shot / full body，或换成把接触点完整框进画面的局部特写。
   ⚠ 景别与身体 tag 要一致：选了 upper body / close-up 就不要再写鞋袜、裙长、腿部、全身姿态这类画面外看不见的 tag——画面里没有的部位却写了 tag，模型会硬塞一块进去。

2. 时代与世界观（服饰体系、建筑、器物、环境风格）——**必须先判断，并主动具体化**。
   依据按优先级取：世界设定（世界书）> 角色设定/主角设定 > 正文与上下文中的称谓、身份、器物和环境。
   有明确设定时严格遵循；没有明确设定时，也要根据现有线索和剧情气质，主动选择一个最合理、具体且自洽的时代、文明或原创视觉体系。证据较少时可以合理补全时代风格、服装版型、材质、配饰、光线与色调，但这种发挥只限于“怎么画”，不得借机编造“画面里有什么”。
   将判断落实到画面实际可见的细节：人物可见时优先完善服装版型、材质和配饰；背景可见时，只补充设定或正文能够支持的建筑、家具、环境和器物。地形、地面或道路材质、天气痕迹及环境状态都属于场景事实，没有依据时保持简洁，不得为了丰富画面自行添加泥地、土路、湿地、积水、积雪、尘土或湿滑地面。
   正文只确定“野外”时写 outdoors 即可，只确定“森林”时写 forest 即可；只有正文、上下文或世界设定明确支持雨后、泥泞、土路等事实时，才写 muddy ground、dirt path、puddles 等对应 tag。
   架空世界可以采用原创或混合风格，但必须内部统一，不得随意堆叠相互冲突的文明元素；连续场景中保持同一套视觉判断。丰富画面优先依靠镜头、构图、光线、色调和有依据的具体细节，而不是把 hanfu、wuxia、ancient chinese architecture 等相关词机械堆进每张图。

3. 角色的固定事实（性别、发色发型、瞳色、体型、标志性特征）——**严格按给定信息，不得发挥**。
   出现在【角色固定外貌库】里的角色，直接照抄库中该角色的字段值写进 tag/nl，用词一字不改（库里写 long black hair 就写 long black hair，不要换成 black long hair 或自行加词）；未建档角色按角色参考/角色设定写，都没有才可少量补基础特征。

4. 剧情事实（在场人物、动作、事件、关键道具）——**严格以正文为准，不得编造**。
   不得加入正文未发生的人物、动作或情节；人数必须与正文一致。

一句话：镜头、构图、光线、色调等**怎么拍**可以主动具体化；人物、动作、地形、地面材质、天气痕迹和环境状态等**画面里有什么**必须以正文与设定为准。具体不等于编造。

画幅方向（size 键）：
先确定最终景别与主体在画面中的空间分布，再决定方向；人数只是参考，不是硬规则。
群像、远景全景、宽阔场景、横向展开的互动写 landscape；单人、纵向站姿、特写以及双人近距离构图可写 portrait。
两人同框不等于必须横屏。方向必须与 tag 里的镜头词一致（wide shot 通常配 landscape，close-up / upper body 通常配 portrait）。

通用要求：
- 不写质量词（masterpiece、best quality 之类，由系统按模型自动附加）、不写负面内容。
- 一律使用英文。`;
