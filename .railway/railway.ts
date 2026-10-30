import {
  bucket,
  defineRailway,
  github,
  image,
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
    // Live volumes are in San Francisco (sfo) in both environments. Declaring another region
    // would plan a volume move; keep this equal to `railway config pull`.
    region: 'sfo',
    sizeMB: 5000,
  });

  // Postgres runs the pgvector image so migrations can enable the `vector` extension.
  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '100': {}, '80': {}, '95': {} } },
    allowOnlineResize: true,
    // Live volumes are in San Francisco (sfo) in both environments. Declaring another region
    // would plan a volume move; keep this equal to `railway config pull`.
    region: 'sfo',
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
    // Railway's default restart policy is on failure; live leaves the type unset, so only the
    // retry cap is declared (declaring `ON_FAILURE` plans a no-op change).
    deploy: { restartPolicyMaxRetries: 5 },
    // Only production deploys from GitHub; `test` deploys with `railway up` and has no source.
    // Declaring it keeps a full plan from clearing the repo link.
    ...(ctx.isEnvironment('production')
      ? {
          source: github('datamonsterr/taphoa-mini', {
            branch: 'main',
            checkSuites: true,
          }),
        }
      : {}),
    env: {
      DATABASE_URL: Postgres.env.DATABASE_URL,
      REDIS_URL: Redis.env.REDIS_URL,
      // Clerk identity (docs/specs/assistant/auth-clerk.md). The backend derives the issuer and
      // JWKS from the publishable key and uses the secret key for profile reads. Both are set once
      // per environment with the CLI, never committed (docs/deploy.md).
      CLERK_PUBLISHABLE_KEY: preserve(),
      CLERK_SECRET_KEY: preserve(),
      // The backend no longer reads it; remove after the Clerk release is live (X1).
      JWT_SECRET: preserve(),
      RUST_LOG: 'info',
      LOG_FORMAT: 'json',
      // Four decoder sessions measured fastest on 8 vCPU (docs/specs/recognition-latency.md).
      // Production sets it; `test` leaves it unset (the recognizer's automatic default).
      SAM_DECODERS: preserve(),
      // OCR paths are inherited from the Dockerfile; the backend defaults intra-op workers to 4.
      OCR_THREADS: preserve(),
      // Telemetry credentials and routing are managed in Railway in both environments.
      POSTHOG_PROJECT_TOKEN: preserve(),
      POSTHOG_HOST: preserve(),
      OTEL_EXPORTER_OTLP_ENDPOINT: preserve(),
      OTEL_EXPORTER_OTLP_HEADERS: preserve(),
      // Set by the deploy workflow to the deployed git SHA.
      SERVICE_VERSION: preserve(),
      OPENROUTER_API_KEY: preserve(),
      EXPO_ACCESS_TOKEN: preserve(),
      DECISIONS_MODEL: 'inception/mercury-decide',
      // Railway always uses real models; never deploy the scripted provider.
      ASSISTANT_MODEL_PROVIDER: 'openrouter',
      // Per-environment free-model order, updated by X7 comparisons.
      ASSISTANT_MODELS: preserve(),
      // Per-environment store message cap.
      ASSISTANT_DAILY_MESSAGES_PER_STORE: preserve(),
      DIGEST_MODEL_MAX_PER_DAY: preserve(),
      DIGEST_SEND_AT: preserve(),
      // Enable with 1 on test only; never on production.
      ASSISTANT_ALLOW_EVAL_HEADERS: preserve(),
      // Keep reasoning latency low for interactive replies.
      ASSISTANT_REASONING_EFFORT: 'low',
      // Per-environment PostHog feedback survey.
      ASSISTANT_FEEDBACK_SURVEY_ID: preserve(),
      // Per-environment survey rating question.
      ASSISTANT_FEEDBACK_QUESTION_ID: preserve(),
      // Optional per-environment survey comment question.
      ASSISTANT_FEEDBACK_COMMENT_QUESTION_ID: preserve(),
      // Unset means openrouter; the backend refuses `scripted` unless VOICE_ALLOW_SCRIPTED=1.
      VOICE_MODEL_PROVIDER: preserve(),
      // Per-environment audio-native model order (default google/gemini-3.1-flash-lite,google/gemini-2.5-flash-lite).
      VOICE_MODELS: preserve(),
      // Text-only parse models used after the STT fallback.
      VOICE_PARSE_MODELS: preserve(),
      VOICE_STT_MODEL: preserve(),
      // Per-environment store utterance cap (default 300); lower it on test to exercise voice_quota.
      VOICE_DAILY_UTTERANCES_PER_STORE: preserve(),
      VOICE_REQUIRE_ZDR: preserve(),
      // Per-call and whole-utterance timeouts in ms (defaults 6000 and 8000).
      VOICE_MODEL_TIMEOUT_MS: preserve(),
      VOICE_TOTAL_TIMEOUT_MS: preserve(),
      // Enable with 1 on test only (pins the model for evals); never on production.
      VOICE_ALLOW_EVAL_HEADERS: preserve(),
      // Bucket credentials are not referencable from IaC; set once with
      // `railway bucket credentials` + `railway variable set` (docs/deploy.md).
      AWS_ENDPOINT_URL: preserve(),
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      AWS_S3_BUCKET_NAME: preserve(),
      AWS_DEFAULT_REGION: preserve(),
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

  // Private S3-compatible buckets for product and checkout photos (ADR 0002). Railway deletes any
  // bucket the file does not declare, so every live bucket is declared per environment, matching
  // `railway config pull`. Never remove one here without migrating its objects first.
  //   production: `images-prod` (sjc, the live image store) and `images-sin` (sin).
  //   test:       `images` (sin) and `images-sjc` (sjc).
  // Which bucket the backend uses is set by AWS_S3_BUCKET_NAME (preserved above).
  const buckets = ctx.isEnvironment('production')
    ? [
        bucket('images-prod', { region: 'sjc' }),
        bucket('images-sin', { region: 'sin' }),
      ]
    : [
        bucket('images', { region: 'sin' }),
        bucket('images-sjc', { region: 'sjc' }),
      ];

  const resources = [
    Redis,
    Postgres,
    backend,
    redisVolume,
    postgresVolume,
    ...buckets,
  ];

  // One shared telemetry collector: test exports through the production collector's public domain.
  if (ctx.isEnvironment('production')) {
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
        POSTHOG_HOST: preserve(),
        POSTHOG_PROJECT_TOKEN: preserve(),
      },
    });
    resources.push(collector);
  }

  return project('taphoa-mini', {
    variables: { managed: true },
    resources,
  });
});
