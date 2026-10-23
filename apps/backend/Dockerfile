# syntax=docker/dockerfile:1
# Build from repository root: docker build -f apps/backend/Dockerfile .
FROM rust:1-slim-bookworm AS chef
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates g++ pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --locked
ENV CARGO_BUILD_JOBS=2
WORKDIR /app

FROM chef AS planner
COPY apps/backend/ .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# SQLx migration embedding also runs when chef builds the dependency skeleton.
COPY apps/backend/migrations/ migrations/
# Ordinary layers work on Railway without service-specific cache mount IDs.
RUN cargo chef cook --release --recipe-path recipe.json
COPY apps/backend/ .
# COPY keeps old mtimes, which cargo would treat as fresh against the dependency-skeleton build.
RUN find crates -name "*.rs" -exec touch {} + && cargo build --locked --release --bin taphoa-api && cp target/release/taphoa-api /taphoa-api

FROM chef AS assets
ARG SKIP_MODELS=0
ARG TARGETARCH
ENV ORT_INSTALL_DIR=/opt/onnxruntime MODEL_DIR=/opt/models
COPY apps/backend/scripts/ /scripts/
RUN /scripts/fetch-onnxruntime.sh && mkdir -p /opt/models \
    && if [ "$SKIP_MODELS" != "1" ]; then /scripts/fetch-models.sh; fi

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
WORKDIR /app
COPY --from=builder /taphoa-api /usr/local/bin/taphoa-api
COPY --from=assets /opt/onnxruntime/lib/ /opt/onnxruntime/lib/
COPY --from=assets /opt/onnxruntime/LICENSE /opt/onnxruntime/LICENSE
COPY --from=assets /opt/onnxruntime/ThirdPartyNotices.txt /opt/onnxruntime/ThirdPartyNotices.txt
COPY --from=assets --chown=app:app /opt/models/ /app/models/
ENV PORT=8080 LOG_FORMAT=json \
    ORT_DYLIB_PATH=/opt/onnxruntime/lib/libonnxruntime.so.1.23.2 \
    SAM_ENCODER_PATH=/app/models/mobile_sam_image_encoder.onnx \
    SAM_DECODER_PATH=/app/models/sam_mask_decoder_multi.onnx \
    DINO_MODEL_PATH=/app/models/dinov2_small.onnx
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
    CMD curl --fail --silent http://localhost:$PORT/healthz || exit 1
CMD ["taphoa-api"]
