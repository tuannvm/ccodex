# ccodex

TypeScript reimplementation of `ccodex` — run Claude Code CLI with OpenAI GPT models via CLIProxyAPI.

## Quick Start

```bash
npx -y ccodex
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
npx -y ccodex

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
