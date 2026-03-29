# CLIProxyAPI Container Issue - Root Cause Analysis

## Issue
CLIProxyAPI fails to start in Alpine containers with error:
```
cliproxy: failed to create auth directory : mkdir : no such file or directory
```

## Root Cause
This is a **CLIProxyAPI bug**, NOT a ccodex bug.

## Evidence
1. ✅ ccodex's env fix IS compiled correctly (verified in dist/proxy.js)
2. ✅ Manual mkdir works in the container
3. ✅ Environment variables are passed correctly to spawn()
4. ✅ PATH includes /bin where mkdir (busybox) is located
5. ❌ CLIProxyAPI fails with same error even when:
   - Auth directory is pre-created
   - CLIProxyAPI is run directly (not via ccodex)
   - PATH is explicitly set

## Test Results
| Test | Result |
|------|--------|
| Local build with env fix | ✅ Compiled correctly |
| spawn() with env option | ✅ Environment passed correctly |
| mkdir command in container | ✅ Available at /bin/mkdir |
| Manual mkdir | ✅ Works |
| CLIProxyAPI start (fresh container) | ❌ Fails with mkdir error |
| CLIProxyAPI start (pre-created dir) | ❌ Still fails |

## Conclusion
This is a **CLIProxyAPI compatibility issue** with the Alpine/busybox environment.
The ccodex environment fix is correct, but CLIProxyAPI itself has a bug when
running mkdir in this container environment.

## Workaround
None available - this requires fixing CLIProxyAPI or using a different
container base image (e.g., Debian instead of Alpine).
