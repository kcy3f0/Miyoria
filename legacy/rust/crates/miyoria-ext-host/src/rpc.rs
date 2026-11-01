//! JSON-RPC 2.0 over a byte stream with LSP-style `Content-Length` framing.
//!
//! [`Peer`] is symmetric: both sides may send requests and notifications.
//! Incoming requests run concurrently; every outgoing request has a timeout.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

/// Largest accepted frame body.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;
/// The extension lacks the permission for this call.
pub const PERMISSION_DENIED: i64 = -32001;
/// A request timed out (local to the caller, never sent).
pub const TIMEOUT: i64 = -32002;
/// Name already taken by someone else.
pub const CONFLICT: i64 = -32003;
/// A host service (tool registry, storage, ...) is not available.
pub const UNAVAILABLE: i64 = -32004;
/// The connection is closed (local to the caller, never sent).
pub const CLOSED: i64 = -32005;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message} (code {code})")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn invalid_params(e: impl std::fmt::Display) -> Self {
        Self::new(INVALID_PARAMS, format!("invalid params: {e}"))
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(PERMISSION_DENIED, message)
    }

    pub fn internal(e: impl std::fmt::Display) -> Self {
        Self::new(INTERNAL_ERROR, e.to_string())
    }
}

/// Serves incoming requests and notifications.
#[async_trait]
pub trait Handler: Send + Sync + 'static {
    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError>;
    async fn notification(&self, method: &str, params: Value);
}

/// Encodes one message as a frame.
pub fn encode_frame(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).expect("JSON values always serialize");
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(&body);
    out
}

/// Reads one frame body. `Ok(None)` on a clean end of stream.
pub async fn read_frame<R: AsyncBufRead + Unpin>(r: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let invalid = |m: String| std::io::Error::new(std::io::ErrorKind::InvalidData, m);
    let mut length: Option<usize> = None;
    let mut line = String::new();
    let mut first = true;
    loop {
        line.clear();
        let n = r.read_line(&mut line).await?;
        if n == 0 {
            return if first {
                Ok(None)
            } else {
                Err(std::io::ErrorKind::UnexpectedEof.into())
            };
        }
        first = false;
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Err(invalid(format!("malformed header `{header}`")));
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            let len = value
                .trim()
                .parse()
                .map_err(|_| invalid(format!("bad Content-Length `{}`", value.trim())))?;
            length = Some(len);
        }
    }
    let length = length.ok_or_else(|| invalid("missing Content-Length".to_owned()))?;
    if length > MAX_FRAME {
        return Err(invalid(format!("frame of {length} bytes is too large")));
    }
    let mut body = vec![0; length];
    r.read_exact(&mut body).await?;
    Ok(Some(body))
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

