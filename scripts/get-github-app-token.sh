#!/bin/bash
# get-github-app-token.sh — Generate a GitHub App installation access token
#
# Usage:
#   ./get-github-app-token.sh
#   export GH_TOKEN=$(./get-github-app-token.sh)
#
# Required env vars or args:
#   GITHUB_APP_ID        — App ID from GitHub App settings
#   GITHUB_APP_KEY_FILE  — Path to the .pem private key file
#   GITHUB_INSTALL_ID    — Installation ID (from URL after installing)
#
# The token is valid for 1 hour. Call this before each git/gh operation.

set -euo pipefail

# Config — set these or pass as env vars
APP_ID="${GITHUB_APP_ID:-}"
KEY_FILE="${GITHUB_APP_KEY_FILE:-}"
INSTALL_ID="${GITHUB_INSTALL_ID:-}"

if [ -z "$APP_ID" ] || [ -z "$KEY_FILE" ] || [ -z "$INSTALL_ID" ]; then
  echo "Usage: GITHUB_APP_ID=xxx GITHUB_APP_KEY_FILE=/path/to/key.pem GITHUB_INSTALL_ID=yyy $0" >&2
  exit 1
fi

if [ ! -f "$KEY_FILE" ]; then
  echo "Error: Private key file not found: $KEY_FILE" >&2
  exit 1
fi

# Step 1: Generate JWT (valid for 10 minutes)
NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))

JWT_HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e | tr -d '\n=' | tr '+/' '-_')
JWT_PAYLOAD=$(echo -n "{\"iat\":${IAT},\"exp\":${EXP},\"iss\":\"${APP_ID}\"}" | openssl base64 -e | tr -d '\n=' | tr '+/' '-_')
JWT_SIGN=$(echo -n "${JWT_HEADER}.${JWT_PAYLOAD}" | openssl dgst -sha256 -sign "$KEY_FILE" | openssl base64 -e | tr -d '\n=' | tr '+/' '-_')
JWT="${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIGN}"

# Step 2: Exchange JWT for installation access token
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${INSTALL_ID}/access_tokens")

TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "Error: Failed to get installation token" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

echo "$TOKEN"
