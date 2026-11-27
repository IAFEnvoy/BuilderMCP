mod documents;
mod mcp;
mod minecraft_languages;
mod packs;
mod structures;

use minecraft_languages::MinecraftLanguages;
use packs::{PackInfo, PackStore};
use std::path::PathBuf;
use tauri::{Manager, State, ipc::Response};

async fn file_io<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_resource_packs(store: State<'_, PackStore>) -> Result<Vec<PackInfo>, String> {
    let store = store.inner().clone();
    file_io(move || store.list()).await
}

#[tauri::command]
async fn list_resource_pack_archives(path: PathBuf) -> Result<Vec<PathBuf>, String> {
    file_io(move || packs::list_archives(&path)).await
}

#[tauri::command]
async fn set_resource_pack_order(
    store: State<'_, PackStore>,
    ids: Vec<String>,
) -> Result<(), String> {
    let store = store.inner().clone();
    file_io(move || store.set_order(&ids)).await
}

#[tauri::command]
async fn import_resource_pack(
    store: State<'_, PackStore>,
    path: PathBuf,
) -> Result<PackInfo, String> {
    if !path.is_absolute() {
        return Err("请提供资源包 ZIP、JAR 或文件夹的绝对路径。".into());
    }
    let store = store.inner().clone();
    file_io(move || store.import(&path)).await
}

#[tauri::command]
async fn read_resource_pack(store: State<'_, PackStore>, id: String) -> Result<Response, String> {
    let store = store.inner().clone();
    file_io(move || store.bytes(&id)).await.map(Response::new)
}

#[tauri::command]
async fn remove_resource_pack(store: State<'_, PackStore>, id: String) -> Result<(), String> {
    let store = store.inner().clone();
    file_io(move || store.remove(&id)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            app.manage(PackStore::new(data.join("resource-packs")));
            app.manage(MinecraftLanguages::new(
                data.join("minecraft-languages"),
                app.path().home_dir().ok(),
                app.path().data_dir().ok(),
            ));
            app.manage(mcp::start(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_resource_packs,
            list_resource_pack_archives,
            set_resource_pack_order,
            import_resource_pack,
            read_resource_pack,
            remove_resource_pack,
            minecraft_languages::minecraft_translations,
            documents::save_document,
            documents::read_structure_file,
            documents::save_structure_file,
            documents::save_replay_file,
            mcp::mcp_ready,
            mcp::mcp_reply
        ])
        .run(tauri::generate_context!())
        .expect("error while running Builder MCP");
}
