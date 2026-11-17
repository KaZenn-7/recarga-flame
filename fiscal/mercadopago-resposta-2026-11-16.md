# Resposta do suporte do Mercado Pago (16/11/2026)

Pergunta enviada pelo dono pelo app (Ajuda → Fale Conosco), com a descrição completa da atividade: venda de pacotes de moedas de um jogo mobile, compra no canal oficial depois do pagamento, entrega pelo ID, sem contas nem apostas. Também perguntou sobre a categoria e o produto para o futuro modelo de intermediação.

Guardar como prova de boa-fé: a atividade foi descrita ao MP sem omissões.

## Resposta (texto recebido)

1. **A atividade é permitida?** Não consegui confirmar a autorização para esse modelo específico. As regras disponíveis não esclarecem a revenda de moedas de jogos compradas no canal oficial e entregues pelo ID. Portanto, não seria correto garantir que sua operação está aprovada — nem classificá-la como aposta, diante do que você descreveu.

2. **Qual categoria cadastrar?** Sua conta está cadastrada como "Outras atividades de servicos pessoais nao especificadas anteriormente". Entre as categorias disponíveis, não encontrei uma específica para moedas ou créditos de jogos. Não tenho fundamento para recomendar uma categoria genérica como enquadramento correto. Não alterei seu cadastro.

3. **Marketplace, split ou conta vinculada?** O que pude confirmar: o modelo marketplace aceita Checkout Transparente e Checkout Pro. O split é uma funcionalidade para marketplace, não uma alternativa independente a ele, e exige implementação por desenvolvedor. Nesse modelo, os vendedores vinculam suas próprias contas Mercado Pago à plataforma. Isso não confirma que o split atende à compra que você faz no canal oficial em nome do cliente, nem que cobrar uma taxa torna esse fluxo elegível. A documentação técnica não ficou disponível para verificar esse ponto e o uso de "conta vinculada". Assim, a indicação do produto para seu futuro modelo permanece sem confirmação.

Atenção à futura migração: se você mudar esta conta de pessoa física para jurídica, será necessário substituir a chave Pix e renovar as credenciais da integração.

## Leitura (Claude, 16/11/2026)

- **Não proibiu nem aprovou.** A atividade continua numa zona cinzenta: o MP pode bloquear a conta ou reter saldo a seu critério (Termos, cláusula 6.1 xiv).
- **A categoria atual é genérica** ("outras atividades de serviços pessoais"). O MP não sugeriu outra nem alterou. Rever quando a conta passar para PJ, junto com o CNAE 7490-1/04.
- **O marketplace/split do MP não serve para o modelo de intermediação.** Ele exige que cada vendedor tenha conta no MP, e o fornecedor (bot do jogo, pago em Stars) não tem. O conflito entre a cláusula 1.3.2 (conta só para "recursos próprios") e tratar os repasses como valores de terceiros continua: **ponto obrigatório para o contador antes da Fase 2.**
- **Na migração PF → PJ**: nova chave Pix e novas credenciais (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e o webhook cadastrado no painel do MP).
