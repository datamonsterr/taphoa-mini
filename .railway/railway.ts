import {
  bucket,
  defineRailway,
  image,
  postgres,
  preserve,
  project,
  redis,
  service,
  volume,
} from 'railway/iac';

export default defineRailway((ctx) => {
  const Redis = redis('Redis', { region: 'sin' });
  Redis.deploy = {
    startCommand:
      '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
  };
  Redis.networking = { privateNetworkEndpoint: 'redis' };
  const redisVolume = volume('redis-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'sin',
    sizeMB: 5000,
  });

  // Postgres runs the pgvector image so migrations can enable the `vector` extension.
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    region: 'sin',
    sizeMB: 5000,
  });
  const Postgres = service('Postgres', {
    source: image('pgvector/pgvector:0.8.7-pg18-trixie'),
    replicas: { sin: 1 },
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
    replicas: { sin: 1 },
    healthcheck: '/healthz',
    healthcheckTimeout: 300,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5 },
    env: {
      DATABASE_URL: Postgres.env.DATABASE_URL,
      REDIS_URL: Redis.env.REDIS_URL,
      JWT_SECRET: preserve(),
      RUST_LOG: 'info',
      LOG_FORMAT: 'json',
      // Four decoder sessions measured fastest on 8 vCPU (docs/specs/recognition-latency.md).
      SAM_DECODERS: '4',
      // OCR paths are inherited from the Dockerfile; cap intra-op workers.
      OCR_THREADS: '4',
      // Telemetry credentials and routing are managed in Railway in both environments.
      POSTHOG_PROJECT_TOKEN: preserve(),
      POSTHOG_HOST: preserve(),
      OTEL_EXPORTER_OTLP_ENDPOINT: preserve(),
      OTEL_EXPORTER_OTLP_HEADERS: preserve(),
      OPENROUTER_API_KEY: preserve(),
      DECISIONS_MODEL: 'inception/mercury-decide:free',
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
  // Production runs in Singapore (sin), close to shops in Vietnam; the image bucket sits in the
  // same region so original-photo uploads stay off the scan's critical path. IaC has no
  // per-environment buckets, so the `test` environment keeps its own `images-sjc` bucket outside
  // this file; plan `test` with care.
  const images = bucket('images-sin', { region: 'sin' });

  const resources = [
    Redis,
    Postgres,
    backend,
    redisVolume,
    postgresVolume,
    images,
  ];

  // One shared telemetry stack: test exports through the production collector's public domain.
  if (ctx.isEnvironment('production')) {
    const langfusePostgres = postgres('langfuse-postgres', { region: 'sfo' });
    langfusePostgres.deploy = {
      ...langfusePostgres.deploy,
      requiredMountPath: '/var/lib/postgresql/data',
    };
    langfusePostgres.networking = { privateNetworkEndpoint: 'postgres-4xnr' };
    langfusePostgres.variables = {
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
    };
    const langfuseRedis = redis('langfuse-redis', { region: 'sfo' });
    langfuseRedis.image = 'redis:8.2';
    langfuseRedis.source = image('redis:8.2');
    langfuseRedis.defaultMountPath = '/data';
    langfuseRedis.deploy = {
      ...langfuseRedis.deploy,
      startCommand:
        '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
    };
    langfuseRedis.variables = {
      REDISHOST: preserve(),
      REDISPASSWORD: preserve(),
      REDISPORT: preserve(),
      REDISUSER: preserve(),
      REDIS_PASSWORD: preserve(),
      REDIS_URL: preserve(),
    };
    const langfusePostgresVolume = volume('postgres-volume-wZbV', {
      alerts: { usage: { '100': {}, '80': {}, '95': {} } },
      allowOnlineResize: true,
      region: 'sfo',
      sizeMB: 5000,
    });
    const langfuseRedisVolume = volume('redis-volume-53l7', {
      alerts: { usage: { '100': {}, '80': {}, '95': {} } },
      allowOnlineResize: true,
      region: 'sfo',
      sizeMB: 5000,
    });
    const clickhouseVolume = volume('langfuse-clickhouse-volume', {
      alerts: { usage: { '100': {}, '80': {}, '95': {} } },
      allowOnlineResize: true,
      region: 'sfo',
      sizeMB: 5000,
    });

    const clickhouse = service('langfuse-clickhouse', {
      source: image('clickhouse/clickhouse-server:26.4.5'),
      replicas: { sfo: 1 },
      volumeMounts: { '/var/lib/clickhouse': clickhouseVolume },
      env: {
        CLICKHOUSE_DB: preserve(),
        CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: preserve(),
        CLICKHOUSE_PASSWORD: preserve(),
        CLICKHOUSE_USER: preserve(),
      },
    });

    // Generated public domains (web: 3000, collector: 4318) stay managed in Railway.
    const langfuseWeb = service('langfuse-web', {
      source: image('langfuse/langfuse:4.70.0'),
      replicas: { sfo: 1 },
      env: {
        AUTH_DISABLE_SIGNUP: preserve(),
        CLICKHOUSE_CLUSTER_ENABLED: preserve(),
        CLICKHOUSE_MIGRATION_URL: preserve(),
        CLICKHOUSE_PASSWORD: preserve(),
        CLICKHOUSE_URL: preserve(),
        CLICKHOUSE_USER: preserve(),
        DATABASE_URL: preserve(),
        ENCRYPTION_KEY: preserve(),
        HOSTNAME: preserve(),
        LANGFUSE_INIT_ORG_ID: preserve(),
        LANGFUSE_INIT_ORG_NAME: preserve(),
        LANGFUSE_INIT_PROJECT_ID: preserve(),
        LANGFUSE_INIT_PROJECT_NAME: preserve(),
        LANGFUSE_INIT_PROJECT_PUBLIC_KEY: preserve(),
        LANGFUSE_INIT_PROJECT_SECRET_KEY: preserve(),
        LANGFUSE_INIT_USER_EMAIL: preserve(),
        LANGFUSE_INIT_USER_NAME: preserve(),
        LANGFUSE_INIT_USER_PASSWORD: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_BUCKET: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_ENABLED: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_ENDPOINT: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_FORCE_PATH_STYLE: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_PREFIX: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_REGION: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_BUCKET: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_PREFIX: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_REGION: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_PREFIX: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_REGION: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: preserve(),
        NEXTAUTH_SECRET: preserve(),
        NEXTAUTH_URL: preserve(),
        PORT: preserve(),
        REDIS_CONNECTION_STRING: preserve(),
        SALT: preserve(),
        TELEMETRY_ENABLED: preserve(),
      },
    });
    const langfuseWorker = service('langfuse-worker', {
      source: image('langfuse/langfuse-worker:4.70.0'),
      replicas: { sfo: 1 },
      env: {
        CLICKHOUSE_CLUSTER_ENABLED: preserve(),
        CLICKHOUSE_MIGRATION_URL: preserve(),
        CLICKHOUSE_PASSWORD: preserve(),
        CLICKHOUSE_URL: preserve(),
        CLICKHOUSE_USER: preserve(),
        DATABASE_URL: preserve(),
        ENCRYPTION_KEY: preserve(),
        HOSTNAME: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_BUCKET: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_ENABLED: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_ENDPOINT: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_FORCE_PATH_STYLE: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_PREFIX: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_REGION: preserve(),
        LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_BUCKET: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_PREFIX: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_REGION: preserve(),
        LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_PREFIX: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_REGION: preserve(),
        LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: preserve(),
        NEXTAUTH_SECRET: preserve(),
        NEXTAUTH_URL: preserve(),
        PORT: preserve(),
        REDIS_CONNECTION_STRING: preserve(),
        SALT: preserve(),
        TELEMETRY_ENABLED: preserve(),
      },
    });
    const collector = service('otel-collector', {
      build: {
        builder: 'DOCKERFILE',
        dockerfilePath: 'infra/otel-collector/Dockerfile',
        watchPatterns: ['infra/otel-collector/**'],
      },
      replicas: { sfo: 1 },
      // Railway's default restart policy is on failure; retain the pulled unset type.
      deploy: { restartPolicyMaxRetries: 5 },
      env: {
        COLLECTOR_BEARER_TOKEN: preserve(),
        LANGFUSE_OTLP_ENDPOINT: preserve(),
        LANGFUSE_PUBLIC_KEY: preserve(),
        LANGFUSE_SECRET_KEY: preserve(),
        POSTHOG_HOST: preserve(),
        POSTHOG_PROJECT_TOKEN: preserve(),
      },
    });
    resources.push(
      langfusePostgres,
      langfuseRedis,
      langfusePostgresVolume,
      langfuseRedisVolume,
      clickhouseVolume,
      clickhouse,
      langfuseWeb,
      langfuseWorker,
      collector,
      bucket('langfuse', { region: 'sin' }),
    );
  }

  return project('taphoa-mini', {
    variables: { managed: true },
    resources,
  });
});
