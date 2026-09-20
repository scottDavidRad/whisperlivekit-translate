#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WLK="$PROJECT_DIR/.venv/bin/wlk"
PYTHON="$PROJECT_DIR/.venv/bin/python"

if [ ! -x "$WLK" ]; then
  printf '%s\n' 'WhisperLiveKit is not installed in .venv.' >&2
  printf '%s\n' 'Run: python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt' >&2
  exit 1
fi

# Translate any Whisper-supported input language to English by default.
# WLK_TASK=transcribe keeps speech in its original language.
case "${WLK_TASK:-translate}" in
  translate) set -- --direct-english-translation "$@" ;;
  transcribe) ;;
  *) printf '%s\n' 'WLK_TASK must be translate or transcribe.' >&2; exit 2 ;;
esac

# Sortformer assigns anonymous speaker IDs (up to four speakers per session).
# WLK_DIARIZATION=0 runs the lighter speech-only server.
case "${WLK_DIARIZATION:-1}" in
  1) set -- --diarization --diarization-backend sortformer "$@" ;;
  0) ;;
  *) printf '%s\n' 'WLK_DIARIZATION must be 1 or 0.' >&2; exit 2 ;;
esac

# CLI options override the value defaults, for example --port 8765 --model small.
# A single decoding beam keeps CPU inference responsive. Set WLK_BEAM_SIZE=5
# to match the upstream decoder when accuracy matters more than latency.
exec "$PYTHON" "$PROJECT_DIR/server/app.py" \
  --host 127.0.0.1 \
  --port 8000 \
  --pcm-input \
  --backend "${WLK_BACKEND:-faster-whisper}" \
  --backend-policy localagreement \
  --model small \
  --lan auto \
  --beams "${WLK_BEAM_SIZE:-1}" \
  --log-level INFO \
  "$@"
