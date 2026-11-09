// Modelo de acordo de parceria (cupom) da Recarga Flame — .docx editável, campos a preencher em amarelo.
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, LevelFormat, Footer, PageNumber,
} = require('docx');

const FONT = 'Arial';
const ORANGE = 'E8501A';
// texto normal / negrito / campo a preencher (amarelo)
const t = (text, o = {}) => new TextRun({ text, font: FONT, size: 22, ...o });
const b = (text) => t(text, { bold: true });
const f = (text) => t(`[${text}]`, { highlight: 'yellow', bold: true });
const P = (runs, o = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], spacing: { after: 120, line: 300 }, ...o });
const H = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text, font: FONT, size: 24, bold: true, color: ORANGE })] });
const LI = (runs) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], numbering: { reference: 'bul', level: 0 }, spacing: { after: 80, line: 290 } });

// tabelas (larguras em DXA somando 9406 = largura útil); hl(ri, ci) destaca a célula em amarelo (campo a preencher)
const mkTable = (W, rows, hl = () => false) => new Table({
  width: { size: W.reduce((a, c) => a + c, 0), type: WidthType.DXA },
  columnWidths: W,
  rows: rows.map((r, ri) => new TableRow({ tableHeader: ri === 0,
    children: r.map((text, i) => new TableCell({
      width: { size: W[i], type: WidthType.DXA },
      shading: ri === 0 ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3E4DC' } : undefined,
      margins: { top: 80, bottom: 80, left: 100, right: 100 },
      children: [new Paragraph({ alignment: i ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text, font: FONT, size: 20, bold: ri === 0 || hl(ri, i), highlight: hl(ri, i) ? 'yellow' : undefined })] })],
    })) })),
});
// faixas do plano de metas (padrão da loja; ajuste se o parceiro tiver faixas próprias)
const faixas = mkTable([5600, 3806], [
  ['Vendas do Parceiro no mês', 'Comissão (% do lucro)'],
  ['até R$ 1.499,99', '30%'],
  ['a partir de R$ 1.500,00', '35%'],
  ['a partir de R$ 4.000,00', '40%'],
  ['a partir de R$ 10.000,00', '45%'],
], (ri) => ri > 0);
// exemplos com os preços e o custo de 09/11/2026 (Star a R$ 0,0868), cliente com 5% de desconto
const exemplos = mkTable([2306, 1500, 1400, 1050, 1050, 1050, 1050], [
  ['Produto', 'Cliente paga', 'Lucro', '30%', '35%', '40%', '45%'],
  ['10.000 Coins', 'R$ 19,86', 'R$ 4,82', 'R$ 1,45', 'R$ 1,69', 'R$ 1,93', 'R$ 2,17'],
  ['Gold Pass', 'R$ 35,06', 'R$ 11,19', 'R$ 3,36', 'R$ 3,92', 'R$ 4,48', 'R$ 5,04'],
  ['100.000 Coins', 'R$ 166,16', 'R$ 34,40', 'R$ 10,32', 'R$ 12,04', 'R$ 13,76', 'R$ 15,48'],
]);

const aviso = new Table({
  width: { size: 9406, type: WidthType.DXA }, columnWidths: [9406],
  rows: [new TableRow({ children: [new TableCell({
    width: { size: 9406, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'FFF8D6' },
    margins: { top: 140, bottom: 140, left: 180, right: 180 },
    children: [
      P([b('Como usar este modelo (apague este quadro antes de enviar)')], { spacing: { after: 80 } }),
      LI([t('Preencha todos os campos '), f('EM AMARELO'), t(' e remova o destaque amarelo.')]),
      LI(t('A tabela de faixas da cláusula 3 traz as faixas padrão. Se o parceiro tiver faixas próprias (painel → Cupons → Editar → Faixas deste parceiro), troque os valores. Para comissão fixa, troque a tabela por "X% do lucro em todas as vendas" e apague as frases sobre faixas.')),
      LI(t('Os exemplos usam 5% de desconto e os preços e custos de 09/11/2026 — servem só de ilustração.')),
      LI(t('O link de acompanhamento do parceiro está no painel → Cupons → "Copiar link do parceiro".')),
      LI(t('O link curto do cupom é recargaflame.com.br/<código do cupom> e só funciona com o cupom ATIVO no painel.')),
      LI(t('Envie por mensagem ou e-mail e guarde a resposta de aceite do parceiro.')),
    ],
  })] })],
});

