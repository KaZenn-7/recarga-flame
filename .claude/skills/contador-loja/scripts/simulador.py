#!/usr/bin/env python3
"""Simulador de regimes tributários para loja online (Brasil, valores 2026).

Compara o custo anual estimado em MEI, Simples Nacional e Lucro Presumido.
É uma ESTIMATIVA para orientar a decisão: não substitui a apuração do contador.

Exemplos:
  python3 simulador.py --receita-anual 150000
  python3 simulador.py --receita-mensal 40000 --cmv 55 --uf-icms 18 --pct-monofasico 30
  python3 simulador.py --receita-anual 400000 --atividade servico-fator-r --folha-anual 60000 --prolabore-anual 36000
"""
import argparse

# ---- Parâmetros 2026 (conferidos em nov/2026; ver references/fontes.md) ----
TETO_MEI = {2026: 81_000, 2027: 110_000, 2028: 140_000}  # LC 238/2026
DAS_MEI_2026 = {"comercio": 82.05, "servico": 86.05, "ambos": 87.05}
LIMITE_SIMPLES = 4_800_000
SUBLIMITE_ICMS_ISS = 3_600_000

# (limite superior da faixa, alíquota nominal, parcela a deduzir)
ANEXO_I = [(180e3, .04, 0), (360e3, .073, 5940), (720e3, .095, 13860),
           (1.8e6, .107, 22500), (3.6e6, .143, 87300), (4.8e6, .19, 378000)]
ANEXO_III = [(180e3, .06, 0), (360e3, .112, 9360), (720e3, .135, 17640),
             (1.8e6, .16, 35640), (3.6e6, .21, 125640), (4.8e6, .33, 648000)]
ANEXO_V = [(180e3, .155, 0), (360e3, .18, 4500), (720e3, .195, 9900),
           (1.8e6, .205, 17100), (3.6e6, .23, 62100), (4.8e6, .305, 540000)]

# Repartição do Anexo I, por faixa (índice 0..5): (PIS+COFINS, ICMS) como fração da alíquota efetiva.
# Fonte: LC 123/2006, Anexo I. Confira antes de usar em apuração real.
REPART_I = [(.155, .34), (.155, .34), (.155, .335), (.155, .335), (.155, .335), (.344, 0.0)]


def faixa(rbt12, tabela):
    for i, (lim, aliq, ded) in enumerate(tabela):
        if rbt12 <= lim:
            return i, aliq, ded
    return None, None, None


def aliq_efetiva(rbt12, tabela):
    i, aliq, ded = faixa(rbt12, tabela)
    if i is None:
        return None, None
    if rbt12 <= 0:
        return i, tabela[0][1]
    return i, max(0.0, (rbt12 * aliq - ded) / rbt12)


