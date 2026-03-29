# CLIProxyAPI mkdir Failure Fix

## Problem

CLIProxyAPI failed to start in containers with the error:
```
cliproxy: failed to create auth directory : mkdir : no such file or directory
```

## Root Cause

The `spawn()` call in `startProxy()` didn't include the `env` option. While Node.js typically inherits parent environment by default, explicitly omitting `env` can cause issues in containerized environments where the environment might not be fully inherited.

Without proper environment, CLIProxyAPI couldn't find the `mkdir` command (not in PATH) to create the auth directory.

## Solution

Added explicit environment passing to both CLIProxyAPI spawn calls:

### 1. startProxy (line 1091)
```typescript
const child = spawn(proxyExe, ["-config", configPath], {
  detached: true,
  stdio: ["ignore", out.fd, out.fd],
  env: { ...process.env, HOME: home }, // Pass environment so mkdir and other commands work
});
```

### 2. launchLogin (line 1134)
```typescript
const child = spawnCmd(proxyExe, ["-codex-login"], {
  stdio: "inherit",
  env: { ...process.env }, // Ensure environment is available
});
```

## Changes

| Commit | Description |
|--------|-------------|
| `f9d0ef2` | Fix: pass environment to CLIProxyAPI spawn to fix mkdir failure |
| `2711ad6` | Fix: pass environment to CLIProxyAPI login spawn for consistency |

## Testing

Created comprehensive test script `container-test/test-env-fix.sh` that verifies:
- Environment variables are available in child processes
- mkdir command works with explicit environment
- ccodex basic commands work correctly

All tests pass ✓

## Codex Review

Codex-5.3-High review confirmed:
- ✅ Root cause fix is correct
- ✅ No security issues with spreading process.env
- ✅ Edge cases handled properly
- ✅ No functional regressions introduced

## Files Modified

- `src/proxy.ts` - Added env option to two spawn calls
- `container-test/test-env-fix.sh` - New test script

## Impact

This fix ensures ccodex works correctly in:
- Containerized environments (Docker, Podman)
- Restricted environments with minimal PATH
- CI/CD pipelines
- Apple containers (ccontainer)

## Verification Commands

```bash
# Run the test script
./container-test/test-env-fix.sh test1

# Manual test in container
ccontainer test1
container exec test1 sh -c "cd /tmp && npx -y @tuannvm/ccodex --status"
```

## Status

✅ **Fix implemented, tested, and pushed to master**

Ready for npm publish (v0.4.1 or next version).
