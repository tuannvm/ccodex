# Troubleshooting

## Viewing Logs

### Proxy log

CLIProxyAPI writes its output to:

```
~/.cache/ccodex-cliproxy.log
```

Tail it while running:

```bash
tail -f ~/.cache/ccodex-cliproxy.log
```

### Debug mode

Set `CCODEX_DEBUG=1` to enable verbose logging from `ccodex` itself:

```bash
CCODEX_DEBUG=1 ccodex
```

This prints internal state: auth checks, proxy start/stop, install steps, and path resolution.

---

## Common Issues

### "Authentication still not configured after login"

Login completed but the proxy didn't pick up the credentials. Try:

```bash
rm ~/.cli-proxy-api/codex-*.json
ccodex --login
```

If you're using a company SSO / Okta-secured OpenAI org, make sure you selected the
correct organization during the OAuth flow.

### Browser didn't open during login

`ccodex` shows the OAuth URL directly in the terminal. Press **`c`** to copy it, then
paste it into your browser manually.

### Proxy won't start

Check the proxy log for errors:

```bash
cat ~/.cache/ccodex-cliproxy.log
```

Then verify the proxy binary is installed:

```bash
ccodex --status
```

### "co" / "ccodex" alias not found after first run

Re-source your shell config:

```bash
source ~/.zshrc   # or ~/.bashrc
```

---

## Auth Files

Credentials are stored per account:

```
~/.cli-proxy-api/codex-<email>-<org>.json
```

To reset auth for all accounts:

```bash
rm ~/.cli-proxy-api/codex-*.json
ccodex --login
```

---

## Platform Notes

### macOS / Linux

Fully supported. CLIProxyAPI is installed via Homebrew (macOS) or binary download (Linux).

### Windows

Partial support — CLIProxyAPI auto-install is not fully automated on Windows.
Manual steps required:

1. Install Claude Code CLI manually and verify `claude` is on `PATH`
2. Install and start CLIProxyAPI manually
3. Run `ccodex --status` to verify before use
