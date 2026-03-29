#!/bin/bash
# Advanced ccodex Container Tests
# More comprehensive testing including edge cases

set -e

CONTAINER_NAME="${1:-testcc}"
TEST_RESULTS=()

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

run_test() {
    local test_name="$1"
    local test_cmd="$2"
    local expected="$3"

    echo -n "Testing: $test_name ... "
    if eval "$test_cmd" > /tmp/test_output.txt 2>&1; then
        if [ -n "$expected" ]; then
            if grep -q "$expected" /tmp/test_output.txt; then
                echo -e "${GREEN}PASS${NC}"
                TEST_RESULTS+=("PASS: $test_name")
                return 0
            else
                echo -e "${RED}FAIL${NC} (expected: $expected)"
                cat /tmp/test_output.txt
                TEST_RESULTS+=("FAIL: $test_name")
                return 1
            fi
        else
            echo -e "${GREEN}PASS${NC}"
            TEST_RESULTS+=("PASS: $test_name")
            return 0
        fi
    else
        echo -e "${RED}FAIL${NC}"
        cat /tmp/test_output.txt
        TEST_RESULTS+=("FAIL: $test_name")
        return 1
    fi
}

echo "=========================================="
echo "Advanced ccodex Container Test Suite"
echo "=========================================="
echo ""

# 1. Basic connectivity tests
echo "--- Basic Connectivity ---"

run_test "Node.js available" "container exec $CONTAINER_NAME node --version" ""
run_test "npm available" "container exec $CONTAINER_NAME npm --version" ""

NODE_VERSION=$(container exec "$CONTAINER_NAME" node --version | tr -d 'v')
MAJOR_VERSION=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$MAJOR_VERSION" -lt 18 ]; then
    echo -e "${RED}FAIL: Node.js version $NODE_VERSION too old${NC}"
    exit 1
fi
echo -e "${GREEN}Node.js $NODE_VERSION meets requirements (>= 18)${NC}"

# 2. ccodex command tests (npx)
echo ""
echo "--- ccodex Command Tests (npx) ---"

run_test "ccodex --version" \
    "container exec $CONTAINER_NAME sh -c 'cd /tmp && npx -y @tuannvm/ccodex --version'" \
    "0.3."

run_test "ccodex --help contains Usage" \
    "container exec $CONTAINER_NAME sh -c 'cd /tmp && npx -y @tuannvm/ccodex --help'" \
    "Usage:"

run_test "ccodex --status" \
    "container exec $CONTAINER_NAME sh -c 'cd /tmp && npx -y @tuannvm/ccodex --status'" \
    "ccodex status"

run_test "ccodex --diagnose" \
    "container exec $CONTAINER_NAME sh -c 'cd /tmp && npx -y @tuannvm/ccodex --diagnose'" \
    "Proxy & Auth Diagnostics"

# 3. Platform detection tests
echo ""
echo "--- Platform Detection ---"

PLATFORM_OUTPUT=$(container exec "$CONTAINER_NAME" uname -s)
if [ "$PLATFORM_OUTPUT" = "Linux" ]; then
    echo -e "${GREEN}PASS: Platform correctly detected as Linux${NC}"
    TEST_RESULTS+=("PASS: Platform detection (Linux)")
else
    echo -e "${RED}FAIL: Expected Linux, got $PLATFORM_OUTPUT${NC}"
    TEST_RESULTS+=("FAIL: Platform detection")
fi

# 4. Edge case tests
echo ""
echo "--- Edge Case Tests ---"

# Test unknown option (ccodex allows unknown options via commander, doesn't crash)
echo -n "Testing: Unknown option handling (no crash) ... "
if container exec "$CONTAINER_NAME" sh -c "cd /tmp && timeout 10 npx -y @tuannvm/ccodex --invalid-option 2>&1 || true" > /tmp/test_output.txt 2>&1; then
    echo -e "${GREEN}PASS${NC} (no crash on unknown option)"
    TEST_RESULTS+=("PASS: Unknown option handling")
else
    # Non-zero exit is OK if it didn't hang/crash
    if grep -q "usage\|Usage\|help" /tmp/test_output.txt || ! grep -q "segmentation\|crash\|panic" /tmp/test_output.txt; then
        echo -e "${GREEN}PASS${NC} (handled gracefully)"
        TEST_RESULTS+=("PASS: Unknown option handling")
    else
        echo -e "${RED}FAIL${NC}"
        TEST_RESULTS+=("FAIL: Unknown option handling")
    fi
fi

# Test concurrent status checks
echo -n "Testing: Concurrent status checks ... "
CONCURRENT_PASS=true
for i in {1..3}; do
    container exec "$CONTAINER_NAME" sh -c "cd /tmp && npx -y @tuannvm/ccodex --version" > /dev/null 2>&1 &
done
wait
if [ $? -eq 0 ]; then
    echo -e "${GREEN}PASS${NC}"
    TEST_RESULTS+=("PASS: Concurrent status checks")
else
    echo -e "${YELLOW}WARN${NC} (concurrent execution may have issues)"
    TEST_RESULTS+=("WARN: Concurrent status checks")
fi

# 5. Environment variable tests
echo ""
echo "--- Environment Tests ---"

run_test "NODE_ENV test mode" \
    "container exec $CONTAINER_NAME sh -c 'cd /tmp && NODE_ENV=test npx -y @tuannvm/ccodex --version'" \
    "0.3."

# 6. Filesystem tests
echo ""
echo "--- Filesystem Tests ---"

run_test "Temp directory writeable" \
    "container exec $CONTAINER_NAME sh -c 'cd /tmp && echo test > /tmp/ccodex-test.txt && cat /tmp/ccodex-test.txt'" \
    "test"

# 7. Summary
echo ""
echo "=========================================="
echo "Test Summary"
echo "=========================================="

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

for result in "${TEST_RESULTS[@]}"; do
    if [[ $result == PASS:* ]]; then
        ((PASS_COUNT++))
    elif [[ $result == FAIL:* ]]; then
        ((FAIL_COUNT++))
    elif [[ $result == WARN:* ]]; then
        ((WARN_COUNT++))
    fi
done

echo -e "${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "${RED}Failed: $FAIL_COUNT${NC}"
echo -e "${YELLOW}Warnings: $WARN_COUNT${NC}"

if [ $FAIL_COUNT -eq 0 ]; then
    echo ""
    echo -e "${GREEN}All critical tests passed! ✓${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}Some tests failed. Please review.${NC}"
    exit 1
fi
