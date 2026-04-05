#!/bin/bash
set -e
cat > /tmp/input.json
cd /app
if [ "$NANOCLAW_ENGINE" = "tsx" ]; then
  tsx src/index.ts < /tmp/input.json
else
  node dist/index.js < /tmp/input.json
fi
