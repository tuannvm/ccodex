# ccodex Integration Test Scenarios

**Version:** v0.4.6
**Purpose:** Comprehensive integration testing for production validation

---

## Test Environment Setup

### Prerequisites
```bash
# For container tests
docker run --rm -it ubuntu:24.04 sh
docker run --rm -it alpine:latest sh

# For local tests
node --version  # >= 18.x
npm --version
```

---

## Test Suite 1: Fresh Installation

### TC-1.1: Ubuntu Fresh Install
```bash
# In Ubuntu container
docker run --rm -it ubuntu:24.04 sh -c "
  apt-get update && apt-get install -y curl
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  npx -y @tuannvm/ccodex@0.4.6
"
```

**Expected Results:**
- ✅ Node.js and npm install without errors
- ✅ CLIProxyAPI downloads successfully
- ✅ Config created at ~/.config/ccodex/config.yaml
- ✅ CLIProxyAPI starts on port 8317
- ✅ OAuth URL displayed if no auth exists

**Verification Commands:**
```bash
# Check CLIProxyAPI process
ps aux | grep cli-proxy-api

# Check config file
cat ~/.config/ccodex/config.yaml

# Check port listening
netstat -tlnp | grep 8317
```

---

### TC-1.2: Alpine Fresh Install
```bash
# In Alpine container
docker run --rm -it alpine:latest sh -c "
  apk add --no-cache nodejs npm
  npx -y @tuannvm/ccodex@0.4.6
"
```

**Expected Results:** Same as TC-1.1

**Known Differences:**
- Busybox mkdir (should work with v0.4.3+ fixes)
- Different PATH structure (handled by v0.4.5+)

---

### TC-1.3: Local Machine Fresh Install
```bash
# On local machine (macOS/Linux)
npx -y @tuannvm/ccodex@0.4.6
```

**Expected Results:**
- ✅ Shell aliases added to rc file
- ✅ Claude Code CLI installed via npm
- ✅ CLIProxyAPI binary installed
- ✅ Config created with correct format

---

## Test Suite 2: Configuration Management

### TC-2.1: Legacy Config Migration
```bash
# Create legacy config format
mkdir -p ~/.config/ccodex
cat > ~/.config/ccodex/config.yaml << 'EOF'
server:
  host: 127.0.0.1
  port: 8317
auth_dir: /tmp/old-auth
EOF

# Run ccodex - should auto-repair
npx -y @tuannvm/ccodex@0.4.6 --status

# Check repaired config
cat ~/.config/ccodex/config.yaml
```

**Expected Results:**
- ✅ `server:` wrapper removed
- ✅ `auth_dir` changed to `auth-dir`
- ✅ `api-keys: ["sk-dummy"]` added
- ✅ `log.level` replaced with `debug: false` (after fix)

---

### TC-2.2: Config from v0.4.5
```bash
# Create v0.4.5 config (missing api-keys)
mkdir -p ~/.config/ccodex
cat > ~/.config/ccodex/config.yaml << 'EOF'
host: 127.0.0.1
port: 8317
auth-dir: ~/.cli-proxy-api
log:
  level: info
EOF

# Run ccodex - should add api-keys
npx -y @tuannvm/ccodex@0.4.6 --status

# Verify api-keys added
grep -A1 "api-keys:" ~/.config/ccodex/config.yaml
```

**Expected Results:**
- ✅ `api-keys: ["sk-dummy"]` added
- ✅ Other config preserved

---

### TC-2.3: Invalid Config Handling
```bash
# Create invalid YAML config
mkdir -p ~/.config/ccodex
cat > ~/.config/ccodex/config.yaml << 'EOF'
host: 127.0.0.1
  port: broken yaml
    auth-dir: test
EOF

# Should fail gracefully with clear error
npx -y @tuannvm/ccodex@0.4.6 2>&1 | head -20
```

**Expected Results:**
- ❌ Clear error message about invalid config
- ❌ No crash or hang

---

## Test Suite 3: OAuth Authentication

### TC-3.1: OAuth Login Flow (Container)
```bash
# In container (no browser)
docker run --rm -it ubuntu:24.04 sh -c "
  npx -y @tuannvm/ccodex@0.4.6 --login
"
```

