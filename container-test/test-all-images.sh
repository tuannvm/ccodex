#!/bin/bash
# Test CLIProxyAPI across all container images
set -e

RESULTS_FILE="/tmp/container-test-results.md"
echo "# CLIProxyAPI Container Image Test Results" > "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "Test Date: $(date)" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "## Test Summary" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"
echo "| Image | OS | mkdir Type | Manual mkdir | CLIProxyAPI | Result |" >> "$RESULTS_FILE"
echo "|-------|-------|-----------|--------------|-------------|--------|" >> "$RESULTS_FILE"

test_image() {
    local IMAGE="$1"
    local CONTAINER_NAME="test-${IMAGE//:/-}"
    CONTAINER_NAME="${CONTAINER_NAME//\//-}"

    echo "=== Testing: $IMAGE ==="
    echo ""

    # Clean up any existing container
    container stop "$CONTAINER_NAME" 2>/dev/null || true
    container rm "$CONTAINER_NAME" 2>/dev/null || true

    # Create container
    echo "1. Creating container..."
    container run -d --name "$CONTAINER_NAME" \
        --mount type=bind,source=/Users/tuannvm/Projects/cli/ccodex,target=/ccodex \
        "$IMAGE" sleep 3600 >/dev/null 2>&1

    # Fix DNS if needed
    container exec "$CONTAINER_NAME" sh -c "echo 'nameserver 8.8.8.8' > /etc/resolv.conf" 2>/dev/null || true

    # Get OS info
    echo "2. Detecting OS..."
    OS_INFO=$(container exec "$CONTAINER_NAME" sh -c "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME || uname -a" 2>/dev/null)
    echo "   OS: $OS_INFO"

    # Check mkdir type
    echo "3. Checking mkdir type..."
    MKDIR_TYPE="unknown"
    MKDIR_PATH=$(container exec "$CONTAINER_NAME" sh -c "which mkdir" 2>/dev/null)
    if container exec "$CONTAINER_NAME" sh -c "mkdir --version 2>&1" | grep -q GNU 2>/dev/null; then
        MKDIR_TYPE="GNU coreutils"
    elif container exec "$CONTAINER_NAME" sh -c "mkdir --help 2>&1" | grep -q busybox 2>/dev/null; then
        MKDIR_TYPE="busybox"
    fi
    echo "   mkdir: $MKDIR_PATH ($MKDIR_TYPE)"

    # Test manual mkdir
    echo "4. Testing manual mkdir..."
    MANUAL_MKDIR="FAIL"
    if container exec "$CONTAINER_NAME" sh -c "mkdir -p /tmp/test-mkdir && echo 'OK'" >/dev/null 2>&1; then
        MANUAL_MKDIR="OK"
    fi
    echo "   Manual mkdir: $MANUAL_MKDIR"

    # Download CLIProxyAPI
    echo "5. Downloading CLIProxyAPI..."
    container exec "$CONTAINER_NAME" sh -c "
        cd /tmp &&
        curl -fsSL -o cliproxy.tar.gz 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v6.9.6/CLIProxyAPI_6.9.6_linux_arm64.tar.gz' 2>&1 &&
        tar -xzf cliproxy.tar.gz &&
        chmod +x cli-proxy-api &&
        ./cli-proxy-api -version 2>&1 | head -1
    " >/dev/null 2>&1

    # Create test config
    echo "6. Creating test config..."
    container exec "$CONTAINER_NAME" sh -c "
        mkdir -p /tmp/test-home/.config/test
        cat > /tmp/test-home/.config/test/config.yaml << 'EOF'
port: 8080
host: 127.0.0.1
log:
  level: info
auth_dir: /tmp/test-home/.config/test/auth
EOF
    " >/dev/null 2>&1

    # Test CLIProxyAPI
    echo "7. Testing CLIProxyAPI..."
    CLI_PROXY_RESULT="FAIL"
    CLI_PROXY_ERROR=""
    OUTPUT=$(container exec "$CONTAINER_NAME" sh -c "
        HOME=/tmp/test-home /tmp/cli-proxy-api -config /tmp/test-home/.config/test/config.yaml 2>&1
    " 2>/dev/null || echo "EXIT_CODE:$?")

    if echo "$OUTPUT" | grep -q "failed to create auth directory"; then
        CLI_PROXY_RESULT="FAIL (mkdir error)"
        CLI_PROXY_ERROR="mkdir : no such file or directory"
    elif echo "$OUTPUT" | grep -q "CLIProxyAPI Version"; then
        CLI_PROXY_RESULT="STARTED"
    else
        CLI_PROXY_RESULT="FAIL (other)"
        CLI_PROXY_ERROR=$(echo "$OUTPUT" | head -3)
    fi
    echo "   CLIProxyAPI: $CLI_PROXY_RESULT"
    if [ -n "$CLI_PROXY_ERROR" ]; then
        echo "   Error: $CLI_PROXY_ERROR"
    fi

    # Cleanup
    container stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    container rm "$CONTAINER_NAME" >/dev/null 2>&1 || true

    # Determine final result
    FINAL_RESULT="❌ FAIL"
    if [ "$MANUAL_MKDIR" = "OK" ] && [ "$CLI_PROXY_RESULT" = "STARTED" ]; then
        FINAL_RESULT="✅ PASS"
    elif [ "$MANUAL_MKDIR" = "OK" ] && echo "$CLI_PROXY_RESULT" | grep -q "mkdir error"; then
        FINAL_RESULT="⚠️ CLIProxyAPI BUG"
    fi

    echo "   Result: $FINAL_RESULT"
    echo ""

    # Add to results table
    OS_SHORT=$(echo "$OS_INFO" | cut -d'"' -f2 | head -1)
    echo "| $IMAGE | $OS_SHORT | $MKDIR_TYPE | $MANUAL_MKDIR | $CLI_PROXY_RESULT | $FINAL_RESULT |" >> "$RESULTS_FILE"

    return 0
}

# Test all images
echo "Testing all container images..."
echo ""

test_image "alpine:latest"
test_image "ubuntu:24.04"
test_image "ghcr.io/tuannvm/tuannvm:claude"

echo ""
echo "=== Test Complete ==="
echo ""
echo "Results saved to: $RESULTS_FILE"
cat "$RESULTS_FILE"
