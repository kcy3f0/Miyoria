//! VTube Studio client against a fake VTS server.

mod common;

use std::time::Duration;

use common::{FakeVts, temp_dir, wait_until};
use miyoria_stage::vts::{ApiError, PluginInfo, VtsClient, token_path};

const TIMEOUT: Duration = Duration::from_secs(5);

fn plugin() -> PluginInfo {
    PluginInfo {
        name: "Miyoria".into(),
        developer: "Miyoria".into(),
        icon: None,
    }
}

async fn client(vts: &FakeVts) -> VtsClient {
    VtsClient::connect(&vts.url(), TIMEOUT).await.unwrap()
}

#[tokio::test]
async fn auth_flow_persists_and_renews_the_token() {
    let vts = FakeVts::start().await;
    let dir = temp_dir();
    let file = token_path(&dir.join("nested"));

    let c = client(&vts).await;
    c.authenticate(&plugin(), &file, TIMEOUT).await.unwrap();
    assert_eq!(
        vts.types(),
        ["AuthenticationTokenRequest", "AuthenticationRequest"]
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "tok-1");
    let reqs = vts.requests();
    assert_eq!(reqs[0]["apiName"], "VTubeStudioPublicAPI");
    assert_eq!(reqs[0]["apiVersion"], "1.0");
    assert_eq!(reqs[0]["data"]["pluginName"], "Miyoria");
    assert_eq!(reqs[0]["data"]["pluginDeveloper"], "Miyoria");
    assert_eq!(reqs[1]["data"]["authenticationToken"], "tok-1");
    assert_ne!(reqs[0]["requestID"], reqs[1]["requestID"]);
    drop(c);

    // The stored token is reused.
    vts.clear();
    let c = client(&vts).await;
    c.authenticate(&plugin(), &file, TIMEOUT).await.unwrap();
    assert_eq!(vts.types(), ["AuthenticationRequest"]);
    drop(c);

    // A revoked token is replaced.
    vts.clear();
    vts.state.lock().valid_token = Some("revoked".into());
    let c = client(&vts).await;
    c.authenticate(&plugin(), &file, TIMEOUT).await.unwrap();
    assert_eq!(
        vts.types(),
        [
            "AuthenticationRequest",
            "AuthenticationTokenRequest",
            "AuthenticationRequest"
        ]
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "tok-2");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn denied_plugin_is_an_error() {
    let vts = FakeVts::start().await;
    vts.state.lock().deny = true;
    let dir = temp_dir();
    let file = token_path(&dir);
    let c = client(&vts).await;
    let err = c.authenticate(&plugin(), &file, TIMEOUT).await.unwrap_err();
    assert!(err.to_string().contains("denied"), "{err}");
    assert!(!file.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn model_hotkeys_and_expressions() {
    let vts = FakeVts::start().await;
    let c = client(&vts).await;

    let model = c.current_model().await.unwrap();
    assert!(model.loaded);
    assert_eq!(
        (model.name.as_str(), model.id.as_str()),
        ("DeepSeek-chan", "m1")
    );

    let hotkeys = c.hotkeys().await.unwrap();
    assert_eq!(hotkeys.len(), 2);
    assert_eq!(hotkeys[0].kind, "TriggerAnimation");

    // Names resolve to ids, case-insensitively; ids pass through.
    assert_eq!(c.trigger_hotkey("wave").await.unwrap(), "hk-wave");
    assert_eq!(c.trigger_hotkey("hk-clear").await.unwrap(), "hk-clear");
    assert!(c.trigger_hotkey("Dance").await.is_err());
    let triggers: Vec<_> = vts
        .requests()
        .into_iter()
        .filter(|r| r["messageType"] == "HotkeyTriggerRequest")
        .map(|r| r["data"]["hotkeyID"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(triggers, ["hk-wave", "hk-clear"]);

    let expressions = c.expressions().await.unwrap();
    assert_eq!(expressions[0].file, "happy.exp3.json");
    c.set_expression("happy.exp3.json", true, 0.3)
        .await
        .unwrap();
    let req = vts
        .requests()
        .into_iter()
        .rfind(|r| r["messageType"] == "ExpressionActivationRequest")
        .unwrap();
    assert_eq!(req["data"]["expressionFile"], "happy.exp3.json");
    assert_eq!(req["data"]["active"], true);
    assert!((req["data"]["fadeTime"].as_f64().unwrap() - 0.3).abs() < 1e-6);
    let state = vts
        .requests()
        .into_iter()
        .find(|r| r["messageType"] == "ExpressionStateRequest")
        .unwrap();
    assert_eq!(state["data"]["details"], false);

    let params = c.input_parameters().await.unwrap();
    assert!(params.contains("FaceAngleX") && params.contains("MouthForm"));

    let err = c
        .request("NoSuchRequest", serde_json::json!({}))
        .await
        .unwrap_err();
    let api = err.downcast_ref::<ApiError>().expect("API error");
    assert_eq!(api.id, 2);
}

#[tokio::test]
async fn injection_is_batched_and_coalesced() {
    let vts = FakeVts::start().await;
    let c = client(&vts).await;
    // Several frames queued back to back: unsent values merge, newest wins.
    c.inject(&[("MouthOpen", 0.5), ("MouthForm", 0.1)], false);
    c.inject(&[("FaceAngleX", 3.0)], false);
    c.inject(&[("MouthOpen", 0.7), ("NotANumber", f32::NAN)], true);
    wait_until(|| {
        let inj = vts.injections();
        inj.last().is_some_and(|d| {
            d["parameterValues"].as_array().unwrap().iter().any(|p| {
                p["id"] == "MouthOpen" && (p["value"].as_f64().unwrap() - 0.7).abs() < 1e-6
            })
        })
    })
    .await;
    let injections = vts.injections();
    assert!((1..=3).contains(&injections.len()), "{injections:?}");
    let mut seen = std::collections::BTreeMap::new();
    for d in &injections {
        assert_eq!(d["mode"], "set");
        for p in d["parameterValues"].as_array().unwrap() {
            seen.insert(
                p["id"].as_str().unwrap().to_owned(),
                p["value"].as_f64().unwrap(),
            );
        }
    }
    assert_eq!(injections.last().unwrap()["faceFound"], true);
    assert_eq!(
        seen.keys().map(String::as_str).collect::<Vec<_>>(),
        ["FaceAngleX", "MouthForm", "MouthOpen"]
    );
    assert!((seen["FaceAngleX"] - 3.0).abs() < 1e-6);

    // A single frame carries every parameter in one request.
    vts.clear();
    c.inject(
        &[("MouthOpen", 0.2), ("FaceAngleX", 1.0), ("EyeLeftX", -0.5)],
        false,
    );
    wait_until(|| !vts.injections().is_empty()).await;
    assert_eq!(
        vts.injections()[0]["parameterValues"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[tokio::test]
async fn disconnect_fails_requests() {
    use futures::StreamExt;
    // A server that hangs up on the first request.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let _ = ws.next().await;
    });
    let c = VtsClient::connect(&format!("ws://{addr}"), TIMEOUT)
        .await
        .unwrap();
    let err = c.current_model().await.unwrap_err();
    assert!(err.to_string().contains("disconnected"), "{err}");
    tokio::time::timeout(TIMEOUT, c.closed()).await.unwrap();
    assert!(c.is_closed());
    assert!(
        VtsClient::connect("ws://127.0.0.1:1", Duration::from_millis(500))
            .await
            .is_err()
    );
}
