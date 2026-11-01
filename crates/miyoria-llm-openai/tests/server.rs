//! End-to-end tests against an in-process HTTP server returning canned SSE.

use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures::StreamExt;
use miyoria_llm::{
    ChatMessage, ChatProvider, ChatRequest, ChatResponse, ProviderConfig, ProviderFactory,
    StreamEvent, ToolSpec, Usage,
};
use miyoria_llm_openai::{OpenAiConfig, OpenAiFactory, OpenAiProvider};
use serde_json::{Value, json};

#[derive(Clone)]
enum Canned {
    /// SSE body, sent in pieces of `split` bytes.
    Sse { body: String, split: usize },
    Status {
        status: u16,
        body: &'static str,
        retry_after: Option<&'static str>,
    },
}

#[derive(Default)]
struct Shared {
    script: Mutex<Vec<Canned>>,
    hits: AtomicUsize,
    requests: Mutex<Vec<(HeaderMap, Value)>>,
}

struct Server {
    base_url: String,
    shared: Arc<Shared>,
}

impl Server {
    async fn start(script: Vec<Canned>) -> Self {
        let shared = Arc::new(Shared {
            script: Mutex::new(script),
            ..Default::default()
        });
        let app = Router::new()
            .route("/v1/chat/completions", post(handler))
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            base_url: format!("http://{addr}/v1/"),
            shared,
        }
    }

    fn provider(&self) -> OpenAiProvider {
        let mut config = OpenAiConfig::new(&self.base_url).api_key("sk-test-secret");
        config.retry_backoff = Duration::from_millis(10);
        config
            .headers
            .insert("X-Title".into(), "miyoria-tests".into());
        OpenAiProvider::new("test", config).unwrap()
    }

    fn hits(&self) -> usize {
        self.shared.hits.load(Ordering::SeqCst)
    }

    fn last_request(&self) -> (HeaderMap, Value) {
        self.shared
            .requests
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap()
    }
}

async fn handler(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let hit = shared.hits.fetch_add(1, Ordering::SeqCst);
    shared.requests.lock().unwrap().push((headers, body));
    let canned = {
        let script = shared.script.lock().unwrap();
        script[hit.min(script.len() - 1)].clone()
    };
    match canned {
        Canned::Sse { body, split } => {
            let pieces: Vec<Vec<u8>> = body.as_bytes().chunks(split).map(<[u8]>::to_vec).collect();
            let stream = futures::stream::iter(pieces).then(|p| async move {
                tokio::time::sleep(Duration::from_millis(2)).await;
                Ok::<_, Infallible>(p)
            });
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                Body::from_stream(stream),
            )
                .into_response()
        }
        Canned::Status {
            status,
            body,
            retry_after,
        } => {
            let mut resp = (StatusCode::from_u16(status).unwrap(), body).into_response();
            if let Some(v) = retry_after {
                resp.headers_mut()
                    .insert(header::RETRY_AFTER, v.parse().unwrap());
            }
            resp
        }
    }
}

fn sse(chunks: &[Value], done: bool, split: usize) -> Canned {
    let mut body = String::from(": keep-alive\n\n");
    for c in chunks {
        body.push_str(&format!("data: {c}\r\n\r\n"));
    }
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    Canned::Sse { body, split }
}

fn delta(delta: Value) -> Value {
    json!({"choices": [{"index": 0, "delta": delta, "finish_reason": null}]})
}

fn finish(reason: &str, usage: Option<Value>) -> Value {
    json!({"choices": [{"index": 0, "delta": {}, "finish_reason": reason}], "usage": usage})
}

fn request() -> ChatRequest {
    ChatRequest {
        model: "deepseek-chat".into(),
        messages: vec![ChatMessage::system("be cute"), ChatMessage::user("hi")],
        ..Default::default()
    }
}

async fn events(provider: &OpenAiProvider, req: ChatRequest) -> Vec<StreamEvent> {
    let stream = provider.stream(req).await.unwrap();
    stream.map(Result::unwrap).collect().await
}

