//! Provider and module tests against in-process axum mock servers.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::post;
use futures::{StreamExt, TryStreamExt};
use miyoria_kernel::Module;
use miyoria_speech::{
    AsrHint, AudioBuf, AudioStream, ProviderConfig, SpeechConfig, SpeechModule, SpeechService,
    TtsRequest, wav,
};
use serde_json::{Value, json};

/// What the mock saw: headers and raw body of the last request.
#[derive(Default)]
struct Seen {
    headers: HeaderMap,
    body: Vec<u8>,
}

type Shared = Arc<Mutex<Seen>>;

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn cfg(v: Value) -> ProviderConfig {
    serde_json::from_value(v).unwrap()
}

fn tone() -> AudioBuf {
    AudioBuf {
        sample_rate: 16_000,
        samples: (0..320).map(|i| (i * 50) as i16).collect(),
    }
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

async fn collect(stream: AudioStream) -> Vec<AudioBuf> {
    stream.try_collect().await.unwrap()
}

fn flatten(chunks: &[AudioBuf]) -> Vec<i16> {
    chunks.iter().flat_map(|c| c.samples.clone()).collect()
}

fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

// ------------------------------------------------------------------------ ASR

async fn record(State(seen): State<Shared>, headers: HeaderMap, body: Bytes) {
    *seen.lock().unwrap() = Seen {
        headers,
        body: body.to_vec(),
    };
}

#[tokio::test]
async fn asr_http_worker() {
    let seen = Shared::default();
    let app = Router::new()
        .route(
            "/asr",
            post(|s: State<Shared>, h: HeaderMap, b: Bytes| async move {
                record(s, h, b).await;
                axum::Json(json!({
                    "text": "早安", "language": "zh", "emotion": "happy",
                    "audio_events": ["laughter"], "duration_ms": 20
                }))
            }),
        )
        .with_state(seen.clone());
    let url = serve(app).await;

    let svc = SpeechModule::with_default_factories(
        serde_json::from_value(json!({
            "asr": {"local": {"kind": "http-worker", "url": format!("{url}/")}}
        }))
        .unwrap(),
    )
    .build_service()
    .unwrap();
    let hint = AsrHint {
        language: Some("zh".into()),
        prompt: Some("Miyoria".into()),
    };
    let (name, t) = svc.transcribe(&tone(), &hint).await.unwrap();
    assert_eq!(name, "local");
    assert_eq!(t.text, "早安");
    assert_eq!(t.language.as_deref(), Some("zh"));
    assert_eq!(t.emotion.as_deref(), Some("happy"));
    assert_eq!(t.audio_events, vec!["laughter"]);

    let seen = seen.lock().unwrap();
    let ct = seen.headers[header::CONTENT_TYPE].to_str().unwrap();
    assert!(ct.starts_with("multipart/form-data"), "{ct}");
    assert!(contains(&seen.body, "name=\"audio\""));
    assert!(contains(&seen.body, "RIFF"));
    assert!(contains(&seen.body, "name=\"language\""));
    assert!(contains(&seen.body, "name=\"prompt\""));
    assert!(contains(&seen.body, "Miyoria"));
}

#[tokio::test]
async fn asr_http_worker_optional_fields_and_error_body() {
    let app = Router::new()
        .route(
            "/ok/asr",
            post(|| async { axum::Json(json!({"text": "hi"})) }),
        )
        .route(
            "/bad/asr",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    axum::Json(json!({"error": "bad wav"})),
                )
            }),
        );
    let url = serve(app).await;
    let build = |path: &str| {
        let c = cfg(json!({"kind": "http-worker", "url": format!("{url}/{path}")}));
        miyoria_speech::AsrFactory::build(&miyoria_speech::HttpWorkerAsrFactory, "w", &c).unwrap()
    };

    let t = build("ok")
        .transcribe(&tone(), &AsrHint::default())
        .await
        .unwrap();
    assert_eq!(t.text, "hi");
    assert!(t.audio_events.is_empty() && t.emotion.is_none());

    let err = build("bad")
        .transcribe(&tone(), &AsrHint::default())
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("400") && err.contains("bad wav"), "{err}");
}

