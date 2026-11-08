# ROADMAP — CounterFlame (loja de revenda por Pix)

> Plano de escala. A arquitetura atual (`server.js` + `public/` + SQLite) é adequada
> e NÃO precisa ser reescrita. Cada fase adiciona 1-2 peças pequenas DENTRO da
> arquitetura atual, disparada por um marco de volume — não por tempo.
>
> **Princípio:** complexidade só se paga quando a dor aparece (escala, time, ambientes).
> O gargalo real é a entrega manual em Stars: hoje funciona a 2-5 vendas/dia porque o
> operador dá conta. Escalar = remover esse gargalo na ordem abaixo.
>
> **Caminho crítico para vender mais que no WhatsApp:** Fase 0 → Fase 1.

Legenda de status: ⬜ pendente · 🔄 em progresso · ✅ concluído

---

## Fase 0 — Fundação (fazer ANTES de divulgar) 🔴 ✅ CONCLUÍDA (2026-11)
Sem isso, o primeiro pico de tráfego vira prejuízo.

- ✅ **Hardening de segurança** (4 itens auditados) — CONCLUÍDO 2026-11:
  - ✅ Rate limit no `/painel` e rotas admin (anti-brute-force): janela deslizante por IP
    conta só FALHAS; 20 falhas/15min → 429. Login correto SEMPRE passa (operador nunca
    fica trancado fora, mesmo com atacante martelando o mesmo IP).
  - ✅ Escapar `nome`/`img` no frontend da loja (helper `esc()` no render do catálogo).
  - ✅ Headers de segurança no Express (CSP, X-Frame-Options:DENY, nosniff, Referrer-Policy).
  - ✅ Validar `img` no servidor (allowlist: só `/img/arquivo` ou URL `https://`).
  - ✅ Permissões 600 no `.env` e `loja.db` — VPS compartilhada.
- ✅ **Webhook do Mercado Pago** — CONCLUÍDO 2026-11: rota `/webhook/mercadopago` com HMAC,
  URL cadastrada no painel MP (evento Pagamentos), credenciais de produção no `.env`.
  Validado de ponta a ponta com 2 Pix reais de R$0,50: MP chamou o webhook → assinatura
  conferiu → pedido virou `paid` automaticamente (confirmado no nginx access log: HTTP 200).
  BUG CORRIGIDO no caminho: `date_of_expiration` do Pix era calculado 9h no passado (conta
  de fuso errada) → Pix nascia expirado e o banco recusava o QR. Agora expira em +30min
  com offset de fuso correto.
- ✅ **Testes automatizados (núcleo)** — CONCLUÍDO 2026-11: `node --test` (runner nativo,
  zero dependências novas), roda contra DB temporário, mocka CounterFlame e Mercado Pago.
  Cobre o caminho crítico: preço server-side, validação de pagamento, CRUD+validações de
  produto, rate-limit admin (bloqueia brute-force / login correto passa), XSS escapado,
  snapshot do pedido. Rodar `npm test` antes de cada deploy. NÃO testa UI/CSS (ROI baixo).
- ✅ **Backup automático do `loja.db`** — CONCLUÍDO 2026-11: `backup-db.sh` (snapshot via
  better-sqlite3 `.backup()`, gzip, rotação 14 dias, chmod 600, em `backups/`). Cron diário
  às 04h (`crontab -l`). Testado: restaura e abre com as 2 tabelas.

### Fase 0.5 — Complementos de segurança (revisão de 2026-11-06)
Revisão pós-Fase 0. O frontend ser legível (Ctrl+U/Inspecionar) NÃO é risco: não há
segredos nele e o servidor revalida tudo (preço, pagamento, ID, bloqueios).

- ✅ **Backups fora de `public/`** — `index.html.bak.*`, `img_bak/`, `img_bak2/` estavam
  acessíveis por HTTP; movidos para `old-public/` (fora da pasta servida).
