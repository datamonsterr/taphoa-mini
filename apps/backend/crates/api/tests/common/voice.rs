#![allow(dead_code)]
//! Voice test kit: scripted model, parse builders and multipart uploads.
use super::world::{Reply, World};
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use std::{sync::Arc, time::Duration};
use taphoa_api::voice::{
    VoiceConfig,
    model::{Intent, ParsedLine, VoiceParse},
    scripted::{ScriptedVoiceModel, Step},
};
use tower::ServiceExt;
use uuid::Uuid;

pub fn line(
    spoken: &str,
    query: &str,
    quantity: Option<f64>,
    unit: Option<&str>,
    price: Option<f64>,
    words: Option<&str>,
) -> ParsedLine {
    ParsedLine {
        spoken: spoken.into(),
        query: query.into(),
        quantity,
        unit: unit.map(Into::into),
        unit_price: price,
        price_spoken: words.map(Into::into),
    }
}
pub fn sale(
    transcript: &str,
    lines: Vec<ParsedLine>,
    payment: &str,
    customer: Option<&str>,
) -> VoiceParse {
    VoiceParse {
        transcript: transcript.into(),
        language: "vi".into(),
        intent: Intent::Sale,
        lines,
        payment_method: Some(payment.into()),
        customer_name: customer.map(Into::into),
        confidence: 0.9,
    }
}

pub async fn setup(
    steps: Vec<Step>,
    tweak: impl FnOnce(&mut VoiceConfig),
) -> (World, Arc<ScriptedVoiceModel>) {
    let mut w = World::new().await;
    let model = Arc::new(ScriptedVoiceModel::new(steps));
    let mut config = VoiceConfig {
        models: vec!["g/one".into(), "g/two".into()],
        parse_models: vec!["p/one".into(), "p/two".into()],
        stt_model: "w/stt".into(),
        hint_ttl: Duration::ZERO,
        ..VoiceConfig::default()
    };
    tweak(&mut config);
    w.state.voice.config = Arc::new(config);
    w.state.voice.model = Some(model.clone());
    w.state.redis = None;
    w.app = taphoa_api::router(w.state.clone());
    (w, model)
}

pub fn multipart(audio: Option<&[u8]>, fields: &[(&str, &str)]) -> (String, Vec<u8>) {
    let boundary = "voiceboundary7MA4YWxkTrZu0gW";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    if let Some(audio) = audio {
        body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"clip.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n").as_bytes());
        body.extend(audio);
        body.extend(b"\r\n");
    }
    body.extend(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

pub async fn upload_with(
    w: &World,
    token: &str,
    audio: Option<&[u8]>,
    fields: &[(&str, &str)],
    extra_headers: &[(&str, &str)],
) -> Reply {
    let (content_type, body) = multipart(audio, fields);
    let b = Uuid::new_v4().into_bytes();
    let mut request = Request::post("/v1/voice/utterances")
        .header("content-type", content_type)
        .header("authorization", format!("Bearer {token}"))
        .header("x-forwarded-for", format!("10.{}.{}.{}", b[0], b[1], b[2]));
    for (k, v) in extra_headers {
        request = request.header(*k, *v);
    }
    let response = w
        .app
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let raw = to_bytes(response.into_body(), 8 << 20)
        .await
        .unwrap()
        .to_vec();
    let body = serde_json::from_slice(&raw).unwrap_or(serde_json::Value::Null);
    Reply {
        status,
        body,
        headers,
        raw,
    }
}

pub async fn upload(w: &World, audio: &[u8], mode: &str) -> Reply {
    upload_with(
        w,
        &w.seller,
        Some(audio),
        &[
            ("mode", mode),
            ("language", "vi"),
            ("context", r#"{"entry":"chat","screen":"test"}"#),
        ],
        &[],
    )
    .await
}
