# 方块工坊 · Builder MCP

用 Tauri 2 和 Three.js 搭建 Minecraft 建筑。桌面应用提供 3D 编辑器和本机 MCP 服务，两者编辑同一个场景并共享撤销历史。

## 启动

Windows 开发环境需要 Node.js、Rust 的 MSVC 工具链和 WebView2。当前项目使用 Node.js 24 和 Rust 1.95 验证。

```powershell
npm ci
npm run tauri dev
```

用 `npm run tauri build` 构建桌面程序和安装包。只构建可执行文件时，运行 `npm run tauri build -- --no-bundle`。

## 发布

发版前提高 `src-tauri/Cargo.toml` 中的版本，连同更新后的 `src-tauri/Cargo.lock` 一起提交。推送到 `main` 时，如果最新提交的标题以 `release:` 开头，构建成功后会按 Cargo 版本发布到 `v<版本号>` 并生成 Release 说明。Windows x64 提供 `.exe`，Linux x64、macOS Intel 和 Apple Silicon 各自的 `.tar.gz` 内含可执行文件并保留执行权限。

## 编辑建筑

- 启动时画布为空，导入的全局资源包会自动加载到方块库。点「新建」可开始另一座建筑。
- 「打开」读取 Java 版结构 `.nbt` 和 Litematica 投影 `.litematic`，保留方块状态和 Java DataVersion。Litematica 的多个区域会合并到同一场景。桌面版和 MCP 还支持基岩版结构 `.mcstructure`。编辑后用「保存」更新当前文件，首次保存或使用「另存为」时可选择格式。
- 当前项目有修改时，新建、打开或关闭窗口前会提示保存。可选择「保存」「不保存」或「取消」。尚未保存过的项目可在弹窗中选择结构格式。
- 用 `Ctrl+Z` 撤销，`Ctrl+Y` 或 `Ctrl+Shift+Z` 重做。`Ctrl+N` 新建，`Ctrl+O` 打开，`Ctrl+S` 保存，`Ctrl+Shift+S` 另存为。视口右下角的问号可查看快捷键。
- 在三维视图工具栏点击「录制操作」开始记录编辑，再点一次结束。点击「回放操作」后，从录制时的建筑开始，每 0.2 秒重现一次方块编辑，并固定在开始回放时的相机视角。可用 `Esc` 停止回放。当前项目会话可重复播放最近一段录制。
- 在方块库用 Mod ID 下拉框按方块 ID 的命名空间筛选，也可以同时搜索名称或资源 ID、选择类别。点击方块可切换画笔，有可调属性的方块会同时打开设置浮层。
- 左键使用当前工具，中键单击吸取方块，拖动旋转视角，右键拖动平移，滚轮缩放。底部可输入铺设方块的工作层 Y 坐标。
- 视口右上角可切换「透视」和「正交」。工具栏的「等轴」会切到正交投影，并从等轴角度框住建筑。「导出透明 PNG」按当前取景渲染建筑，图片最长边为 1920 像素。
- 方块纹理按同名 `.png.mcmeta` 中的 `animation` 设置循环播放。视口截图、透明 PNG 和 MCP 的方块渲染使用当前动画帧。方块库和画笔缩略图使用首个有效帧。
- 用选取工具点击方块，按住 Shift 多选。检查器顶部可修改选中方块的朝向、轴向等状态，多选时可批量修改共有属性。用区域选取或填充工具标记两个角点。检查器可移动选区原点、绕 Y 轴旋转 90°，或把选区缩放到三个轴的整数尺寸。
- 选好画笔后，在三维视图工具栏点「替换方块」或按 `R`。点击已有方块可替换单块，点击选区内的方块可替换整个选区。
- 选中方块后用 `Ctrl+C` 复制，按 `Ctrl+V` 显示粘贴预览，再点击视口放置。`Esc` 取消预览。粘贴以选区包围盒的最小角为原点，复制的方块会覆盖对应位置，空格会保留目标方块。整次粘贴可以撤销，剪贴板可在同一窗口内重复使用或跨项目使用。
- 保存 `.litematic` 和 `.mcstructure` 项目时保留场景坐标。导入游戏导出的 `.mcstructure` 时使用局部坐标。保存 `.nbt` 时，有负坐标的轴会平移到从 0 开始。
- 箱子、陷阱箱、末影箱、铜箱子和潜影盒使用导入资源里的实体贴图显示闭合模型。铜箱子支持各氧化阶段、涂蜡变体和双箱左右半部。屏障、光源和结构空位在视口中显示可选取的图标，导出透明建筑图时隐藏。
- 单选旗帜或拼图方块后，可在检查器编辑图案或拼接参数。复制、移动和保存 Java `.nbt`、`.litematic` 时会保留这些数据。基岩版 `.mcstructure` 读写仍限于方块及其状态。
- 基岩版结构可读取 v1、v2 及 zlib 压缩的 v2，保存为小端 NBT v1。Java 与基岩版的方块及状态通过 Nucleation 的映射转换，基岩版附加包方块在目标游戏中需要相应的附加包。
- 结构文件的根级 `BuilderMCP` 标签记录导出软件版本 `SoftwareVersion`，以及实际放置的非空气方块所用的命名空间 `BlockNamespaces`。
- 项目设置中的 Minecraft 版本用于 Java 版导出，默认使用 1.21.1。导入的 Java 文件版本如果未收录，可在设置中选择「保留原版本」。[Minecraft Wiki 数据版本表](https://zh.minecraft.wiki/w/数据版本)

## 全局资源包

在左下角「资源包」点「导入 ZIP / JAR」可同时选择多个 `.zip` 资源包、Minecraft 客户端或模组的 `.jar`。「批量导入目录」会按文件名顺序导入所选目录直接包含的 ZIP 和 JAR。「导入解包资源包」接受带有 `assets` 的资源根目录，例如模组的 `src/main/resources` 或 `src/generated/resources`。

桌面版在应用数据目录保存资源包的路径和顺序，所有项目共享这些记录。管理界面会显示每个包的来源路径。启动时从原路径读取最新内容，缺失或损坏的包会保留条目并显示失败原因，其余包继续加载。移除条目只删除路径记录。旧版导入的资源包使用当时保存在应用数据目录中的文件，因为旧记录没有原始路径。

把文件拖到桌面应用窗口时，`.zip` 和 `.jar` 会导入资源包，`.nbt`、`.litematic` 和 `.mcstructure` 会打开建筑。拖入多个结构时可选择其中一个，切换建筑前会检查未保存的修改。

拖动资源包左侧的把手调整顺序。也可选中把手后使用 ↑ 和 ↓。应用从下往上加载，上层的同名资源优先，顺序修改后立即应用并在下次启动时恢复。新导入的包放在最上方。

启动加载和手动导入时，方块库和资源包管理窗口会显示总进度、当前包的加载阶段和已索引文件数。

方块库、视口和画笔使用全局资源包提供的方块定义、模型和纹理。缺少模型时显示紫黑棋盘格方块，缺少纹理时在模型对应表面显示棋盘格。视口支持 `variants`、`multipart`、模型继承、元素旋转、UV 和半透明材质。方块库优先用 `items` 指定的库存模型，兼容旧版 `models/item`，并应用 GUI 变换和染色。动画纹理使用首帧。需要原版模型和纹理的第三方资源包可放在对应版本的 Minecraft 客户端 JAR 上方。

方块库上方可以切换方块语言，默认简体中文，选择会随应用保存。ZIP、JAR 和文件夹里的 `assets/<namespace>/lang` 会自动提供语言选项，支持 JSON 和旧版 `.lang`。导入原版客户端 JAR 后，编辑器也会按对应版本读取 Minecraft 或 Gradle 的语言缓存，必要时从 Mojang 获取语言文件并保存到 AppData。

方块名称先查所选语言，缺失时逐条回退到美式英语。每种语言依次查找 `block.<namespace>.<path>` 和 `item.<namespace>.<path>`，同名翻译键优先用导入资源包的值。两种语言都缺失时显示 `block.<namespace>.<path>` 原文。资源 ID 中的 `/` 会按 Minecraft 译名规则转换成 `.`。

## MCP 接入

在此项目的 Codex 会话中可用 `$builder-mcp` 引导 AI 选材、搭建、截图和保存。[Builder MCP 技能](.agents/skills/builder-mcp/SKILL.md)

启动桌面应用后，从顶部 **MCP** 按钮复制地址。客户端选用 **Streamable HTTP**。可用以下配置的客户端将这段内容加入 MCP 配置。

```json
{
  "mcpServers": {
    "buildermcp": {
      "url": "http://127.0.0.1:38741/mcp"
    }
  }
}
```

服务监听本机回环地址。需要使用其他端口时，在启动桌面应用的环境中设置 `BUILDER_MCP_PORT`。

| 操作 | MCP 工具 |
| --- | --- |
| 新建、打开和保存结构 | `new_project`、`open_project`、`save_project` |
| 读取场景、方块及状态 | `get_scene`、`list_blocks`、`search_palette` |
| 导入全局资源包 | `import_resource_pack` |
| 放置、替换、填充、删除 | `set_blocks`、`fill_box`、`remove_box` |
| 选区、移动、旋转、缩放和撤销 | `select_box`、`transform_selection`、`undo_redo` |
| 复制和粘贴选区 | `copy_selection`、`paste_selection` |
| 相机和截图 | `set_camera`、`capture_screenshot` |
| 录制操作和导出回放 | `start_recording`、`stop_recording`、`export_replay`、`get_replay_export` |
| 预览方块状态 | `render_block_states` |
| 导出建筑 | `export_structure` |

`search_palette` 可传 `"mod_id": "minecraft"` 只查原版方块，也可以同时传 `query` 搜索名称。

`import_resource_pack` 接受运行编辑器的机器上的绝对 `path`。桌面版按原路径链接 ZIP、JAR 和包含 `assets` 的解包资源包目录，侧栏模式支持 ZIP 和 JAR。用户需要先在顶部「MCP」面板勾选「允许 MCP 导入资源包」。权限仅在本次编辑器会话有效。导入成功后，新包位于全局资源包列表顶部，可用 `search_palette` 查询方块。

调用 `select_box` 和 `copy_selection` 后，向 `paste_selection` 传入目标 `origin` 即可放置副本。MCP 和编辑器共用剪贴板。

流水化制作可以依次调用 `new_project`、放置方块和 `save_project`，再用 `open_project` 打开返回的路径。`open_project` 和 `save_project` 接受运行编辑器的机器上的绝对路径。省略保存路径时会更新当前文件，首次保存则在应用数据目录的 `exports` 下生成文件，默认使用 `.litematic`。保存基岩版时可指定 `.mcstructure` 路径，或传 `{"format":"mcstructure"}`。

`new_project` 可传 `"minecraft_version": "1.21.1"` 指定 Java 版导出版本。`get_scene`、`new_project` 和 `open_project` 返回可识别的 `minecraftVersion`。

新建或打开会保留有未保存修改的场景，调用方可传 `discard_unsaved: true` 明确丢弃这些修改。向指定的已有路径保存时可传 `overwrite: true` 覆盖文件。`export_structure` 会在 `exports` 生成独立副本，并以建筑包围盒的最小坐标为局部原点。

工具使用 `[x, y, z]` 坐标，+X 朝东、+Y 朝上、+Z 朝南。例如用 `fill_box` 创建石砖地基，然后调用 `capture_screenshot` 查看视口。

```json
{
  "from": [0, 0, 0],
  "to": [10, 0, 8],
  "state": "minecraft:stone_bricks"
}
```

`set_camera` 可传 `{"projection":"orthographic"}` 切换正交投影，或传 `{"preset":"isometric"}` 直接取等轴视角。

`capture_screenshot` 返回 PNG 图像内容。传入 `{"transparent":true,"width":1600}` 可按当前取景渲染透明底建筑图，最长边为 1600 像素。默认截图模式下，`width` 限制截图宽度。

先调用 `start_recording`，再执行搭建操作，最后用 `stop_recording` 结束录制。`export_replay` 使用调用时的相机导出 WebM，按每步 0.2 秒播放。可传入绝对 `.webm` 路径，或省略 `path` 让应用在 `exports` 目录生成文件。向 `get_replay_export` 传入 `{"export_id":"上一步返回的 exportId"}` 查询，`status` 为 `completed` 时会返回 `path` 和 `bytes`。

`render_block_states` 使用已导入的资源包渲染 1 至 32 个方块状态，按输入顺序返回 256×256 的透明背景 PNG。缺少模型或纹理时使用紫黑棋盘格，空气返回空白图。`follow_camera` 默认为 `false`，使用默认斜视角。设为 `true` 时，预览沿用当前视口的相机方向和投影方式，并将对应方块居中。

MCP 写入或预览旗帜时可传入 `blockEntity` 和旗帜状态。拼图方块的 `blockEntity` 可设置 `name`、`target`、`pool`、`final_state`、`joint` 和两个优先级。

```json
{
  "states": [
    "minecraft:stone_bricks",
    { "name": "minecraft:spruce_stairs", "properties": { "facing": "east", "half": "top" } }
  ],
  "follow_camera": true
}
```
