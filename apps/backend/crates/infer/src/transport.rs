//! Limits apply before HTTP parsing/authentication. HTTP/1 is sufficient for the
//! single backend client; HTTP/2 multiplexing cannot bypass connection admission.
use axum::Router;
use hyper::rt::{Sleep, Timer};
use hyper::server::conn::http1;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpListener,
    sync::{Semaphore, watch},
    task::JoinSet,
};

#[derive(Clone, Copy)]
pub struct Limits {
    pub connections: usize,
    /// Deadline from the first byte of a request head; never reset by a trickle.
    pub header_timeout: Duration,
    pub idle_timeout: Duration,
    pub header_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: 32,
            header_timeout: Duration::from_secs(3),
            idle_timeout: Duration::from_secs(120),
            header_bytes: 8192,
        }
    }
}

impl Limits {
    pub fn from_env() -> anyhow::Result<Self> {
        let mut limits = Self::default();
        if let Ok(value) = std::env::var("INFERENCE_IDLE_KEEPALIVE_SECS") {
            let seconds: u64 = value.parse().map_err(|_| {
                anyhow::anyhow!("INFERENCE_IDLE_KEEPALIVE_SECS must be a positive integer")
            })?;
            anyhow::ensure!(
                seconds > 0,
                "INFERENCE_IDLE_KEEPALIVE_SECS must be positive"
            );
            limits.idle_timeout = Duration::from_secs(seconds);
        }
        Ok(limits)
    }
}

// Hyper starts its head timer before waiting for an idle keep-alive peer. A
// per-connection timer lets that wait use the idle limit, then shortens it once
// the transport delivers the first head bytes. Hyper still owns parsing and
// drops the timer as soon as the complete head is parsed. The API's reqwest
// client does not pipeline. A partial pipelined head already buffered inside
// Hyper cannot be observed here and retains the idle deadline.
#[derive(Default)]
struct HeadClock {
    first_byte: Option<Instant>,
    first_head: bool,
}
#[derive(Clone)]
struct HeadTimer {
    clock: Arc<Mutex<HeadClock>>,
    limits: Limits,
}
struct HeadSleep {
    clock: Arc<Mutex<HeadClock>>,
    deadline: Instant,
    header_timeout: Duration,
    sleep: Pin<Box<tokio::time::Sleep>>,
}
impl Future for HeadSleep {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let first_byte = self.clock.lock().unwrap().first_byte;
        let deadline = first_byte.map_or(self.deadline, |started| started + self.header_timeout);
        self.sleep.as_mut().reset(deadline.into());
        self.sleep.as_mut().poll(cx)
    }
}
impl Sleep for HeadSleep {}
impl Timer for HeadTimer {
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Sleep>> {
        self.sleep_until(Instant::now() + duration)
    }
    fn sleep_until(&self, _deadline: Instant) -> Pin<Box<dyn Sleep>> {
        let mut clock = self.clock.lock().unwrap();
        let timeout = if clock.first_head {
            self.limits.header_timeout
        } else {
            self.limits.idle_timeout
        };
        clock.first_head = false;
        clock.first_byte = None;
        let deadline = Instant::now() + timeout;
        Box::pin(HeadSleep {
            clock: self.clock.clone(),
            deadline,
            header_timeout: self.limits.header_timeout,
            sleep: Box::pin(tokio::time::sleep_until(deadline.into())),
        })
    }
}
struct HeadIo<T> {
    inner: T,
    clock: Arc<Mutex<HeadClock>>,
}
impl<T: AsyncRead + Unpin> AsyncRead for HeadIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.clock
                .lock()
                .unwrap()
                .first_byte
                .get_or_insert_with(Instant::now);
        }
        result
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for HeadIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
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
                    let clock = Arc::new(Mutex::new(HeadClock { first_head: true, ..HeadClock::default() }));
                    let io = TokioIo::new(HeadIo { inner: stream, clock: clock.clone() });
                    let mut builder = http1::Builder::new();
                    builder.timer(HeadTimer { clock, limits })
                        .header_read_timeout(limits.header_timeout)
                        .max_header_size(limits.header_bytes)
                        .max_headers(32)
                        .max_buf_size(16 * 1024)
                        .keep_alive(true);
                    let connection = builder.serve_connection(io, service);
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
        start_with_limits(Limits {
            connections: cap,
            header_timeout: timeout,
            ..Limits::default()
        })
        .await
    }
    async fn start_with_limits(
        limits: Limits,
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
                limits,
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
    async fn health(stream: &mut TcpStream) {
        stream
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        // Consume the complete response before waiting, so old response bytes
        // cannot masquerade as a successful second request.
        let mut response = Vec::new();
        loop {
            let mut byte = [0];
            stream.read_exact(&mut byte).await.unwrap();
            response.push(byte[0]);
            if response.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        assert!(response.starts_with(b"HTTP/1.1 200"));
        let headers = String::from_utf8(response).unwrap();
        let length: usize = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length: "))
            .unwrap()
            .parse()
            .unwrap();
        stream.read_exact(&mut vec![0; length]).await.unwrap();
    }
    #[tokio::test]
    async fn idle_keep_alive_survives_five_seconds_then_partial_head_expires() {
        let (addr, stop, task) = start(3, Duration::from_millis(150)).await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        health(&mut stream).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        health(&mut stream).await;
        stream
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: slow")
            .await
            .unwrap();
        assert!(!closed(stream).await.starts_with(b"HTTP/1.1 200"));
        let _ = stop.send(());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn configured_idle_keep_alive_expires() {
        let (addr, stop, task) = start_with_limits(Limits {
            idle_timeout: Duration::from_millis(150),
            header_timeout: Duration::from_millis(50),
            ..Limits::default()
        })
        .await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        health(&mut stream).await;
        let _ = closed(stream).await;
        let _ = stop.send(());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn partial_head_trickle_does_not_extend_header_deadline() {
        let (addr, stop, task) = start(3, Duration::from_millis(400)).await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        health(&mut stream).await;
        stream
            .write_all(b"GET /healthz HTTP/1.1\r\nHost: ")
            .await
            .unwrap();
        let started = Instant::now();
        tokio::time::sleep(Duration::from_millis(300)).await;
        stream.write_all(b"slow").await.unwrap();
        let _ = closed(stream).await;
        assert!(started.elapsed() < Duration::from_millis(600));
        let _ = stop.send(());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn oversized_headers_are_closed() {
        let (addr, stop, task) = start(3, Duration::from_millis(100)).await;
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
