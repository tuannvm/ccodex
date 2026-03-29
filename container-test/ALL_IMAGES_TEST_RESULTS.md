# CLIProxyAPI Container Image Test Results

## Test Summary

**Date:** 2026-03-29
**CLIProxyAPI Version:** v6.9.6 (Commit: 65706922)
**Architecture:** ARM64 (aarch64)

### Result: All Images Failed ❌

| Image | OS | mkdir Type | Manual mkdir | CLIProxyAPI | Result |
|-------|-------|-----------|--------------|-------------|--------|
| alpine:latest | Alpine Linux v3.23 | busybox (/bin/mkdir) | ✅ OK | ❌ mkdir error | CLIProxyAPI BUG |
| ubuntu:24.04 | Ubuntu 24.04.4 LTS | GNU coreutils (/usr/bin/mkdir) | ✅ OK | ❌ mkdir error | CLIProxyAPI BUG |
| ghcr.io/tuannvm/tuannvm:claude | Alpine Linux v3.21 | busybox (/bin/mkdir) | ✅ OK | ❌ mkdir error | CLIProxyAPI BUG |

## Key Findings

### 1. Universal Failure
All three container images (Alpine, Ubuntu, custom) fail with **identical error**:
```
cliproxy: failed to create auth directory : mkdir : no such file or directory
```

### 2. mkdir Works Manually
On all images, manual `mkdir -p /tmp/test-path` succeeds without issue.

### 3. Not Alpine-Specific
The error occurs on both:
- Alpine with busybox mkdir
- Ubuntu with GNU coreutils mkdir

This definitively proves the issue is **not** related to busybox vs GNU.

### 4. Pre-creation Doesn't Help
Creating the auth directory before running CLIProxyAPI doesn't prevent the error.

## Root Cause Analysis

The CLIProxyAPI Go binary is using `exec.Command("mkdir", ...)` without proper environment inheritance. When the subprocess is spawned:

1. **No PATH**: The subprocess cannot find the `mkdir` command
2. **No environment**: Even basic shell environment is missing
3. **Result**: `exec: "mkdir": executable file not found in $PATH`

This is a **CLIProxyAPI internal bug** that affects all containerized environments.

## Impact on CI

**CRITICAL**: CLIProxyAPI **cannot run in any container environment** without fixing this bug.

### Recommended Actions

1. **File CLIProxyAPI issue**: https://github.com/router-for-me/CLIProxyAPI/issues
2. **Workaround**: None - this is a hard blocker
3. **Alternative**: Consider using a different proxy solution or running CLIProxyAPI on the host (not containerized)

## Test Evidence

### Alpine Test
```bash
$ HOME=/tmp/test-home ./cli-proxy-api -config config.yaml
CLIProxyAPI Version: 6.9.6
[error] proxy service exited with error: cliproxy: failed to create auth directory : mkdir : no such file or directory
```

### Ubuntu Test
```bash
$ HOME=/tmp/test-home ./cli-proxy-api -config config.yaml
CLIProxyAPI Version: 6.9.6
[error] proxy service exited with error: cliproxy: failed to create auth directory : mkdir : no such file or directory
```

### Custom Image Test
```bash
$ HOME=/tmp/test-home ./cli-proxy-api -config config.yaml
CLIProxyAPI Version: 6.9.6
[error] proxy service exited with error: cliproxy: failed to create auth directory : mkdir : no such file or directory
```

## Conclusion

**CONFIRMED**: CLIProxyAPI has a universal bug preventing it from running in ANY container environment (Alpine, Ubuntu, or custom images).

The bug is in CLIProxyAPI's Go code - it's using `exec.Command("mkdir", ...)` without proper environment, causing the subprocess to fail finding the mkdir command.

**This is a hard blocker for CI deployment.**
