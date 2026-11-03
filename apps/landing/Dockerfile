# syntax=docker/dockerfile:1
# Build from repository root: docker build -f apps/landing/Dockerfile -t landing .
# The landing page has no dependencies, so the build stage needs only the Node runtime.
FROM node:24.22.2-alpine3.24 AS build
WORKDIR /site
COPY apps/landing/ .
RUN node scripts/build.mjs

FROM caddy:2.11.7-alpine
COPY --from=build /site/dist /srv
COPY apps/landing/Caddyfile /etc/caddy/Caddyfile
