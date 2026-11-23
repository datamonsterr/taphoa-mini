//! A counting TCP proxy in front of Postgres. Every client exchange the server has to
//! answer (a simple `Query`, or one extended-protocol batch ended by `Sync`) is one network
//! round trip, which is the unit that costs ~170 ms against a remote production database.
#![allow(dead_code)]
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

#[derive(Clone, Default)]
pub struct PgCounter {
    exchanges: Arc<Mutex<Vec<String>>>,
}

impl PgCounter {
    /// Starts a proxy to `upstream` (`postgres://user:pw@host:port/db`) and returns the
    /// counter plus connect options that go through it (TLS disabled).
    pub async fn start(upstream: &str) -> (Self, PgConnectOptions) {
        let options: PgConnectOptions = upstream.parse().expect("database url");
        let target = format!("{}:{}", options.get_host(), options.get_port());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let counter = Self::default();
        let log = counter.exchanges.clone();
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let Ok(server) = TcpStream::connect(&target).await else {
                    continue;
                };
                let (mut client_read, mut client_write) = client.into_split();
                let (mut server_read, mut server_write) = server.into_split();
                let log = log.clone();
                tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut server_read, &mut client_write).await;
                });
                tokio::spawn(async move {
                    let mut parser = Parser::new(log);
                    let mut buffer = vec![0u8; 64 * 1024];
                    while let Ok(n) = client_read.read(&mut buffer).await {
                        if n == 0 || server_write.write_all(&buffer[..n]).await.is_err() {
                            break;
                        }
                        parser.feed(&buffer[..n]);
                    }
                });
            }
        });
        let proxied = options
            .host("127.0.0.1")
            .port(port)
            .ssl_mode(PgSslMode::Disable);
        (counter, proxied)
    }

    pub fn reset(&self) {
        self.exchanges.lock().unwrap().clear();
    }

    /// One entry per exchange: the SQL text(s) it carried (`Parse`-only exchanges, which sqlx
    /// uses to describe a statement it has not cached on that connection yet, read `<describe>`).
    pub fn exchanges(&self) -> Vec<String> {
        self.exchanges.lock().unwrap().clone()
    }

    /// Exchanges that carry SQL, without sqlx connection pings.
    pub fn statements(&self) -> Vec<String> {
        self.exchanges()
            .into_iter()
            .filter(|sql| sql != "<ping>")
            .collect()
    }
}

/// Splits the frontend byte stream into messages and groups them into exchanges.
struct Parser {
    log: Arc<Mutex<Vec<String>>>,
    pending: Vec<u8>,
    started: bool,
    statements: HashMap<String, String>,
    current: Vec<String>,
    parsed_only: bool,
}

impl Parser {
    fn new(log: Arc<Mutex<Vec<String>>>) -> Self {
        Self {
            log,
            pending: Vec::new(),
            started: false,
            statements: HashMap::new(),
            current: Vec::new(),
            parsed_only: false,
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        loop {
            if !self.started {
                if self.pending.len() < 4 {
                    return;
                }
                let len = u32::from_be_bytes(self.pending[..4].try_into().unwrap()) as usize;
                if self.pending.len() < len {
                    return;
                }
                self.pending.drain(..len);
                self.started = true;
                continue;
            }
            if self.pending.len() < 5 {
                return;
            }
            let len = u32::from_be_bytes(self.pending[1..5].try_into().unwrap()) as usize;
            if self.pending.len() < 1 + len {
                return;
            }
            let tag = self.pending[0];
            let body: Vec<u8> = self.pending[5..1 + len].to_vec();
            self.pending.drain(..1 + len);
            self.message(tag, &body);
        }
    }

    fn message(&mut self, tag: u8, body: &[u8]) {
        let strings: Vec<String> = body
            .split(|b| *b == 0)
            .map(|part| String::from_utf8_lossy(part).into_owned())
            .collect();
        match tag {
            b'Q' => self.log.lock().unwrap().push(strings[0].clone()),
            b'P' => {
                self.statements.insert(
                    strings[0].clone(),
                    strings.get(1).cloned().unwrap_or_default(),
                );
                self.parsed_only = true;
            }
            b'B' => {
                self.parsed_only = false;
                let sql = self
                    .statements
                    .get(strings.get(1).map_or("", String::as_str))
                    .cloned()
                    .unwrap_or_default();
                self.current.push(sql);
            }
            b'S' => {
                let entry = if self.current.is_empty() && self.parsed_only {
                    "<describe>".to_owned()
                } else {
                    self.current.join(" ; ")
                };
                // A bare `Sync` is sqlx testing a connection (before acquire and after release).
                let entry = if entry.is_empty() {
                    "<ping>".to_owned()
                } else {
                    entry
                };
                self.current.clear();
                self.parsed_only = false;
                self.log.lock().unwrap().push(entry);
            }
            _ => {}
        }
    }
}
