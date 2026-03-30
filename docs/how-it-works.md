# How It Works

## Startup Flow

Every run of `ccodex` goes through this sequence:

```
ccodex
  │
  ├─ 1. Check / install Claude Code CLI (npm)
  ├─ 2. Check / install CLIProxyAPI (Homebrew / binary)
  ├─ 3. Configure shell aliases (ccodex, co, claude-openai) — once
  ├─ 4. Start CLIProxyAPI on 127.0.0.1:8317 (skip if already running)
  │
  ├─ 5. Auth check
  │     ├─ Already configured → skip to step 6
  │     └─ Not configured →
  │           ├─ Launch OAuth login (-no-browser flag)
  │           ├─ Show URL + "Browser didn't open? (c to copy)"
  │           ├─ Wait for browser callback
  │           ├─ Credentials written to ~/.cli-proxy-api/codex-*.json
  │           └─ Restart proxy to load new credentials
  │
  └─ 6. Spawn Claude Code with ANTHROPIC_BASE_URL=http://127.0.0.1:8317
```

## Component Overview

```
┌─────────────┐
│   ccodex    │  TypeScript CLI — orchestrates setup and spawns Claude
└──────┬──────┘
       │  ANTHROPIC_BASE_URL=http://127.0.0.1:8317
       ▼
┌─────────────┐
│ CLIProxyAPI │  Local proxy — translates Anthropic API calls to OpenAI
│   :8317     │  Credentials: ~/.cli-proxy-api/codex-*.json
└──────┬──────┘
       │  OpenAI API (GPT-5.3-Codex)
       ▼
┌─────────────┐
│ Claude Code │  Anthropic's claude CLI — unmodified
│    CLI      │
└─────────────┘
```

## OAuth Login Flow

`ccodex` passes `-no-browser` to CLIProxyAPI and intercepts the OAuth URL from stdout.
It shows the URL with a copy-to-clipboard prompt instead of dumping raw proxy output.

When login completes (browser callback received):
1. Credentials are written to `~/.cli-proxy-api/codex-<email>-<org>.json`
2. The running proxy is killed and restarted so it picks up the new credentials
3. `ccodex` polls until the proxy is ready, then launches Claude Code

Supports standard OpenAI accounts and Okta-secured org accounts (e.g. company SSO).

## Proxy Compatibility Check

On every startup, if the proxy is already running, `ccodex` sends a test request with
`Authorization: Bearer sk-dummy`. It parses the JSON error response to distinguish:

- **Proxy rejects our key** (`invalid_api_key` / `missing_api_key`) → stale proxy, restart it
- **Upstream 401** (wrong OpenAI credentials) → proxy is fine, pass through
- **200 OK** → proxy is authenticated and ready

## Model Mapping

Claude Code selects models by tier. CLIProxyAPI maps them to GPT-5.3-Codex variants:

| Claude Tier | GPT Model               |
|-------------|-------------------------|
| Opus        | `gpt-5.3-codex(xhigh)`  |
| Sonnet      | `gpt-5.3-codex(high)`   |
| Default     | `gpt-5.3-codex(medium)` |
| Haiku       | `gpt-5.3-codex(low)`    |
