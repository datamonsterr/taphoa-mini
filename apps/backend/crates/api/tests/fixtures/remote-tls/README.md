Test-only self-signed localhost certificate and public test key for delayed TLS
accept regression coverage. No generation runs during tests. The certificate has
DNS localhost and IP 127.0.0.1 SANs and is valid through 2126. Never use this key
outside tests.