#[tokio::test]
async fn streams_text_split_across_chunk_boundaries() {
    let server = Server::start(vec![sse(
        &[
            delta(json!({"role": "assistant", "content": ""})),
            delta(json!({"content": "你好,"})),
            delta(json!({"content": " world"})),
            delta(json!({"content": "!"})),
            finish("stop", None),
        ],
        true,
        7,
    )])
    .await;
    let provider = server.provider();
    let evs = events(&provider, request()).await;
    let text: String = evs
        .iter()
        .filter_map(|e| match e {
            StreamEvent::TextDelta(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "你好, world!");
    assert_eq!(
        evs.last(),
        Some(&StreamEvent::Done {
            finish_reason: Some("stop".into()),
            usage: None
        })
    );

    let (headers, body) = server.last_request();
    assert_eq!(headers["authorization"], "Bearer sk-test-secret");
    assert_eq!(headers["x-title"], "miyoria-tests");
    assert_eq!(body["model"], "deepseek-chat");
    assert_eq!(body["stream"], true);
    assert_eq!(body["stream_options"], json!({"include_usage": true}));
    assert_eq!(
        body["messages"][1],
        json!({"role": "user", "content": "hi"})
    );
    for absent in [
        "temperature",
        "max_tokens",
        "stop",
        "tools",
        "response_format",
    ] {
        assert!(body.get(absent).is_none(), "{absent} should not be sent");
    }
}

#[tokio::test]
async fn separates_deepseek_reasoning_content() {
    let server = Server::start(vec![sse(
        &[
            delta(json!({"content": null, "reasoning_content": "Let me "})),
            delta(json!({"content": null, "reasoning_content": "think."})),
            delta(json!({"content": "Hello!", "reasoning_content": null})),
            finish("stop", None),
        ],
        true,
        16,
    )])
    .await;
    let resp = server.provider().complete(request()).await.unwrap();
    assert_eq!(resp.reasoning, "Let me think.");
    assert_eq!(resp.text, "Hello!");
}

#[tokio::test]
async fn assembles_tool_call_deltas() {
    let call = |index: u32, id: Option<&str>, name: Option<&str>, args: &str| {
        let mut function = json!({"arguments": args});
        if let Some(name) = name {
            function["name"] = json!(name);
        }
        let mut c = json!({"index": index, "function": function});
        if let Some(id) = id {
            c["id"] = json!(id);
            c["type"] = json!("function");
        }
        delta(json!({"tool_calls": [c]}))
    };
    let server = Server::start(vec![sse(
        &[
            call(0, Some("call_a"), Some("roll"), ""),
            call(0, None, None, "{\"sides\""),
            call(1, Some("call_b"), Some("weather"), "{\"city\":"),
            call(0, None, None, ":20}"),
            call(1, None, None, "\"Taipei\"}"),
            finish("tool_calls", None),
        ],
        true,
        11,
    )])
    .await;
    let mut req = request();
    req.tools.push(ToolSpec {
        name: "roll".into(),
        description: "Roll a die".into(),
        parameters: json!({"type": "object", "properties": {"sides": {"type": "integer"}}}),
    });
    req.temperature = Some(0.25);
    req.max_tokens = Some(64);
    req.stop = vec!["\n\n".into()];
    req.json_mode = true;
    let resp = server.provider().complete(req).await.unwrap();
    assert_eq!(resp.finish_reason.as_deref(), Some("tool_calls"));
    assert_eq!(resp.tool_calls.len(), 2);
    assert_eq!(resp.tool_calls[0].id, "call_a");
    assert_eq!(resp.tool_calls[0].name, "roll");
    assert_eq!(resp.tool_calls[0].arguments, "{\"sides\":20}");
    assert_eq!(resp.tool_calls[1].id, "call_b");
    assert_eq!(resp.tool_calls[1].name, "weather");
    assert_eq!(resp.tool_calls[1].arguments, "{\"city\":\"Taipei\"}");

    let (_, body) = server.last_request();
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["function"]["name"], "roll");
    assert_eq!(body["temperature"], 0.25);
    assert_eq!(body["max_tokens"], 64);
    assert_eq!(body["stop"], json!(["\n\n"]));
    assert_eq!(body["response_format"], json!({"type": "json_object"}));
}

#[tokio::test]
async fn reports_usage_with_cached_tokens() {
    // DeepSeek: usage on the finishing chunk.
    let deepseek = sse(
        &[
            delta(json!({"content": "hi"})),
            finish(
                "stop",
                Some(json!({
                    "prompt_tokens": 120, "completion_tokens": 3, "total_tokens": 123,
                    "prompt_cache_hit_tokens": 100, "prompt_cache_miss_tokens": 20
                })),
            ),
        ],
        true,
        9,
    );
    // OpenAI: usage in a separate trailing chunk with no choices.
    let openai = sse(
        &[
            delta(json!({"content": "hi"})),
            finish("length", None),
            json!({"choices": [], "usage": {
                "prompt_tokens": 50, "completion_tokens": 8,
                "prompt_tokens_details": {"cached_tokens": 32}
            }}),
        ],
        true,
        13,
    );
    let server = Server::start(vec![deepseek, openai]).await;
    let provider = server.provider();

    let evs = events(&provider, request()).await;
    let dones: Vec<_> = evs
        .iter()
        .filter(|e| matches!(e, StreamEvent::Done { .. }))
        .collect();
    assert_eq!(dones.len(), 1);
    assert_eq!(
        dones[0],
        &StreamEvent::Done {
            finish_reason: Some("stop".into()),
            usage: Some(Usage {
                prompt_tokens: 120,
                completion_tokens: 3,
                cached_prompt_tokens: Some(100),
            }),
        }
    );

    let resp = provider.complete(request()).await.unwrap();
    assert_eq!(resp.finish_reason.as_deref(), Some("length"));
    assert_eq!(
        resp.usage,
        Some(Usage {
            prompt_tokens: 50,
            completion_tokens: 8,
            cached_prompt_tokens: Some(32),
        })
    );
}

#[tokio::test]
async fn retries_server_errors_before_streaming() {
    let server = Server::start(vec![
        Canned::Status {
            status: 500,
            body: "boom",
            retry_after: None,
        },
        Canned::Status {
            status: 429,
            body: "slow down",
            retry_after: Some("0"),
        },
        sse(
            &[delta(json!({"content": "ok"})), finish("stop", None)],
            true,
            64,
        ),
    ])
    .await;
    let resp = server.provider().complete(request()).await.unwrap();
    assert_eq!(resp.text, "ok");
    assert_eq!(server.hits(), 3);
}

#[tokio::test]
async fn gives_up_after_max_retries() {
    let server = Server::start(vec![Canned::Status {
        status: 503,
        body: "overloaded",
        retry_after: None,
    }])
    .await;
    let err = server.provider().stream(request()).await.err().unwrap();
    assert!(err.to_string().contains("503"), "{err}");
    assert_eq!(server.hits(), 3);
}

#[tokio::test]
async fn unauthorized_error_includes_status_and_body() {
    let server = Server::start(vec![Canned::Status {
        status: 401,
        body: r#"{"error":{"message":"Authentication Fails (no such user)","type":"authentication_error"}}"#,
        retry_after: None,
    }])
    .await;
    let err = server.provider().stream(request()).await.err().unwrap();
    let msg = format!("{err:#}");
    assert!(msg.contains("401"), "{msg}");
    assert!(msg.contains("Authentication Fails"), "{msg}");
    assert!(!msg.contains("sk-test-secret"), "{msg}");
    assert_eq!(server.hits(), 1, "4xx must not be retried");
}

#[tokio::test]
async fn truncated_stream_errors_without_retry() {
    let server = Server::start(vec![sse(&[delta(json!({"content": "hal"}))], false, 64)]).await;
    let provider = server.provider();
    let mut stream = provider.stream(request()).await.unwrap();
    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        StreamEvent::TextDelta("hal".into())
    );
    assert!(stream.next().await.unwrap().is_err());
    assert!(stream.next().await.is_none());
    assert_eq!(server.hits(), 1);
}

