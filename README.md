# @tuannvm/ccodex

TypeScript reimplementation of `ccodex` — run Claude Code CLI with OpenAI GPT models via CLIProxyAPI.

## Quick Start

```bash
npx -y @tuannvm/ccodex
```

That's it. `ccodex` will automatically:
1. Check/install Claude Code CLI (via npm)
2. Check/install CLIProxyAPI (via Homebrew)
3. Set up shell aliases (`ccodex`, `co`, `claude-openai`)
4. Configure shell integration
5. Start the proxy in background
6. Launch OAuth login if needed
7. Run Claude Code with GPT-5.3 Codex models

## Usage

```bash
# First run - sets everything up automatically
npx -y @tuannvm/ccodex

# After setup - use aliases
ccodex
co
claude-openai

# Check setup status
ccodex --status

# Launch OAuth login manually
ccodex --login
```

## How It Works

Every time you run `ccodex`, it:
1. Ensures all dependencies are installed
2. Starts the proxy if not running
3. Checks authentication, launches login if needed
4. Runs Claude Code with the proxy configuration

This makes it "just work" without manual setup steps.

### OAuth Login UX

When login is required, `ccodex` launches the OAuth flow and shows:

```
Browser didn't open? Use the url below to sign in (c to copy)
  https://auth.openai.com/oauth/authorize?...
```

Press **`c`** to copy the URL to your clipboard. After completing login in the browser, the proxy restarts automatically and Claude Code launches.

## Production Readiness (v0.4.10)

`ccodex` v0.4.10 is production-ready for:
- ✅ **macOS** (arm64, x64)
- ✅ **Linux** (arm64, x64)

### Windows Status (Known Limitations)

Windows support is currently partial and is not yet production-ready.

Current Windows limitations:
- `CLIProxyAPI` auto-install is not fully automated; manual proxy setup is required.
- Shell/profile integration differs across `PowerShell`, `Windows PowerShell`, and `cmd`, and may need manual adjustment.
- Path and wrapper differences (`.cmd`/`.exe`) are handled in detection, but end-to-end setup remains less reliable than macOS/Linux.

Recommended Windows flow for now:
1. Install Claude Code CLI manually and verify `claude` is on `PATH`.
2. Install and run proxy components manually.
3. Use `ccodex --status` to verify runtime before interactive use.

For team rollouts, treat Windows as "best effort" until full installer parity lands.

### Security Features

- **Allowlist environment passing**: Only essential environment variables are passed to Claude subprocess (PATH, HOME, TMP, etc.)
- **Mandatory checksum verification**: Downloaded binaries are verified against SHA-256 checksums before installation
- **Fail-closed policy**: Installation fails hard if checksums cannot be verified
- **No API key leakage**: All Anthropic/OpenAI variables are explicitly excluded from subprocess environment

### Known Limitations

- **Checksum trust model**: Binary and checksum are both fetched from the same GitHub release. If the release account is compromised, both could be malicious. Future versions may add signature verification.
- **Concurrency**: No install lock file; concurrent installations may race (low frequency issue).
- **Platform support**: Only arm64 and x64 architectures are supported.

## Model Mapping

| Claude Tier | GPT Model |
|-------------|-----------|
| Opus | `gpt-5.3-codex(xhigh)` |
| Sonnet | `gpt-5.3-codex(high)` |
| Default | `gpt-5.3-codex(medium)` |
| Haiku | `gpt-5.3-codex(low)` |

## Architecture

```
┌─────────────┐
│  ccodex     │  ← TypeScript CLI (this package)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│CLIProxyAPI  │  ← Local proxy (cliproxyapi/cliproxy)
│  :8317      │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Claude Code │  ← Anthropic's claude CLI
│    CLI      │
└─────────────┘
```

## Requirements

- Node.js >= 18
- Homebrew (for CLIProxyAPI installation)
- Claude Code CLI (`claude`)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
node dist/cli.js --status
```

## License

MIT