#[tokio::test]
async fn asr_openai() {
    let seen = Shared::default();
    let app = Router::new()
        .route(
            "/v1/audio/transcriptions",
            post(|s: State<Shared>, h: HeaderMap, b: Bytes| async move {
                record(s, h, b).await;
                axum::Json(json!({"text": "hello"}))
            }),
        )
        .with_state(seen.clone());
    let url = serve(app).await;

    let svc = SpeechModule::with_default_factories(
        serde_json::from_value(json!({
            "asr": {"groq": {
                "kind": "openai", "base_url": format!("{url}/v1"),
                "api_key": "sk-test", "model": "whisper-large-v3-turbo"
            }}
        }))
        .unwrap(),
    )
    .build_service()
    .unwrap();
    let hint = AsrHint {
        language: Some("en".into()),
        prompt: None,
    };
    let (_, t) = svc.transcribe(&tone(), &hint).await.unwrap();
    assert_eq!(t.text, "hello");
    assert_eq!(t.language.as_deref(), Some("en"));

    let seen = seen.lock().unwrap();
    assert_eq!(seen.headers[header::AUTHORIZATION], "Bearer sk-test");
    assert!(contains(&seen.body, "name=\"file\""));
    assert!(contains(&seen.body, "whisper-large-v3-turbo"));
    assert!(contains(&seen.body, "name=\"response_format\""));
    assert!(contains(&seen.body, "json"));
    assert!(contains(&seen.body, "name=\"language\""));
    assert!(!contains(&seen.body, "name=\"prompt\""));
}

#[tokio::test]
async fn asr_error_falls_back_to_next_provider() {
    let app = Router::new()
        .route(
            "/down/asr",
            post(|| async { (StatusCode::SERVICE_UNAVAILABLE, "model loading") }),
        )
        .route(
            "/up/asr",
            post(|| async { axum::Json(json!({"text": "backup"})) }),
        );
    let url = serve(app).await;

    let config: SpeechConfig = serde_json::from_value(json!({
        "asr": {
            "a_primary": {"kind": "http-worker", "url": format!("{url}/down")},
            "b_backup": {"kind": "http-worker", "url": format!("{url}/up")},
        },
    }))
    .unwrap();
    // default chain = name order
    let svc = SpeechModule::with_default_factories(config.clone())
        .build_service()
        .unwrap();
    let (name, t) = svc.transcribe(&tone(), &AsrHint::default()).await.unwrap();
    assert_eq!((name.as_str(), t.text.as_str()), ("b_backup", "backup"));

    // chain with only the failing provider surfaces the error
    let mut only_down = config;
    only_down.asr_chain = Some(vec!["a_primary".into()]);
    let svc = SpeechModule::with_default_factories(only_down)
        .build_service()
        .unwrap();
    let err = svc
        .transcribe(&tone(), &AsrHint::default())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("503") && err.contains("model loading"),
        "{err}"
    );
}

// ------------------------------------------------------------------------ TTS

/// Streams `body` in pieces cut at the given byte offsets.
fn chunked(body: Vec<u8>, cuts: &[usize], headers: &[(&str, &str)]) -> Response {
    let mut pieces = Vec::new();
    let mut last = 0;
    for &c in cuts.iter().chain([&body.len()]) {
        pieces.push(Bytes::copy_from_slice(&body[last..c]));
        last = c;
    }
    let stream = futures::stream::iter(pieces).then(|b| async move {
        tokio::time::sleep(Duration::from_millis(5)).await;
        Ok::<_, Infallible>(b)
    });
    let mut resp = Response::new(Body::from_stream(stream));
    for (k, v) in headers {
        resp.headers_mut().insert(
            header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            HeaderValue::from_str(v).unwrap(),
        );
    }
    resp
}

