#!/bin/sh
# Actual release-image smoke test. Never uses the existing corpus or services.
set -eu
jobs_image=${BBS_JOBS_TEST_IMAGE:-herkules-bbs-jobs:test}
web_image=${BBS_WEB_TEST_IMAGE:-herkules-bbs-web:test}
task_name="herkules-bbs-web-test-$$"
cleanup() {
  docker rm -f "$task_name-web" "$task_name-db" >/dev/null 2>&1 || true
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
