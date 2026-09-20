#!/bin/sh
# Install this backend as a per-user launchd service. Run on the serving Mac.
# Example: WLK_MODEL_DIR=/path/to/small WLK_CHUNK_SIZE=1 ./scripts/install-mac-service.sh 127.0.0.1 18768
set -eu
umask 077

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PYTHON="$PROJECT_DIR/.venv/bin/python"
LABEL=com.scottrad.whisperlivekit
BIND_HOST=${1:-127.0.0.1}
PORT=${2:-18768}
SERVICE_DIR="$PROJECT_DIR/.service"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$(uname -s)" != Darwin ] || [ ! -x "$PYTHON" ]; then
  printf '%s\n' 'Run on macOS after installing requirements.txt into .venv.' >&2
  exit 1
fi

export WLK_SERVICE_PROJECT="$PROJECT_DIR" WLK_SERVICE_HOST="$BIND_HOST" WLK_SERVICE_PORT="$PORT"
export WLK_SERVICE_PLIST="$PLIST" WLK_SERVICE_LABEL="$LABEL"
mkdir -p "$SERVICE_DIR" "$PROJECT_DIR/logs" "$HOME/Library/LaunchAgents"

"$PYTHON" - <<'PY'
import ipaddress
import json
import os
from pathlib import Path
import plistlib

PROVIDER_KEYS = {
    'CODEX_BIN', 'CODEX_MODEL', 'CONVERSATION_PROVIDER', 'CONVERSATION_BASE_URL',
    'CONVERSATION_MODEL', 'CONVERSATION_API_KEY', 'CONVERSATION_ALLOW_KEYLESS',
    'OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_MODEL', 'QWEN_BASE_URL', 'QWEN_MODEL', 'QWEN_API_KEY',
    'DASHSCOPE_API_KEY',
}

project = Path(os.environ['WLK_SERVICE_PROJECT'])
host = os.environ['WLK_SERVICE_HOST']
ip = ipaddress.ip_address(host)
allowed = any(ip in network for network in (
    ipaddress.ip_network('127.0.0.0/8'), ipaddress.ip_network('::1/128'),
    ipaddress.ip_network('10.0.0.0/8'), ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.168.0.0/16'), ipaddress.ip_network('100.64.0.0/10'),
))
if not allowed:
    raise SystemExit('Bind to a specific loopback, LAN, or Tailscale address.')
# Keep Codex's saved account behind loopback/Tailscale, even when LAN binding
# would otherwise be permitted for a speech-only installation.
private_codex_bind = ip.is_loopback or ip in ipaddress.ip_network('100.64.0.0/10')
provider_file = project / '.service' / 'provider-env.json'
provider_environment = json.loads(provider_file.read_text()) if provider_file.exists() else {}
provider_environment = {k: v for k, v in provider_environment.items() if k in PROVIDER_KEYS and isinstance(v, str)}
source_env = project / 'server.env'
if source_env.exists():
    if source_env.stat().st_mode & 0o077:
        raise SystemExit('Make server.env private first: chmod 600 server.env')
    for line in source_env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not separator or key not in PROVIDER_KEYS:
            raise SystemExit('server.env contains an unsupported provider setting.')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        if '\x00' in value:
            raise SystemExit('server.env contains an invalid value.')
        provider_environment[key] = value
for key in PROVIDER_KEYS:
    if key in os.environ:
        provider_environment[key] = os.environ[key]
if not private_codex_bind:
    raise SystemExit('The Codex-enabled backend must bind to loopback or a Tailscale address.')
provider_temporary = provider_file.with_suffix('.json.tmp')
provider_temporary.write_text(json.dumps(provider_environment))
provider_temporary.chmod(0o600)
provider_temporary.replace(provider_file)
port = int(os.environ['WLK_SERVICE_PORT'])
if not 1024 <= port <= 65535:
    raise SystemExit('Port must be between 1024 and 65535.')
