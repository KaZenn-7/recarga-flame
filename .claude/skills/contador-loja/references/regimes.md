# Regimes tributários para loja online (conferido em nov/2026)

## 0. Vender como pessoa física (sem CNPJ)
- Vender itens pessoais usados de vez em quando: em geral não há imposto. Ganho de capital em bens de pequeno valor tem isenção mensal específica; confira o limite atual na Receita.
- **Comprar para revender com habitualidade é atividade empresarial.** Como PF, o risco é ser equiparado a pessoa jurídica (e cobrado como empresa, com multa) e ter o ICMS cobrado pelo estado. Marketplaces e meios de pagamento informam as operações ao fisco: a Receita recebe esses dados, e os estados recebem pela DIMP.
- Recomendação padrão: formalizar. Normalmente o MEI é a porta de entrada mais barata.

## 1. MEI (Microempreendedor Individual)
- **Teto de faturamento:** R$ 81.000/ano em 2026. A **LC 238/2026** (sancionada em 21/10/2026) eleva para **R$ 110.000 em 2027** e **R$ 140.000 a partir de 2028**, além de permitir até 2 empregados.
- Abriu no meio do ano: o teto é proporcional (R$ 6.750 × meses em 2026; recalcule com o novo teto em 2027).
- **DAS fixo mensal em 2026** (salário mínimo de R$ 1.621):
  - comércio/indústria: **R$ 82,05** (INSS de R$ 81,05 + ICMS de R$ 1);
  - serviço: R$ 86,05;
  - comércio e serviço: R$ 87,05.
  - Vence no dia 20. Em 2027, o valor muda com o novo salário mínimo.
- **Estourou o teto:**
  - até 20% acima: paga DAS complementar sobre o excesso e vira ME no ano seguinte;
  - mais de 20% acima: desenquadramento **retroativo** ao início do ano, pagando como ME desde janeiro.
- Restrições:
  - a atividade precisa estar na lista de ocupações permitidas;
  - não pode ser sócio, titular ou administrador de outra empresa;
  - não pode ter filial.
- Nota fiscal: obrigatória na venda para PJ. Para PF, só se o cliente pedir, mas marketplaces costumam exigir.
- Obrigações: DAS mensal, **DASN-SIMEI até 31/05**, relatório mensal de receitas (guardar).
- Para e-commerce de comércio, o MEI quase sempre é **o regime mais barato enquanto couber no teto**: cerca de R$ 985/ano contra pelo menos 4% do faturamento no Simples.

## 2. Simples Nacional (ME até R$ 360 mil, EPP até R$ 4,8 mi)
Alíquota efetiva = (RBT12 × alíquota nominal − parcela a deduzir) ÷ RBT12. O RBT12 é o faturamento dos 12 meses anteriores ao mês de apuração.

**Anexo I (comércio, que é o caso típico de e-commerce):**
| Faixa (RBT12) | Alíquota | Dedução |
|---|---|---|
| até 180.000 | 4,00% | 0 |
| 180.000,01 – 360.000 | 7,30% | 5.940 |
| 360.000,01 – 720.000 | 9,50% | 13.860 |
| 720.000,01 – 1.800.000 | 10,70% | 22.500 |
| 1.800.000,01 – 3.600.000 | 14,30% | 87.300 |
| 3.600.000,01 – 4.800.000 | 19,00% | 378.000 |

**Repartição do Anexo I** (usada para excluir tributos já pagos por monofásico/ST). Valores em % da alíquota efetiva:
| Faixa | IRPJ | CSLL | COFINS | PIS | CPP | ICMS |
|---|---|---|---|---|---|---|
| 1ª e 2ª | 5,50 | 3,50 | 12,74 | 2,76 | 41,50 | 34,00 |
| 3ª a 5ª | 5,50 | 3,50 | 12,74 | 2,76 | 42,00 | 33,50 |
| 6ª | 13,50 | 10,00 | 28,27 | 6,13 | 42,10 | — (ICMS fora do DAS) |
> Confira a repartição oficial no Anexo I da LC 123/2006 antes de usar em apuração real.

