import {
  bucket,
  defineRailway,
  image,
  preserve,
  project,
  redis,
  service,
  volume,
} from 'railway/iac';

export default defineRailway(() => {
  const Redis = redis('Redis', { region: 'sfo' });
  Redis.deploy = {
    startCommand:
      '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
  };
  Redis.networking = { privateNetworkEndpoint: 'redis' };
  const redisVolume = volume('redis-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'sfo',
    sizeMB: 5000,
  });

  // Postgres runs the pgvector image so migrations can enable the `vector` extension.
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'sfo',
    sizeMB: 5000,
  });
  const Postgres = service('Postgres', {
    source: image('pgvector/pgvector:0.8.7-pg18-trixie'),
    replicas: { sfo: 1 },
    deploy: { requiredMountPath: '/var/lib/postgresql/data' },
    networking: { privateNetworkEndpoint: 'postgres' },
    volumeMounts: { '/var/lib/postgresql/data': postgresVolume },
    env: {
      DATABASE_URL: preserve(),
      PGDATA: preserve(),
      PGDATABASE: preserve(),
      PGHOST: preserve(),
      PGPASSWORD: preserve(),
      PGPORT: preserve(),
      PGUSER: preserve(),
      POSTGRES_DB: preserve(),
      POSTGRES_PASSWORD: preserve(),
      POSTGRES_USER: preserve(),
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: preserve(),
      SSL_CERT_DAYS: preserve(),
    },
  });

  // Deployed with `railway up --service backend` from the repository root (see docs/deploy.md).
  const backend = service('backend', {
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'apps/backend/Dockerfile',
      watchPatterns: ['apps/backend/**', 'rust-toolchain.toml'],
    },
    replicas: { sfo: 1 },
    healthcheck: '/healthz',
    healthcheckTimeout: 300,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5 },
    env: {
      DATABASE_URL: Postgres.env.DATABASE_URL,
      REDIS_URL: Redis.env.REDIS_URL,
      JWT_SECRET: preserve(),
      RUST_LOG: 'info',
      LOG_FORMAT: 'json',
      // Bucket credentials are not referencable from IaC; set once with
      // `railway bucket credentials` + `railway variable set` (docs/deploy.md).
      AWS_ENDPOINT_URL: preserve(),
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      AWS_S3_BUCKET_NAME: preserve(),
      AWS_DEFAULT_REGION: preserve(),
      // Secret per environment: generated once in the terminal, never committed (docs/deploy.md).
      JWT_SECRET: preserve(),
      S3_FORCE_PATH_STYLE: 'false',
      // Behind Railway's proxy the client address comes from X-Real-IP.
      CLIENT_IP_SOURCE: 'x-real-ip',
      // Set only on the test environment (high limits for e2e); preserved, never managed here.
      RATE_LIMIT_STORE_CREATE_PER_HOUR: preserve(),
      RATE_LIMIT_JOIN_PER_HOUR: preserve(),
      RATE_LIMIT_RECOVER_PER_10MIN: preserve(),
      S3_CREATE_BUCKET: 'false',
      IMAGE_URL_TTL_SECONDS: '900',
    },
  });

  // Private S3-compatible bucket for product and checkout photos (ADR 0002).
  const images = bucket('images', { region: 'sin' });

  return project('taphoa-mini', {
    variables: { managed: true },
    resources: [Redis, Postgres, backend, redisVolume, postgresVolume, images],
  });
});
