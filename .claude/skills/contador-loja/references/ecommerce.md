# Particularidades do e-commerce (conferido em nov/2026)

## Faturamento: o que conta
- A receita bruta é o **valor total das vendas**, sem descontar a comissão do marketplace, a taxa do gateway ou o frete subsidiado. Essas taxas são despesas.
- Frete cobrado do cliente e destacado na nota em geral compõe a receita. Confira com o contador como sua plataforma emite.
- Devoluções e cancelamentos com nota de entrada reduzem a receita do mês.
- Pix e cartão em conta de PF para vendas da loja **misturam patrimônio** e aparecem para o fisco. Use conta PJ.

## ICMS
- **Venda dentro do estado:** alíquota interna (em geral 17% a 23%, conforme a UF). No Simples, já está dentro do DAS.
- **Venda para outro estado, consumidor final não contribuinte** (o caso típico de B2C):
  - **Regime normal (Presumido/Real):** o vendedor paga a alíquota interestadual na origem e o **DIFAL** ao estado de destino, via GNRE. DIFAL = alíquota interna do destino − alíquota interestadual (4%, 7% ou 12%).
  - **Simples Nacional:** em regra **dispensado do DIFAL na venda** (STF, ADI 5464; Convênio ICMS 93/2015, cláusula nona derrubada). A SEFAZ-SP confirmou isso em resposta à Consulta 34088/2026, e quem pagou indevidamente pode pedir restituição. Alguns estados ainda tentam cobrar: confira a UF de destino em caso de notificação.
  - **Atenção:** no Simples, muitos estados cobram **DIFAL/antecipação nas COMPRAS** de outros estados para revenda. Isso é diferente da venda e foi validado pelo STF. Verifique as regras do seu estado.
- **Substituição tributária (ST):** se o produto tem ST e o ICMS já foi retido pelo fornecedor, a revenda sai sem ICMS (CSOSN 500 no Simples). **Segregue essa receita no PGDAS** para não pagar o ICMS de novo dentro do DAS.

## PIS/COFINS monofásico
- Cosméticos, perfumaria, higiene pessoal, medicamentos, autopeças, pneus, bebidas frias e outros: o fabricante ou importador recolhe PIS/COFINS pela cadeia toda.
- **No Simples, a receita desses produtos deve ser segregada no PGDAS**, o que exclui a parcela de PIS+COFINS do DAS (≈15,5% da alíquota efetiva no Anexo I). É uma das economias legais mais esquecidas. Cabe recuperar os últimos 5 anos pagos a mais.
- Confira por NCM se o produto é monofásico (Lei 10.147/2000 e correlatas).

## Marketplaces e plataformas
- A nota é emitida pelo **vendedor** (sua empresa), não pelo marketplace.
- Os relatórios do marketplace servem de prova de receita: concilie mensalmente com as notas emitidas.
- A comissão do marketplace é serviço tomado. Fora do Simples pode gerar créditos (no Real/na reforma). No Simples, é só despesa.

## Dropshipping e importação
- **Dropshipping nacional:** você é revendedor. Precisa receber a nota do fornecedor e emitir a sua para o cliente (ou usar o modelo de venda à ordem, com notas específicas).
- **Importação pela empresa:** II, IPI, PIS/COFINS-importação e ICMS-importação, com despachante/Siscomex. Mude bastante a simulação e consulte o contador.
- **Remessas internacionais direto ao consumidor** (o cliente como importador): regras do Remessa Conforme e alíquotas de importação para pessoa física. A loja brasileira que vende assim tem riscos de enquadramento: consulte especialista.

## Produtos digitais (infoprodutos, cursos, software, assinaturas)
- São tratados como **serviço**: ISS (municipal) e, no Simples, normalmente Anexo III (ou V conforme a atividade/Fator R).
- O MEI tem lista restrita de ocupações de serviço: verifique se a sua atividade digital é permitida.
- Venda para o exterior (exportação de serviço) pode ter isenções. Segregue no PGDAS.

## Itens virtuais de jogos (moedas, gemas, skins, contas)
- O IBGE classifica a **intermediação na compra e venda de itens virtuais para uso em jogos eletrônicos** no **CNAE 7490-1/04**. Esse CNAE **não é permitido no MEI**, e usar o 4789-0/99 (varejo de produtos) para isso é enquadramento errado. Caminho normal: ME no Simples, provavelmente Anexo III (confirmar com o contador e no PGDAS).
- Margem baixa + imposto sobre a receita bruta = o imposto come boa parte do lucro. Ex.: margem de 17% com DAS de 6% sobre o bruto leva cerca de 35% do lucro.
- **Modelo de receita (o ponto que mais pesa):**
  - **Revenda:** a loja compra o item/moeda com estoque próprio (ex.: estrelas pré-compradas) e vende. Receita = valor total cobrado do cliente.
  - Base legal: LC 123/2006, art. 3º, §1º. A receita bruta inclui "o resultado nas operações em conta alheia", ou seja, só o ganho, não o valor repassado. Contabilmente, o CPC 47 olha para quem controla o bem, quem tem risco de estoque, quem define o preço e quem responde pela entrega.
  - **Intermediação/mandato:** a loja compra **em nome e por conta do cliente**, repassa o custo e cobra uma taxa. Receita = só a taxa, e o repasse não é faturamento. Só vale se for real: termos de uso/contrato dizendo isso, preço do item e taxa separados no checkout e na nota, compra feita depois do pedido, sem estoque próprio, e controle de repasses. Se a operação na prática é revenda (estoque comprado antes, preço único), o fisco pode desconsiderar e cobrar sobre o bruto. **Decisão para o contador, por escrito.**
- Pagamentos: muitos gateways e marketplaces proíbem ou restringem a venda de moeda virtual de jogos. Confira os termos do gateway antes de crescer, porque o risco é bloqueio/retenção de saldo.
- Insumos comprados com cripto (USDT → estrelas do Telegram etc.): cada uso de cripto é uma alienação (ganho/perda) e entra no limite da DeCripto (R$ 35 mil/mês sem exchange brasileira). Na PJ, a cripto vira ativo da empresa, com custo e notas/registros de cada compra.
- Servidor no exterior ou domínio .com.br não mudam onde se paga imposto: vale o domicílio do dono/empresa.

## Nota fiscal
- Produto: NF-e (modelo 55) ou NFC-e, conforme a operação e o estado.
- Serviço: **NFS-e padrão nacional** (obrigatória para Simples/MEI conforme o cronograma do emissor nacional; verifique o seu município).
- Desde 03/08/2026, empresas **fora** do Simples devem preencher os campos de IBS/CBS na NF-e. Optantes do Simples estão dispensados em 2026.
