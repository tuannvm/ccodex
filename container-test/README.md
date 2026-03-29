# ccodex Cross-Platform Testing

## Purpose

Verify **ccodex works on both Linux and macOS** for users. The container test is specifically for **Linux compatibility verification**, since the primary development platform is macOS.

## Test Coverage Summary

| Platform | Test Method | Status |
|----------|-------------|--------|
| **macOS ARM64** | Native (primary dev) | ✅ Verified |
| **macOS x64** | Native | ✅ Supported |
| **Linux ARM64** | Container (ccontainer) | ✅ Verified |
| **Linux x64** | Container / CI | ✅ Supported |
| **Windows** | Native testing | ⚠️ Partial (see README) |

## Quick Test Commands

### macOS (Primary Development)
```bash
# From the ccodex directory
npm run build
node dist/cli.js --version
node dist/cli.js --status
node dist/cli.js --diagnose
```

### Linux Compatibility (via ccontainer)
```bash
# Create Linux test environment
ccontainer test --mount /Users/tuannvm/Projects/cli/ccodex

# Or use existing container
container exec testcc sh -c "cd /tmp && npx -y @tuannvm/ccodex --status"
```

### Linux Compatibility (via Docker - alternative)
```bash
# Build and test Linux compatibility
docker build -f Dockerfile.test -t ccodex-linux-test .
docker run --rm ccodex-linux-test
```

## Test Scripts

| Script | Purpose | Platform |
|--------|---------|----------|
| `run-container-tests.sh` | Basic container tests | Linux (via ccontainer) |
| `advanced-tests.sh` | Comprehensive tests | Linux (via ccontainer) |

## CI/CD Integration

GitHub Actions workflow (`.github/workflows/container-test.yml`) tests:
- Node.js 18, 20, 22
- Debian Bookworm (via container)
- Alpine Linux (via container)
- Published npm package

## Test Results (Latest Run)

### Environment
- **Container**: ghcr.io/tuannvm/tuannvm:claude (Alpine Linux v3.21.6)
- **Node.js**: v22.15.1
- **Architecture**: ARM64 (aarch64)

### All Tests Passed ✅ (11/11)

| Test | Result |
|------|--------|
| Node.js available | ✅ |
| npm available | ✅ |
| ccodex --version | ✅ |
| ccodex --help | ✅ |
| ccodex --status | ✅ |
| ccodex --diagnose | ✅ |
| Platform detection (Linux) | ✅ |
| Unknown option handling | ✅ |
| Concurrent status checks | ✅ |
| NODE_ENV test mode | ✅ |
| Temp directory writeable | ✅ |

## Known Issues & Limitations

### Container DNS Issue
**Issue**: Default container DNS fails to resolve registry.npmjs.org (EAI_AGAIN)
**Workaround**: Set DNS to 8.8.8.8
```bash
container exec testcc sh -c "echo 'nameserver 8.8.8.8' > /etc/resolv.conf"
```

### Platform-Specific Notes
- **macOS**: Primary development platform, fully supported
- **Linux**: Fully supported via Homebrew and npm
- **Windows**: Known limitations (see main README.md)

## Files

- `run-container-tests.sh` - Basic test script for ccontainer
- `advanced-tests.sh` - Comprehensive edge case testing
- `TEST_RESULTS.md` - Detailed test results
- `Dockerfile.test` - Linux compatibility verification (alternative)
- `.github/workflows/container-test.yml` - CI/CD pipeline

## Conclusion

✅ **ccodex is verified to work on both Linux and macOS** for end users.

The container tests confirm Linux compatibility, while native macOS development ensures macOS support. Windows has partial support with documented limitations.