**Expected Results:**
- ✅ OAuth URL displayed in terminal
- ✅ Instructions to copy URL to browser
- ✅ Token saved to ~/.cli-proxy-api/ after auth completion

**Sample Output:**
```
Launching ChatGPT/Codex OAuth login...
CLIProxyAPI Version: 6.9.6
Visit the following URL to continue authentication:
https://auth.openai.com/oauth/authorize?client_id=...
```

---

### TC-3.2: Existing OAuth Token
```bash
# Ensure token exists
ls -la ~/.cli-proxy-api/codex-*.json

# Run ccodex - should skip login
npx -y @tuannvm/ccodex@0.4.6 --status
```

**Expected Results:**
- ✅ Status shows "ChatGPT/Codex auth configured"
- ✅ No OAuth prompt displayed

---

### TC-3.3: Expired OAuth Token
```bash
# Manually expire token by modifying JSON
TOKEN_FILE=$(ls ~/.cli-proxy-api/codex-*.json | head -1)
jq '.expired = "2020-01-01"' "$TOKEN_FILE" > /tmp/token.json
mv /tmp/token.json "$TOKEN_FILE"

# Run ccodex - should detect expiry
npx -y @tuannvm/ccodex@0.4.6
```

**Expected Results:**
- ⚠️ Detects expired token
- ✅ Prompts for re-authentication

---

## Test Suite 4: CLIProxyAPI Integration

### TC-4.1: Proxy Startup Verification
```bash
# Start ccodex
npx -y @tuannvm/ccodex@0.4.6 --status

# Verify proxy is running
curl http://127.0.0.1:8317/health 2>&1 || echo "Health endpoint not available"

# Alternative: check process
ps aux | grep cli-proxy-api | grep -v grep
```

**Expected Results:**
- ✅ CLIProxyAPI process running
- ✅ Listening on 127.0.0.1:8317

---

### TC-4.2: API Key Authentication
```bash
# Start ccodex
npx -y @tuannvm/ccodex@0.4.6

# Test with correct key
curl -H "Authorization: Bearer sk-dummy" \
  http://127.0.0.1:8317/v1/models

# Test with wrong key
curl -H "Authorization: Bearer wrong-key" \
  http://127.0.0.1:8317/v1/models
```

**Expected Results:**
- ✅ `sk-dummy` key returns model list
- ❌ `wrong-key` returns 401

---

### TC-4.3: Proxy Health Check
```bash
# Check if proxy is responsive
npx -y @tuannvm/ccodex@0.4.6 --status

# Kill proxy manually
pkill -f cli-proxy-api

# Run ccodex - should restart proxy
npx -y @tuannvm/ccodex@0.4.6 --status
```

**Expected Results:**
- ✅ Status detects proxy not running
- ✅ Automatically restarts proxy

---

## Test Suite 5: Claude Code Integration

### TC-5.1: Basic Claude Code Execution
```bash
# Run simple command
npx -y @tuannvm/ccodex@0.4.6 "say hello"
```

**Expected Results:**
- ✅ Claude Code starts
- ✅ Uses GPT-5.3 Codex model
- ✅ Returns response

---

### TC-5.2: Model Mapping Verification
```bash
# Check environment variables
npx -y @tuannvm/ccodex@0.4.6 --help 2>&1 | grep -i model

# Verify model aliases
env | grep ANTHROPIC | grep MODEL
```

**Expected Results:**
- ✅ `ANTHROPIC_MODEL=gpt-5.3-codex(medium)`
- ✅ `ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-5.3-codex(xhigh)`

---

### TC-5.3: Error Handling
```bash
# Test with invalid API (simulate)
npx -y @tuannvm/ccodex@0.4.6 "cause an error" 2>&1
```

**Expected Results:**
- ✅ Clear error message
- ✅ No crash or hang

---

## Test Suite 6: Container-Specific Tests

### TC-6.1: Minimal Container (Alpine)
```bash
# Minimal Alpine with just Node.js
docker run --rm -it alpine:latest sh -c "
  apk add --no-cache nodejs npm
  npx -y @tuannvm/ccodex@0.4.6 --status
"
```

**Expected Results:**
- ✅ All status checks pass
- ✅ CLIProxyAPI starts correctly

---

