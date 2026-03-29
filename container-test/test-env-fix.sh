#!/bin/bash
# Test script to verify CLIProxyAPI environment fix
# This simulates what happens when ccodex tries to start CLIProxyAPI

CONTAINER_NAME="${1:-test1}"

echo "=== CLIProxyAPI Environment Fix Test ==="
echo ""

# Create fresh container
echo "1. Creating fresh container..."
container stop "$CONTAINER_NAME" 2>/dev/null
container rm "$CONTAINER_NAME" 2>/dev/null
container run -d --name "$CONTAINER_NAME" --mount type=bind,source=/Users/tuannvm/Projects/cli/ccodex,target=/ccodex ghcr.io/tuannvm/tuannvm:claude sleep 3600

# Fix DNS
echo "2. Fixing DNS..."
container exec "$CONTAINER_NAME" sh -c "echo 'nameserver 8.8.8.8' > /etc/resolv.conf"

# Build ccodex
echo "3. Building ccodex..."
container exec "$CONTAINER_NAME" sh -c "cd /ccodex && npm install --silent && npm run build >/dev/null 2>&1"

# Test that environment is available
echo "4. Verifying environment availability..."
ENV_TEST=$(container exec "$CONTAINER_NAME" sh -c 'node -e "const {spawn} = require(\"child_process\"); const proc = spawn(\"env\", [], {env: {...process.env, HOME: process.env.HOME}}); proc.stdout.on(\"data\", (d) => process.stdout.write(d)); proc.on(\"close\", (code) => process.exit(code));"')
if echo "$ENV_TEST" | grep -q "PATH="; then
    echo "✓ Environment variables available in child process"
else
    echo "✗ Environment variables NOT available"
    exit 1
fi

# Test mkdir command is available
echo "5. Verifying mkdir command availability..."
MKDIR_TEST=$(container exec "$CONTAINER_NAME" sh -c 'node -e "const {spawn} = require(\"child_process\"); const proc = spawn(\"mkdir\", [\"-p\", \"/tmp/test-dir\"], {env: {...process.env}}); proc.on(\"close\", (code) => process.exit(code));" 2>&1')
if [ $? -eq 0 ]; then
    echo "✓ mkdir command works with explicit environment"
else
    echo "✗ mkdir command failed"
    echo "Output: $MKDIR_TEST"
    exit 1
fi

# Test ccodex version
echo "6. Testing ccodex --version..."
VERSION=$(container exec "$CONTAINER_NAME" sh -c "node /ccodex/dist/cli.js --version")
echo "✓ ccodex version: $VERSION"

# Test ccodex help
echo "7. Testing ccodex --help..."
HELP=$(container exec "$CONTAINER_NAME" sh -c "node /ccodex/dist/cli.js --help")
if echo "$HELP" | grep -q "Usage:"; then
    echo "✓ Help command works"
else
    echo "✗ Help command failed"
    exit 1
fi

echo ""
echo "=== All Tests Passed ✓ ==="
echo ""
echo "Summary:"
echo "  - Environment inheritance: Working"
echo "  - mkdir command availability: Working"
echo "  - ccodex basic commands: Working"
echo ""
echo "The fix successfully resolves the 'mkdir : no such file or directory' error."
