#!/usr/bin/env bash
# Backup diário do banco da loja CounterFlame com rotação (mantém 14 dias).
# Usa a API .backup() do better-sqlite3 (snapshot consistente mesmo com o app escrevendo).
# Não depende do CLI sqlite3 do sistema.
set -euo pipefail

APP_DIR="/home/ramos/cf-teste-deploy"
DEST="$APP_DIR/backups"
KEEP=14

mkdir -p "$DEST"
chmod 700 "$DEST"

export BH_APP_DIR="$APP_DIR" BH_DEST="$DEST"

# carrega o node do NVM
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

cd "$APP_DIR"
node -e '
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const appDir = process.env.BH_APP_DIR;
const dest = process.env.BH_DEST;
const dbPath = path.join(appDir, "loja.db");
if (!fs.existsSync(dbPath)) { console.error("DB nao encontrado:", dbPath); process.exit(1); }
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(dest, `loja-${stamp}.db`);
const db = new Database(dbPath, { readonly: true });
db.backup(out).then(() => {
  db.close();
  fs.chmodSync(out, 0o600);
  console.log("backup ok:", out);
}).catch((e) => { console.error("falha no backup:", e.message); process.exit(1); });
'

# empacota o mais recente junto com a chave das impressões (.fp_key: HMAC de conta/IP).
# Sem a chave, um banco restaurado perde os bloqueios por conta/IP.
# Restaurar: gpg -d arquivo.tar.gz.gpg | tar -xz   → loja-<data>.db e .fp_key
LATEST=$(ls -t "$DEST"/loja-*.db 2>/dev/null | head -1 || true)
if [ -n "$LATEST" ]; then
  PKG="${LATEST%.db}.tar.gz"
  (umask 077; tar -czf "$PKG" -C "$DEST" "$(basename "$LATEST")" $( [ -f "$APP_DIR/.fp_key" ] && echo "-C $APP_DIR .fp_key" ))
  chmod 600 "$PKG"
  rm -f "$LATEST"
  LATEST="${PKG%.gz}"   # abaixo o script usa "$LATEST.gz"
fi

# ---- cópia fora da VPS: criptografa e envia pelo bot do Telegram ----
# Ativa só se TG_BOT_TOKEN, TG_CHAT_ID e BACKUP_PASSPHRASE estiverem no .env.
# Segredos lidos do .env sem `source` e nunca passados na linha de comando (não aparecem no `ps`).
envval() { grep -m1 "^$1=" "$APP_DIR/.env" | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true; }
TG_BOT_TOKEN=$(envval TG_BOT_TOKEN)
TG_CHAT_ID=$(envval TG_CHAT_ID)
BACKUP_PASSPHRASE=$(envval BACKUP_PASSPHRASE)
if [ -n "${LATEST:-}" ] && [ -n "$TG_BOT_TOKEN" ] && [ -n "$TG_CHAT_ID" ] && [ -n "$BACKUP_PASSPHRASE" ]; then
  ENC="$LATEST.gz.gpg"
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
    --symmetric --cipher-algo AES256 -o "$ENC" "$LATEST.gz"
  chmod 600 "$ENC"
  N_PED=$(BH_DB="$APP_DIR/loja.db" node -e 'const D=require("better-sqlite3");const d=new D(process.env.BH_DB,{readonly:true});console.log(d.prepare("SELECT COUNT(*) n FROM orders").get().n)' 2>/dev/null || echo "?")
  CAPTION="Backup loja.db $(date '+%d/%m %H:%M') · $N_PED pedidos · $(du -h "$ENC" | cut -f1)"
  senddoc() {  # $1 = chat, $2 = tópico (ou vazio)
    printf 'url = "https://api.telegram.org/bot%s/sendDocument"\n' "$TG_BOT_TOKEN" | curl -sS --max-time 60 -K - \
      -F "chat_id=$1" ${2:+-F "message_thread_id=$2"} -F "document=@$ENC" -F "caption=$CAPTION" || true
  }
  # tópico 🗄️ Sistema do grupo (se configurado); se o grupo falhar, manda no chat privado
  read -r TG_GRUPO TG_TOPICO <<< "$(node "$APP_DIR/tools/tg-destino.cjs" sistema 2>/dev/null)"
  RESP=""
  [ -n "${TG_GRUPO:-}" ] && RESP=$(senddoc "$TG_GRUPO" "$TG_TOPICO")
  printf '%s' "$RESP" | grep -q '"ok":true' || RESP=$(senddoc "$TG_CHAT_ID" "")
  rm -f "$ENC"
  if printf '%s' "$RESP" | grep -q '"ok":true'; then
    echo "[$(date -Is)] enviado ao Telegram"
  else
    echo "[$(date -Is)] FALHA ao enviar ao Telegram: $(printf '%s' "$RESP" | grep -o '"description":"[^"]*"' || echo sem resposta)"
    UPLOAD_FAIL=1
  fi

  # ---- cópia do CÓDIGO fora da VPS (1x por dia, na rodada das 18h ou com CODE_BACKUP=1) ----
  # git bundle com todo o histórico + a skill da loja; mesmo cifrado (AES256) e mesmo destino.
  # Restaurar: gpg -d codigo-<data>.tar.gz.gpg | tar -xz && git clone codigo.bundle cf-teste-deploy
  # (o .env e os segredos NÃO vão: ficam só na VPS/no gerenciador do operador)
  if [ "$(date +%H)" = "18" ] || [ "${CODE_BACKUP:-0}" = "1" ]; then
    CTMP=$(mktemp -d)
    git -C "$APP_DIR" bundle create "$CTMP/codigo.bundle" --all >/dev/null 2>&1
    SKILL="$HOME/.hermes/skills/software-development/cf-store-counterflame/SKILL.md"
    [ -f "$SKILL" ] && cp "$SKILL" "$CTMP/SKILL-cf-store.md"
    CPKG="$DEST/codigo-$(date +%Y-%m-%dT%H-%M).tar.gz"
    (umask 077; tar -czf "$CPKG" -C "$CTMP" .)
    rm -rf "$CTMP"
    ENC="$CPKG.gpg"
    printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
      --symmetric --cipher-algo AES256 -o "$ENC" "$CPKG"
    rm -f "$CPKG"
    CAPTION="Backup do código $(date '+%d/%m %H:%M') · $(git -C "$APP_DIR" rev-list --count HEAD) commits · último $(git -C "$APP_DIR" log -1 --format=%h) · $(du -h "$ENC" | cut -f1)"
    RESP=""
    [ -n "${TG_GRUPO:-}" ] && RESP=$(senddoc "$TG_GRUPO" "$TG_TOPICO")
    printf '%s' "$RESP" | grep -q '"ok":true' || RESP=$(senddoc "$TG_CHAT_ID" "")
    rm -f "$ENC"
    if printf '%s' "$RESP" | grep -q '"ok":true'; then
      echo "[$(date -Is)] código enviado ao Telegram"
    else
      echo "[$(date -Is)] FALHA ao enviar o código: $(printf '%s' "$RESP" | grep -o '"description":"[^"]*"' || echo sem resposta)"
      UPLOAD_FAIL=1
    fi
  fi
else
  echo "[$(date -Is)] envio externo desativado (faltam TG_BOT_TOKEN/TG_CHAT_ID/BACKUP_PASSPHRASE no .env)"
fi

# rotação: remove backups com mais de KEEP dias
find "$DEST" \( -name 'loja-*.db.gz' -o -name 'loja-*.tar.gz' \) -mtime +$KEEP -delete

echo "[$(date -Is)] backup concluido"
exit "${UPLOAD_FAIL:-0}"
