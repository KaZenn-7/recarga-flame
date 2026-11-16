## Fiscal / impostos da loja

- Contexto fiscal completo em `fiscal/`:
  - `perfil.md`: quem é a loja, números, pendências;
  - `historico.md`: decisões e conversa anterior;
  - `plano-intermediacao.md`: o que implementar, em fases.
- Para qualquer assunto de imposto, CNPJ, nota, regime, cripto ou preço/checkout com impacto fiscal, use a skill `contador-loja`.
- Planejamento tributário **somente lícito**. Nunca sugerir omitir receita, vender sem nota, usar CPF de terceiros ou dividir faturamento artificialmente.
- O modelo de **intermediação** (receita = só a taxa) fica atrás da flag `MODELO_INTERMEDIACAO` e só é ativado depois do CNPJ e do parecer do contador por escrito.
- Mantenha `fiscal/perfil.md` e `fiscal/historico.md` atualizados ao fim de cada sessão relevante.
