# Perfil fiscal da loja

> Mantido pelo Claude. Atualize sempre que algo mudar. Última atualização: 2026-11-17

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
  1. O dono compra **USDT em P2P** (Wallet do Telegram ou Binance), pagando em R$.
  2. Na mesma hora, usa o USDT para comprar **Telegram Stars** no **fragment.com** (saldo antecipado do meio de pagamento).
  3. O cliente paga em **Pix** (Mercado Pago, checkout transparente, conta PF).
  4. Depois do pagamento, o dono compra o pacote no bot com as Stars, informando o ID do cliente.
  5. O bot entrega direto na conta do cliente.
- **Não há estoque de pacotes.** A compra ocorre só depois do pagamento e a entrega vai do fornecedor direto ao cliente.
- USDT e Stars são só meio de pagamento: o dono nunca os vende, apenas compra e gasta.

## Números
- Loja no ar desde ~08/11/2026.
- **Dados reais do banco da loja (`loja.db`), de 08/11 a 17/11/2026 (20h30 BRT):**
  - 214 pedidos entregues. 54 cancelados, nenhum deles pago. Nenhum reembolso. Ticket médio ≈ R$ 27,14.
  - Total recebido dos clientes (já sem os cupons): **R$ 5.807,30**.
  - Custo dos pacotes (47.293★ × custo da Star congelado em cada pedido): **R$ 4.131,31** (71,1% do recebido).
  - Taxa do Pix no MP (0,99%): R$ 57,49.
  - Comissões de parceiros (devidas, nenhuma paga ainda): ≈ R$ 442,17.
  - Lucro: **≈ R$ 1.176,33** (20,3%). Descontando as cobranças em dobro do bot (#116, #128, #181: 1.620★ ≈ R$ 141,67, em disputa), fica **≈ R$ 1.035**, ou 17,8%.
  - Receita pelos dois modelos: **revenda R$ 5.807,30**; intermediação ≈ R$ 1.675,99 (recebido − custo dos pacotes).
  - Vendas por dia: ≈ R$ 247/dia de 08 a 14/11; R$ 1.018 (15/11), R$ 1.500 (16/11), R$ 1.559 (17/11 até 20h30).
  - Compras de USDT já lançadas no painel: 3 (R$ 1.100,00 por 189,57 USDT).
- Projeção: ainda não dá para projetar. Com 9 dias de dados e uma alta de 5× nos últimos 2, qualquer número é chute. **Recalcular no fim de dezembro de 2026.**
- Pendência de conciliação (o dono diz que todas as compras recentes de Stars foram registradas; conferir pelo histórico de transações do Telegram na Fase 1): o saldo de Stars no Telegram (5.254★) está ~2.700★ acima do que as compras registradas explicam (38.035 compradas − 33.898 entregues − 1.620 em dobro = 2.517). Pode haver compra não registrada no painel, bônus ou reembolso de Stars.
- Simulação (Simples, Anexo III, 6% na 1ª faixa):
  - a estimativa antiga (R$ 9,9 mil/ano como revenda e R$ 1,7 mil/ano como intermediação) partia da projeção de R$ 166 mil/ano, já descartada;
  - com novembro (parcial) × 12: revenda ≈ R$ 3,0 mil/ano, intermediação ≈ R$ 0,9 mil/ano. Está subestimado, porque o mês ainda está no início e o ritmo subiu;
  - refazer com o relatório de novembro fechado (01/12) e de novo no fim de dezembro.

## Pagamentos e cripto
- Gateway: Mercado Pago (conta PF, categoria "outras atividades de serviços pessoais"; migrar para PJ após o CNPJ, com nova chave Pix e novas credenciais da integração). Pix a 0,99%, ≈ R$ 0,26 no pedido médio de R$ 26,50.
- **Plano B, se o MP recusar** (taxas de nov/2026 vindas de comparativos; confirmar nos sites oficiais):
  - Woovi: 0,80% ou R$ 0,85 fixo;
  - Pagar.me: ~0,99%;
  - Efí: 1,19%;
  - Asaas: R$ 1,99 fixo por Pix, ruim para o ticket de R$ 26,50 (7,5%);
  - após o CNPJ, Pix por API do banco PJ (Inter, Sicoob, BB), com tarifa baixa ou zero a confirmar.
  - Primeiras opções: **Woovi** e **Pix por API de um banco PJ**. Pedir a qualquer novo gateway a mesma confirmação por escrito, porque nenhum diz claramente se aceita moeda de jogo.
  - A regra de "recursos próprios" vem da regulação das contas de pagamento, não é exclusiva do MP: a intermediação vai exigir produto de marketplace/split (há na Efí, na Pagar.me e no Asaas).
  - Trocar de gateway exige mexer em `src/mercadopago.js` (Pix, webhook e reembolsos).
- USDT comprado **sempre em P2P**, às vezes na Wallet do Telegram, às vezes na Binance. É gasto direto no **fragment.com** para comprar as Stars, sem passar pelo saldo do Telegram. A compra no Fragment é a alienação do USDT; o hash da transação serve de comprovante. Tratar como **sem exchange brasileira**: a DeCripto é obrigatória se o volume do mês (compras + usos, a confirmar) passar de R$ 35 mil. Diz que consegue os comprovantes das compras anteriores.
- Em novembro/2026 o volume fica ≈ R$ 6,6 mil (R$ 3,3 mil comprados + R$ 3,3 mil usados). Se o ritmo de 15–16/11 se mantiver, **dezembro pode passar de R$ 35 mil**.
- O dono compra o USDT e o usa na mesma hora. A "perda" que aparece no relatório é praticamente o ágio do P2P sobre a cotação de mercado.
- Registros (Fase 1, no ar desde 16/11/2026), no painel de Stars, em 2 passos:
  1. **"1 · Comprei USDT"**: R$ pago, USDT recebido, Wallet ou Binance, nome do vendedor P2P, número da ordem e data;
  2. **"2 · Comprei Stars"**: Stars, USDT pago e hash do Fragment. O custo em R$ sai do custo médio do USDT.
  - Compras antigas de Stars: botão "+ USDT" em cada uma. O relatório mensal sai sozinho no dia 1º (Telegram, tópico resumo), ou sob demanda com `node tools/relatorio-fiscal.mjs AAAA-MM`.
- **Meses acima de R$ 35 mil** (compras + usos, sem exchange brasileira):
  - entregar a **DeCripto** daquele mês no e-CAC até o último dia útil do mês seguinte, com cada operação (data, tipo, quantidade, R$, taxas, plataforma e, se exigido, a contraparte);
  - multa por atraso ou erro: pela IN 1.888, uma pessoa física pagava R$ 100 por mês de atraso e 1,5% do valor informado errado. Confirmar os valores da IN 2.291;
  - imposto ≈ R$ 0, porque o ganho é quase nulo ou negativo (o ágio do P2P vira perda). Se houver ganho, a regra mais provável é 15% sobre o ganho líquido anual (cripto fora de exchange brasileira);
  - a loja avisa no Telegram aos 80% e aos 100% do limite, e o relatório mensal traz os dados das operações.
- Telegram Stars não são cripto: é crédito no app, e gastar não gera ganho de capital.
- Gastar USDT para comprar Stars é **alienação de cripto**. O ganho ou perda é a variação da cotação entre a compra e o uso (tende a centavos). Registrar tudo.

## Pendências
- [x] Município: São Paulo capital, sede na residência.
- [ ] Consulta de viabilidade do endereço residencial (na abertura da ME).
- [x] Onde compra USDT: P2P na Wallet do Telegram e na Binance.
- [ ] Juntar os comprovantes de USDT desde 07/11/2026 e lançá-los no painel: "1 · Comprei USDT" para as compras de USDT e "+ USDT" em cada uma das 14 compras de Stars.
- [x] Termos do Mercado Pago lidos em 16/11/2026 (versão de 15/09/2026). Moeda/item de jogo **não aparece** como proibido: nem na lista de produtos proibidos (ajuda/3264) nem nas operações proibidas (cláusula 6.1). Riscos que restam:
  - cláusula 6.1 (xiv): o MP pode barrar qualquer atividade "a seu exclusivo critério";
  - cláusula 2.4: a atividade precisa corresponder à cadastrada na conta;
  - cláusula 2.13.1: guardar a prova de entrega por 1 ano (a loja já guarda a resposta do bot);
  - **cláusula 1.3.2: a conta serve só para "recursos próprios"**. É vedado usá-la como gestor de pagamentos de terceiros, salvo contas vinculadas ou a função de marketplace/intermediação via Pix (2.6.5.6). Isso conflita com tratar os repasses como "valores de terceiros" no modelo de intermediação. **Levar ao contador e ao MP antes da Fase 2.**
- [x] Suporte do MP consultado em 16/11/2026 (`fiscal/mercadopago-resposta-2026-11-16.md`): **não confirmou nem proibiu**. A conta está cadastrada como "outras atividades de serviços pessoais", e o MP não sugeriu outra categoria. O marketplace/split exige que cada vendedor tenha conta no MP, então **não serve** para a intermediação (o fornecedor é o bot do jogo).
- [ ] Reduzir a exposição no MP enquanto a situação for cinzenta: sacar o saldo para o banco com frequência e manter a prova de entrega (já automática).
- [ ] Deixar um plano B pronto: as mensagens adaptadas para a Woovi e para um banco PJ foram enviadas ao dono no Telegram em 16/11/2026. Canais:
  - **Woovi**: "Falar com vendas" em woovi.com (leva ao cadastro gratuito em app.woovi.com, que não obriga a usar) ou DM no Instagram @woovibr / LinkedIn. Não há e-mail nem WhatsApp de vendas publicados.
  - **Banco PJ** (ex.: Inter Empresas): sem canal para quem ainda não é cliente. A API Pix só é contratada com a conta PJ aberta (precisa do CNPJ). Até lá, perguntar pelo chat do app PF do banco, se tiver conta, ou deixar para a abertura da ME.
- [ ] Contratar contador (ainda não tem); validar por escrito o modelo de intermediação e o CNAE/anexo.
- [ ] Levar ao contador:
  - se compras e usos somam juntos para o limite de R$ 35 mil da DeCripto;
  - se o envio mensal da IN 2.291 já está ativo ou ainda vale a IN 1.888;
  - se é obrigatório identificar o vendedor P2P (o painel já guarda o nome);
  - se a Binance conta como exchange brasileira;
  - se o custo da Star pode ser por PEPS (regra atual da loja) ou precisa ser custo médio.
- [ ] Abrir a ME (Simples) e a conta PJ; migrar o recebimento.
- [ ] Declarar no IRPF 2027 o resultado do período em que vendeu como PF.
