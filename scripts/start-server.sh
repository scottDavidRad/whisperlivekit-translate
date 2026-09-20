#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WLK="$PROJECT_DIR/.venv/bin/wlk"

if [ ! -x "$WLK" ]; then
  printf '%s\n' 'WhisperLiveKit is not installed in .venv.' >&2
  printf '%s\n' 'Run: python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt' >&2
  exit 1
fi

# Options supplied by the caller override the defaults, for example:
# ./scripts/start-server.sh --port 8765 --lan es --direct-english-translation
exec "$WLK" \
  --host 0.0.0.0 \
  --port 8000 \
  --pcm-input \
  --backend faster-whisper \
  --backend-policy localagreement \
  --model base \
  "$@"
