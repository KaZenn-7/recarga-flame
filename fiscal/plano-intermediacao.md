# Plano técnico: modelo de intermediação + registros fiscais

> Especificação para o Claude Code implementar na loja. Antes de codar, leia a stack real do projeto (plataforma, banco, integração com o Mercado Pago e com o bot do Telegram) e adapte. Pergunte ao dono antes de qualquer mudança visível ao cliente (preços, checkout, termos).

## Fases

| Fase | O quê | Quando ativar |
|---|---|---|
| 1 | Registros: compras de USDT, compras de Stars, pedidos com custo de repasse, relatório mensal | ✅ **No ar desde 16/11/2026** (`src/fiscal.js`, migração 6) |
| 2 | Checkout com dois valores + aceite dos termos de intermediação | Implementar atrás de uma flag (`MODELO_INTERMEDIACAO=false`) e ativar só com CNPJ + parecer do contador |
| 3 | Conta PJ no Mercado Pago, emissão de NFS-e só da taxa, demonstrativo de repasse ao cliente | Depois de abrir a ME |

## Fase 1: registros (fonte da verdade fiscal)

Guarde num banco (ou num SQLite em `fiscal/registros/fiscal.db`) e exporte para CSV mensalmente. Os modelos de CSV estão em `fiscal/registros/`.

### 1.1 `compras_usdt`
| campo | descrição |
|---|---|
| id | |
| data_hora | UTC e horário de Brasília |
| plataforma | nome da exchange/P2P e tipo: `nacional` / `estrangeira` / `p2p` / `carteira_propria` |
| brl_pago | valor em R$ pago, incluindo taxas |
| usdt_recebido | quantidade líquida recebida |
| custo_brl_por_usdt | brl_pago / usdt_recebido |
| comprovante | hash/ID da transação, link ou arquivo |

### 1.2 `compras_stars` (cada uso de USDT = alienação de cripto)
| campo | descrição |
|---|---|
| id, data_hora | |
| usdt_gasto | quantidade de USDT usada |
| custo_brl_usdt_gasto | custo de aquisição em R$ desse USDT (custo médio ponderado do saldo) |
| cotacao_brl_usdt_no_uso | cotação de mercado no momento do uso |
| valor_alienacao_brl | usdt_gasto × cotação no uso |
| ganho_perda_brl | valor_alienacao_brl − custo_brl_usdt_gasto |
| stars_recebidas | |
| custo_brl_por_star | custo_brl_usdt_gasto / stars_recebidas |
| comprovante | |

Notas:
- **Custo médio ponderado** do saldo de USDT e do saldo de Stars. Atualize a cada compra.
- A cotação no uso pode vir de uma API pública de preço USDT/BRL. Guarde a fonte.

### 1.3 `pedidos`
| campo | descrição |
|---|---|
| pedido_id, data_hora | |
| mp_payment_id | ID do pagamento no Mercado Pago |
| valor_pago_cliente_brl | total pago |
| id_jogo_cliente | ID informado pelo cliente |
| pacote | nome/quantidade de coins |
| stars_gastas | Stars consumidas na compra no bot |
| custo_repasse_brl | stars_gastas × custo médio por star (R$) |
| taxa_intermediacao_brl | valor_pago_cliente − custo_repasse |
| status_entrega | pendente / entregue / falhou / reembolsado |
| prova_entrega | ID/timestamp da mensagem do bot de confirmação, ou print salvo |
| reembolso_brl, data_reembolso | se houver |

Na compra no bot, registre automaticamente a resposta do bot (texto, horário, ID da mensagem) como prova de que a compra foi feita **em nome do cliente** (ID dele).

### 1.4 Relatório mensal (`fiscal/relatorios/AAAA-MM.md`)
- Total recebido dos clientes; total de repasses; total de taxas; reembolsos.
- **Receita bruta pelos dois modelos:** revenda (total recebido) e intermediação (só as taxas).
- RBT12 pelos dois modelos e alerta de faixa do Simples.
- Cripto:
  - volume de USDT alienado no mês, em R$;
  - ganho/perda líquido;
  - alerta se passar de R$ 35 mil/mês sem exchange brasileira (DeCripto);
  - lembrete de que, em exchange estrangeira, o ganho anual paga 15%.
- Rode `python3 .claude/skills/contador-loja/scripts/simulador.py` com o RBT12 e anexe o resultado.

## Fase 2: checkout de intermediação (atrás da flag)

> **Suspensa (26/11/2026).** O parecer preliminar do contador conclui que o fluxo atual é revenda por conta própria. A intermediação só se sustenta com um fornecedor identificado que contrate a loja como agente, além de contratos, fluxo financeiro e documentos fiscais coerentes. Não implementar sem um novo parecer.

> ⚠️ 16/11/2026: o MP não confirmou nenhum produto para esse modelo. O marketplace/split exige conta MP do vendedor, e a conta comum é só para "recursos próprios" (Termos, cláusula 1.3.2). Só implementar depois que o contador resolver como os repasses ficam no MP, ou com outro gateway que tenha produto adequado.

### Regras de preço
1. `custo_repasse` de cada pacote = stars do pacote × custo médio atual por star (R$). Recalcule quando o custo médio mudar e arredonde para cima, em centavos.
2. `taxa` = **`preço_atual − custo_repasse`**, mantendo o preço final de hoje. Decidido pelo dono em 16/11/2026.
3. **Proibido embutir margem no repasse.** O repasse é o custo real; todo o ganho fica na taxa.

### Tela de produto e checkout
- Mostrar: "Valor do pacote (repassado ao fornecedor): R$ X" + "Taxa de intermediação: R$ Y" = "Total: R$ Z".
- Checkbox obrigatório: "Li e aceito os Termos de Intermediação". Grave o aceite (versão dos termos, data/hora, IP, pedido_id).
- Texto curto: "Compramos o pacote **em seu nome**, para a conta de ID ___, diretamente no fornecedor oficial do jogo. A entrega é feita pelo próprio fornecedor."
- Campo de ID do jogo com confirmação ("digite novamente") para reduzir entregas erradas.

### Termos
- Publicar `fiscal/termos-intermediacao-rascunho.md` **só depois de revisado pelo contador/advogado**. Versionar (v1, v2…).

## Fase 3: depois do CNPJ
- Mercado Pago em conta PJ (o recebimento deixa de ir para o CPF). O MP avisou que é preciso **nova chave Pix e novas credenciais**: trocar `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` no `.env` e recadastrar o webhook `/webhook/mercadopago`. Testar com um Pix real de valor baixo.
- Emitir **NFS-e apenas da taxa de intermediação**, pelo emissor do município da sede ou o padrão nacional. Integrar por API se o volume justificar.
- Enviar ao cliente um **demonstrativo de repasse** (valor do pacote repassado + taxa), separado da nota.
- Contabilidade: os repasses ficam como valores de terceiros (passivo/conta de repasse), e só a taxa é receita. Exportar os CSVs mensais para o contador.

## Critérios para o contador avaliar (anexar ao pedido de parecer)
- Compra só depois do pagamento; sem estoque de pacotes; entrega direta do fornecedor na conta do cliente.
- As Stars são saldo de meio de pagamento (como manter moeda estrangeira), não estoque do produto.
- Preço segregado (repasse a custo + taxa), aceite de mandato, prova de cada compra em nome do cliente.
- Pontos fracos a discutir: Stars compradas antecipadamente com recursos próprios; responsabilidade perante o cliente (CDC) em caso de falha; definição do custo da star (custo médio).
