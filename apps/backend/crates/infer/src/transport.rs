//! Limits apply before HTTP parsing/authentication. HTTP/1 is sufficient for the
//! single backend client; HTTP/2 multiplexing cannot bypass connection admission.
use axum::Router;
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, watch},
    task::JoinSet,
};

#[derive(Clone, Copy)]
pub struct Limits {
    pub connections: usize,
    /// Hyper 1.12 starts this on each read_head, including an idle keep-alive
    /// connection. Partial header bytes do not reset it.
    pub header_timeout: Duration,
    pub header_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: 32,
            header_timeout: Duration::from_secs(3),
            header_bytes: 8192,
        }
    }
}

pub async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
    limits: Limits,
) -> anyhow::Result<()> {
    anyhow::ensure!(limits.connections > 0, "connection limit must be positive");
    let slots = Arc::new(Semaphore::new(limits.connections));
    let (stop, _) = watch::channel(false);
    let mut connections = JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break,
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                if result.is_err() { tracing::error!("HTTP connection task panicked"); }
            }
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let Ok(permit) = slots.clone().try_acquire_owned() else {
                    // Do not create a task or wait for a slot on an excess socket.
                    drop(stream);
                    continue;
                };
                let service = TowerToHyperService::new(router.clone());
                let mut stopped = stop.subscribe();
                connections.spawn(async move {
                    let _permit = permit;
                    // APIs checked against hyper 1.12.0 / hyper-util 0.1.21 docs.
                    let mut builder = http1::Builder::new();
                    builder.timer(TokioTimer::new())
                        .header_read_timeout(limits.header_timeout)
                        .max_header_size(limits.header_bytes)
                        .max_headers(32)
                        .max_buf_size(16 * 1024)
                        .keep_alive(true);
                    let connection = builder.serve_connection(TokioIo::new(stream), service);
                    tokio::pin!(connection);
                    tokio::select! {
                        _ = &mut connection => {},
                        _ = stopped.changed() => {
                            connection.as_mut().graceful_shutdown();
                            let _ = connection.await;
                        }
                    }
                });
            }
        }
    }
    let _ = stop.send(true);
    // Bound draining even if an authenticated peer stops reading its response.
    if tokio::time::timeout(Duration::from_secs(15), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.shutdown().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
        sync::oneshot,
    };
    const TOKEN: &str = "transport-tests-use-a-32-character-token";
    async fn start(
        cap: usize,
        timeout: Duration,
    ) -> (
        std::net::SocketAddr,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        // Exercise the real authentication/body middleware with fake models.
        let service = crate::Service::new(crate::tests::fake(), TOKEN, "cpu").unwrap();
        let app = service.router();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            serve(
                listener,
                app,
                async {
                    let _ = stopped.await;
                },
                Limits {
                    connections: cap,
                    header_timeout: timeout,
                    header_bytes: 8192,
                },
            )
            .await
            .unwrap();
        });
        (addr, stop, task)
    }
    async fn closed(mut stream: TcpStream) -> Vec<u8> {
        let mut out = Vec::new();
        // A reset also means the refused connection was closed immediately.
        let _ = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut out))
            .await
            .expect("connection must close");
        out
    }
    async fn auth_request(addr: std::net::SocketAddr) -> Vec<u8> {
        let body = taphoa_recognition::wire::encode(&taphoa_recognition::wire::ImageRequest {
            image: crate::tests::photo(2, 2),
        })
        .unwrap();
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(format!("POST /v1/segment HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",taphoa_recognition::wire::CONTENT_TYPE,body.len()).as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
        closed(stream).await
    }
    #[tokio::test]
    async fn connection_cap_refuses_excess_without_serving_them() {
        let (addr, stop, task) = start(2, Duration::from_secs(2)).await;
        // Complete a health request on each socket, proving it was admitted;
        // leave both keep-alive connections open to hold the actual permits.
        let mut held = Vec::new();
        for _ in 0..2 {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream
                .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .await
                .unwrap();
            let mut bytes = vec![0; 1024];
            let n = stream.read(&mut bytes).await.unwrap();
            assert!(bytes[..n].starts_with(b"HTTP/1.1 200"));
            held.push(stream);
        }
        let mut excess = TcpStream::connect(addr).await.unwrap();
        let _ = excess
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await;
        let response = tokio::time::timeout(Duration::from_millis(500), closed(excess))
            .await
            .expect("excess is not queued");
        assert!(!response.starts_with(b"HTTP/1.1 200"));
        drop(held);
        let _ = stop.send(());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn incomplete_headers_expire_and_normal_auth_still_works() {
        let (addr, stop, task) = start(3, Duration::from_millis(150)).await;
        let silent = TcpStream::connect(addr).await.unwrap();
        let mut partial = TcpStream::connect(addr).await.unwrap();
        partial
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: slow")
            .await
            .unwrap();
        assert!(auth_request(addr).await.starts_with(b"HTTP/1.1 200"));
        assert!(!closed(silent).await.starts_with(b"HTTP/1.1 200"));
        assert!(!closed(partial).await.starts_with(b"HTTP/1.1 200"));
        let _ = stop.send(());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn idle_keep_alive_and_oversized_headers_are_closed() {
        let (addr, stop, task) = start(3, Duration::from_millis(100)).await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut bytes = [0; 1024];
        assert!(stream.read(&mut bytes).await.unwrap() > 0);
        let _ = closed(stream).await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET /healthz HTTP/1.1\r\nHost: localhost\r\nX-Large: {}\r\n\r\n",
                    "a".repeat(8192)
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        assert!(closed(stream).await.starts_with(b"HTTP/1.1 431"));
        let _ = stop.send(());
        task.await.unwrap();
    }
}
