# ccodex

Run [Claude Code](https://claude.ai/code) with OpenAI GPT-5.3 Codex models — zero manual setup.

## Quick Start

```bash
npx -y @tuannvm/ccodex
```

That's it. On first run, `ccodex` installs everything it needs, walks you through login,
and drops you straight into Claude Code.

## How It Works

```
  You
   │
   │  npx -y @tuannvm/ccodex  (or: ccodex / co)
   ▼
┌──────────────────────────────────────┐
│              ccodex                  │
│                                      │
│  ✓ installs Claude Code CLI          │
│  ✓ installs CLIProxyAPI              │
│  ✓ sets up shell aliases             │
│  ✓ starts local proxy (:8317)        │
│  ✓ handles OAuth login               │
└──────────────────┬───────────────────┘
                   │
                   ▼
        ┌─────────────────┐
        │   CLIProxyAPI   │  translates Claude → GPT-5.3 Codex
        │   :8317 (local) │
        └────────┬────────┘
                 │
                 ▼
        ┌─────────────────┐
        │   Claude Code   │  unchanged — all your normal workflows
        └─────────────────┘
```

## Usage

```bash
# First run — full setup + launch
npx -y @tuannvm/ccodex

# After setup — use any alias
ccodex
co
claude-openai

# Re-authenticate
ccodex --login

# Check status
ccodex --status
```

## Login

When signing in for the first time, `ccodex` opens the OAuth URL and shows:

```
Browser didn't open? Use the url below to sign in (c to copy)
  https://auth.openai.com/oauth/authorize?...
```

Press **`c`** to copy the URL. Works with standard OpenAI accounts and company SSO (Okta).

## Requirements

- Node.js >= 18
- macOS or Linux (Windows: partial support)
- Homebrew (macOS, for CLIProxyAPI)

## Docs

- [How it works](docs/how-it-works.md) — startup flow, proxy, model mapping
- [Troubleshooting](docs/troubleshooting.md) — logs, common errors, auth reset
- [Security](docs/security.md) — binary verification, credential handling

## License

MIT
