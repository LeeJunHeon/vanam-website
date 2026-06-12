#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

TS="$(date +%Y%m%d-%H%M%S)"
LOG="build-logs/build-$TS.log"
mkdir -p build-logs

echo "▶ VANAM build $TS" | tee "$LOG"

# 빌드 전 스냅샷(깃 저장소일 때만)
if [ -d .git ]; then
  git add -A && git commit -m "snapshot before build $TS" >/dev/null 2>&1 || true
fi

npm run build 2>&1 | tee -a "$LOG"
STATUS=${PIPESTATUS[0]}

if [ "$STATUS" -eq 0 ]; then
  echo "✅ BUILD OK ($TS)" | tee -a "$LOG"
else
  echo "❌ BUILD FAILED (exit $STATUS) — $TS" | tee -a "$LOG"
  echo "── 마지막 에러 ──"; tail -n 30 "$LOG"
fi

# Google Chat 알림 (WEBHOOK_URL 설정 시에만)
if [ -n "${WEBHOOK_URL:-}" ]; then
  if [ "$STATUS" -eq 0 ]; then MSG="✅ VANAM 빌드 성공 ($TS)"; else MSG="❌ VANAM 빌드 실패 ($TS) — 로그 확인"; fi
  curl -s -X POST "$WEBHOOK_URL" -H 'Content-Type: application/json' -d "{\"text\":\"$MSG\"}" >/dev/null || true
fi

exit $STATUS
