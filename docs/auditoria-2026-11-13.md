# Auditoria da Recarga Flame — 13/11/2026

Auditoria só de leitura (código, banco, logs, configurações), separada por setor. Prioridade: 🔴 alta · 🟡 média · ⚪ baixa.
Status de cada sugestão: **✅ feito**, **⬜ pendente** ou **➖ decidido não fazer** (com o motivo).

## Visão geral
- Nenhum 5xx no nginx entre 10 e 13/11 (650× 200, 603× 304, 58× 404).
- `npm audit`: 0 vulnerabilidades. Só o eslint está desatualizado (9 → 10).
- PM2: 0 reinícios inesperados; pm2-logrotate (10 MB, 7 dias).
- Entregas: 52 de 55 automáticas. Tempo: mediana 7 s, p90 28 s, pior 415 s.
- Testes: 131 de unidade (134 após os itens feitos) + teste no navegador (`test:e2e`).

## 1. Pagamento (Pix / Mercado Pago)
**Bem:** preço sempre calculado no servidor; webhook com assinatura HMAC; pagamento conferido pela API do MP (não pelo corpo do webhook); confirmação dupla (consulta + webhook) sem aviso duplicado; tempo limite de 15 s no Pix e 8 s na sincronização.
- ➖ ⚪ (decidido não fazer: um aviso repetido só faz a loja consultar o MP de novo — nada muda sem o MP confirmar; recusar por idade arrisca perder avisos legítimos reenviados pelo MP) O webhook não confere a idade do `ts` da assinatura. Risco baixo (só dispara uma consulta ao MP); recusar avisos com mais de 10 min fecha a porta para repetição.
- ✅ 🟡 ~~Sem `MP_WEBHOOK_SECRET` a loja subiria~~ — falso positivo: `server.js` já recusa subir sem `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `ADMIN_USER`, `ADMIN_PASS` e `PUBLIC_URL`.

## 2. Entrega automática (Stars / conta do Telegram)
**Bem:** um pagamento por vez; trava atômica por pedido; desligamento seguro (espera até 25 s, `kill_timeout` 30 s); "incerto" resolvido sozinho; saldo real lido a cada 5 min.
- ✅ 🔴 **Tempo limite nas chamadas da conta do Telegram (GramJS).** A fila única não tinha limite: uma chamada travada (ex.: os TIMEOUT de 11/11) parava todas as entregas e deixava o pedido em `paying` para sempre.
  Feito: limite de 3 min por tarefa na fila (`makeSerial` em `tg-user.js`), cobrindo o FLOOD_WAIT de até 2 min. Antes de cobrar → erro "nada cobrado" (a tarefa travada desiste de cobrar quando destrava); depois de enviar a cobrança → "incerto" (recibo conferido sozinho). Vigia a cada 1 min avisa em Alertas quando um pedido está "pagando" há mais de 5 min (`vigiaPagamentos` em `src/autopay.js`).
- ✅ 🟡 O `healthcheck.sh` só testava `/api/products`. Feito: `/api/health` (só local) + checagem no monitor. Não detecta sessão do Telegram caída, leitura dos botões parada ou saldo desatualizado. Sugestão: rota `/api/health` com esses estados, usada pelo monitor.
- ✅ ⚪ Limite de saldo baixo: era 500★; pico de 11/11 foi 2.946★ num dia. Feito: padrão 1.500★ (≈ meio dia de pico; `STARS_LOW` no `.env` ainda sobrepõe).

## 3. Carrinho e regras de produto
**Bem:** limites (Arsenal em sequência, níveis até 100, 10 itens) valem na tela, no servidor e na conferência antes de pagar. 4 carrinhos na última semana.
- ✅ 🟡 (feito: `getPlayerVitrine`, 30 s só no `/api/player`; logs mostravam também 429 do CounterFlame) `getPlayer` (CounterFlame) sem cache: chamado em cada busca de ID, atualização de tela e pedido. Cache de 30–60 s por ID só na vitrine; ao gerar o Pix e antes de pagar continua consultando na hora.
- ✅ 🟡 (feito: 400 = conta não encontrada; 429/5xx/sem resposta = 503 "o jogo não respondeu", uma linha no log) CounterFlame 400 (ID inválido) vira erro 500 com stack no log ("CounterFlame respondeu 400", `server.js` getPlayer). Tratar como "Conta não encontrada" limpa o log de erros.

## 4. Telegram (avisos e botões)
**Bem:** só o operador usa os botões; mensagens editadas em vez de duplicadas; tópicos; se o grupo falhar, vai no privado.
- ✅ 🟡 (feito: entra na `/api/health`) `tgPoll` falhando tenta de novo a cada 5 s sem limite e sem avisar (um token revogado deixaria os botões mortos em silêncio). Avisar após N falhas seguidas (pode entrar na `/api/health`).

## 5. Painel e login
**Bem:** senha + código pelo Telegram; sessão com prazo e renovação; proteção contra força bruta; ações exigem origem própria ou `x-painel`. Cookie `cf_sess` em `Lax` (correção do F5 no iPhone, b84a5e3).
- ✅ ⚪ 8 sessões ativas, todas do mesmo iPhone. Feito: botão 🔒 no painel lista as sessões (aparelho, IP, datas) e encerra uma ou todas as outras.
- ✅ ⚪ O código de login mostrava só o IP. Feito: "IP: … · iPhone · Chrome".

## 6. Parcerias, cupons e comissões
**Bem:** histórico de alterações, extrato mensal, fechamento automático no 1º dia útil.
- ✅ 🟡 Dados pendentes dos parceiros. Situação em 13/11: AQUILA (cupom que mais vende) tem nome e e-mail, **falta só a chave Pix**; IANSO2 sem dados e sem vendas; NEXUS e RAMOS5 não existem mais.
  Feito: lembrete no dia 25 às 9h (1x/mês, tópico Parcerias) com quem tem comissão e está sem Pix/e-mail; fechamento marca "⚠️ sem chave Pix/e-mail" (`lembreteDadosTick` em `src/parceiros.js`). ⬜ Cadastrar a chave Pix da AQUILA antes de 01/12.
- ✅ ⚪ (`orders.coupon` entrou na migração v5; `events.coupon` não precisa: a consulta usa `events_ts`) Sem índice em `orders.coupon` / `events.coupon`. Irrelevante hoje (76 pedidos, 1.205 eventos).

## 7. E-mail
**Bem:** um e-mail por carrinho; chave do Resend só de envio; DKIM `resend._domainkey`; SPF do Resend no subdomínio `send.`.
- ⬜ 🟡 DMARC `p=none` e sem `rua`. DNS no Registro.br (operador). Passos: (1) alias `dmarc@` no ImprovMX → seu e-mail; (2) TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:dmarc@recargaflame.com.br; adkim=r; aspf=r`; (3) após 2–4 semanas de relatórios limpos, trocar `p=none` por `p=quarantine`.
- ⬜ ⚪ Sem registro CAA no DNS (operador, Registro.br): CAA `0 issue "letsencrypt.org"` no domínio raiz — só a Let's Encrypt pode emitir certificado.