plist = Path(os.environ['WLK_SERVICE_PLIST'])
if plist.exists():
    existing = plistlib.loads(plist.read_bytes())
    if existing.get('WorkingDirectory') != str(project):
        raise SystemExit(f'Refusing to replace another project\'s service: {plist}')

# Bound logs to 6 MiB total. The wrapper forwards launchd termination signals
# to the speech process and returns its exit status so KeepAlive can restart it.
runner = project / '.service' / 'run.py'
runner.write_text('''import json
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path
import signal
import subprocess
import sys

project = Path(__file__).resolve().parents[1]
provider_file = project / '.service' / 'provider-env.json'
if provider_file.exists():
    os.environ.update(json.loads(provider_file.read_text()))
logger = logging.getLogger('whisperlivekit.service')
logger.setLevel(logging.INFO)
handler = RotatingFileHandler(project / 'logs' / 'server.log', maxBytes=2 * 1024 * 1024, backupCount=2)
handler.setFormatter(logging.Formatter('%(message)s'))
logger.addHandler(handler)
process = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', bufsize=1)
def terminate(signum, frame):
    if process.poll() is None:
        process.send_signal(signum)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
try:
    for line in process.stdout:
        logger.info(line.rstrip())
finally:
    sys.exit(process.wait())
''')

arguments = [str(project / '.venv/bin/python'), str(runner),
             '/bin/sh', str(project / 'scripts/start-server.sh'),
             '--host', host, '--port', str(port), '--warmup-file', '']
if os.environ.get('WLK_MODEL_DIR'):
    model = Path(os.environ['WLK_MODEL_DIR']).resolve()
    backend = os.environ.get('WLK_BACKEND', 'faster-whisper')
    filename = 'weights.npz' if backend == 'mlx-whisper' else 'model.bin'
    if not (model / filename).is_file():
        raise SystemExit(f'Missing Whisper model {filename}: {model}')
    arguments.extend(['--model_dir', str(model)])
if os.environ.get('WLK_CHUNK_SIZE'):
    chunk_size = float(os.environ['WLK_CHUNK_SIZE'])
    if not 0.1 <= chunk_size <= 3:
        raise SystemExit('WLK_CHUNK_SIZE must be between 0.1 and 3 seconds.')
    arguments.extend(['--vac-chunk-size', str(chunk_size), '--min-chunk-size', str(chunk_size)])

environment = {
    'PATH': f"{project / '.venv/bin'}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    'PYTHONUNBUFFERED': '1', 'TOKENIZERS_PARALLELISM': 'false',
}
for key in ('HF_HOME', 'HF_HUB_OFFLINE', 'WLK_TASK', 'WLK_DIARIZATION',
            'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'WLK_BEAM_SIZE', 'WLK_BACKEND'):
    if key in os.environ:
        environment[key] = os.environ[key]
payload = {
    'Label': os.environ['WLK_SERVICE_LABEL'], 'ProgramArguments': arguments,
    'WorkingDirectory': str(project), 'EnvironmentVariables': environment,
    'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30,
    # Live captions directly affect app responsiveness; background QoS can
    # throttle speech inference severely on Apple Silicon efficiency cores.
    'ProcessType': 'Interactive', 'ExitTimeOut': 20,
}
temporary = plist.with_suffix('.plist.tmp')
temporary.write_bytes(plistlib.dumps(payload))
temporary.chmod(0o600)
temporary.replace(plist)
print(f'Prepared {plist}')
PY

DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  # bootout can return while the old speech process is still shutting down.
  ATTEMPTS=0
  while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -ge 30 ]; then
      printf '%s\n' 'The previous service has not stopped; retry after it exits.' >&2
      exit 1
    fi
    sleep 1
  done
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
printf '%s\n' "Installed $LABEL at ws://$BIND_HOST:$PORT/asr" \
  "Logs: $PROJECT_DIR/logs/server.log (rotated, 6 MiB maximum)" \
  "Status: launchctl print $DOMAIN/$LABEL" \
  "Restart: launchctl kickstart -k $DOMAIN/$LABEL"
