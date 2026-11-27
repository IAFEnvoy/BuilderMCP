use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    net::{Ipv4Addr, TcpListener},
    num::NonZeroU16,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use uuid::Uuid;

const DEFAULT_PORT: u16 = 38741;
type Reply = Result<Value, String>;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Access {
    Disabled,
    ReadOnly,
    ReadWrite,
}

impl Access {
    fn permits(self, tool: &Tool) -> bool {
        match self {
            Self::Disabled => false,
            Self::ReadOnly => {
                tool.annotations
                    .as_ref()
                    .and_then(|hints| hints.read_only_hint)
                    == Some(true)
            }
            Self::ReadWrite => true,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Preferences {
    port: NonZeroU16,
    access: Access,
}

impl Default for Preferences {
    fn default() -> Self {
        let port = std::env::var("BUILDER_MCP_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(NonZeroU16::new(DEFAULT_PORT).unwrap());
        Self {
            port,
            access: Access::ReadWrite,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    port: Option<NonZeroU16>,
    access: Option<Access>,
    allow_pack_import: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    url: String,
    error: Option<String>,
    port: NonZeroU16,
    access: Access,
    allow_pack_import: bool,
}

struct ListenerState {
    preferences: Preferences,
    allow_pack_import: bool,
    stop: Option<oneshot::Sender<()>>,
    generation: u64,
    error: Option<String>,
}

impl ListenerState {
    fn status(&self) -> McpStatus {
        let Preferences { port, access } = self.preferences;
        McpStatus {
            url: format!("http://127.0.0.1:{port}/mcp"),
            error: self.error.clone(),
            port,
            access,
            allow_pack_import: self.allow_pack_import,
        }
    }

    fn tool_error(&self, tool: &Tool) -> Option<&'static str> {
        if !self.preferences.access.permits(tool) {
            return Some(match self.preferences.access {
                Access::Disabled => "MCP access is disabled in the editor’s settings.",
                _ => "This tool requires read/write MCP access. The editor is in read-only mode.",
            });
        }
        if tool.name == "import_resource_pack" && !self.allow_pack_import {
            return Some(
                "Resource pack import is disabled. Enable it in the editor’s MCP settings.",
            );
        }
        None
    }
}

pub struct Bridge {
    app: AppHandle,
    ready: AtomicBool,
    pending: Mutex<HashMap<Uuid, oneshot::Sender<Reply>>>,
    listener: Mutex<ListenerState>,
    config: PathBuf,
    tools: Vec<Tool>,
}

struct Pending<'a> {
    bridge: &'a Bridge,
    id: Uuid,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.bridge.pending.lock().unwrap().remove(&self.id);
    }
}

impl Bridge {
    async fn request(&self, name: &str, arguments: Value) -> Reply {
        if !self.ready.load(Ordering::Acquire) {
            return Err(
                "The editor is still starting. Try again once the viewport is ready.".into(),
            );
        }
        let id = Uuid::new_v4();
        let (send, recv) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 32 {
                return Err("Too many requests are waiting for the editor.".into());
            }
            pending.insert(id, send);
        }
        let _pending = Pending { bridge: self, id };
        self.app
            .emit_to(
                "main",
                "builder-mcp-request",
                json!({ "id": id.to_string(), "name": name, "arguments": arguments }),
            )
            .map_err(|error| error.to_string())?;
        let timeout = if name == "import_resource_pack" {
            120
        } else {
            30
        };
        tokio::time::timeout(Duration::from_secs(timeout), recv)
            .await
            .map_err(|_| format!("The editor did not respond within {timeout} seconds."))?
            .map_err(|_| "The editor closed before responding.")?
    }
}

#[derive(Clone)]
struct McpServer {
    bridge: Arc<Bridge>,
}

impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Use the available tools to inspect or edit the active Minecraft project. Coordinates are integer [x, y, z] Minecraft cells. Use get_scene and search_palette for context, render_block_states for block previews, and capture_screenshot to inspect the live viewport. Block edits are undoable in the editor.")
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.bridge
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .cloned()
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let access = self.bridge.listener.lock().unwrap().preferences.access;
        Ok(ListToolsResult::with_all_items(
            self.bridge
                .tools
                .iter()
                .filter(|tool| access.permits(tool))
                .cloned()
                .collect(),
        ))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.as_ref();
        let Some(tool) = self.get_tool(name) else {
            return Err(ErrorData::invalid_params(
                format!("Unknown tool: {name}"),
                None,
            ));
        };
        if let Some(error) = self.bridge.listener.lock().unwrap().tool_error(&tool) {
            return Ok(CallToolResult::error(vec![ContentBlock::text(error)]).into());
        }
        let args = Value::Object(request.arguments.unwrap_or_default());
        let reply = self.bridge.request(name, args).await;
        let result = match (name, reply) {
            ("capture_screenshot", Ok(value)) => match value.get("data").and_then(Value::as_str) {
                Some(data) => Ok(CallToolResult::success(vec![ContentBlock::image(
                    data,
                    "image/png",
                )])),
                None => Err("The viewport returned no PNG data.".into()),
            },
            ("render_block_states", Ok(value)) => value
                .as_array()
                .filter(|images| !images.is_empty())
                .ok_or_else(|| "The preview renderer returned no images.".to_owned())
                .and_then(|images| {
                    images
                        .iter()
                        .map(|image| {
                            image
                                .as_str()
                                .map(|data| ContentBlock::image(data, "image/png"))
                                .ok_or_else(|| {
                                    "The preview renderer returned invalid PNG data.".to_owned()
                                })
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .map(CallToolResult::success),
            (_, reply) => reply.map(CallToolResult::structured),
        };
        Ok(result
            .unwrap_or_else(|error| CallToolResult::error(vec![ContentBlock::text(error)]))
            .into())
    }
}

fn load_tools() -> Vec<Tool> {
    let specification: Value =
        serde_json::from_str(include_str!("../../src/mcp-tools.json")).expect("MCP tool JSON");
    specification["tools"]
        .as_array()
        .expect("MCP tool list")
        .iter()
        .map(|item| {
            let mut item = item.clone();
            item["inputSchema"]["$defs"] = specification["$defs"].clone();
            serde_json::from_value(item).expect("MCP tool definition")
        })
        .collect()
}

fn bind(port: NonZeroU16) -> Result<tokio::net::TcpListener, String> {
    let runtime = tauri::async_runtime::handle();
    let _guard = runtime.inner().enter();
    TcpListener::bind((Ipv4Addr::LOCALHOST, port.get()))
        .and_then(|listener| {
            listener.set_nonblocking(true)?;
            tokio::net::TcpListener::from_std(listener)
        })
        .map_err(|error| format!("无法监听本机端口 {port}。{error}"))
}

fn serve(bridge: &Arc<Bridge>, state: &mut ListenerState, listener: tokio::net::TcpListener) {
    let (stop, stopped) = oneshot::channel();
    // Replacing the sender shuts down the previous listener after the new one has bound.
    state.stop = Some(stop);
    state.error = None;
    state.generation += 1;
    let generation = state.generation;
    let bridge = bridge.clone();
    tauri::async_runtime::spawn(async move {
        let server = McpServer {
            bridge: bridge.clone(),
        };
        let config = StreamableHttpServerConfig::default()
            .enforce_origin_validation()
            .with_json_response(true)
            .with_max_request_body_bytes(8 * 1024 * 1024);
        let service = StreamableHttpService::new(
            move || Ok(server.clone()),
            Arc::new(LocalSessionManager::default()),
            config,
        );
        let result = axum::serve(listener, axum::Router::new().route_service("/mcp", service))
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
        let mut state = bridge.listener.lock().unwrap();
        if state.generation == generation {
            state.stop = None;
            state.error = result.err().map(|error| error.to_string());
        }
    });
}

pub fn start(app: AppHandle, config: PathBuf) -> Arc<Bridge> {
    let preferences: Preferences = fs::File::open(&config)
        .ok()
        .and_then(|file| serde_json::from_reader(file).ok())
        .unwrap_or_default();
    let bridge = Arc::new(Bridge {
        app,
        ready: AtomicBool::new(false),
        pending: Mutex::new(HashMap::new()),
        listener: Mutex::new(ListenerState {
            preferences,
            allow_pack_import: false,
            stop: None,
            generation: 0,
            error: None,
        }),
        config,
        tools: load_tools(),
    });
    {
        let mut state = bridge.listener.lock().unwrap();
        match bind(preferences.port) {
            Ok(listener) => serve(&bridge, &mut state, listener),
            Err(error) => state.error = Some(error),
        }
    }
    bridge
}

#[tauri::command]
pub fn mcp_ready(state: State<'_, Arc<Bridge>>) -> McpStatus {
    state.ready.store(true, Ordering::Release);
    state.listener.lock().unwrap().status()
}

#[tauri::command]
pub async fn configure_mcp(
    state: State<'_, Arc<Bridge>>,
    update: SettingsUpdate,
) -> Result<McpStatus, String> {
    let bridge = state.inner().clone();
    crate::file_io(move || {
        let mut state = bridge.listener.lock().unwrap();
        let port = update.port.unwrap_or(state.preferences.port);
        let access = update.access.unwrap_or(state.preferences.access);
        let listener =
            if update.port.is_some() && (port != state.preferences.port || state.stop.is_none()) {
                Some(bind(port)?)
            } else {
                None
            };
        if update.port.is_some() || update.access.is_some() {
            let preferences = Preferences { port, access };
            let bytes = serde_json::to_vec(&preferences).map_err(|error| error.to_string())?;
            let parent = bridge.config.parent().ok_or("无效的 MCP 配置路径。")?;
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            crate::documents::write_document(&bridge.config, &bytes, true)?;
            state.preferences = preferences;
        }
        state.allow_pack_import = access == Access::ReadWrite
            && update.allow_pack_import.unwrap_or(state.allow_pack_import);
        if let Some(listener) = listener {
            serve(&bridge, &mut state, listener);
        }
        Ok(state.status())
    })
    .await
}

#[tauri::command]
pub fn mcp_reply(
    state: State<'_, Arc<Bridge>>,
    id: String,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|error| error.to_string())?;
    if let Some(sender) = state.pending.lock().unwrap().remove(&id) {
        let _ = sender.send(match error {
            Some(error) => Err(error),
            None => Ok(value.unwrap_or(Value::Null)),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_modes_follow_read_only_annotations_and_pack_import_requires_consent() {
        let tools = load_tools();
        let mut allowed: Vec<_> = tools
            .iter()
            .filter(|tool| Access::ReadOnly.permits(tool))
            .map(|tool| tool.name.as_ref())
            .collect();
        allowed.sort_unstable();
        assert_eq!(
            allowed,
            [
                "capture_screenshot",
                "get_replay_export",
                "get_scene",
                "list_blocks",
                "render_block_states",
                "search_palette"
            ]
        );
        assert!(tools.iter().all(|tool| !Access::Disabled.permits(tool)));

        let import = tools
            .iter()
            .find(|tool| tool.name == "import_resource_pack")
            .unwrap();
        let mut state = ListenerState {
            preferences: Preferences::default(),
            allow_pack_import: false,
            stop: None,
            generation: 0,
            error: None,
        };
        assert!(
            state
                .tool_error(import)
                .unwrap()
                .contains("Resource pack import")
        );
        state.allow_pack_import = true;
        assert!(state.tool_error(import).is_none());
        state.preferences.access = Access::ReadOnly;
        assert!(state.tool_error(import).unwrap().contains("read-only"));
    }

    #[test]
    fn a_conflicting_port_fails_to_bind_and_can_be_retried() {
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = NonZeroU16::new(occupied.local_addr().unwrap().port()).unwrap();
        assert!(bind(port).is_err());
        drop(occupied);
        assert_eq!(bind(port).unwrap().local_addr().unwrap().port(), port.get());
        assert!(serde_json::from_value::<SettingsUpdate>(json!({ "port": 0 })).is_err());
        assert!(serde_json::from_value::<SettingsUpdate>(json!({ "port": 65_536 })).is_err());
    }
}