fn speech_samples() -> Vec<i16> {
    (0..1000).map(|i| (i * 7 - 3000) as i16).collect()
}

#[tokio::test]
async fn tts_http_worker_streams_across_odd_byte_boundaries() {
    let seen = Shared::default();
    let pcm = pcm_bytes(&speech_samples());
    let app = Router::new()
        .route(
            "/tts",
            post(move |s: State<Shared>, h: HeaderMap, b: Bytes| {
                let pcm = pcm.clone();
                async move {
                    record(s, h, b).await;
                    // odd offsets, a 1-byte piece and a piece ending mid-sample
                    chunked(
                        pcm,
                        &[3, 4, 5, 501, 1001, 1500],
                        &[
                            ("content-type", "audio/L16; rate=24000; channels=1"),
                            ("x-sample-rate", "24000"),
                        ],
                    )
                }
            }),
        )
        .with_state(seen.clone());
    let url = serve(app).await;

    let svc = SpeechModule::with_default_factories(
        serde_json::from_value(json!({
            "tts": {"qwen": {"kind": "http-worker", "url": url, "voice": "default-voice"}}
        }))
        .unwrap(),
    )
    .build_service()
    .unwrap();

    let req = TtsRequest {
        text: "哼".into(),
        language: Some("Chinese".into()),
        emotion: Some("annoyed".into()),
        ..Default::default()
    };
    let (name, stream) = svc.synthesize(req).await.unwrap();
    assert_eq!(name, "qwen");
    let chunks = collect(stream).await;
    assert!(chunks.len() > 1, "expected several chunks");
    assert!(chunks.iter().all(|c| c.sample_rate == 24_000));
    assert_eq!(flatten(&chunks), speech_samples());

    let body: Value = serde_json::from_slice(&seen.lock().unwrap().body).unwrap();
    assert_eq!(
        body,
        json!({"text": "哼", "language": "Chinese", "emotion": "annoyed", "voice": "default-voice"})
    );

    // a voice in the request wins over the configured one
    let req = TtsRequest {
        text: "x".into(),
        voice: Some("other".into()),
        ..Default::default()
    };
    collect(svc.synthesize(req).await.unwrap().1).await;
    let body: Value = serde_json::from_slice(&seen.lock().unwrap().body).unwrap();
    assert_eq!(body["voice"], "other");
}

#[tokio::test]
async fn tts_http_worker_rate_from_content_type_and_missing_rate() {
    let app = Router::new()
        .route(
            "/ct/tts",
            post(|| async {
                chunked(
                    vec![1, 0, 2, 0],
                    &[1],
                    &[("content-type", "audio/L16; rate=16000")],
                )
            }),
        )
        .route(
            "/none/tts",
            post(|| async { chunked(vec![1, 0], &[], &[]) }),
        );
    let url = serve(app).await;
    let tts = |path: &str| {
        let c = cfg(json!({"kind": "http-worker", "url": format!("{url}/{path}")}));
        miyoria_speech::TtsFactory::build(&miyoria_speech::HttpWorkerTtsFactory, "w", &c).unwrap()
    };

    let chunks = collect(tts("ct").synthesize(TtsRequest::default()).await.unwrap()).await;
    assert!(chunks.iter().all(|c| c.sample_rate == 16_000));
    assert_eq!(flatten(&chunks), vec![1, 2]);

    // no X-Sample-Rate and no rate= -> error (so the fallback chain moves on)
    let err = tts("none").synthesize(TtsRequest::default()).await;
    assert!(err.is_err_and(|e| e.to_string().contains("sample rate")));
}

