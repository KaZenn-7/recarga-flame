#!/usr/bin/env bash
# Teste de restauração de um backup cifrado (o mesmo arquivo que vai para o Telegram):
# decifra com a senha do .env, extrai numa pasta temporária (dentro de backups/, 700), abre o banco e confere:
# integridade do SQLite, versão do esquema, nº de pedidos (> 0 e não mais que o banco atual) e .fp_key igual à atual.
# Uso: tools/verificar-backup.sh <arquivo.tar.gz.gpg>   → imprime "ok: N pedidos" (exit 0) ou "FALHA: motivo" (exit 1)
# A senha vai pelo descritor (fd 0 do gpg), nunca na linha de comando. Nada é impresso além do resultado.
set -uo pipefail
APP_DIR="/home/ramos/cf-teste-deploy"
ENC="${1:-}"
falha() { echo "FALHA: $1"; exit 1; }
[ -f "$ENC" ] || falha "arquivo não encontrado"
envval() { grep -m1 "^$1=" "$APP_DIR/.env" | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true; }
PASS=$(envval BACKUP_PASSPHRASE)
[ -n "$PASS" ] || falha "BACKUP_PASSPHRASE ausente no .env"

TMP=$(umask 077; mktemp -d "$APP_DIR/backups/.verif.XXXXXX") || falha "sem pasta temporária"
trap 'rm -rf "$TMP"' EXIT
printf '%s' "$PASS" | gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 -d "$ENC" 2>/dev/null \
  | tar -xz -C "$TMP" 2>/dev/null || falha "não decifrou/extraiu (senha ou arquivo)"
DBF=$(ls "$TMP"/loja-*.db 2>/dev/null | head -1)
[ -n "$DBF" ] || falha "banco ausente no pacote"
if [ -f "$APP_DIR/.fp_key" ]; then
  [ -f "$TMP/.fp_key" ] || falha ".fp_key ausente no pacote"
  cmp -s "$TMP/.fp_key" "$APP_DIR/.fp_key" || falha ".fp_key diferente da atual"
fi
VF_DB="$DBF" VF_LIVE="$APP_DIR/loja.db" node -e '
const D = require("better-sqlite3");
const b = new D(process.env.VF_DB, { readonly: true });
const ic = b.pragma("integrity_check", { simple: true });
if (ic !== "ok") { console.log("FALHA: integridade " + ic); process.exit(1); }
const v = b.pragma("user_version", { simple: true });
const n = b.prepare("SELECT COUNT(*) n FROM orders").get().n;
const live = new D(process.env.VF_LIVE, { readonly: true }).prepare("SELECT COUNT(*) n FROM orders").get().n;
if (!v) { console.log("FALHA: banco sem versão de esquema"); process.exit(1); }
if (!n || n > live) { console.log(`FALHA: ${n} pedidos no backup, ${live} no banco atual`); process.exit(1); }
console.log(`ok: ${n} pedidos, esquema v${v}`);
' 2>/dev/null || exit 1
