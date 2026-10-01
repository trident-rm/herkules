#!/bin/sh
# Actual release-image smoke test. Never uses the existing corpus or services.
set -eu
jobs_image=${BBS_JOBS_TEST_IMAGE:-herkules-bbs-jobs:test}
web_image=${BBS_WEB_TEST_IMAGE:-herkules-bbs-web:test}
task_name="herkules-bbs-web-test-$$"
cleanup() {
  docker rm -f "$task_name-web" "$task_name-worker" "$task_name-db" >/dev/null 2>&1 || true
  docker network rm "$task_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker network create "$task_name" >/dev/null
docker run -d --name "$task_name-db" --network "$task_name" --network-alias postgres \
  -e POSTGRES_USER=bbs -e POSTGRES_PASSWORD=local-container-test -e POSTGRES_DB=bbs \
  postgres:18-alpine >/dev/null
attempt=0
until docker exec "$task_name-db" pg_isready -U bbs -d bbs >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || exit 1
  sleep 1
done
# The jobs image owns the unchanged Drizzle migration history and rederivation.
docker run --rm --network "$task_name" \
  -e DATABASE_URL=postgres://bbs:local-container-test@postgres/bbs \
  -e APP_ORIGIN=https://bbs.example -e PUBLIC_ORIGIN=https://platform.example \
  -e BBS_CLIENT_SECRET=container-test-client-secret-00000000000000000000000000000000 \
  -e BBS_COOKIE_SECRET=container-test-cookie-secret-00000000000000000000000000000000 \
  "$jobs_image" migrate
docker run -d --name "$task_name-web" --network "$task_name" \
  -e DATABASE_URL=postgres://bbs:local-container-test@postgres/bbs \
  -e APP_ORIGIN=https://bbs.example -e PUBLIC_ORIGIN=https://platform.example \
  -e BBS_CLIENT_SECRET=container-test-client-secret-00000000000000000000000000000000 \
  -e BBS_COOKIE_SECRET=container-test-cookie-secret-00000000000000000000000000000000 \
  "$web_image" >/dev/null
attempt=0
until [ "$(docker inspect --format '{{.State.Health.Status}}' "$task_name-web")" = healthy ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then docker logs "$task_name-web"; exit 1; fi
  sleep 1
done
docker exec "$task_name-web" sh -ec '
  ! command -v node
  ! command -v npm
  test "$(cat /proc/1/comm)" = herkules-bbs
  test "$(id -u)" != 0
  test ! -d /app/node_modules
  wget -qO /tmp/index http://127.0.0.1:3003/
  wget -qO /tmp/account http://127.0.0.1:3003/account
  cmp /tmp/index /tmp/account
  grep -q "<script" /tmp/index
  wget -qO /tmp/feed http://127.0.0.1:3003/api/articles
  grep -q "items" /tmp/feed
  wget -qO /tmp/robots http://127.0.0.1:3003/robots.txt
  grep -q "User-agent" /tmp/robots
  ! wget -qO /tmp/missing http://127.0.0.1:3003/assets/missing.js
  test ! -s /tmp/missing
  awk "/^VmRSS:/ { print }" /proc/1/status
'
docker stop --time 10 "$task_name-web" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$task_name-web")" = 0
echo 'Rust-only BBS image smoke test passed: preparation, readiness, assets/API, nonroot Rust PID 1, no Node and graceful shutdown'

# A persisted open circuit makes this worker smoke send no requests to RoboMaster.
docker exec -i "$task_name-db" psql -U bbs -d bbs -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO source_guard_state(source_id,state_json,updated_at)
VALUES ('robomaster', jsonb_build_object(
  'consecutive_failures',1,'open_until_ms',floor(extract(epoch FROM now())*1000)+3600000,
  'minute_bucket_start_ms',floor(extract(epoch FROM now())*1000),'minute_count',0,
  'day_bucket_start_ms',floor(extract(epoch FROM now())/86400)*86400000,'day_count',0,
  'last_request_at_ms',null,'last_failure_at_ms',null,'last_failure_reason','container fixture safety',
  'total_requests',123),now())
ON CONFLICT(source_id) DO UPDATE SET state_json=excluded.state_json;
SQL
docker run -d --name "$task_name-worker" --network "$task_name" --no-healthcheck \
  -e DATABASE_URL=postgres://bbs:local-container-test@postgres/bbs \
  "$web_image" work >/dev/null
attempt=0
until docker logs "$task_name-worker" 2>&1 | grep -q 'crawler started'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then docker logs "$task_name-worker"; exit 1; fi
  sleep 1
done
docker exec "$task_name-worker" sh -ec '
  ! command -v node
  test "$(cat /proc/1/comm)" = herkules-bbs
  test "$(id -u)" != 0
  awk "/^VmRSS:/ { print }" /proc/1/status
'
docker stop --time 15 "$task_name-worker" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$task_name-worker")" = 0
test "$(docker exec "$task_name-db" psql -U bbs -d bbs -Atc "SELECT state_json->>'total_requests' FROM source_guard_state WHERE source_id='robomaster'")" = 123
echo 'Rust-only crawler image smoke passed: nonroot Rust PID 1, no Node, persisted limits, no source requests and graceful shutdown'
