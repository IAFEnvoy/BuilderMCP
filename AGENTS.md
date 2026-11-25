# Builder MCP

## 发布

- 推送到 `main` 时，GitHub Actions 检查本次推送的最新提交。提交标题必须以小写的 `release:` 开头，四个平台都构建成功后才会自动发布 GitHub Release。
- **每次发版都务必提高 `src-tauri/Cargo.toml` 中的 `[package].version`，并把同步更新的 `src-tauri/Cargo.lock` 一起提交和推送。** 提交标题可以写成 `release: v0.1.2`。发布流程按 Cargo 版本创建 `v<版本号>` 标签。
