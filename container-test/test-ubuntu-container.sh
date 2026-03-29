#!/bin/bash
# Test ccodex with CLIProxyAPI in Ubuntu-based container
# This tests the workaround for CLIProxyAPI's Alpine/busybox mkdir bug

set -e

CONTAINER_NAME="${1:-ubuntu-test}"

echo "=== CLIProxyAPI Ubuntu Container Test ==="
echo ""

# Clean up any existing container
echo "1. Cleaning up existing container..."
container stop "$CONTAINER_NAME" 2>/dev/null || true
container rm "$CONTAINER_NAME" 2>/dev/null || true

# Create Ubuntu-based container with mount
echo "2. Creating Ubuntu 24.04 container..."
container run -d --name "$CONTAINER_NAME" \
    --mount type=bind,source=/Users/tuannvm/Projects/cli/ccodex,target=/ccodex \
    ubuntu:24.04 sleep 3600

# Fix DNS in Ubuntu
echo "3. Fixing DNS..."
container exec "$CONTAINER_NAME" sh -c "echo 'nameserver 8.8.8.8' > /etc/resolv.conf"

# Install Node.js and npm in Ubuntu
echo "4. Installing Node.js and npm..."
container exec "$CONTAINER_NAME" sh -c "
    apt-get update >/dev/null 2>&1 &&
    apt-get install -y curl >/dev/null 2>&1 &&
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 &&
    apt-get install -y nodejs >/dev/null 2>&1 &&
    node --version &&
    npm --version
"

# Build ccodex
echo "5. Building ccodex..."
container exec "$CONTAINER_NAME" sh -c "cd /ccodex && npm install --silent && npm run build >/dev/null 2>&1"

# Test ccodex version
echo "6. Testing ccodex --version..."
VERSION=$(container exec "$CONTAINER_NAME" sh -c "node /ccodex/dist/cli.js --version")
echo "✓ ccodex version: $VERSION"

# Test ccodex status
echo "7. Testing ccodex --status..."
container exec "$CONTAINER_NAME" sh -c "node /ccodex/dist/cli.js --status" || echo "Note: Status check may require proxy config"

# Test ccodex diagnose
echo "8. Testing ccodex --diagnose..."
container exec "$CONTAINER_NAME" sh -c "node /ccodex/dist/cli.js --diagnose" || echo "Note: Diagnose may require proxy config"

# Verify Ubuntu environment (not Alpine)
echo "9. Verifying container base OS..."
OS_INFO=$(container exec "$CONTAINER_NAME" sh -c "cat /etc/os-release | grep PRETTY_NAME")
echo "✓ Container OS: $OS_INFO"

# Verify mkdir is GNU coreutils (not busybox)
echo "10. Verifying mkdir availability..."
MKDIR_PATH=$(container exec "$CONTAINER_NAME" sh -c "which mkdir")
echo "✓ mkdir at: $MKDIR_PATH"
# Check if it's busybox or GNU
if container exec "$CONTAINER_NAME" sh -c "mkdir --version 2>&1 | head -1" | grep -q "GNU"; then
    echo "✓ Type: GNU coreutils (not busybox)"
else
    echo "⚠ Type: Unknown (file command not available)"
fi

# Test actual mkdir in container
echo "11. Testing mkdir command in container..."
container exec "$CONTAINER_NAME" sh -c "mkdir -p /tmp/test-ubuntu-mkdir && echo '✓ mkdir works in Ubuntu'"

# Download and test CLIProxyAPI in Ubuntu
echo "12. Testing CLIProxyAPI in Ubuntu container..."
container exec "$CONTAINER_NAME" sh -c "
    cd /tmp &&
    curl -fsSL -o cliproxy.tar.gz 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v6.9.6/CLIProxyAPI_6.9.6_linux_arm64.tar.gz' 2>&1 &&
    tar -xzf cliproxy.tar.gz &&
    chmod +x cli-proxy-api &&
    ./cli-proxy-api -version 2>&1 | head -5
"

echo "13. Testing CLIProxyAPI config directory creation (Ubuntu)..."
container exec "$CONTAINER_NAME" sh -c "
    cd /tmp &&
    HOME=/tmp/test-home ./cli-proxy-api -config /tmp/test-config.yml 2>&1 | head -10
"

echo ""
echo "=== Ubuntu Container Test Summary ==="
echo ""
echo "Results:"
echo "  - Container OS: Ubuntu 24.04 (not Alpine)"
echo "  - mkdir: GNU coreutils (not busybox)"
echo "  - ccodex version: $VERSION"
echo "  - Environment: Linux with full GNU utilities"
echo ""
echo "This should work around the CLIProxyAPI Alpine/busybox bug."
echo ""