- ✅ **HSTS + remover `X-Powered-By`** — `Strict-Transport-Security: max-age=31536000`.
- ⏸️ **Senha do admin forte** (operador troca no `.env`) — ADIADO pelo operador; mitigado pelo 2FA da Fase 1. Hoje 9 caracteres; usar 20+
  aleatórios. O limite de 20 falhas/IP não segura ataque distribuído com senha curta.
- ✅ **Backup fora da VPS** — `backup-db.sh` criptografa o `.gz` (gpg AES-256, senha
  `BACKUP_PASSPHRASE`) e envia pelo bot @db_backups_RecargaFlame_bot (`TG_BOT_TOKEN`,
  `TG_CHAT_ID` no `.env`) todo dia às 04h. Falha de envio fica em `backups/backup.log`.
  Desde 2026-11-07 o pacote é `loja-<data>.tar.gz` (banco + `.fp_key`). Restaurar: `gpg -d … | tar -xz`.
  Restaurar: `gpg -d loja-XXXX.db.gz.gpg | gunzip > loja.db`. A senha fica guardada FORA da VPS.
  O mesmo bot pode ser reaproveitado nas notificações da Fase 1.
- ✅ **App escutar só em `127.0.0.1`** — antes escutava em `*:3102` (bloqueado pelo UFW).
  Defesa em profundidade: se o firewall mudar, ninguém fala com o Node direto e não dá
  pra forjar `X-Forwarded-For` para burlar os rate limits. 1 linha no `app.listen`.

### Experiência do cliente — revisão de 2026-11-06
O fluxo de compra (conta → produto → confirmação → Pix) está bom; os buracos estão no
que o cliente não sabe antes de pagar e no pós-pagamento.

**Antes da Fase 1:**
- ✅ **Contato de suporte visível** — WhatsApp +55 11 95299-7031 e Telegram @kazenn7 no
  rodapé e na tela de pagamento (o WhatsApp já abre com nº do pedido + ID da conta).
- ✅ **Prazo de entrega explícito** — "até 1h; seg–sex 7h–23h; sáb/dom/feriados 11h–23h;
  fora disso, manhã seguinte". Aparece na confirmação (antes do Pix), após pago e no rodapé.
  Texto fixo (não detecta feriado/horário atual) — se mudar o horário, editar `index.html`.
- ✅ **Tela de pagamento corrigida** — tirado o "mantenha esta página aberta" (falso: webhook
  confirma sozinho); contagem regressiva dos 30 min do Pix; número do pedido visível;
  botões "Gerar novo Pix" (expirado/cancelado) e "Fazer outro pedido" (entregue).
- ✅ **E-mail sem promessa falsa** — o campo dizia "para o comprovante", mas nada é enviado.
  Texto ajustado até a notificação por e-mail (Fase 1) existir.

- ✅ **"Cancelar este Pix" na etapa 4** — rota `POST /api/orders/:token/cancel` cancela o
  pagamento NO Mercado Pago (QR antigo deixa de ser pagável → sem pagamento em dobro ao
  trocar de produto) e volta para a confirmação com conta+produto. Se o MP recusar (já
  pago), sincroniza e segue como `paid`. Pedido pago não se cancela pelo site (suporte).
- ✅ **Navegação padronizada** — "← Voltar" no topo das etapas 2 e 3; etapa 4 pendente só
  tem "Cancelar este Pix" (voltar sem cancelar abriria risco de pagar dois Pix).

**Junto da Fase 1:**
- ✅ **Bloqueio visível no catálogo** — `/api/player/:id` devolve `blocked` {produto: motivo};
  card aparece apagado com "Indisponível" e, ao tocar, mostra o motivo. Atualiza em segundo
  plano ao reabrir a página. Servidor continua validando no `POST /api/orders`.
