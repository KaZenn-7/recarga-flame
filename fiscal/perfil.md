# Perfil fiscal da loja

> Mantido pelo Claude. Atualize sempre que algo mudar. Última atualização: 2026-11-16

## Situação jurídica
- Hoje vende como **pessoa física, sem CNPJ**. Pendência nº 1: formalizar.
- Município: **São Paulo (capital)**. A sede será a **residência**, sujeita à consulta de viabilidade e à inscrição no CCM (Cadastro de Contribuintes Mobiliários) para emitir NFS-e. No Simples, o ISS já vem dentro do DAS pela tabela (≈ 2% da receita na 1ª faixa do Anexo III), então mudar de cidade não traria economia relevante. Uma sede de fachada em cidade com ISS baixo traz risco de cobrança pela capital.
- Infra: VPS na Europa e domínio .com.br no Registro.br. Isso não altera a tributação: vale o domicílio em SP.
- Plano: **ME no Simples Nacional**, CNAE **7490-1/04** (intermediação de itens virtuais de jogos; não permitido no MEI), provavelmente Anexo III (confirmar com o contador).
- Modelo de receita pretendido: **intermediação (conta alheia)**, com taxa = **preço atual − custo do repasse** (os preços finais não mudam). Depende de validação do contador por escrito. Ver `fiscal/plano-intermediacao.md`.

## O que vende
- Pacotes de moedas (coins) do jogo **Counter Flame** (jogo mobile russo não oficial, estilo CS2), entregues na conta do cliente pelo **ID do jogo**.
- O jogo só vende itens por **Telegram Stars**, via bot.
- Fluxo atual:
  1. O dono compra **USDT**.
  2. Usa o USDT para comprar **Telegram Stars** mais baratas (saldo antecipado do meio de pagamento).
  3. O cliente paga em **Pix** (Mercado Pago, checkout transparente, conta PF).
  4. Depois do pagamento, o dono compra o pacote no bot com as Stars, informando o ID do cliente.
  5. O bot entrega direto na conta do cliente.
- **Não há estoque de pacotes.** A compra ocorre só depois do pagamento e a entrega vai do fornecedor direto ao cliente.
- USDT e Stars são só meio de pagamento: o dono nunca os vende, apenas compra e gasta.

## Números
- Loja no ar desde ~08/11/2026.
- **Dados reais do banco da loja (`loja.db`), de 08/11 a 16/11/2026 (20h20 BRT):**
  - 157 pedidos entregues (134 Pix). 45 cancelados, nenhum deles pago. Nenhum reembolso.
  - Total recebido dos clientes: **R$ 4.159,43** (preço de tabela R$ 4.291,80 − R$ 132,37 de desconto de cupom).
  - Custo dos pacotes (33.898★ × custo da Star congelado em cada pedido): **R$ 2.964,67** (71,3% do recebido).
  - Taxa do Pix no MP (0,99%): R$ 41,18.
  - Comissões de parceiros (devidas, nenhuma paga ainda): ≈ R$ 286,68.
  - Lucro: **≈ R$ 866,90** (20,8%). Descontando as cobranças em dobro do bot (#116, #128, #181: 1.620★ ≈ R$ 141,67, em disputa), fica **≈ R$ 725**, ou 17,4%.
  - Receita pelos dois modelos: **revenda R$ 4.159,43**; intermediação ≈ R$ 1.194,76 (recebido − custo dos pacotes).
  - O ritmo acelerou: 08–14/11 ≈ R$ 247/dia; 15–16/11 ≈ R$ 1.215/dia.
- Projeção: ainda não dá para projetar. Com 9 dias de dados e uma alta de 5× nos últimos 2, qualquer número é chute. **Recalcular no fim de dezembro de 2026.**
- Pendência de conciliação (o dono diz que todas as compras recentes de Stars foram registradas; conferir pelo histórico de transações do Telegram na Fase 1): o saldo de Stars no Telegram (5.254★) está ~2.700★ acima do que as compras registradas explicam (38.035 compradas − 33.898 entregues − 1.620 em dobro = 2.517). Pode haver compra não registrada no painel, bônus ou reembolso de Stars.
- Simulação (Simples, Anexo III, 6%):
  - como revenda: imposto ~R$ 9,9 mil/ano (≈35% do lucro);
  - como intermediação: ~R$ 1,7 mil/ano (6% só sobre as taxas).

## Pagamentos e cripto
- Gateway: Mercado Pago (conta PF; migrar para PJ após o CNPJ).
- USDT comprado em **P2P na Wallet do Telegram ou na Binance**. Tratar como **sem exchange brasileira**: a DeCripto é obrigatória se o volume do mês (compras + usos, a confirmar) passar de R$ 35 mil. Diz que consegue os comprovantes das compras anteriores.
- Em novembro/2026 o volume fica ≈ R$ 6,6 mil (R$ 3,3 mil comprados + R$ 3,3 mil usados). Se o ritmo de 15–16/11 se mantiver, **dezembro pode passar de R$ 35 mil**.
- O dono compra o USDT e o usa na mesma hora. A "perda" que aparece no relatório é praticamente o ágio do P2P sobre a cotação de mercado.
- Registros (Fase 1, no ar desde 16/11/2026): painel de Stars → seção USDT. O relatório mensal sai sozinho no dia 1º (Telegram, tópico resumo), ou sob demanda com `node tools/relatorio-fiscal.mjs AAAA-MM`.
- Telegram Stars não são cripto: é crédito no app, e gastar não gera ganho de capital.
- Gastar USDT para comprar Stars é **alienação de cripto**. O ganho ou perda é a variação da cotação entre a compra e o uso (tende a centavos). Registrar tudo.

## Pendências
- [x] Município: São Paulo capital, sede na residência.
- [ ] Consulta de viabilidade do endereço residencial (na abertura da ME).
- [x] Onde compra USDT: P2P na Wallet do Telegram e na Binance.
- [ ] Juntar os comprovantes de USDT desde 07/11/2026 e lançá-los no painel (Stars → "+ Compra de USDT" e "+ USDT" em cada compra de Stars).
- [ ] Verificar nos termos do Mercado Pago se a venda de moeda virtual de jogo é permitida (risco de bloqueio/retenção).
- [ ] Contratar contador (ainda não tem); validar por escrito o modelo de intermediação e o CNAE/anexo.
- [ ] Abrir a ME (Simples) e a conta PJ; migrar o recebimento.
- [ ] Declarar no IRPF 2027 o resultado do período em que vendeu como PF.