## 8. Loja (frontend), SEO e desempenho
Funil dos últimos 7 dias (aparelhos únicos):

| Etapa | Aparelhos | Passagem |
|---|---|---|
| Visita | 228 | — |
| Buscou ID | 129 | 57% |
| Escolheu produto | 81 | 63% |
| Gerou Pix | 43 | 53% |
| Pagou | 34 | 79% |
| Entregue | 34 | 100% |

- ✅ 🔴 **Maior perda: escolher produto → gerar Pix (47%).** Achado: 26 tentativas recusadas pela loja (400, e-mail vazio/incompleto) contra 80 Pix gerados (06–12/11); o aviso aparecia embaixo dos termos.
  Feito: e-mail conferido antes de enviar, com aviso junto do campo e foco; e-mail lembrado no aparelho; erros da tela registrados no funil (`err_email`, `err_regra`, `err_pix`) e mostrados no painel. Comparar a passagem select→pix (53% antes) após 1 semana. ✅ Botão de pagar no celular (14/11): medido em 360×560, 375×553, 390×664 e 412×780, ficava 109–372 px abaixo da tela. Agora fica numa barra fixa no rodapé (`.paybar`, sticky) com o total ("Gerar Pix de R$ X"), e a caixa de cupom da confirmação vem fechada.
- ✅ 🟡 Imagens com `Cache-Control: max-age=0` (feito: `/img` com 1 dia) (express.static sem `maxAge`): toda visita revalida as imagens (uma levou ~270 ms). `maxAge` de 30 dias, ou `immutable` com versão no nome.
- ✅ ⚪ (feito: 16 `.jpg` movidos para `cf-teste-deploy-archive/2026-11-07/img-jpg-antigos`; padrão de imagem do produto agora `/img/<key>.webp`) 15 `.jpg` antigos em `public/img` sem uso (~1 MB; produtos usam `.webp`). Atenção: `c1000.jpg` é usado pelo fallback `/img/${key}.jpg`.
- ✅ ⚪ CSP com `'unsafe-inline'`; falta `Permissions-Policy`; HSTS sem `includeSubDomains`/`preload`. Feito: `script-src` só com hashes dos `<script>` fixos (calculados ao subir), `onerror` virou listener; `Permissions-Policy`; HSTS `includeSubDomains` (www tem HTTPS). `preload` não: é compromisso difícil de desfazer. `style-src 'unsafe-inline'` fica (estilos não executam código).

