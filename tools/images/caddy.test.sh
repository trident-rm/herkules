#!/bin/sh
# Validate the actual app fragments inside the documented infrastructure slots.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cat > "$work/Caddyfile" <<'CADDY'
http://platform.test {
 import /routes/platform.caddy
}
http://bbs.test {
 import /routes/bbs.caddy
}
http://training.test {
 import /routes/training.caddy
}
http://ai.test {
 import /routes/ai.caddy
}
CADDY
docker run --rm -v "$work/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$root/tools/images/caddy:/routes:ro" \
  caddy:2.10-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > "$work/config.json"
python3 - "$work/config.json" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
encoded = json.dumps(config)
for value in ['/auth/internal/*', '/auth/*', '/.well-known/*', '/mcp/bbs*', '/mcp/feishu*', 'feishu:3005', 'auth:3001', 'bbs:3003', 'inference:4010', '/srv/training']:
    assert value in encoded, value
# The internal route must still reject requests; imports must not lose that guard.
def visit(value):
    if isinstance(value, dict):
        yield value
        for child in value.values(): yield from visit(child)
    elif isinstance(value, list):
        for child in value: yield from visit(child)
assert any(v.get('handler') == 'static_response' and v.get('status_code') == 404 for v in visit(config))
PY
echo 'Application Caddy fragments passed'

sh "$root/tools/images/training.test.sh"
