# Security

## What ccodex Does

`ccodex` runs entirely on your local machine. It:

- Installs CLIProxyAPI from official GitHub releases
- Starts a local proxy on `127.0.0.1:8317` (not exposed to the network)
- Stores OAuth credentials in `~/.cli-proxy-api/` (user-only permissions)
- Spawns Claude Code with the proxy as its API endpoint

No credentials or API keys are sent anywhere by `ccodex` itself.

## Binary Verification

Downloaded CLIProxyAPI binaries are verified with SHA-256 checksums before installation.
Installation fails hard if the checksum cannot be verified.

**Trust model caveat:** The binary and its checksum are both fetched from the same GitHub
release. If that release is compromised, both could be malicious. Signature verification
may be added in a future version.

## Environment Isolation

When spawning Claude Code, `ccodex` passes only an explicit allowlist of environment
variables (PATH, HOME, TMP, etc.). All Anthropic and OpenAI API key variables are
explicitly excluded to prevent accidental credential leakage.

## Credentials

OAuth credentials are written to `~/.cli-proxy-api/codex-<email>-<org>.json` with
`0600` permissions (user read/write only).

## Known Limitations

- **Concurrency**: No install lock file — concurrent first-run installations may race.
  Low frequency in practice.
- **Architecture**: Only `arm64` and `x64` are supported for CLIProxyAPI binary downloads.