/// One side of a JSON-RPC connection.
pub struct Peer {
    out: mpsc::Sender<Vec<u8>>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl Peer {
    /// Creates a peer writing to `writer`. The returned future pumps outgoing
    /// frames and must be spawned; it ends when the peer is dropped or the
    /// writer fails.
    pub fn new<W>(writer: W) -> (Arc<Self>, impl Future<Output = std::io::Result<()>> + Send)
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(1024);
        let peer = Arc::new(Self {
            out: tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });
        let pump = async move {
            let mut writer = writer;
            while let Some(frame) = rx.recv().await {
                writer.write_all(&frame).await?;
                writer.flush().await?;
            }
            Ok(())
        };
        (peer, pump)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Sends a request and waits for the response, at most `timeout`.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        if self.is_closed() {
            return Err(RpcError::new(CLOSED, "connection closed"));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        let frame = encode_frame(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        }));
        if self.out.send(frame).await.is_err() {
            self.pending.lock().remove(&id);
            return Err(RpcError::new(CLOSED, "connection closed"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::new(CLOSED, "connection closed")),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(RpcError::new(
                    TIMEOUT,
                    format!("`{method}` timed out after {} ms", timeout.as_millis()),
                ))
            }
        }
    }

    /// Sends a notification, waiting for queue space.
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        let frame = encode_frame(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        self.out
            .send(frame)
            .await
            .map_err(|_| RpcError::new(CLOSED, "connection closed"))
    }

    /// Sends a notification unless the outgoing queue is full. Returns whether
    /// it was queued.
    pub fn try_notify(&self, method: &str, params: Value) -> bool {
        let frame = encode_frame(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        self.out.try_send(frame).is_ok()
    }

    async fn respond(&self, id: Value, result: Result<Value, RpcError>) {
        let message = match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
        };
        let _ = self.out.send(encode_frame(&message)).await;
    }

    /// Reads incoming messages until the stream ends, dispatching requests and
    /// notifications to `handler` and responses to waiting callers. Pending
    /// requests fail with [`CLOSED`] when it returns.
    pub async fn serve<R>(
        self: &Arc<Self>,
        reader: R,
        handler: Arc<dyn Handler>,
    ) -> std::io::Result<()>
    where
        R: AsyncRead + Unpin + Send,
    {
        let mut reader = tokio::io::BufReader::new(reader);
        let mut tasks = JoinSet::new();
        let result = loop {
            while tasks.try_join_next().is_some() {}
            let body = match read_frame(&mut reader).await {
                Ok(Some(body)) => body,
                Ok(None) => break Ok(()),
                Err(e) => break Err(e),
            };
            let message: Value = match serde_json::from_slice(&body) {
                Ok(m) => m,
                Err(e) => {
                    self.respond(Value::Null, Err(RpcError::new(PARSE_ERROR, e.to_string())))
                        .await;
                    continue;
                }
            };
            self.dispatch(message, &handler, &mut tasks).await;
        };
        self.closed.store(true, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(Err(RpcError::new(CLOSED, "connection closed")));
        }
        tasks.abort_all();
        result
    }

    async fn dispatch(
        self: &Arc<Self>,
        message: Value,
        handler: &Arc<dyn Handler>,
        tasks: &mut JoinSet<()>,
    ) {
        let Value::Object(mut obj) = message else {
            self.respond(
                Value::Null,
                Err(RpcError::new(INVALID_REQUEST, "not an object")),
            )
            .await;
            return;
        };
        let id = obj.remove("id").filter(|id| !id.is_null());
        if let Some(Value::String(method)) = obj.remove("method") {
            let params = obj.remove("params").unwrap_or(Value::Null);
            let handler = handler.clone();
            let peer = self.clone();
            tasks.spawn(async move {
                match id {
                    Some(id) => {
                        let result = handler.request(&method, params).await;
                        peer.respond(id, result).await;
                    }
                    None => handler.notification(&method, params).await,
                }
            });
            return;
        }
        let Some(id) = id.and_then(|id| id.as_u64()) else {
            return; // response to nothing we sent, or a malformed message
        };
        let Some(tx) = self.pending.lock().remove(&id) else {
            return; // late response after a timeout
        };
        let result = match (obj.remove("result"), obj.remove("error")) {
            (_, Some(error)) => Err(serde_json::from_value(error).unwrap_or_else(|e| {
                RpcError::new(INTERNAL_ERROR, format!("bad error object: {e}"))
            })),
            (Some(result), None) => Ok(result),
            (None, None) => Ok(Value::Null),
        };
        let _ = tx.send(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_roundtrip_across_chunks() {
        let a = encode_frame(&json!({ "x": "測試" }));
        let b = encode_frame(&json!([1, 2]));
        let mut bytes = a.clone();
        bytes.extend_from_slice(&b);
        // A reader that hands out one byte at a time.
        let (mut w, r) = tokio::io::duplex(1);
        let writer = tokio::spawn(async move { w.write_all(&bytes).await });
        let mut r = tokio::io::BufReader::new(r);
        let first = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&first).unwrap()["x"],
            "測試"
        );
        let second = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(second, b"[1,2]");
        writer.await.unwrap().unwrap();
        assert!(read_frame(&mut r).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_bad_headers() {
        let mut r = tokio::io::BufReader::new(&b"Content-Type: x\r\n\r\n{}"[..]);
        assert!(read_frame(&mut r).await.is_err());
        let mut r = tokio::io::BufReader::new(&b"Content-Length: 99999999999\r\n\r\n"[..]);
        assert!(read_frame(&mut r).await.is_err());
        let mut r = tokio::io::BufReader::new(&b"Content-Length: 10\r\n\r\n{}"[..]);
        assert!(read_frame(&mut r).await.is_err());
    }

    struct Echo;

    #[async_trait]
    impl Handler for Echo {
        async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
            match method {
                "echo" => Ok(params),
                "sleep" => {
                    let ms = params.as_u64().unwrap_or(0);
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    Ok(json!(ms))
                }
                "never" => std::future::pending().await,
                _ => Err(RpcError::new(METHOD_NOT_FOUND, method)),
            }
        }
        async fn notification(&self, _: &str, _: Value) {}
    }

    fn pair() -> (Arc<Peer>, Arc<Peer>) {
        let (a_io, b_io) = tokio::io::duplex(64 * 1024);
        let (a_r, a_w) = tokio::io::split(a_io);
        let (b_r, b_w) = tokio::io::split(b_io);
        let (a, a_pump) = Peer::new(a_w);
        let (b, b_pump) = Peer::new(b_w);
        tokio::spawn(a_pump);
        tokio::spawn(b_pump);
        let a2 = a.clone();
        tokio::spawn(async move { a2.serve(a_r, Arc::new(Echo)).await });
        let b2 = b.clone();
        tokio::spawn(async move { b2.serve(b_r, Arc::new(Echo)).await });
        (a, b)
    }

    #[tokio::test]
    async fn correlates_out_of_order_responses() {
        let (a, _b) = pair();
        let t = Duration::from_secs(5);
        let (slow, fast, echo, missing) = tokio::join!(
            a.request("sleep", json!(80), t),
            a.request("sleep", json!(5), t),
            a.request("echo", json!({ "k": 1 }), t),
            a.request("nope", Value::Null, t),
        );
        assert_eq!(slow.unwrap(), json!(80));
        assert_eq!(fast.unwrap(), json!(5));
        assert_eq!(echo.unwrap(), json!({ "k": 1 }));
        assert_eq!(missing.unwrap_err().code, METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn times_out_and_closes() {
        let (a, b) = pair();
        let err = a
            .request("never", Value::Null, Duration::from_millis(50))
            .await
            .unwrap_err();
        assert_eq!(err.code, TIMEOUT);
        assert!(a.pending.lock().is_empty());
        drop(b);
        // `b`'s serve task still holds it; the connection stays usable.
        assert!(
            a.request("echo", json!(1), Duration::from_secs(1))
                .await
                .is_ok()
        );
    }
}