**Anexo III (serviços em geral; inclui muitos produtos digitais e serviços):**
6% / 11,2% (−9.360) / 13,5% (−17.640) / 16% (−35.640) / 21% (−125.640) / 33% (−648.000)

**Anexo V (serviços intelectuais; vale quando o Fator R < 28%):**
15,5% / 18% (−4.500) / 19,5% (−9.900) / 20,5% (−17.100) / 23% (−62.100) / 30,5% (−540.000)

**Fator R** = (folha + pró-labore + encargos dos últimos 12 meses) ÷ RBT12. Se for ≥ 28%, a atividade sujeita ao Fator R vai para o Anexo III, que é mais barato. Comércio (Anexo I) não usa Fator R.

**Outros limites:**
- Sublimite de **R$ 3,6 mi**: acima dele, ICMS/ISS saem do DAS e são pagos pelo regime normal.
- Acima de R$ 4,8 mi: exclusão do Simples.
- No Anexo I, a CPP (INSS patronal) já está dentro do DAS. Sobre o pró-labore incide só o INSS do sócio (11%, retido) e o IRPF.

## 3. Lucro Presumido
- **IRPJ:** 15% sobre a base presumida (comércio: 8% da receita; serviços em geral: 32%), mais adicional de 10% sobre a base que passar de R$ 20 mil/mês (R$ 60 mil/trimestre).
- **CSLL:** 9% sobre a base (comércio: 12%; serviços: 32%).
- **PIS 0,65% + COFINS 3%** (cumulativos) sobre a receita.
- **ICMS** pelo regime normal: alíquota interna do estado, com crédito das compras, mais DIFAL nas vendas interestaduais a consumidor final. Para serviços, **ISS** de 2% a 5%.
- **INSS patronal:** 20% sobre pró-labore; cerca de 26–28% sobre a folha (20% + RAT + terceiros).
- **LC 224/2025:** desde 2026, os percentuais de presunção sobem 10% (ex.: 8% → 8,8%) **sobre a parcela da receita acima de R$ 5 mi/ano**. Há liminares contra (TRF-3); considere isso como risco em disputa.
- Costuma compensar mais para serviço com margem alta do que para comércio de margem apertada. Para lojas no Anexo I abaixo de cerca de R$ 1,8 mi, o Simples geralmente ganha, mas **simule**.

## 4. Lucro Real
- IRPJ/CSLL sobre o lucro contábil efetivo. PIS/COFINS não cumulativos (9,25%) com créditos.
- Faz sentido com margem baixa ou prejuízo e faturamento alto. Exige contabilidade completa. Fora do escopo de simulação simples: recomende um contador.

## 5. Tirar dinheiro da empresa: pró-labore x lucros (2026)
- **Pró-labore:**
  - INSS de 11% do sócio (até o teto), mais 20% patronal fora do Simples Anexo I;
  - IRPF pela tabela, com **isenção até R$ 5.000/mês a partir de 2026** (Lei 15.270/2025).
  - Estratégia comum: pró-labore de 1 salário mínimo (garante INSS) e o resto como lucros.
- **Distribuição de lucros:**
  - isenta até **R$ 50.000/mês por sócio, por empresa**;
  - acima disso, **retenção de 10% de IRRF** (Lei 15.270/2025).
  - A Receita entende que a regra vale também para o Simples. Isso está sendo contestado judicialmente com base na isenção da LC 123: trate como risco.
  - Há ainda o IRPF mínimo para quem tem renda total acima de R$ 600 mil/ano.
- **Limite da isenção sem contabilidade:** sem escrituração contábil (livro diário/balanço), o lucro distribuível isento fica limitado à base presumida (comércio: 8% da receita, menos os tributos). **Ter contabilidade completa permite distribuir o lucro real isento**, o que costuma valer o custo.
