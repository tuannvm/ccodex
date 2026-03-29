# CLIProxyAPI Ubuntu Container Test Results

## Test Setup
- Container: Ubuntu 24.04 (not Alpine)
- Architecture: ARM64 (aarch64)
- CLIProxyAPI version: v6.9.6
- ccodex version: 0.4.2

## Test Results

| Test | Result | Details |
|------|--------|---------|
| Container creation | ✅ Success | Ubuntu 24.04 container created |
| mkdir command | ✅ Works | `mkdir -p /tmp/test-ubuntu-mkdir` succeeds |
| CLIProxyAPI download | ✅ Success | ARM64 binary downloaded |
| CLIProxyAPI version | ✅ Success | Version 6.9.6, Commit 65706922 |
| Auth directory pre-creation | ✅ Success | `/tmp/ccodex-test/.config/ccodex/auth` exists |
| CLIProxyAPI start (v6.9.5) | ❌ Failed | "mkdir : no such file or directory" |
| CLIProxyAPI start (v6.9.6) | ❌ Failed | "mkdir : no such file or directory" |
| ccodex --status | ✅ Success | Works without starting CLIProxyAPI |

## Root Cause Analysis

### Finding 1: mkdir works in Ubuntu
```bash
$ mkdir -p /tmp/ccodex-test/.config/ccodex/auth
✓ mkdir works in Ubuntu
```

The mkdir command itself works perfectly in the Ubuntu container. The GNU coreutils mkdir is available at `/usr/bin/mkdir`.

### Finding 2: Auth directory exists
```bash
$ ls -la /tmp/ccodex-test/.config/ccodex/auth/
drwxr-xr-x 2 root root 4096 Mar 29 16:41 .
drwxr-xr-x 4 root root 4096 Mar 29 16:41 ..
```

The auth directory exists with correct permissions.

### Finding 3: CLIProxyAPI fails anyway
```
[error] [run.go:54] proxy service exited with error: cliproxy: failed to create auth directory : mkdir : no such file or directory
```

CLIProxyAPI fails with the same error even when:
- Running in Ubuntu (not Alpine)
- Using GNU coreutils (not busybox)
- Auth directory already exists
- PATH is explicitly set

## Conclusion

**This is a CLIProxyAPI internal bug, not a ccodex or environment issue.**

The error occurs because CLIProxyAPI's Go code is likely using `exec.Command("mkdir", ...)` without proper environment inheritance, causing the subprocess to fail to find the mkdir command.

### Evidence

1. ✅ Manual mkdir works
2. ✅ ccodex's environment fix is correctly compiled
3. ✅ Environment variables are passed correctly in ccodex
4. ❌ CLIProxyAPI fails regardless of container OS (Alpine OR Ubuntu)
5. ❌ CLIProxyAPI fails even when auth directory is pre-created

### Impact

This bug affects:
- CLIProxyAPI v6.9.5
- CLIProxyAPI v6.9.6 (latest as of 2026-03-29)
- Both Alpine and Ubuntu containers
- ARM64 and likely other architectures

### Recommendation

**File issue with CLIProxyAPI project** at:
https://github.com/router-for-me/CLIProxyAPI/issues

The CLIProxyAPI code needs to use `os.MkdirAll` instead of `exec.Command("mkdir")` or properly inherit environment when executing external commands.

## Workaround

No viable workaround exists. The issue is internal to CLIProxyAPI's Go binary and cannot be fixed from ccodex's TypeScript code.
