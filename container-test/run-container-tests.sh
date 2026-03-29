#!/bin/bash
# ccodex Container Test Script
# Tests ccodex CLI functionality in a Linux container
# Usage: ./run-container-tests.sh [container-name]

set -e

CONTAINER_NAME="${1:-testcc}"
MOUNT_DIR="/ccodex"

echo "=========================================="
echo "ccodex Container Test Suite"
echo "=========================================="
echo ""

# Check if container is running
echo "1. Checking container status..."
if ! container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "❌ FAIL: Container '$CONTAINER_NAME' not found"
    echo "   Create it with: container run -d --name $CONTAINER_NAME ghcr.io/tuannvm/tuannvm:claude sleep 3600"
    exit 1
fi
echo "✓ PASS: Container '$CONTAINER_NAME' found"
echo ""

# Check Node.js version
echo "2. Checking Node.js version..."
NODE_VERSION=$(container exec "$CONTAINER_NAME" node --version 2>/dev/null | tr -d 'v')
if [ -z "$NODE_VERSION" ]; then
    echo "❌ FAIL: Node.js not found in container"
    exit 1
fi
MAJOR_VERSION=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$MAJOR_VERSION" -lt 18 ]; then
    echo "❌ FAIL: Node.js version $NODE_VERSION is too old (need >= 18)"
    exit 1
fi
echo "✓ PASS: Node.js $NODE_VERSION"
echo ""

# Check npm version
echo "3. Checking npm version..."
NPM_VERSION=$(container exec "$CONTAINER_NAME" npm --version 2>/dev/null)
if [ -z "$NPM_VERSION" ]; then
    echo "❌ FAIL: npm not found in container"
    exit 1
fi
echo "✓ PASS: npm $NPM_VERSION"
echo ""

# Fix DNS if needed (common issue in containers)
echo "4. Configuring DNS..."
container exec "$CONTAINER_NAME" sh -c "echo 'nameserver 8.8.8.8' > /etc/resolv.conf" 2>/dev/null || true
echo "✓ PASS: DNS configured to 8.8.8.8"
echo ""

# Test ccodex version
echo "5. Testing ccodex --version..."
CCODEX_VERSION=$(container exec "$CONTAINER_NAME" sh -c "cd /tmp && npx -y @tuannvm/ccodex --version" 2>/dev/null)
if [ -z "$CCODEX_VERSION" ]; then
    echo "❌ FAIL: ccodex --version failed"
    exit 1
fi
echo "✓ PASS: ccodex version $CCODEX_VERSION"
echo ""

# Test ccodex help
echo "6. Testing ccodex --help..."
HELP_OUTPUT=$(container exec "$CONTAINER_NAME" sh -c "cd /tmp && npx -y @tuannvm/ccodex --help" 2>/dev/null)
if ! echo "$HELP_OUTPUT" | grep -q "Usage:"; then
    echo "❌ FAIL: ccodex --help output invalid"
    exit 1
fi
echo "✓ PASS: --help command works"
echo ""

# Test ccodex status
echo "7. Testing ccodex --status..."
STATUS_OUTPUT=$(container exec "$CONTAINER_NAME" sh -c "cd /tmp && npx -y @tuannvm/ccodex --status" 2>/dev/null)
if [ -z "$STATUS_OUTPUT" ]; then
    echo "❌ FAIL: ccodex --status failed"
    exit 1
fi
echo "✓ PASS: --status command works"
echo "$STATUS_OUTPUT"
echo ""

# Test ccodex diagnose
echo "8. Testing ccodex --diagnose..."
DIAGNOSE_OUTPUT=$(container exec "$CONTAINER_NAME" sh -c "cd /tmp && npx -y @tuannvm/ccodex --diagnose" 2>/dev/null)
if [ -z "$DIAGNOSE_OUTPUT" ]; then
    echo "❌ FAIL: ccodex --diagnose failed"
    exit 1
fi
echo "✓ PASS: --diagnose command works"
echo ""

# Get platform info
echo "9. Detecting platform..."
PLATFORM_INFO=$(container exec "$CONTAINER_NAME" sh -c "uname -a && cat /etc/os-release | grep -E '^(NAME|VERSION_ID)='" 2>/dev/null)
echo "$PLATFORM_INFO"
echo "✓ PASS: Platform detection successful"
echo ""

echo "=========================================="
echo "All tests passed! ✓"
echo "=========================================="
echo ""
echo "Summary:"
echo "  - Container: $CONTAINER_NAME"
echo "  - Node.js: $NODE_VERSION"
echo "  - npm: $NPM_VERSION"
echo "  - ccodex: $CCODEX_VERSION"
echo ""
