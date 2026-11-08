#!/usr/bin/env bash
# Alerta de loja fora do ar (roda pelo cron a cada 5 min, FORA do app).
# Avisa no Telegram só na mudança de estado: caiu (2 falhas seguidas, evita alarme falso) e voltou.
set -uo pipefail
APP_DIR="/home/ramos/cf-teste-deploy"
STATE="$APP_DIR/.health_state"   # "ok" ou "down:<n falhas>"
envval() { grep -m1 "^$1=" "$APP_DIR/.env" | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true; }
URL="$(envval PUBLIC_URL)/api/products"
TG_BOT_TOKEN=$(envval TG_BOT_TOKEN); TG_CHAT_ID=$(envval TG_CHAT_ID)

send() {
  [ -n "$TG_BOT_TOKEN" ] && [ -n "$TG_CHAT_ID" ] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TG_BOT_TOKEN" | curl -sS --max-time 15 -K - \
    --data-urlencode "chat_id=$TG_CHAT_ID" --data-urlencode "text=$1" >/dev/null || true
}

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL" || true); [ -n "$CODE" ] || CODE=000
PREV=$(cat "$STATE" 2>/dev/null || echo ok)

if [ "$CODE" = "200" ]; then
  if [ "${PREV%%:*}" = "down" ] && [ "${PREV#down:}" -ge 2 ] 2>/dev/null; then
    send "✅ Loja voltou ao ar ($(date '+%d/%m %H:%M'))."
  fi
  echo ok > "$STATE"
else
  N=1; [ "${PREV%%:*}" = "down" ] && N=$(( ${PREV#down:} + 1 ))
  echo "down:$N" > "$STATE"
  if [ "$N" -eq 2 ]; then
    send "🔴 Loja FORA DO AR ($(date '+%d/%m %H:%M')) — $URL respondeu HTTP $CODE. Ver: pm2 status cf-teste / pm2 logs cf-teste"
  fi
  echo "[$(date -Is)] falha $N: HTTP $CODE"
fi