const doc = new Document({
  creator: 'Recarga Flame', title: 'Acordo de parceria — cupom',
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 34, bold: true }, paragraph: { spacing: { before: 0, after: 80 }, keepNext: true } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 24, bold: true, color: ORANGE }, paragraph: { spacing: { before: 260, after: 100 }, keepNext: true } },
    ],
  },
  numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1250, bottom: 1250, left: 1250, right: 1250 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: 'Recarga Flame · recargaflame.com.br · página ', font: FONT, size: 16, color: '888888' }),
      new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: '888888' }),
    ] })] }) },
    children: [
      aviso,
      new Paragraph({ spacing: { after: 200 }, children: [] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Acordo de parceria — cupom ', font: FONT, size: 34, bold: true }),
        new TextRun({ text: '[CÓDIGO DO CUPOM]', font: FONT, size: 34, bold: true, highlight: 'yellow' })] }),
      P([t('Recarga Flame · recargaflame.com.br', { color: '777777', size: 20 })], { spacing: { after: 240 } }),
      P([t('Entre '), b('Recarga Flame'), t(', representada por '), f('SEU NOME COMPLETO'), t(' ("Loja"), e '), f('NOME DO PARCEIRO'),
        t(', do canal/perfil '), f('NOME DO CANAL OU PERFIL'), t(' ("Parceiro").')]),

      H('1. O que é'),
      P([t('O Parceiro divulga a Loja com o cupom '), f('CÓDIGO DO CUPOM'), t(' e o link '), f('recargaflame.com.br/CÓDIGO'),
        t('. Em troca, recebe comissão sobre as vendas feitas com o cupom.')]),

      H('2. Desconto para o cliente'),
      P([t('Quem usar o cupom tem '), f('5'), t('% de desconto, calculado automaticamente pela Loja no momento do pagamento. O desconto nunca deixa o preço abaixo do custo do item.')]),

      H('3. Comissão e metas'),
      P([t('O Parceiro recebe uma porcentagem do '), b('lucro'), t(' de cada venda paga e entregue com o cupom. A porcentagem depende do '),
        b('total vendido pelo Parceiro no mês'), t(' (soma do que os clientes pagaram com o cupom), conforme a tabela:')]),
      faixas,
      new Paragraph({ spacing: { after: 120 }, children: [] }),
      LI([b('A faixa atingida vale para todas as vendas do mês'), t(' — inclusive as feitas antes de bater a meta.')]),
      LI([b('Faixa garantida: '), t('quem atinge uma faixa começa o mês seguinte uma faixa abaixo dela (ex.: atingiu 40% em março → começa abril em 35%). A garantia vale só para o mês seguinte.')]),
      LI(t('Os meses são do calendário (horário de Brasília). Ao fechar o mês, a faixa daquele mês fica registrada e não muda depois.')),
      P([b('Lucro'), t(' = valor pago pelo cliente − custo das Stars usadas na compra − taxa do Mercado Pago (0,99%). O custo das Stars é o custo real pago pela Loja, '),
        b('registrado no momento de cada venda'), t(' — uma venda já feita não tem o lucro alterado depois.')], { spacing: { before: 120, after: 120 } }),
      P([t('Exemplos de comissão por venda em cada faixa:', { italics: true, color: '555555', size: 20 })], { spacing: { after: 80 } }),
      exemplos,
      new Paragraph({ spacing: { after: 120 }, children: [] }),

      H('4. O que não conta'),
      LI(t('Pedidos não pagos, cancelados, reembolsados ou estornados (inclusive contestação de Pix/MED) não contam para a meta nem geram comissão.')),
      LI([t('Compras feitas pelo próprio Parceiro (contas do jogo de ID '), f('IDs DO JOGO DO PARCEIRO'), t(') não contam para a meta nem geram comissão.')]),
      LI(t('Se uma venda já paga ao Parceiro for estornada depois, o valor é descontado do próximo pagamento.')),

      H('5. Acompanhamento'),
      P([t('O Parceiro acompanha tudo por um '), b('link privado'), t(' com as vendas do mês, a faixa atual, quanto falta para a próxima, a comissão estimada, o histórico mensal e os pagamentos recebidos, atualizado na hora. O link é pessoal: não compartilhe. Se ele vazar, a Loja gera um novo e o anterior para de funcionar.')]),

      H('6. Pagamento'),
      P([t('Mensal, até o dia '), f('5'), t(' do mês seguinte, por Pix para a chave '), f('CHAVE PIX DO PARCEIRO'),
        t('. O valor de cada mês é o mostrado no link de acompanhamento. Valores abaixo de R$ '),
        f('20'), t(' podem ser acumulados para o mês seguinte.')]),

      H('7. Divulgação'),
      P(t('O Parceiro divulga do jeito que preferir, desde que:')),
      LI(t('não prometa o que a Loja não oferece (por exemplo: reembolso após a entrega, preço "oficial" ou itens que a Loja não vende);')),
      LI(t('deixe claro que é uma parceria (por exemplo: "parceria" ou "#publi");')),
      LI(t('lembre que a Loja é uma revenda independente, sem vínculo com a Valve nem com a equipe do CounterFlame.')),
      P(t('O atendimento aos clientes é da Loja: dúvidas e problemas vão para recargaflame.com.br/suporte.')),

      H('8. Exclusividade e mudanças'),
      P(t('Não há exclusividade para nenhum dos lados. Desconto, faixas e comissão só mudam com acordo dos dois; uma mudança vale do mês seguinte em diante, nunca para meses já fechados.')),

      H('9. Duração e encerramento'),
      P([t('Vale por tempo indeterminado. Qualquer um pode encerrar avisando com '), f('7'),
        t(' dias de antecedência. As comissões das vendas feitas até o encerramento são pagas normalmente.')]),

      H('10. Independência'),
      P(t('Este acordo não cria vínculo de emprego, sociedade ou representação entre as partes.')),

      H('Aceite'),
      P([t('Para aceitar, basta o Parceiro responder: '), b('"Li e concordo com o acordo de parceria do cupom '), f('CÓDIGO DO CUPOM'), b('".')]),
      P([t('Data: '), f('DD/MM/AAAA')], { spacing: { before: 200, after: 120 } }),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(process.argv[2], buf); console.log('ok', buf.length); });
