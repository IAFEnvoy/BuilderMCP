---
name: builder-mcp
description: 用方块工坊的 Builder MCP 搭建、编辑、检查或导出 Minecraft 建筑。适用于操作编辑器场景、按 Mod ID 选方块、复制选区，以及交付 .nbt、.litematic 或基岩版 .mcstructure 文件。
---

# Builder MCP

## 连接和项目

- 用 `get_scene {}` 确认活动项目、`dirty`、`minecraftVersion`、场景范围和资源包加载情况。MCP 和桌面用户编辑的是同一个场景，也共用选区、剪贴板和撤销历史。
- 如果工具不可用，启动方块工坊桌面应用，从顶部「MCP」面板取得 Streamable HTTP 地址。默认是 `http://127.0.0.1:38741/mcp`，可用 `BUILDER_MCP_PORT` 修改端口。工具前缀随客户端配置的服务器名变化。编辑器还在加载时，等启动完成再调用 `get_scene`。
- 修改当前建筑时直接在活动项目操作。打开指定结构用 `open_project`，传桌面所在机器的绝对 `path`。从头搭建用 `new_project`，用 `minecraft_version` 指定 Java 正式版，例如 `{"name":"石砖门楼","minecraft_version":"1.21.1"}`。省略版本时沿用当前项目。切换项目遇到未保存修改时保留原项目，只有用户已授权丢弃时才传 `discard_unsaved: true`。

## 选材和搭建

- 用 `search_palette` 查询实际加载的方块。指定模组时传完整命名空间 `mod_id`，例如 `{"mod_id":"create","query":"casing","limit":20}`。省略 `query` 可列出该模组的方块，用 `nextOffset` 翻页。使用结果的资源 ID 和 `state`，按返回的 `properties` 选择朝向、半砖位置等属性。属性值用字符串。
- 资源包提供方块库、模型和纹理。搜索不到需要的模组时检查 `resourcePacks`，可通过桌面「资源包」导入 Minecraft 客户端 JAR、模组 JAR 或 ZIP。紫黑棋盘格表示缺少模型或纹理，使用 `list_blocks` 可核对已放置的方块 ID 和状态。
- 坐标是整数 `[x,y,z]`，+X 朝东、+Y 朝上、+Z 朝南。`fill_box`、`remove_box` 和 `select_box` 的 `from`、`to` 都包含端点。地基、墙和柱子可用 `fill_box`，例如 `{"from":[0,0,0],"to":[6,0,4],"state":"minecraft:stone_bricks"}`。`hollow: true` 填外壳并清空内部。
- 零散细节用 `set_blocks` 批量放置。每次最多 20,000 条，`state: null` 可删除对应格。楼梯等有朝向的方块可传 `{"blocks":[{"pos":[3,0,-1],"state":{"name":"minecraft:stone_brick_stairs","properties":{"facing":"south","half":"bottom"}}}]}`。
- 重复构件用 `select_box`、`copy_selection {}`、`paste_selection`。`origin` 是副本包围盒的最小角。粘贴覆盖副本所占的格，副本的空格保留目标内容。用 `transform_selection` 移动、旋转或缩放选区，指定旋转和尺寸时先旋转。误操作可用 `undo_redo {"action":"undo"}` 撤销最近一次编辑。

## 检查和交付

- 用 `set_camera` 切到 `isometric`、`front`、`right` 或 `top`，再用 `capture_screenshot` 查看整体或立面。`isometric` 默认使用正交投影。交付透明底建筑图可调用 `capture_screenshot {"transparent":true,"width":1920}`，其中 `width` 是图片最长边。
- 用 `render_block_states` 单独检查最多 32 个方块状态。`follow_camera: false` 用默认斜视角，`true` 沿用当前视口方向和投影。精确核对坐标和方块状态时，用带范围的 `list_blocks`。
- 用 `save_project` 保存活动项目。指定 `path` 时用绝对路径，扩展名决定格式。需要替换用户指定的已有文件时传 `overwrite: true`。省略 `path` 会保存至格式匹配的当前文件，或在应用数据目录的 `exports` 生成文件，首次默认 `.litematic`。
- `.litematic` 和 `.mcstructure` 项目保存保留场景坐标，`.nbt` 项目保存会把有负坐标的轴平移至从 0 开始。只需交付独立副本时用 `export_structure`，可选 `litematic`、`nbt` 或 `mcstructure`。副本写入 `exports`，建筑包围盒最小角平移至 `[0,0,0]`。
- 检查保存返回的 `path`、`format` 和 `bytes`，把实际输出路径交给用户。需要确认活动项目已保存时，再读 `get_scene` 的 `dirty`。
