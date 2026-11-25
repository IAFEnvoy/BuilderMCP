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
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, TcpListener},
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

#[derive(Clone, Serialize)]
pub struct McpStatus {
    url: String,
    error: Option<String>,
}

pub struct Bridge {
    app: AppHandle,
    ready: AtomicBool,
    pending: Mutex<HashMap<Uuid, oneshot::Sender<Reply>>>,
    status: Mutex<McpStatus>,
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
        tokio::time::timeout(Duration::from_secs(30), recv)
            .await
            .map_err(|_| "The editor did not respond within 30 seconds.")?
            .map_err(|_| "The editor closed before responding.")?
    }
}

#[derive(Clone)]
struct McpServer {
    bridge: Arc<Bridge>,
    tools: Arc<Vec<Tool>>,
}

impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Use new_project or open_project to start working on a Minecraft structure, and save_project to save it as .nbt or .litematic. Coordinates are integer [x, y, z] Minecraft cells. Use get_scene and search_palette for context, render_block_states for block previews, and capture_screenshot to inspect the live viewport. Block edits are undoable in the editor.")
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools.iter().find(|tool| tool.name == name).cloned()
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.tools.as_ref().clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.as_ref();
        if self.get_tool(name).is_none() {
            return Err(ErrorData::invalid_params(
                format!("Unknown tool: {name}"),
                None,
            ));
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

fn load_tools() -> Arc<Vec<Tool>> {
    let specification: Value =
        serde_json::from_str(include_str!("../../src/mcp-tools.json")).expect("MCP tool JSON");
    let tools = specification["tools"]
        .as_array()
        .expect("MCP tool list")
        .iter()
        .map(|item| {
            let mut item = item.clone();
            item["inputSchema"]["$defs"] = specification["$defs"].clone();
            serde_json::from_value(item).expect("MCP tool definition")
        })
        .collect();
    Arc::new(tools)
}

pub fn start(app: AppHandle) -> Arc<Bridge> {
    let port = std::env::var("BUILDER_MCP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).and_then(|listener| {
        listener.set_nonblocking(true)?;
        Ok(listener)
    });
    let bridge = Arc::new(Bridge {
        app,
        ready: AtomicBool::new(false),
        pending: Mutex::new(HashMap::new()),
        status: Mutex::new(McpStatus {
            url: format!("http://127.0.0.1:{port}/mcp"),
            error: listener.as_ref().err().map(ToString::to_string),
        }),
    });
    if let Ok(listener) = listener {
        let server = McpServer {
            bridge: bridge.clone(),
            tools: load_tools(),
        };
        let status = bridge.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let listener = tokio::net::TcpListener::from_std(listener)?;
                let config = StreamableHttpServerConfig::default()
                    .enforce_origin_validation()
                    .with_json_response(true)
                    .with_max_request_body_bytes(8 * 1024 * 1024);
                let service = StreamableHttpService::new(
                    move || Ok(server.clone()),
                    Arc::new(LocalSessionManager::default()),
                    config,
                );
                axum::serve(listener, axum::Router::new().route_service("/mcp", service)).await
            }
            .await;
            if let Err(error) = result {
                status.status.lock().unwrap().error = Some(error.to_string());
            }
        });
    }
    bridge
}

#[tauri::command]
pub fn mcp_ready(state: State<'_, Arc<Bridge>>) -> McpStatus {
    state.ready.store(true, Ordering::Release);
    state.status.lock().unwrap().clone()
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