#[tokio::test]
async fn factory_builds_from_provider_config() {
    let server = Server::start(vec![sse(
        &[delta(json!({"content": "hey"})), finish("stop", None)],
        true,
        64,
    )])
    .await;
    let config: ProviderConfig = serde_json::from_value(json!({
        "kind": "deepseek",
        "base_url": server.base_url,
        "api_key": "sk-factory-secret",
        "timeout_secs": 30,
        "max_retries": 0,
        "headers": {"X-Custom": "1"},
    }))
    .unwrap();
    let factory = OpenAiFactory;
    assert!(factory.kinds().contains(&"openai-compatible"));
    let provider = factory.build("deepseek", &config).unwrap();
    assert_eq!(provider.name(), "deepseek");
    let resp: ChatResponse = provider.complete(request()).await.unwrap();
    assert_eq!(resp.text, "hey");
    let (headers, _) = server.last_request();
    assert_eq!(headers["authorization"], "Bearer sk-factory-secret");
    assert_eq!(headers["x-custom"], "1");

    let parsed = OpenAiConfig::from_provider_config(&config).unwrap();
    assert_eq!(parsed.timeout, Duration::from_secs(30));
    assert_eq!(parsed.max_retries, 0);
    let debug = format!(
        "{parsed:?} {:?}",
        OpenAiProvider::new("x", parsed.clone()).unwrap()
    );
    assert!(!debug.contains("sk-factory-secret"), "{debug}");

    // Default endpoints and URL joining.
    let bare = |kind: &str| -> ProviderConfig {
        serde_json::from_value(json!({"kind": kind, "api_key": "k"})).unwrap()
    };
    let url = |cfg: OpenAiConfig| OpenAiProvider::new("x", cfg).unwrap().url().to_owned();
    assert_eq!(
        url(OpenAiConfig::from_provider_config(&bare("deepseek")).unwrap()),
        "https://api.deepseek.com/chat/completions"
    );
    assert_eq!(
        url(OpenAiConfig::from_provider_config(&bare("openai")).unwrap()),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        url(OpenAiConfig::new("http://localhost:11434/v1")),
        "http://localhost:11434/v1/chat/completions"
    );
    assert!(factory.build("local", &bare("openai-compatible")).is_err());
}
