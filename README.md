# 方块工坊 · Builder MCP

用 Tauri 2 和 Three.js 搭建 Minecraft Java 版建筑。桌面应用提供 3D 编辑器和本机 MCP 服务，两者编辑同一个场景并共享撤销历史。

## 启动

Windows 开发环境需要 Node.js、Rust 的 MSVC 工具链和 WebView2。当前项目使用 Node.js 24 和 Rust 1.95 验证。

```powershell
npm ci
npm run tauri dev
```

用 `npm run tauri build` 构建桌面程序和安装包。只构建可执行文件时，运行 `npm run tauri build -- --no-bundle`。

## 发布

在 GitHub 的 **Actions → Publish Release → Run workflow** 手动发布。流程从 `src-tauri/Cargo.toml` 读取版本，构建 Windows、Linux 和两种 macOS 架构的安装包，然后发布到 `v<版本号>` 并生成 Release 说明。

## 编辑建筑

- 启动时画布为空，导入的全局资源包会自动加载到方块库。点「新建」可开始另一座建筑。
- 「打开」读取原版结构 `.nbt` 和 Litematica 投影 `.litematic`，保留方块状态和 Minecraft DataVersion。Litematica 的多个区域会合并到同一场景。编辑后用「保存」更新当前文件，首次保存或使用「另存为」时可选择格式。
- 当前项目有修改时，新建、打开或关闭窗口前会提示保存。可选择「保存」「不保存」或「取消」。尚未保存过的项目可在弹窗中选择结构格式。
- 用 `Ctrl+Z` 撤销，`Ctrl+Y` 或 `Ctrl+Shift+Z` 重做。`Ctrl+N` 新建，`Ctrl+O` 打开，`Ctrl+S` 保存，`Ctrl+Shift+S` 另存为。视口右下角的问号可查看快捷键。
- 在方块库用 Mod ID 下拉框按方块 ID 的命名空间筛选，也可以同时搜索名称或资源 ID、选择类别。点击方块可切换画笔，检查器可修改朝向、轴向或半砖位置等方块状态。
- 左键使用当前工具，中键拖动旋转视角，右键拖动平移，滚轮缩放。底部可输入铺设方块的工作层 Y 坐标。
- 视口右上角可切换「透视」和「正交」。「等轴」会切到正交投影，并从等轴角度框住建筑。顶部的「导出透明 PNG」按当前取景渲染建筑，图片最长边为 1920 像素。
- 用选取工具点击方块，按住 Shift 多选。用区域选取或填充工具标记两个角点。检查器可移动选区原点、绕 Y 轴旋转 90°，或把选区缩放到三个轴的整数尺寸。
- 选中方块后用 `Ctrl+C` 复制，按 `Ctrl+V` 显示粘贴预览，再点击视口放置。`Esc` 取消预览。粘贴以选区包围盒的最小角为原点，复制的方块会覆盖对应位置，空格会保留目标方块。整次粘贴可以撤销，剪贴板可在同一窗口内重复使用或跨项目使用。
- 保存 `.litematic` 时保留场景坐标。保存 `.nbt` 时，有负坐标的轴会平移到从 0 开始。实体和方块实体的附加数据会跳过。
- 在项目设置选择目标 Minecraft Java 正式版，应用会将对应的数据版本写入结构文件。默认使用 1.21.1。导入文件的版本如果未收录，可在设置中选择「保留原版本」。[Minecraft Wiki 数据版本表](https://zh.minecraft.wiki/w/数据版本)

## 全局资源包

在左下角「资源包」点「导入 ZIP / JAR」可同时选择多个 `.zip` 资源包、Minecraft 客户端或模组的 `.jar`。「导入文件夹」接受带有 `assets` 的资源包根目录。Windows 上的副本保存在 `%APPDATA%\com.iafenvoy.buildermcp\resource-packs`。所有项目共享这份资源库，删除原文件后也能继续使用。

把文件拖到桌面应用窗口时，`.zip` 和 `.jar` 会导入资源包，`.nbt` 和 `.litematic` 会打开建筑。拖入多个结构时可选择其中一个，切换建筑前会检查未保存的修改。

用资源包列表中的 ↑ 和 ↓ 调整顺序。应用从下往上加载，上层的同名资源优先，顺序修改后立即应用并在下次启动时恢复。新导入的包放在最上方。

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
| 放置、替换、填充、删除 | `set_blocks`、`fill_box`、`remove_box` |
| 选区、移动、旋转、缩放和撤销 | `select_box`、`transform_selection`、`undo_redo` |
| 复制和粘贴选区 | `copy_selection`、`paste_selection` |
| 相机和截图 | `set_camera`、`capture_screenshot` |
| 预览方块状态 | `render_block_states` |
| 导出建筑 | `export_structure` |

`search_palette` 可传 `"mod_id": "minecraft"` 只查原版方块，也可以同时传 `query` 搜索名称。

调用 `select_box` 和 `copy_selection` 后，向 `paste_selection` 传入目标 `origin` 即可放置副本。MCP 和编辑器共用剪贴板。

流水化制作可以依次调用 `new_project`、放置方块和 `save_project`，再用 `open_project` 打开返回的路径。`open_project` 和 `save_project` 接受运行编辑器的机器上的绝对路径。省略保存路径时会更新当前文件，首次保存则在应用数据目录的 `exports` 下生成文件，默认使用 `.litematic`。

`new_project` 可传 `"minecraft_version": "1.21.1"` 指定目标游戏版本。`get_scene`、`new_project` 和 `open_project` 返回可识别的 `minecraftVersion`。

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

`render_block_states` 使用已导入的资源包渲染 1 至 32 个方块状态，按输入顺序返回 256×256 的透明背景 PNG。缺少模型或纹理时使用紫黑棋盘格，空气返回空白图。`follow_camera` 默认为 `false`，使用默认斜视角。设为 `true` 时，预览沿用当前视口的相机方向和投影方式，并将对应方块居中。

```json
{
  "states": [
    "minecraft:stone_bricks",
    { "name": "minecraft:spruce_stairs", "properties": { "facing": "east", "half": "top" } }
  ],
  "follow_camera": true
}
```
