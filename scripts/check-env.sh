#!/usr/bin/env bash
set -euo pipefail

REQUIRED_VARS=(
  DIGITALOCEAN_ACCESS_TOKEN
  HF_TOKEN
  GRADIENT_API_KEY
  SPACES_ACCESS_KEY_ID
  SPACES_SECRET_ACCESS_KEY
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: Missing required environment variables:" >&2
  for var in "${missing[@]}"; do
    echo "  - $var" >&2
  done
  echo "" >&2
  echo "Run: source ~/env/gtc.env" >&2
  exit 1
fi

echo "All required environment variables are set."
