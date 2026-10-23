//! Per-instance fan-out from Redis to connected store streams.
use futures_util::StreamExt;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{broadcast, watch},
    task::JoinHandle,
};
use uuid::Uuid;

use super::{Backoff, parse_event_id, stopped};

#[derive(Debug)]
pub struct HubMessage {
    pub id: i64,
    pub event_type: String,
    pub payload: String,
}

type StoreChannels = HashMap<Uuid, broadcast::Sender<Arc<HubMessage>>>;

struct Inner {
    channels: Mutex<StoreChannels>,
    shutdown: Mutex<watch::Receiver<bool>>,
    // Keep the default signal open when no background tasks are configured.
    _default_shutdown: watch::Sender<bool>,
    heartbeat: Duration,
}

#[derive(Clone)]
pub struct Hub(Arc<Inner>);

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        Self::with_heartbeat(Duration::from_secs(25))
    }

    pub fn with_heartbeat(heartbeat: Duration) -> Self {
        let (sender, receiver) = watch::channel(false);
        Self(Arc::new(Inner {
            channels: Mutex::new(HashMap::new()),
            shutdown: Mutex::new(receiver),
            _default_shutdown: sender,
            heartbeat,
        }))
    }

    pub(crate) fn heartbeat(&self) -> Duration {
        self.0.heartbeat
    }

    pub(crate) fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.0.shutdown.lock().expect("hub shutdown lock").clone()
    }

    pub(crate) fn set_shutdown(&self, shutdown: watch::Receiver<bool>) {
        *self.0.shutdown.lock().expect("hub shutdown lock") = shutdown;
    }

    pub(crate) fn subscribe(&self, store_id: Uuid) -> Subscription {
        let mut channels = self.0.channels.lock().expect("hub channels lock");
        let receiver = channels
            .entry(store_id)
            .or_insert_with(|| broadcast::channel(1024).0)
            .subscribe();
        Subscription {
            hub: self.clone(),
            store_id,
            receiver: Some(receiver),
        }
    }

    fn broadcast(&self, store_id: Uuid, message: HubMessage) {
        let mut channels = self.0.channels.lock().expect("hub channels lock");
        if let Some(channel) = channels.get(&store_id)
            && channel.send(Arc::new(message)).is_err()
        {
            channels.remove(&store_id);
        }
    }

    pub(crate) fn spawn_subscriber(
        &self,
        redis_url: String,
        mut shutdown: watch::Receiver<bool>,
    ) -> JoinHandle<()> {
        let hub = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                () = stopped(&mut shutdown) => {},
                () = hub.subscribe_redis(redis_url) => {},
            }
            tracing::info!("event hub subscriber stopped");
        })
    }

    async fn subscribe_redis(&self, redis_url: String) {
        let mut backoff = Backoff::default();
        loop {
            let connect = async {
                let client = redis::Client::open(redis_url.as_str())?;
                let mut connection = client.get_async_pubsub().await?;
                connection.psubscribe("store:*:events").await?;
                Ok::<_, redis::RedisError>(connection)
            };
            match tokio::time::timeout(Duration::from_secs(5), connect).await {
                Ok(Ok(mut connection)) => {
                    tracing::info!("event hub subscribed to store channels");
                    let mut messages = connection.on_message();
                    while let Some(message) = messages.next().await {
                        backoff.reset();
                        if let Some((store, event)) = decode_message(&message) {
                            self.broadcast(store, event);
                        } else {
                            tracing::warn!("event hub ignored malformed store message");
                        }
                    }
                    tracing::warn!("event hub Redis stream ended; reconnecting");
                }
                _ => tracing::warn!("event hub Redis subscription failed; retrying"),
            }
            backoff.sleep().await;
        }
    }
}

fn decode_message(message: &redis::Msg) -> Option<(Uuid, HubMessage)> {
    let store_id = message
        .get_channel_name()
        .strip_prefix("store:")?
        .strip_suffix(":events")?
        .parse()
        .ok()?;
    let payload: String = message.get_payload().ok()?;
    let envelope: Value = serde_json::from_str(&payload).ok()?;
    let id = parse_event_id(envelope.get("id")?.as_str()?)?;
    let event_type = envelope.get("type")?.as_str()?.to_owned();
    if event_type.contains(['\r', '\n']) {
        return None;
    }
    Some((
        store_id,
        HubMessage {
            id,
            event_type,
            payload: envelope.to_string(),
        },
    ))
}

pub(crate) struct Subscription {
    hub: Hub,
    store_id: Uuid,
    receiver: Option<broadcast::Receiver<Arc<HubMessage>>>,
}

impl Subscription {
    pub(crate) async fn recv(&mut self) -> Result<Arc<HubMessage>, broadcast::error::RecvError> {
        self.receiver
            .as_mut()
            .expect("active subscription")
            .recv()
            .await
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut channels = self.hub.0.channels.lock().expect("hub channels lock");
        self.receiver.take();
        if let Some(channel) = channels.get(&self.store_id)
            && channel.receiver_count() == 0
        {
            channels.remove(&self.store_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: i64) -> HubMessage {
        HubMessage {
            id,
            event_type: "store.changed".into(),
            payload: "{}".into(),
        }
    }

    #[tokio::test]
    async fn subscriptions_fan_out_only_within_a_store_and_release_channels() {
        let hub = Hub::new();
        let store = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut first = hub.subscribe(store);
        let mut second = hub.subscribe(store);
        let mut isolated = hub.subscribe(other);
        hub.broadcast(store, message(1));
        assert_eq!(first.recv().await.unwrap().id, 1);
        assert_eq!(second.recv().await.unwrap().id, 1);
        assert!(matches!(
            isolated.receiver.as_mut().unwrap().try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        drop(first);
        assert_eq!(hub.0.channels.lock().unwrap().len(), 2);
        drop(second);
        assert!(!hub.0.channels.lock().unwrap().contains_key(&store));
        drop(isolated);
        assert!(hub.0.channels.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn slow_receivers_report_lag_for_reconnection() {
        let hub = Hub::new();
        let store = Uuid::new_v4();
        let mut subscription = hub.subscribe(store);
        for id in 1..=1025 {
            hub.broadcast(store, message(id));
        }
        assert!(matches!(
            subscription.recv().await,
            Err(broadcast::error::RecvError::Lagged(1))
        ));
    }
}
