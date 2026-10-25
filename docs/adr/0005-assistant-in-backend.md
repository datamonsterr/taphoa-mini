# ADR 0005: Assistant agent loop runs in the backend with confirm-before-write

Status: Accepted · Date: 2026-10-25

## Context

The owner wants an in-app assistant that reads and analyzes store data, suggests what to
restock and what to do next, and helps with daily work. The model must be a free OpenRouter
model with tool calling for now. Free models share one account-wide quota (1,000 requests per
day) and their quality varies.

## Decision

- The agent loop runs in a new Rust `assistant` module. It calls OpenRouter chat completions
  with tool calling, executes assistant tools in-process through the existing service layer
  with the caller's `Actor`, persists threads and messages in Postgres, and streams replies to
  the app over SSE. The OpenRouter key never leaves the server.
- Tools are read tools or propose tools. A propose tool only stores a proposed action; the
  write runs when the member taps Confirm, through the normal handler path, permission check
  and idempotency key. The assistant never writes on its own.
- The model is configured as an ordered list of free tool-capable models (`ASSISTANT_MODELS`).
  The golden set picks the default. Per-store daily message caps protect the shared quota.
- Next-step chips are rule-based and never call the model, so the camera screen has no LLM
  latency or quota cost.

## Considered options

- Agent loop in the mobile app: rejected; it exposes the key, duplicates permission logic and
  splits traces between device and server.
- Autonomous writes: rejected; free models make mistakes and money and stock records must stay
  trustworthy.
