//! Contract SSE frames. The unbounded channel lets a turn finish persisting after disconnect.
use super::model::Usage;
use axum::response::sse::{Event, Sse};
use futures_util::{Stream, stream};
use serde::Serialize;
use serde_json::Value;
use std::convert::Infallible;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum StreamEvent {
    #[serde(rename = "message.created")]
    Created { message_id: Uuid, thread_id: Uuid },
    #[serde(rename = "message.delta")]
    Delta { text: String },
    #[serde(rename = "tool.started")]
    ToolStarted {
        call_id: String,
        tool: String,
        label_vi: String,
    },
    #[serde(rename = "tool.finished")]
    ToolFinished {
        call_id: String,
        tool: String,
        ok: bool,
        summary_vi: String,
    },
    #[serde(rename = "action.proposed")]
    Action(Value),
    #[serde(rename = "card")]
    Card(Value),
    #[serde(rename = "message.completed")]
    Completed {
        message_id: Uuid,
        model: String,
        usage: Usage,
    },
    #[serde(rename = "error")]
    Error {
        code: &'static str,
        message_vi: String,
    },
}
pub type Sender = UnboundedSender<StreamEvent>;
pub(crate) fn send(tx: &Sender, event: StreamEvent) {
    let _ = tx.send(event);
}
pub(crate) fn response(
    rx: UnboundedReceiver<StreamEvent>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    Sse::new(stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|event| {
            // All variants contain JSON values, strings or integers; serialization is infallible.
            let frame = serde_json::to_value(event).expect("SSE frame is JSON");
            let event = Event::default()
                .event(frame["event"].as_str().expect("event name"))
                .data(frame["data"].to_string());
            (Ok(event), rx)
        })
    }))
}
