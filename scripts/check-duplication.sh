#!/usr/bin/env bash
# jscpd duplication check — reports only clones involving staged files.
# Usage: ./scripts/check-duplication.sh <src-dir> [staged-file ...]

set -euo pipefail

SRC_DIR="$1"; shift
STAGED_FILES=("$@")

# Filter out test/migration files
FILTERED_STAGED=()
for f in "${STAGED_FILES[@]}"; do
  if [[ ! "$f" =~ \.(spec|test)\.(ts|tsx)$ ]] && \
     [[ ! "$f" =~ /migrations/ ]]; then
    FILTERED_STAGED+=("$f")
  fi
done
if [ ${#FILTERED_STAGED[@]} -eq 0 ]; then
  echo "No non-test/migration staged files — skipping duplication check."
  exit 0
fi

STAGED_FILES=("${FILTERED_STAGED[@]}")

RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
NC="\033[0m"

MIN_LINES=25
MIN_TOKENS=60

REPORT_DIR=$(mktemp -d)
trap 'rm -rf "$REPORT_DIR"' EXIT

npx --yes jscpd "$SRC_DIR" \
  --threshold 100 \
  --min-lines "$MIN_LINES" \
  --min-tokens "$MIN_TOKENS" \
  --format "typescript" \
  --ignore '**/generated/**' \
  --ignore '**/migrations/**' \
  --ignore '**/*.spec.ts' \
  --ignore '**/*.test.ts' \
  --reporters json \
  --output "$REPORT_DIR" \
  --silent >/dev/null 2>&1

REPORT_FILE="$REPORT_DIR/jscpd-report.json"
if [ ! -f "$REPORT_FILE" ]; then
  echo -e "${YELLOW}No jscpd report generated — skipping.${NC}"
  exit 0
fi

JQ_PATTERNS="["
FIRST=true
for f in "${STAGED_FILES[@]}"; do
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    JQ_PATTERNS+=","
  fi
  JQ_PATTERNS+="\"$f\""
done
JQ_PATTERNS+="]"

MATCHES=$(jq --argjson staged "$JQ_PATTERNS" '
  [.duplicates[] | select(
    (.firstFile.name as $f | $staged | any(. == $f)) or
    (.secondFile.name as $s | $staged | any(. == $s))
  )]
' "$REPORT_FILE")

COUNT=$(echo "$MATCHES" | jq 'length')

if [ "$COUNT" -eq 0 ]; then
  echo -e "${GREEN}✅ No duplicated code blocks found in staged files${NC}"
  exit 0
fi

echo -e "${RED}❌ Found $COUNT duplicated code block(s) involving staged files:${NC}"
echo ""
echo "$MATCHES" | jq -r '.[] |
  "  Clone (\(.lines) lines):\n    " +
  .firstFile.name + ":" + (.firstFile.start | tostring) + "-" + (.firstFile.end | tostring) +
  "\n    " +
  .secondFile.name + ":" + (.secondFile.start | tostring) + "-" + (.secondFile.end | tostring) +
  "\n"
'
echo -e "${YELLOW}Thresholds: min-lines=$MIN_LINES, min-tokens=$MIN_TOKENS${NC}"
echo -e "${YELLOW}Extract shared logic into a helper function or module.${NC}"
exit 1