- ✅ **Link do pedido no endereço** — `#pedido=<token>` (hash: não vai pro servidor/logs) +
  botão "Copiar link" na etapa 4. Abre em qualquer aparelho via `GET /api/orders/:token?full=1`
  (dados do pedido + QR enquanto pendente; nunca o e-mail). Colunas novas em `orders`:
  `qr`, `qr_b64`, `expires_at` (pedidos anteriores abrem só com status).
- ✅ **Ajuda "Onde encontro meu ID?"** — bloco recolhível no passo 1 com texto + print
  recortado da tela inicial (`public/img/help-id.jpg`, ID destacado).

**No go-live do domínio:**
- ✅ **Marca no site** — "Recarga Flame" + ícone no topo da loja, login e painel; favicon,
  ícone de tela inicial (192/180 px) e `<title>`/descrição novos; descrição do Pix no extrato
  do cliente agora é "<produto> CounterFlame - Recarga Flame". Originais em `brand/`.
- ✅ **Rodapé** — mantém a menção à Valve DE PROPÓSITO (decisão do operador): o CounterFlame é
  uma versão não oficial do CS2 para mobile, então o aviso de "sem vínculo" cobre os dois.
- ⬜ **Página de termos e reembolso** — erro de ID, prazo, quando cabe estorno. Ajuda a
  contestar MED e passa confiança.

---

## Migração para domínio de produção 🌐 (fazer no go-live, antes de divulgar)
Hoje a loja roda em `cf-teste.easybuscas.click` (subdomínio de teste). Para produção,
usar um domínio de marca própria.

**Domínio escolhido:** `recargaflame.com.br` (verificado LIVRE em 2026-11, no `.com.br` e
no `.com`). Raciocínio: "recarga" = termo que o BR busca; "flame" remete ao CounterFlame
SEM usar a marca do jogo (evita risco jurídico); marca própria escala para outros jogos;
`.com.br` (~R$40/ano no registro.br) passa mais confiança para loja que recebe Pix.
Opcional: registrar `recargaflame.com` também (~R$60/ano) e redirecionar para o `.com.br`.
Alternativas livres, se preferir: goldflame.com.br, flamegold.com.br, flamerecarga.com,
flamestore.com.br, goldgamer.com.br. EVITAR nome "counterflame" no domínio (marca de 3º).

