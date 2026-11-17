# Histórico fiscal: decisões e contexto

## 2026-11-16: conversa inicial (Claude no app, antes da VPS)

### O que foi analisado
- O dono quer pagar o mínimo de imposto **legalmente**. Planejamento lícito (elisão) sim; evasão não.
- A atividade é revenda/intermediação de pacotes de moedas do jogo Counter Flame, com USDT → Telegram Stars como meio de pagamento.

### Conclusões
1. **Precisa formalizar.** Vender como PF com habitualidade traz risco de equiparação a empresa, com cobrança e multa. O Mercado Pago informa as movimentações ao fisco.
2. **MEI não serve.** O IBGE classifica "intermediação na compra e venda de itens virtuais para uso em jogos eletrônicos" no CNAE 7490-1/04, que não é permitido no MEI. Usar o CNAE de varejo (4789-0/99) seria enquadramento errado.
3. **Caminho: ME no Simples Nacional**, provavelmente Anexo III (6% na 1ª faixa).
4. **Margem baixa (~17%)** faz o imposto sobre o faturamento bruto pesar muito. O ponto de maior economia legal é o **modelo de receita**:
   - revenda: receita = tudo que o cliente paga;
   - intermediação ("conta alheia", LC 123, art. 3º, §1º): receita = só a taxa. Economia estimada de ~R$ 8 mil/ano no ritmo atual.
5. Para ser intermediação de verdade, não basta o nome:
   - preço separado (repasse + taxa);
   - repasse = custo real;
   - termos de mandato;
   - nota só da taxa;
   - log de cada repasse;
   - contabilidade com valores de terceiros;
   - parecer do contador.
6. Lucro Presumido sai pior (~R$ 22 mil/ano na projeção).
7. **Cripto:**
   - Stars não são cripto.
   - Gastar USDT é alienação, mas o ganho ou perda é mínimo (variação cambial). Registrar cada compra e uso.
   - Sem exchange brasileira, operações acima de R$ 35 mil/mês exigem a DeCripto.
   - Em exchange estrangeira, o ganho líquido anual paga 15%.
8. **Risco operacional:** gateways costumam proibir a venda de moeda virtual de jogos. Verificar os termos do Mercado Pago.

### Decisões tomadas
- Seguir rumo a ME no Simples + modelo de intermediação, **sujeito à validação do contador**.
- Implementar já o registro de repasses e de cripto (útil em qualquer modelo).
- Checkout com dois valores e termos novos: implementar e deixar prontos, mas **ativar só depois do CNPJ e do parecer**.

### Perguntas em aberto
- Município da sede? Onde compra USDT? O Mercado Pago permite a categoria?
- Taxa de intermediação: percentual fixo, valor fixo ou "preço atual − custo"?

## 2026-11-16: Claude Code na VPS (sessão 2)
- Faturamento real calculado a partir do `loja.db` e registrado em `perfil.md` (Números).
- A loja já guarda: pedidos com Pix do MP (`orders.mp_id`), Stars e custo da Star congelado em cada pedido (`prod_stars`, `star_cost`), compras de Stars com valor em R$ (`stars_purchases`) e prova de compra no bot (`autopay_info`: resposta do bot, conta e produto; `txId`/recibo quando houver).
- Não existe nenhum registro de USDT. A cotação USDT/BRL também não é guardada.
- A Fase 1 foi planejada, mas **não implementada**: aguarda a aprovação do dono.
- Respostas do dono:
  - mora em SP (falta saber a cidade);
  - compra USDT em P2P (Wallet do Telegram e Binance);
  - consegue os comprovantes;
  - acha que as ~2.700★ a mais no saldo são engano;
  - ainda não leu os termos do Mercado Pago;
  - ainda vai contratar um contador.
- **Decisão:** taxa de intermediação = preço atual − custo do repasse. Os preços continuam os mesmos.
- Esclarecido: chamar a venda de "intermediação" não muda a política de itens proibidos do MP, que vale para o que é vendido. É preciso ler os termos.
- Alerta: no ritmo de 15–16/11, a DeCripto pode ser exigida já em dezembro/2026.

## 2026-11-16: sessão 3, Fase 1 implementada
- Sede: SP capital, na residência. É possível escolher outro local, mas só se for onde a atividade realmente acontece (LC 116, art. 4º). No Simples, o ISS é fixo pela tabela do DAS: mudar de cidade quase não economiza e traz risco de autuação por sede de fachada.
- Custo do USDT: o dono compra e usa na mesma hora. Sugeri comparar o ágio do P2P com uma compra no livro de ofertas (ordem limitada) e com uma exchange brasileira. Se a exchange reportar à Receita, a DeCripto deixa de ser obrigação dele.
- **Fase 1 no ar** (commit 5e72c62, migração 6):
  - tabela `usdt_compras`;
  - USDT, cotação e comprovante em `stars_purchases`;
  - custo médio ponderado do USDT;
  - aviso no Telegram aos 80% e aos 100% de R$ 35 mil/mês;
  - relatório automático no dia 1º;
  - `tools/relatorio-fiscal.mjs`.
- O custo da Star nos pedidos continua por **PEPS** (camadas das compras mais recentes que formam o saldo), não por custo médio. Levar ao contador.
- Os CSVs e relatórios gerados ficam fora do git (têm ID de jogo de clientes).
- Correção do dono: o USDT é sempre comprado em P2P (Wallet do Telegram ou Binance) e gasto no fragment.com para comprar as Stars. Ele não transfere para o Telegram. O painel passou a pedir o hash da compra no Fragment como comprovante.
- Painel: o registro passou a ter 2 passos: (1) "Comprei USDT", pago em R$, com o vendedor P2P e o número da ordem; (2) "Comprei Stars", pago em USDT, com o custo pelo custo médio e o hash do Fragment. Migração 7: `usdt_compras.vendedor`. A compra de Stars só em R$ saiu do painel (a API continua aceitando).
