#!/usr/bin/env bash
# Lizard complexity check for TypeScript files
# Usage: ./scripts/check-complexity.sh [file1 file2 ...]
# If no files provided, checks all staged .ts/.tsx files

set -e

CCN_THRESHOLD=10
LENGTH_THRESHOLD=50
ARGS_THRESHOLD=5

RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
NC="\033[0m"

if ! command -v lizard &> /dev/null; then
    echo -e "${YELLOW}Installing lizard...${NC}"
    pip install lizard --quiet
fi

if [ $# -gt 0 ]; then
    FILES=$(printf "%s\n" "$@" \
      | grep -v '/generated/' \
      | grep -v '\.spec\.ts$' \
      | grep -v '\.test\.ts$' \
      | grep -v '/migrations/' || true)
else
    FILES=$(git diff --name-only --cached --diff-filter=ACMR \
      | grep -E '\.(ts|tsx)$' \
      | grep -v '/generated/' \
      | grep -v '\.spec\.ts$' \
      | grep -v '\.test\.ts$' \
      | grep -v '/migrations/' || true)
fi

if [ -z "$FILES" ]; then
    echo -e "${GREEN}No TypeScript files to check.${NC}"
    exit 0
fi

echo -e "Checking complexity for:"
echo "$FILES" | sed 's/^/  - /'

RESULT=$(echo "$FILES" | tr '\n' ' ' | xargs lizard \
    --CCN $CCN_THRESHOLD \
    --length $LENGTH_THRESHOLD \
    --arguments $ARGS_THRESHOLD \
    --warnings_only \
    2>&1) || true

if [ -n "$RESULT" ]; then
    echo -e "${RED}❌ Complexity thresholds exceeded:${NC}"
    echo "$RESULT"
    echo ""
    echo -e "${YELLOW}Thresholds: CCN≤$CCN_THRESHOLD, length≤$LENGTH_THRESHOLD lines, args≤$ARGS_THRESHOLD${NC}"
    echo -e "${YELLOW}Consider refactoring these functions into smaller units.${NC}"
    exit 1
else
    echo -e "${GREEN}✅ All functions within complexity thresholds${NC}"
    exit 0
fi
