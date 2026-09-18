#!/bin/sh
# Reads the resolved AgentContext as JSON on stdin (STU-1196) and fails the
# item whose chapter title marks itself for the gate, so the fixture's
# fan-out has a genuine mixed success/failure result to render (STU-1261).
INPUT=$(cat)
if echo "$INPUT" | grep -q 'fails review'; then
  echo "Chapter failed the review gate" >&2
  exit 1
fi
echo '{"gated": true}'