#[tokio::test]
async fn tts_openai() {
    let seen = Shared::default();
    let pcm = pcm_bytes(&speech_samples());
    let app = Router::new()
        .route(
            "/v1/audio/speech",
            post(move |s: State<Shared>, h: HeaderMap, b: Bytes| {
                let pcm = pcm.clone();
                async move {
                    record(s, h, b).await;
                    chunked(pcm, &[1, 777, 1999], &[("content-type", "audio/pcm")])
                }
            }),
        )
        .with_state(seen.clone());
    let url = serve(app).await;

    let svc = SpeechModule::with_default_factories(
        serde_json::from_value(json!({
            "tts": {"cloud": {
                "kind": "openai", "base_url": format!("{url}/v1/"), "api_key": "sk-tts",
                "model": "gpt-4o-mini-tts", "voice": "nova"
            }}
        }))
        .unwrap(),
    )
    .build_service()
    .unwrap();
    let (_, stream) = svc
        .synthesize(TtsRequest {
            text: "hello".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let chunks = collect(stream).await;
    assert!(chunks.iter().all(|c| c.sample_rate == 24_000));
    assert_eq!(flatten(&chunks), speech_samples());

    let seen = seen.lock().unwrap();
    assert_eq!(seen.headers[header::AUTHORIZATION], "Bearer sk-tts");
    let body: Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(
        body,
        json!({"model": "gpt-4o-mini-tts", "input": "hello", "voice": "nova", "response_format": "pcm"})
    );
}

#[tokio::test]
async fn tts_gpt_sovits() {
    let seen = Shared::default();
    let pcm = pcm_bytes(&speech_samples());
    let app = Router::new()
        .route(
            "/tts",
            post(move |s: State<Shared>, h: HeaderMap, b: Bytes| {
                let pcm = pcm.clone();
                async move {
                    record(s, h, b).await;
                    chunked(pcm, &[11, 600], &[("content-type", "audio/x-raw")])
                }
            }),
        )
        .with_state(seen.clone());
    let url = serve(app).await;

    let svc = SpeechModule::with_default_factories(
        serde_json::from_value(json!({
            "tts": {"sovits": {
                "kind": "gpt-sovits", "url": url, "ref_audio_path": "refs/a.wav",
                "prompt_text": "你好", "prompt_lang": "zh",
                "params": {"speed_factor": 1.2}
            }}
        }))
        .unwrap(),
    )
    .build_service()
    .unwrap();
    let (_, stream) = svc
        .synthesize(TtsRequest {
            text: "こんにちは".into(),
            language: Some("Japanese".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let chunks = collect(stream).await;
    assert!(chunks.iter().all(|c| c.sample_rate == 32_000));
    assert_eq!(flatten(&chunks), speech_samples());

    let body: Value = serde_json::from_slice(&seen.lock().unwrap().body).unwrap();
    assert_eq!(
        body,
        json!({
            "text": "こんにちは", "text_lang": "ja", "ref_audio_path": "refs/a.wav",
            "prompt_text": "你好", "prompt_lang": "zh", "media_type": "raw",
            "streaming_mode": true, "speed_factor": 1.2
        })
    );
}

#[tokio::test]
async fn tts_failure_falls_back() {
    let pcm = pcm_bytes(&[5, 6, 7]);
    let app = Router::new()
        .route(
            "/a/tts",
            post(|| async {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({"error": "oom"})),
                )
            }),
        )
        .route(
            "/b/tts",
            post(move || {
                let pcm = pcm.clone();
                async move { chunked(pcm, &[], &[("x-sample-rate", "22050")]) }
            }),
        );
    let url = serve(app).await;
    let svc = SpeechModule::with_default_factories(
        serde_json::from_value(json!({
            "tts": {
                "a": {"kind": "http-worker", "url": format!("{url}/a")},
                "b": {"kind": "http-worker", "url": format!("{url}/b")},
            },
            "tts_chain": ["a", "b"],
        }))
        .unwrap(),
    )
    .build_service()
    .unwrap();
    let (name, stream) = svc.synthesize(TtsRequest::default()).await.unwrap();
    assert_eq!(name, "b");
    let chunks = collect(stream).await;
    assert_eq!(chunks[0].sample_rate, 22_050);
    assert_eq!(flatten(&chunks), vec![5, 6, 7]);
}

// --------------------------------------------------------------------- module

#[test]
fn module_config_and_chains() {
    // empty config: starts, nothing available
    let svc: SpeechService = SpeechModule::with_default_factories(SpeechConfig::default())
        .build_service()
        .unwrap();
    assert!(!svc.has_asr() && !svc.has_tts());

    // chains default to everything configured; explicit empty chain disables
    let config: SpeechConfig = toml_like(json!({
        "asr": {"x": {"kind": "http-worker", "url": "http://127.0.0.1:1"}},
        "tts": {"y": {"kind": "openai"}},
        "tts_chain": [],
    }));
    let svc = SpeechModule::with_default_factories(config)
        .build_service()
        .unwrap();
    assert!(svc.has_asr());
    assert!(!svc.has_tts());

    // errors: unknown kind, unknown chain entry, bad settings
    let err = |v: Value| {
        SpeechModule::with_default_factories(toml_like(v))
            .build_service()
            .err()
            .map(|e| format!("{e:#}"))
            .unwrap()
    };
    assert!(err(json!({"asr": {"x": {"kind": "nope"}}})).contains("unknown ASR kind"));
    assert!(
        err(json!({"tts": {"x": {"kind": "gpt-sovits", "url": "u"}}})).contains("speech.tts.x")
    );
    assert!(err(json!({"asr_chain": ["ghost"]})).contains("ghost"));
    assert!(err(json!({"asr": {"x": {"kind": "http-worker"}}})).contains("speech.asr.x"));
}

fn toml_like(v: Value) -> SpeechConfig {
    serde_json::from_value(v).unwrap()
}

#[test]
fn module_manifest_id() {
    let m = SpeechModule::with_default_factories(SpeechConfig::default());
    assert_eq!(m.manifest().id.as_str(), "speech");
}

#[test]
fn wav_is_reexported_and_resample_available() {
    let a = tone();
    assert_eq!(wav::decode(&wav::encode(&a)).unwrap(), a);
    assert_eq!(miyoria_speech::resample(&a, 8_000).samples.len(), 160);
}

#[tokio::test]
async fn tts_vllm_omni_streams_raw_pcm() {
    let seen = Shared::default();
    let pcm = pcm_bytes(&speech_samples());
    let app = Router::new()
        .route(
            "/v1/audio/speech",
            post(move |s: State<Shared>, h: HeaderMap, b: Bytes| {
                let pcm = pcm.clone();
                async move {
                    record(s, h, b).await;
                    chunked(
                        pcm,
                        &[3, 641, 1500],
                        &[("x-audio-sample-rate", "24000"), ("x-audio-channels", "1")],
                    )
                }
            }),
        )
        .with_state(seen.clone());
    let url = serve(app).await;

    let svc = SpeechModule::with_default_factories(
        serde_json::from_value(json!({
            "tts": {"qwen": {
                "kind": "vllm-omni", "base_url": format!("{url}/v1"), "voice": "deepseek-chan",
                "language": "Chinese", "instructions": true, "initial_codec_chunk_frames": 4,
                "extra": {"seed": 7}
            }}
        }))
        .unwrap(),
    )
    .build_service()
    .unwrap();
    let (_, stream) = svc
        .synthesize(TtsRequest {
            text: "哼,才不是在等你呢。".into(),
            instruct: Some("不耐煩".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let chunks = collect(stream).await;
    assert!(chunks.iter().all(|c| c.sample_rate == 24_000));
    assert_eq!(flatten(&chunks), speech_samples());

    let body: Value = serde_json::from_slice(&seen.lock().unwrap().body).unwrap();
    assert_eq!(
        body,
        json!({
            "input": "哼,才不是在等你呢。", "response_format": "pcm", "stream": true,
            "stream_format": "audio", "language": "Chinese", "voice": "deepseek-chan",
            "instructions": "不耐煩", "initial_codec_chunk_frames": 4, "seed": 7
        })
    );
}