def brl(v):
    return "R$ " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def pct(v):
    return f"{v * 100:.2f}%".replace(".", ",")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--receita-anual", type=float, help="faturamento bruto anual (R$)")
    g.add_argument("--receita-mensal", type=float, help="faturamento bruto médio mensal (R$)")
    p.add_argument("--ano", type=int, default=2026, choices=sorted(TETO_MEI), help="ano para o teto do MEI")
    p.add_argument("--atividade", default="comercio",
                   choices=["comercio", "servico-anexo-iii", "servico-fator-r"],
                   help="comercio (Anexo I), servico-anexo-iii, servico-fator-r (III ou V pelo Fator R)")
    p.add_argument("--cmv", type=float, default=50, help="custo das mercadorias, %% da receita (Presumido/ICMS)")
    p.add_argument("--uf-icms", type=float, default=18, help="alíquota interna de ICMS da UF, %% (Presumido)")
    p.add_argument("--iss", type=float, default=5, help="ISS do município, %% (serviços no Presumido)")
    p.add_argument("--pct-monofasico", type=float, default=0, help="%% da receita com PIS/COFINS monofásico")
    p.add_argument("--pct-st", type=float, default=0, help="%% da receita com ICMS-ST já retido")
    p.add_argument("--folha-anual", type=float, default=0, help="salários anuais de empregados (R$)")
    p.add_argument("--prolabore-anual", type=float, default=0, help="pró-labore anual total (R$)")
    a = p.parse_args()

    R = a.receita_anual if a.receita_anual is not None else a.receita_mensal * 12
    comercio = a.atividade == "comercio"
    print(f"\nReceita bruta anual considerada: {brl(R)}  (média {brl(R / 12)}/mês)")
    print(f"Atividade: {a.atividade} | ano do teto MEI: {a.ano}\n")
    res = []
    avisos = []

    # ---- MEI ----
    teto = TETO_MEI[a.ano]
    if R <= teto:
        das = DAS_MEI_2026["comercio" if comercio else "servico"] * 12
        res.append(("MEI", das, "DAS fixo (valores de 2026; muda com o salário mínimo)"))
        if R > 0.85 * teto:
            avisos.append(f"Faturamento a {pct(R / teto)} do teto do MEI ({brl(teto)}). Monitore mês a mês.")
    elif R <= teto * 1.2:
        avisos.append(f"Acima do teto do MEI ({brl(teto)}) em até 20%: DAS complementar e vira ME no ano seguinte.")
    else:
        avisos.append(f"Mais de 20% acima do teto do MEI ({brl(teto)}): MEI inviável (desenquadramento retroativo).")
    if not comercio and R <= teto * 1.2:
        avisos.append("MEI de serviço: confirme se a ocupação está na lista permitida.")

    # ---- Simples Nacional ----
    if R <= LIMITE_SIMPLES:
        folha_total = a.folha_anual + a.prolabore_anual
        if comercio:
            tab, nome = ANEXO_I, "Simples (Anexo I)"
        elif a.atividade == "servico-anexo-iii":
            tab, nome = ANEXO_III, "Simples (Anexo III)"
        else:
            fr = folha_total / R if R else 0
            tab, nome = (ANEXO_III, "Simples (Anexo III, Fator R)") if fr >= .28 else (ANEXO_V, "Simples (Anexo V)")
            avisos.append(f"Fator R = {pct(fr)} (precisa ≥ 28% para cair no Anexo III).")
            if fr < .28:
                falta = .28 * R - folha_total
                avisos.append(f"Faltam ~{brl(falta)}/ano de folha/pró-labore para atingir 28%. Compare com a economia de anexo.")
        i, ef = aliq_efetiva(R, tab)
        das = R * ef
        nota = f"alíquota efetiva {pct(ef)} (faixa {i + 1})"
        if comercio and (a.pct_monofasico or a.pct_st):
            pis_cof, icms = REPART_I[i]
            red = R * ef * (a.pct_monofasico / 100 * pis_cof + a.pct_st / 100 * icms)
            das -= red
            nota += f"; segregação monofásico/ST economiza {brl(red)}"
        # CPP (INSS patronal) já está dentro do DAS nos Anexos I, III e V; o 11% do sócio não entra aqui.
        res.append((nome, das, nota))
        if R > SUBLIMITE_ICMS_ISS:
            avisos.append("Acima do sublimite de R$ 3,6 mi: ICMS/ISS saem do DAS (simulação subestima o Simples).")
        if comercio and i == 5:
            avisos.append("6ª faixa do Anexo I: ICMS é pago fora do DAS (não incluído aqui).")
    else:
        avisos.append("Acima de R$ 4,8 mi: Simples Nacional inviável.")

    # ---- Lucro Presumido ----
    pres_ir = .08 if comercio else .32
    pres_cs = .12 if comercio else .32
    base_extra = max(0.0, R - 5_000_000)  # LC 224/2025: +10% na presunção acima de R$ 5 mi (em disputa)
    base_ir = R * pres_ir + base_extra * pres_ir * 0.10
    base_cs = R * pres_cs + base_extra * pres_cs * 0.10
    irpj = base_ir * .15 + max(0.0, base_ir - 240_000) * .10
    csll = base_cs * .09
    pis_cof = R * .0365
    if comercio:
        icms = max(0.0, a.uf_icms / 100 * (R - R * a.cmv / 100))  # débito na venda − crédito na compra (simplificado)
        icms *= 1 - a.pct_st / 100
        pis_cof *= 1 - a.pct_monofasico / 100
        consumo = icms
        nota_c = f"ICMS ~{a.uf_icms:.0f}% sobre valor agregado (CMV {a.cmv:.0f}%)"
    else:
        consumo = R * a.iss / 100
        nota_c = f"ISS {a.iss:.0f}%"
    inss = a.prolabore_anual * .20 + a.folha_anual * .278
    total_p = irpj + csll + pis_cof + consumo + inss
    res.append(("Lucro Presumido", total_p,
                f"IRPJ {brl(irpj)} + CSLL {brl(csll)} + PIS/COF {brl(pis_cof)} + {nota_c} {brl(consumo)}"
                + (f" + INSS patronal {brl(inss)}" if inss else "")))
    if R > 5_000_000:
        avisos.append("Inclui +10% na presunção (LC 224/2025) sobre a receita acima de R$ 5 mi (há liminares contra).")

    # Para comparar com justiça, o Simples Anexo I/III/V já inclui CPP; no Presumido somamos INSS patronal acima.
    print(f"{'Regime':<32}{'Imposto/ano':>18}{'% receita':>12}")
    print("-" * 62)
    for nome, v, _ in sorted(res, key=lambda x: x[1]):
        print(f"{nome:<32}{brl(v):>18}{pct(v / R if R else 0):>12}")
    print()
    for nome, _, nota in res:
        print(f"• {nome}: {nota}")
    melhor = min(res, key=lambda x: x[1])
    print(f"\n>> Menor custo estimado: {melhor[0]} ({brl(melhor[1])}/ano)")
    if len(res) > 1:
        seg = sorted(res, key=lambda x: x[1])[1]
        print(f"   Diferença para o 2º colocado ({seg[0]}): {brl(seg[1] - melhor[1])}/ano")
    if avisos:
        print("\nAvisos:")
        for w in avisos:
            print(f"  ! {w}")
    print("\nEstimativa simplificada (não considera DIFAL do Presumido, ST de entrada, IRPF do sócio,")
    print("créditos específicos nem regras estaduais). Valide com contador antes de mudar de regime.\n")


if __name__ == "__main__":
    main()
