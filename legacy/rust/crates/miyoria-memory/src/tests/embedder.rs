//! The OpenAI-compatible embedder against a local axum mock.

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use serde_json::{Value, json};

use super::*;
use crate::config::EmbeddingConfig;
use crate::embed::{OpenAiCompatibleEmbedder, build_embedder};

#[derive(Clone, Default)]
struct Seen {
    bodies: Arc<Mutex<Vec<Value>>>,
    auth: Arc<Mutex<Vec<Option<String>>>>,
}

async fn embeddings(
    State(seen): State<Seen>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    seen.auth.lock().push(
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
    );
    seen.bodies.lock().push(body.clone());
    let inputs: Vec<String> = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    if inputs.iter().any(|i| i == "boom") {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "boom" })),
        );
    }
    // Answer in reverse order with explicit indexes.
    let data: Vec<Value> = inputs
        .iter()
        .enumerate()
        .rev()
        .map(|(i, text)| json!({ "index": i, "embedding": [text.chars().count() as f32, 1.0] }))
        .collect();
    (StatusCode::OK, Json(json!({ "data": data, "model": "m" })))
}

async fn serve() -> (String, Seen) {
    let seen = Seen::default();
    let app = Router::new()
        .route("/v1/embeddings", post(embeddings))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}/v1/"), seen)
}

fn config(base_url: &str) -> EmbeddingConfig {
    EmbeddingConfig {
        provider: "openai-compatible".into(),
        base_url: base_url.into(),
        api_key: Some("sk-test".into()),
        model: "bge-m3".into(),
        dimensions: Some(2),
        timeout_secs: 5,
        batch_size: 2,
    }
}

#[tokio::test]
async fn embeds_in_batches_and_orders_by_index() {
    let (url, seen) = serve().await;
    let embedder = OpenAiCompatibleEmbedder::new(&config(&url)).unwrap();
    let texts: Vec<String> = ["a", "bb", "ccc"].iter().map(|s| (*s).to_owned()).collect();
    let out = embedder.embed(&texts).await.unwrap();
    assert_eq!(out, vec![vec![1.0, 1.0], vec![2.0, 1.0], vec![3.0, 1.0]]);

    let bodies = seen.bodies.lock().clone();
    assert_eq!(bodies.len(), 2, "batch_size 2 → two requests");
    assert_eq!(bodies[0]["model"], "bge-m3");
    assert_eq!(bodies[0]["dimensions"], 2);
    assert_eq!(bodies[0]["input"], json!(["a", "bb"]));
    assert_eq!(bodies[1]["input"], json!(["ccc"]));
    assert!(
        seen.auth
            .lock()
            .iter()
            .all(|a| a.as_deref() == Some("Bearer sk-test"))
    );

    let err = embedder.embed(&["boom".to_owned()]).await.unwrap_err();
    assert!(format!("{err:#}").contains("500"), "{err:#}");
}

#[tokio::test]
async fn builds_from_config() {
    assert!(
        !build_embedder(&EmbeddingConfig::default())
            .unwrap()
            .enabled()
    );
    assert!(
        build_embedder(&EmbeddingConfig {
            provider: "openai-compatible".into(),
            ..EmbeddingConfig::default()
        })
        .is_err()
    );
    assert!(
        build_embedder(&EmbeddingConfig {
            provider: "magic".into(),
            ..EmbeddingConfig::default()
        })
        .is_err()
    );

    // Engine-level: stored records get vectors; a failing server only
    // costs the vector, not the memory.
    let (url, _) = serve().await;
    let embedder = build_embedder(&config(&url)).unwrap();
    assert_eq!(embedder.name(), "openai-compatible");
    let e = env_with(MemoryConfig::default(), None, Some(embedder));
    let id = e
        .add(
            MemoryKind::Fact,
            MemoryScope::Global,
            vec![],
            "Owen 喜歡拉麵",
            0.5,
            t0(),
        )
        .await;
    assert_eq!(e.rec(id).await.unwrap().embedding, Some(vec![9.0, 1.0]));
    let id = e
        .add(
            MemoryKind::Fact,
            MemoryScope::Global,
            vec![],
            "boom",
            0.5,
            t0(),
        )
        .await;
    assert_eq!(e.rec(id).await.unwrap().embedding, None);
}
