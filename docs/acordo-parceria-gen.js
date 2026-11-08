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

// tabela de exemplos (preços de 08/11/2026, 5% de desconto, 20% do lucro, R$ 0,0875/★)
const W = [3000, 1700, 1700, 1700, 1306];
const cell = (text, i, head = false, fill) => new TableCell({
  width: { size: W[i], type: WidthType.DXA },
  shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
  margins: { top: 80, bottom: 80, left: 100, right: 100 },
  children: [new Paragraph({ alignment: i ? AlignmentType.RIGHT : AlignmentType.LEFT,
    children: [new TextRun({ text, font: FONT, size: 20, bold: head })] })],
});
const rows = [
  ['Produto', 'Cliente paga', 'Custo + taxa', 'Lucro', 'Comissão'],
  ['Gold Pass', 'R$ 35,06', 'R$ 24,06', 'R$ 11,00', 'R$ 2,20'],
  ['10.000 Coins', 'R$ 19,86', 'R$ 15,16', 'R$ 4,70', 'R$ 0,94'],
  ['100.000 Coins', 'R$ 166,16', 'R$ 132,81', 'R$ 33,35', 'R$ 6,67'],
];
const table = new Table({
  width: { size: W.reduce((a, c) => a + c, 0), type: WidthType.DXA },
  columnWidths: W,
  rows: rows.map((r, ri) => new TableRow({ tableHeader: ri === 0,
    children: r.map((c, i) => cell(c, i, ri === 0, ri === 0 ? 'F3E4DC' : undefined)) })),
});

const aviso = new Table({
  width: { size: 9406, type: WidthType.DXA }, columnWidths: [9406],
  rows: [new TableRow({ children: [new TableCell({
    width: { size: 9406, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'FFF8D6' },
    margins: { top: 140, bottom: 140, left: 180, right: 180 },
    children: [
      P([b('Como usar este modelo (apague este quadro antes de enviar)')], { spacing: { after: 80 } }),
      LI([t('Preencha todos os campos '), f('EM AMARELO'), t(' e remova o destaque amarelo.')]),
      LI(t('Os exemplos da cláusula 3 usam 5% de desconto, 20% do lucro e os preços de 08/11/2026. Se o desconto, a comissão ou os preços forem outros, refaça a conta com o relatório da aba Cupons do painel.')),
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

      H('3. Comissão do Parceiro'),
      P([t('O Parceiro recebe '), f('20'), t('% do '), b('lucro'), t(' de cada venda paga e entregue com o cupom.')]),
      P([b('Lucro'), t(' = valor pago pelo cliente − custo das Stars usadas na compra − taxa do Mercado Pago (0,99%).')]),
      P([t('O custo das Stars é o custo real que a Loja pagou, calculado pela média das recargas de Stars e '), b('registrado no momento de cada venda'),
        t(' — uma venda já feita nunca tem a comissão alterada depois. O custo usado em cada venda aparece no relatório mensal.')]),
      P([t('Exemplos com os preços de hoje (custo de R$ 0,0875 por Star):', { italics: true, color: '555555', size: 20 })], { spacing: { after: 80 } }),
      table,
      new Paragraph({ spacing: { after: 120 }, children: [] }),

      H('4. O que não gera comissão'),
      LI(t('Pedidos não pagos, cancelados, reembolsados ou estornados (inclusive contestação de Pix/MED).')),
      LI(t('Se uma venda já paga ao Parceiro for estornada depois, o valor é descontado do próximo pagamento.')),

      H('5. Pagamento'),
      P([t('Mensal, até o dia '), f('5'), t(' do mês seguinte, por Pix para a chave '), f('CHAVE PIX DO PARCEIRO'),
        t('. Junto com o pagamento, a Loja envia o relatório do mês: número de vendas, valor faturado, lucro e comissão. Valores abaixo de R$ '),
        f('20'), t(' podem ser acumulados para o mês seguinte.')]),

      H('6. Divulgação'),
      P(t('O Parceiro divulga do jeito que preferir, desde que:')),
      LI(t('não prometa o que a Loja não oferece (por exemplo: reembolso após a entrega, preço "oficial" ou itens que a Loja não vende);')),
      LI(t('deixe claro que é uma parceria (por exemplo: "parceria" ou "#publi");')),
      LI(t('lembre que a Loja é uma revenda independente, sem vínculo com a Valve nem com a equipe do CounterFlame.')),
      P(t('O atendimento aos clientes é da Loja: dúvidas e problemas vão para recargaflame.com.br/suporte.')),

      H('7. Exclusividade e mudanças'),
      P(t('Não há exclusividade para nenhum dos lados. Desconto e comissão só mudam com acordo dos dois.')),

      H('8. Duração e encerramento'),
      P([t('Vale por tempo indeterminado. Qualquer um pode encerrar avisando com '), f('7'),
        t(' dias de antecedência. As comissões das vendas feitas até o encerramento são pagas normalmente.')]),

      H('9. Independência'),
      P(t('Este acordo não cria vínculo de emprego, sociedade ou representação entre as partes.')),

      H('Aceite'),
      P([t('Para aceitar, basta o Parceiro responder: '), b('"Li e concordo com o acordo de parceria do cupom '), f('CÓDIGO DO CUPOM'), b('".')]),
      P([t('Data: '), f('DD/MM/AAAA')], { spacing: { before: 200, after: 120 } }),
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(process.argv[2], buf); console.log('ok', buf.length); });
