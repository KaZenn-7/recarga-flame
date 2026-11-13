#!/usr/bin/env bash
# Alerta de loja fora do ar (roda pelo cron a cada 5 min, FORA do app).
# Avisa no Telegram só na mudança de estado: caiu (2 falhas seguidas, evita alarme falso) e voltou.
set -uo pipefail
APP_DIR="/home/ramos/cf-teste-deploy"
STATE="$APP_DIR/.health_state"   # "ok" ou "down:<n falhas>"
envval() { grep -m1 "^$1=" "$APP_DIR/.env" | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true; }
URL="$(envval PUBLIC_URL)/api/products"
TG_BOT_TOKEN=$(envval TG_BOT_TOKEN); TG_CHAT_ID=$(envval TG_CHAT_ID)

# tópico 🚨 Alertas do grupo (se configurado); se o grupo falhar, manda no chat privado
read -r TG_GRUPO TG_TOPICO <<< "$(node "$APP_DIR/tools/tg-destino.cjs" alertas 2>/dev/null)"
tgpost() {  # $1 = chat, $2 = tópico (ou vazio), $3 = texto
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TG_BOT_TOKEN" | curl -sS --max-time 15 -K - \
    --data-urlencode "chat_id=$1" ${2:+--data-urlencode "message_thread_id=$2"} --data-urlencode "text=$3" 2>/dev/null | grep -q '"ok":true'
}
send() {
  [ -n "$TG_BOT_TOKEN" ] && [ -n "$TG_CHAT_ID" ] || return 0
  if [ -n "${TG_GRUPO:-}" ] && tgpost "$TG_GRUPO" "$TG_TOPICO" "$1"; then return 0; fi
  tgpost "$TG_CHAT_ID" "" "$1" || true
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

# ---- saúde por dentro (só com a loja no ar): botões do Telegram, conta separada/saldo, pagamento preso, banco ----
# /api/health só responde pela própria máquina. Avisa na mudança de estado (2 checagens seguidas = 10 min).
[ "$CODE" = "200" ] || exit 0
HSTATE="$APP_DIR/.health_state_int"   # "ok" ou "bad:<n>"
PORT=$(envval PORT); PORT=${PORT:-3102}
HJSON=$(curl -s --max-time 15 "http://127.0.0.1:$PORT/api/health" || true)
# versão da loja sem a rota (404 em HTML): não há o que conferir
case "$HJSON" in "<"*) exit 0 ;; esac
FALHAS=$(printf '%s' "$HJSON" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("rota /api/health não respondeu"); sys.exit()
print("" if d.get("ok") else "; ".join(d.get("falhas") or ["falha desconhecida"]))' 2>/dev/null)
HPREV=$(cat "$HSTATE" 2>/dev/null || echo ok)
if [ -z "$FALHAS" ]; then
  if [ "${HPREV%%:*}" = "bad" ] && [ "${HPREV#bad:}" -ge 2 ] 2>/dev/null; then
    send "✅ Problema interno da loja resolvido ($(date '+%d/%m %H:%M'))."
  fi
  echo ok > "$HSTATE"
else
  N=1; [ "${HPREV%%:*}" = "bad" ] && N=$(( ${HPREV#bad:} + 1 ))
  echo "bad:$N" > "$HSTATE"
  if [ "$N" -eq 2 ]; then
    send "⚠️ Loja no ar, mas com problema ($(date '+%d/%m %H:%M')): $FALHAS. Ver: pm2 logs cf-teste"
  fi
  echo "[$(date -Is)] saúde $N: $FALHAS"
fi