### TC-6.2: Container with Custom PATH
```bash
# Container with minimal PATH
docker run --rm -it alpine:latest sh -c "
  apk add --no-cache nodejs npm
  export PATH=/usr/local/bin:/bin
  npx -y @tuannvm/ccodex@0.4.6
"
```

**Expected Results:**
- ✅ Works even with limited PATH
- ✅ Fallback PATH used (v0.4.5+)

---

### TC-6.3: Volume Mount Persistence
```bash
# Test with volume mount
docker run --rm -it -v ccodex-data:/root/.config \
  alpine:latest sh -c "
  apk add --no-cache nodejs npm
  npx -y @tuannvm/ccodex@0.4.6
  cat ~/.config/ccodex/config.yaml
"
```

**Expected Results:**
- ✅ Config persisted in volume
- ✅ Subsequent runs reuse config

---

## Test Suite 7: Upgrade Scenarios

### TC-7.1: Upgrade from v0.4.2
```bash
# Install old version (simulated)
mkdir -p ~/.config/ccodex
cat > ~/.config/ccodex/config.yaml << 'EOF'
server:
  host: 127.0.0.1
  port: 8317
auth_dir: /tmp/auth
EOF

# Run new version
npx -y @tuannvm/ccodex@0.4.6 --status

# Verify config migrated
cat ~/.config/ccodex/config.yaml
```

**Expected Results:**
- ✅ Config auto-repaired
- ✅ All migrations applied

---

### TC-7.2: Version Check
```bash
# Check version
npx -y @tuannvm/ccodex@0.4.6 --version 2>&1 || echo "Version command not available"
```

**Expected Results:**
- ✅ Version displayed

---

## Test Suite 8: Edge Cases

### TC-8.1: Concurrent Installations
```bash
# Run two installations in parallel
npx -y @tuannvm/ccodex@0.4.6 &
npx -y @tuannvm/ccodex@0.4.6 &
wait
```

**Expected Results:**
- ⚠️ Lock file prevents race (P2 issue if not)
- ✅ Only one installation succeeds

---

### TC-8.2: Network Interruption
```bash
# Simulate network failure during download
# (Requires manual intervention or network simulation tool)
```

**Expected Results:**
- ✅ Graceful error handling
- ✅ Partial files cleaned up

---

### TC-8.3: Disk Space Exhaustion
```bash
# Fill disk temporarily (in container)
docker run --rm -it --tmpfs /tmp:size=10M alpine:latest sh -c "
  apk add --no-cache nodejs npm
  npx -y @tuannvm/ccodex@0.4.6
"
```

**Expected Results:**
- ✅ Clear disk space error
- ✅ Cleanup on failure

---

## Test Execution Order

**Priority Order:**
1. TC-1.1, TC-1.2 (Fresh install - basic functionality)
2. TC-2.1, TC-2.2 (Config management)
3. TC-4.1, TC-4.2 (Proxy integration)
4. TC-3.1 (OAuth flow)
5. TC-5.1 (Claude Code integration)
6. TC-6.1, TC-6.2 (Container-specific)
7. TC-7.1 (Upgrade scenarios)
8. Edge cases (TC-8.x)

---

## Success Criteria

**All tests must pass:**
- ✅ No unexpected crashes
- ✅ Clear error messages for failures
- ✅ Proper cleanup on errors
- ✅ Config repairs applied correctly
- ✅ OAuth works end-to-end
- ✅ CLIProxyAPI starts and responds
- ✅ Claude Code integration works

---

## Automation Script

```bash
#!/bin/bash
# Run all critical tests

echo "=== Running ccodex integration tests ==="

# Test 1: Ubuntu container
echo "Test 1: Ubuntu fresh install"
docker run --rm ubuntu:24.04 sh -c "
  apt-get update -qq && apt-get install -y -qq curl nodejs
  npx -y @tuannvm/ccodex@0.4.6 --status
" && echo "✅ PASS" || echo "❌ FAIL"

# Test 2: Alpine container
echo "Test 2: Alpine fresh install"
docker run --rm alpine:latest sh -c "
  apk add --no-cache -q nodejs npm
  npx -y @tuannvm/ccodex@0.4.6 --status
" && echo "✅ PASS" || echo "❌ FAIL"

echo "=== Tests complete ==="
```

---

**Document Version:** 1.0
**Last Updated:** 2026-03-29
**Status:** Ready for execution