## 9. Banco de dados e backups
**Bem:** backup a cada 6 h, consistente, criptografado (gpg), enviado ao tópico Sistema, rotação de 14 dias. `.env`, `.fp_key`, `.tg_user_session` com permissão 600; `.env` fora do git.
- ✅ 🟡 `journal_mode=delete` (feito: WAL + busy_timeout 5 s). Com WAL, leituras (painel, análises) não bloqueiam escritas (webhook, pagamento). Precisa de backup antes e restart.
- ✅ 🟡 (feito: migração v5) Sem índices em `orders(game_id)`, `orders(status)`, `orders(mp_id)`, `orders(lower(email))`, `events(dev)`. Antifraude, fila e lembretes leem a tabela inteira (rápido hoje, cresce com as vendas).
- ✅ 🟡 **Nenhum teste de restauração de backup.** Feito: `tools/verificar-backup.sh` roda a cada backup no arquivo cifrado enviado; resultado na legenda. Teste mensal: decifrar o último backup numa pasta temporária e conferir se abre e tem o número certo de pedidos.
- ➖ ⚪ (decidido não fazer: a página do parceiro mostra visitas "desde o início"; ~60 mil linhas/ano é pouco para o SQLite) Tabela `events` sem retenção (1.205 linhas).

## 10. Servidor, deploy e operação
**Bem:** Node só em 127.0.0.1; `trust proxy 1`; certificado até 05/02/2027 com renovação automática; logrotate; PM2 sobe com o sistema; json limit 10 kb; rate limits (/api 120/min, pedidos 5/min, player 15/min).
- ✅ 🔴 **Erros não tratados.** Não havia `unhandledRejection`/`uncaughtException`; no Node 24 uma promise rejeitada sem `catch` derruba o processo (pagamento em andamento viraria "incerto").
  Feito: `unhandledRejection` registra, avisa no tópico Sistema (no máximo 1 aviso a cada 10 min) e a loja segue no ar; `uncaughtException` registra, avisa e sai pelo desligamento seguro (espera o pagamento em andamento) e o PM2 sobe de novo (`erroNaoTratado` em `server.js`).
- ✅ 🟡 (feito: `registrarDeploy` — ao subir, avisa no tópico Sistema o commit publicado, os commits novos desde o último deploy e alterações não commitadas) Várias sessões fazendo commits na mesma pasta: um restart publica tudo o que estiver no código (já aconteceu com a9b5720). Antes de cada restart, conferir `git log` desde o último deploy e registrar o hash publicado.
- ⬜ 🟡 Decisões do operador (pendentes da auditoria anterior): reboot da VPS (67 atualizações), SSH só por chave (`PasswordAuthentication`), `X11Forwarding`, portas em todas as interfaces (bloqueadas pelo UFW).
- ✅ ⚪ Sem `max_memory_restart` no PM2 (feito: 400M; usa ~115 MB; reinício passa pelo desligamento seguro). Rate limit/cache no nginx para `/img`: não precisa (o Node já manda cache de 1 dia; mexer no nginx afeta outros sites).
- Contexto: VPS no ar há 26 dias, carga 2,4–2,9 (compartilhada), disco 34%, 3,1 GB de RAM livre.

## 11. Observabilidade
- ✅ 🟡 `healthcheck.sh` agora também consulta `/api/health` (botões, sessão/saldo, pagamento preso, banco).
- ✅ Vigia de pagamento parado e aviso de erro não tratado (setores 2 e 10).
- ✅ ⚪ TIMEOUT do GramJS em 11/11: coberto pelo tempo limite da fila, vigia e `/api/health` (avisam se repetir).

## 12. Qualidade do código e testes
**Bem:** testes cobrem dinheiro, antifraude, entrega e carrinho; lint limpo.
- ➖ ⚪ (adiado: sem ganho para o cliente e risco de quebrar; separar quando mexer nessas partes) `server.js` (~980 linhas) e `views/painel.client.js` (953) são os maiores; separar análises e rotas do admin em módulo próprio (como checkout e autopay).
- ✅ ⚪ `test:e2e` fora do `npm test`. Feito: `npm run verificar` (lint + testes + navegador), usado no deploy quando mexer em `public/` ou no painel.

## Ordem sugerida
1. ✅ Tempo limite e vigia na fila de pagamento do Telegram.
2. ✅ Registro de erros não tratados.
3. ✅ Perda entre escolher o produto e gerar o Pix (e-mail).
4. ✅ Lembrete automático de dados de parceiros (⬜ falta a chave Pix da AQUILA).
5. ✅ `/api/health` completa, cache das imagens, índices + WAL, teste de restauração do backup.