**Passos do go-live (requer aprovação do operador p/ nginx/certbot):**
1. ✅ Registrar o domínio no registro.br. (2026-11-06, vence 2027-11-06)
2. ✅ (raiz + `www`, ambos → VPS) Criar registro DNS A: `recargaflame.com.br` → `169.58.247.93` (+ `www` opcional).
3. ✅ Aguardar propagação DNS (checar com `dig recargaflame.com.br @8.8.8.8`).
4. ✅ Criar site nginx (`/etc/nginx/sites-available/recargaflame.com.br`, upstream `recargaflame_app`) apontando para o app (porta 3102) — espelhar config do cf-teste.
5. ✅ (raiz + www desde 2026-11-07, `certonly --cert-name recargaflame.com.br`; renovação via certbot.timer, dry-run ok; `www` → 301 para a raiz em http e https) Emitir SSL: `sudo certbot --nginx -d recargaflame.com.br` (+ www se usar).
6. ✅ Atualizar `PUBLIC_URL` no `.env` para `https://recargaflame.com.br` e reiniciar PM2.
7. ✅ (2026-11-06; validado pelo pedido #5) Atualizar a URL do webhook no painel do Mercado Pago para o novo domínio.
8. ✅ Nada depende de domínio fixo no código (PUBLIC_URL é lido do .env; healthcheck e avisos já usam o novo).
9. ✅ `cf-teste.easybuscas.click` agora faz 301 → `https://recargaflame.com.br$request_uri` (2026-11-06;
   backup em `/etc/nginx/sites-available/cf-teste.easybuscas.click.bak.1794000689`; cert segue renovando).
10. ✅ E-mail do domínio: ENVIO pela loja via Resend (`pedidos@`, chave `RESEND_API_KEY`); RECEBIMENTO
    `suporte@` → Gmail via ImprovMX (MX mx1/mx2 + SPF na raiz); RESPOSTA como `suporte@` pelo Gmail
    "Enviar como" usando SMTP do Resend (chave separada "Gmail suporte"). Limite grátis Resend: 100/dia
    compartilhado entre loja e respostas. Validado 2026-11-06/07.
11. ✅ (pedido #5, R$3,50: webhook do domínio novo às 18:27:39 → `paid` → entregue) Teste de fumaça: pedido real de baixo valor no domínio novo → paga → webhook → `paid`.

---

## Fase 1 — Vazão operacional (alvo: 10-30 vendas/dia) 🟠
Despachar rápido SEM ficar olhando o painel.
- ✅ **Login do painel com sessão + código pelo Telegram (2FA)** — CONCLUÍDO 2026-11-06.
  `/login` → senha (`POST /login/senha`, anti-brute-force 20/15min por IP, senha certa sempre
  passa) → código de 6 dígitos pelo bot (5 min, uso único, 5 tentativas) → `POST /login/codigo`
  cria sessão (cookie `cf_sess` HttpOnly/Secure/SameSite=Strict, 12h; tabela `admin_sessions`
  guarda só o hash). Botão "Sair" (`POST /logout`). Basic Auth removido.
- ✅ **Expiração automática de pedidos pendentes** — CONCLUÍDO: a cada 5 min, pendente com Pix
  vencido (+5 min de folga) é conferido no MP uma última vez e, se seguir pendente, vira
  `cancelled`. Antes: qualquer um
  gera 5 Pix/min por IP; sem limpeza, pendentes acumulam e o painel (que carrega todos os
  pedidos de uma vez) fica lento/poluído. Job que cancela pendentes após o Pix expirar.
- ✅ **Notificação ao operador** — CONCLUÍDO: bot avisa "💰 Pedido pago #X" (produto, valor,
  Stars, nick/ID, link pronto de entrega no bot do CF, link do painel) uma única vez por pedido.
  Também avisa ⚠️ estorno/chargeback de pedido já pago/entregue. Antes: bot Telegram avisa quando o Pix
  confirma. Multiplica a capacidade sem automação. (Maior alavanca da fase.)
- ✅ **Alerta de loja fora do ar** — CONCLUÍDO: `healthcheck.sh` no cron a cada 5 min (fora do
  app), checa `PUBLIC_URL/api/products`; avisa 🔴 após 2 falhas seguidas e ✅ quando volta.
  Log em `backups/health.log`. Antes: health-check periódico avisa o
  operador se o app parar de responder (hoje só se descobre quando cliente reclama).
- ⏸️ **Controle de saldo de Stars** — ADIADO pelo operador (2026-11-06; controla por fora). Quando fizer: registrar saldo (~1.500-2.000) e alertar quando
  baixo / travar produtos caros, para não vender o que não dá para entregar.
- ✅ **Notificação ao cliente quando entregue** — CONCLUÍDO 2026-11-06 via Resend (`RESEND_API_KEY`):
  "Marcar entregue" manda e-mail de `pedidos@recargaflame.com.br` (reply-to `suporte@`) com resumo
  + link do pedido, uma vez por pedido. Domínio verificado (DKIM `resend._domainkey`, `send.` p/ SPF/MX, DMARC p=none).
  Histórico: e-mail fecha o ciclo, reduz suporte.
  DECIDIDO: fazer junto da migração de domínio, enviando de um endereço do próprio domínio
  (ex.: pedidos@recargaflame.com.br, com SPF/DKIM) — menos spam, mais confiança.

## Fase 2 — Conversão e confiança (alvo: converter o tráfego do youtuber) 🟡
Entra a parceria com "aquilagado" (ver contexto.md).

- ✅ **Cupons** — CONCLUÍDO 2026-11-07. Link `/?cupom=CODIGO` (fica salvo 30 dias no navegador)
  ou campo "Tem um cupom?" na confirmação. Desconto % por cupom (padrão 5%), preço SEMPRE
  calculado no servidor e nunca abaixo do piso (Stars × `STAR_COST_BRL` + taxa `MP_FEE_PCT`).
  Painel → aba Cupons: criar/editar/ativar, copiar link, relatório por período (vendas,
  faturado, descontos, lucro, comissão = % do LUCRO, padrão 20%) — conta só pagos/entregues.
  Pedido guarda `coupon`, `list_cents`, `discount_cents`; aviso de pago mostra o cupom.
  Acordo com o youtuber: fazer POR ESCRITO (contexto.md).
  - ✅ **Controle de comissão paga** (2026-11-07): tabela `coupon_payouts`; relatório mostra
    ganho total, já pago e saldo "a pagar" (histórico todo, independe do período); botão
    "Registrar pagamento" (valor + obs.) e "desfazer". `% de comissão` congelado no pedido
    (`orders.com_pct`): editar o cupom não altera vendas passadas. Estorno após pagar → saldo
    pode virar "crédito".
- ✅ **Pedidos atualizam sozinhos** (2026-11-07): painel consulta `GET /api/admin/orders` a cada
  15 s (pausa com a aba oculta, atualiza ao voltar); pedido pago novo ganha selo NOVO e o título
  da aba mostra "(n)" se chegou enquanto estava em segundo plano. "Atualizar" recarrega só a aba atual.
- ✅ **Consulta de pedido por link/e-mail** — feito via `/#pedido=<token>` (botão "Copiar link" na
  tela do pedido + link no e-mail de entregue); abre em qualquer aparelho.
- ✅ **Analytics no painel** — CONCLUÍDO 2026-11-07. Aba Analytics (`GET /api/admin/analytics`):
  período Hoje/7d/30d/Este mês/Mês passado/Tudo; vendas, faturado, ticket médio, lucro estimado
  (após Stars, taxa MP e comissões de cupom), conversão do Pix (gerados × pagos), entrega
  (mediana pago→entregue e % em até 1h), estornos; faturamento por dia (por mês se >62 dias,
  com tabela) e ranking de produtos. Datas em horário de Brasília.
- ✅ **Guardrails de fraude (Pix/MED)** — CONCLUÍDO 2026-11-07. Configurável no `.env` (R$):
  - **Revisar antes de entregar** (selo vermelho no painel + linha "⚠️ REVISAR" no aviso do Telegram
    + confirmação reforçada): pedido ≥ `RISK_REVIEW_BRL` (150); 1ª compra do ID ≥ `RISK_FIRST_BRL` (50);
    soma paga em 24h pelo ID ou e-mail ≥ `RISK_DAY_BRL` (300).
  - **Checkout recusa**: soma em 24h por ID/e-mail acima de `LIMIT_DAY_BRL` (700); mais de
    `MAX_PENDING_PIX` (3) Pix em aberto por ID/e-mail; ID ou e-mail bloqueado (403 genérico).
  - **Bloqueio automático**: estorno/cancelamento depois de pago bloqueia ID e e-mail (tabela `blocked`);
    desbloquear pelo card do pedido no painel. MED pode chegar até ~80 dias depois — o bloqueio é o que
    impede o mesmo golpista de voltar.
  - ✅ **Impressões do cliente** (2026-11-07): estorno bloqueia também o **aparelho** (cookie
    aleatório `cf_dev`, HttpOnly, 2 anos — recusa no checkout) e a **conta bancária de quem pagou**
    (banco+agência+conta de `bank_info.payer`, só após o pagamento → "REVISAR — NÃO entregue sem
    checar"). **IP só alerta** (4G/CGNAT é compartilhado). IP e conta guardados só como HMAC com a
    chave `.fp_key` (fora do banco, 0600, vai no backup). ⚠️ **NÃO usar `payer.identification`**: sem
    CPF no pedido o MP devolve ali o CNPJ dele mesmo (igual em todo pagamento) — verificado 2026-11-07.

## Fase 3 — Automação da entrega (a grande alavanca) 🟢
Teto real de escala: enquanto a compra em Stars for manual, não se vende dormindo.
Contexto.md já recusou automação total por risco (sessão TG no servidor, compra errada).
Evoluir com segurança:

- ✅ **Entrega assistida** — CONCLUÍDO 2026-11-07.
  - **Telegram**: aviso de pago tem botões "🎮 Abrir entrega · N★" (deep link do bot CF com produto+ID)
    e "✅ Já entreguei" → confirmação ("Sim, entreguei #N" / "Voltar"; pedido com REVISAR mostra os
    motivos em alerta) → entregue + e-mail ao cliente. Só `TG_CHAT_ID` pode usar os botões. Toques lidos
    por long polling `getUpdates` (sem webhook/endpoint novo — NÃO configurar webhook no bot, quebra isso).
    Entregue pelo painel, cancelado ou estornado → botões do aviso viram rótulo ("✅ Entregue…",
    "⛔ Cancelado — não entregar"). `orders.tg_msg` guarda o id da mensagem.
  - **Painel**: fila "Na fila" do mais antigo para o mais novo; ⏱ tempo desde o pagamento (amarelo ≥30 min,
    vermelho ≥50 min, prazo 1h); ao voltar do Telegram depois de "Abrir no Telegram", barra
    "Entregou o pedido #N?" → 1 toque marca entregue.
- ⬜ **Fila/worker** — pedidos pagos entram numa fila processável, não dependem do operador na tela.
- ⬜ **Automação total (só depois)** — mapeamento produto→código à prova de erro, dry-run/
  confirmação, limite de valor automático, kill-switch. Passo mais arriscado; só quando o
  volume justificar.

## Fase 4 — Infra (só se passar de ~100 vendas/dia)
Provavelmente nunca necessário. Para constar:

- ⬜ **Ambiente de staging** — testar mudanças sem arriscar produção.
- ⬜ **Separar HTML do painel** do `server.js` (~280 linhas embutidas) — manutenção.
- ⬜ SQLite aguenta esse patamar; Postgres só se houver concorrência de escrita real
  (vários operadores simultâneos). Até lá, litestream cobre durabilidade.

---

## Trilha paralela — não-técnica (do contexto.md) ✅ RESOLVIDA (2026-11)
Avaliada pelo operador; sem bloqueios para escalar.

- ✅ **Pix / conta PJ:** não é problema no volume inicial — o gateway do Mercado Pago
  já permite receber muitos pagamentos/mês. (A regra de ~30 recebimentos/QR dinâmico se
  aplica a Pix pessoal direto, não ao fluxo via gateway MP.)
- ✅ **Contador:** formalização adiada por decisão do operador — será feita quando o
  volume justificar.
- ✅ **ToS Telegram:** sem risco — NÃO revendemos Stars. Compramos Stars oficialmente e as
  usamos para pagar os itens; o cliente compra o ITEM, não a Star.
- ✅ **ToS Mercado Pago:** sem risco — não vendemos moeda digital/cripto. Vendemos itens de
  jogo (passes, pacotes de skins, pacotes de moedas do jogo), que não se enquadram nas
  proibições de venda da plataforma.

---

## O que já está sólido (não mexer)
- Preço sempre server-side (cliente não forja valor).
- Confirmação de pagamento valida status `approved` E `transaction_amount === cents`.
- Webhook com HMAC + timingSafeEqual.
- SQL 100% parametrizado.
- Produtos no banco com CRUD; snapshot do produto no pedido (editar/excluir não quebra histórico).
- Admin com comparação timing-safe; arquivos sensíveis não servidos via HTTP.

---

_Última atualização: 2026-11 — Fase 0 CONCLUÍDA (hardening, testes, backup, webhook MP
validado em produção com Pix real). Banco limpo (0 pedidos de teste, 15 produtos reais).
Trilha não-técnica resolvida. Próximo: Fase 1 (notificação ao operador)._

## Controle de saldo de Stars ✅ (2026-11-07)
Livro-caixa `stars_ledger` (recarga | ajuste | entrega). Entrega (painel ou Telegram) desconta os ★ do pedido
sozinha (1 vez por pedido). Botão "★ saldo" no topo do painel: registrar recarga (★ + R$ opcional → custo médio
real vs `STAR_COST_BRL`), "Conferir saldo" (informa o saldo real do Telegram → ajuste da diferença), histórico.
Alertas: faixa na fila e selo "SEM STARS" nos pedidos que não cabem no saldo (ordem de chegada); linha no aviso de
pago do Telegram quando a fila passa do saldo; aviso "saldo baixo" ao cruzar `STARS_LOW` (500). Não bloqueia vendas.
Saldo real da conta NÃO é legível por API do bot (é da conta de usuário) — por isso é manual.

### Saldo REAL via conta de usuário separada (2026-11-07) — em configuração
GramJS (`telegram@2.26.22`, exato). `tg-user.js` só LÊ o saldo (`payments.getStarsStatus`) — não envia nem paga.
Login: `node tg-user-login.mjs` no SSH (TG_API_ID/TG_API_HASH no .env, da conta SEPARADA) → `.tg_user_session` (0600,
nginx bloqueia dotfiles, FORA do backup). Lê a cada 5 min + após entrega + "Ler agora"; leitura < 15 min substitui o
saldo manual; falha → aviso no Telegram e volta ao manual. Cada leitura boa realinha o livro-caixa ao real
(ajuste "sincronizado com o Telegram"; ajustes automáticos seguidos viram um só). Revogar: Telegram → Dispositivos → "Recarga Flame (VPS)".
✅ **Conferência da fatura (sem pagar)** — 2026-11-07: ao virar pago, a conta separada abre o bot do CF com
`s_<code>_<ID>` (`messages.startBot`) e lê a resposta ("<produto>\n\nAccount: <nick>" + fatura XTR). Confere ★ da fatura
= ★ do pedido e nick = nick do pedido; resultado em `orders.chk`, no card ("🔎 Conferido…✅" / "❌ não bateu" vira
REVISAR / "⚠ falhou") e no aviso do Telegram (editado). "conferir de novo" no card. 1 conferência por vez.
⚠️ Testes NUNCA usam a conta real: `userConfig()` devolve ok:false com NODE_ENV=test (incidente 2026-11-07: antes
dessa trava, uma rodada de testes mandou 13 /start com IDs de teste ao bot do CF — só faturas, nada pago).
✅ **Pagamento com 1 toque** — 2026-11-07. Botão "⭐ Pagar N★ e entregar" (Telegram, com confirmação) e "⭐ Pagar"
(painel, com confirm). Paga SÓ se: chave geral ligada (Painel → ★ → "Pagamento com 1 toque"; DESLIGADA por padrão),
conferência ✅, sem REVISAR, ≤ `AUTOPAY_MAX_STARS` (1000) por pedido, ≤ `AUTOPAY_DAY_STARS` (4000) em 24h, saldo ok.
No pagamento re-confere a fatura (★, XTR, conta) e o formulário (`getPaymentForm`) antes de `sendStarsForm`.
Trava atômica `orders.autopay` (paying → sent | erro | incerto). `erro` = recusado antes de cobrar (pode repetir);
`incerto` = falha depois do envio (rede/timeout) → NUNCA repete, alerta 🚨; reinício durante pagamento → incerto.
Sucesso → marca entregue (e-mail) + relê saldo.

### Entrega 100% automática ✅ (2026-11-07)
Painel → ★ → "Entrega com Stars": Desligado | 1 toque | **Automático** (`settings.autopay` = 0/1/2). No automático, logo
após a conferência ✅ a loja paga sozinha (mesmas travas: sem REVISAR, tetos, saldo; re-confere antes de pagar).
Telegram: "✅ Entregue automaticamente", "🖐 Entrega MANUAL necessária" (motivo), "⚠️ falhou", "🚨 INCERTA" — sempre com
linha de saldo (🔻 baixo / ⚠️ não cobre a fila). Cliente (`GET /api/orders/:token` → `entrega`: auto|manual|null):
"entregando automaticamente (~1 min)" ou aviso neutro "entrega pela nossa equipe dentro do prazo" — nunca o motivo.
Resolver "incerto"/"erro" pelo painel: botão "🔍 verificar cobrança" olha a FATURA EXATA do pedido — o nº da mensagem
da fatura é gravado em `autopay_info.invMsgId` ANTES de cobrar; paga = fatura tem `receiptMsgId` / recibo
`MessageActionPaymentSent` respondendo a ela (`invoicePaid`). NÃO usar valor+horário (itens têm preço fixo: ambíguo). Só após 1 min →
"foi cobrado" → marcar entregue · "não foi cobrado" → liberar nova tentativa (`autopay='erro'`). Entregue na mão →
"Marcar entregue" normal. Card entregue mostra só "resolvido manualmente".

### Robustez da automação + resumo diário ✅ (2026-11-07)
- Conferência de pedido recém-pago com falha passageira (bot não respondeu, rede, flood) tenta até 3x a cada 90 s antes
  de ir para manual (cliente segue vendo "entregando automaticamente"); pagamento recusado antes de cobrar por motivo
  passageiro tenta 1x de novo. Erro não passageiro (ex.: "sem fatura") não repete.
- GramJS `floodSleepThreshold: 120` (FLOOD_WAIT ≤ 2 min: espera e repete — pedido recusado por flood não executou).
- Sessão da conta separada caiu (AUTH_KEY_*, SESSION_REVOKED, USER_DEACTIVATED): alerta 🔌 com o comando de re-login e
  `canAutopay` recusa ("sessão caiu") → tudo vai para manual até refazer o login.
- Resumo diário no Telegram às `SUMMARY_HOUR` (23h): vendas, faturado, lucro, entregues (auto × manual), mediana de
  entrega, fila/incertos, Stars gastos, saldo e autonomia em dias; 1x por dia (`settings.summary_day`).

### Organização do código ✅ (2026-11-07)
- git LOCAL (`main`, sem remoto — nada é enviado). `.gitignore` exclui .env, banco, .fp_key, .tg_user_session,
  backups/, node_modules, old-public, *.bak.*. Commitar a cada mudança no lugar de criar `*.bak.*`.
- 45 cópias soltas (*.bak.*, loja.db.pre-*) movidas para `~/cf-teste-deploy-archive/2026-11-07/` (700; nada apagado).
- `contexto.md`: exemplo de .env tinha o usuário/senha REAIS do painel → trocado por marcadores (original no arquivo).
- HTML do login e do painel saíram do server.js para `views/login.js` e `views/painel.js` (saída idêntica byte a byte).

### Revisão de segurança da VPS (2026-11-07)
Aplicado: SSH `PermitRootLogin no` (`/etc/ssh/sshd_config.d/10-no-root-login.conf`); ramos/mateus seguem com senha
(testado). Mantidos por decisão do operador: login por senha, `sudo` NOPASSWD do ramos (loja e Hermes rodam como ramos),
senha atual do painel, reboot do kernel pendente, apps internos escutando em 0.0.0.0 (bloqueados pelo UFW).
OK: UFW deny-by-default, fail2ban (sshd), unattended-upgrades, TLS 1.2/1.3, server_tokens off, segredos 600, npm audit 0.
