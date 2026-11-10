// Monta o .docx do acordo de parceria da Recarga Flame.
// Todo dado ausente (null/undefined) vira um campo [EM AMARELO] para preencher à mão — nada é inventado.
// Usado por gerar.cjs (preenchido a partir do cupom) e para o modelo em branco.
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, LevelFormat, Footer, PageNumber,
} = require('docx');

const FONT = 'Arial';
const ORANGE = 'E8501A';
const t = (text, o = {}) => new TextRun({ text, font: FONT, size: 22, ...o });
const b = (text) => t(text, { bold: true });
const f = (text) => t(`[${text}]`, { highlight: 'yellow', bold: true });
// valor conhecido em negrito; desconhecido vira campo amarelo com o rótulo
const v = (val, rotulo) => (val === null || val === undefined || val === '' ? f(rotulo) : b(String(val)));
const P = (runs, o = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], spacing: { after: 120, line: 300 }, ...o });
const H = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text, font: FONT, size: 24, bold: true, color: ORANGE })] });
const LI = (runs) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], numbering: { reference: 'bul', level: 0 }, spacing: { after: 80, line: 290 } });
const brl = (c) => 'R$ ' + (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctTxt = (p) => String(p).replace('.', ',') + '%';
const LARG = 9406; // largura útil (A4, margens de 1250)

// tabela; hl(ri, ci) destaca a célula em amarelo (campo a preencher)
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
const splitW = (fixos, n) => { const resto = LARG - fixos.reduce((a, c) => a + c, 0); const w = Math.floor(resto / n);
  const cols = Array(n).fill(w); cols[n - 1] += resto - w * n; return [...fixos, ...cols]; };

const TIERS_PADRAO = [{ min: 0, pct: 30 }, { min: 150000, pct: 35 }, { min: 400000, pct: 40 }, { min: 1000000, pct: 45 }];

/**
 * d = {
 *   modelo: bool (true = modelo em branco),
 *   cupom, link, desconto, plano: 'metas'|'fixo', comissaoFixa, tiers:[{min,pct}], tiersProprias: bool,
 *   parceiroNome, canal, chavePix, responsavel, semResponsavel, minimo, avisoDias, data,
 *   exemplos: { data: 'dd/mm/aaaa', star: 0.0868, linhas: [{ nome, paga, lucro }] }   (centavos)
 * }
 */
function buildAcordo(d) {
  const modelo = !!d.modelo;
  const metas = d.plano !== 'fixo';
  const tiers = d.tiers && d.tiers.length ? d.tiers : TIERS_PADRAO;
  const linkCurto = d.cupom ? `recargaflame.com.br/${String(d.cupom).toLowerCase()}` : null;

  // ---- tabela de faixas ----
  const faixaRows = [['Vendas do Parceiro no mês', 'Comissão (% do lucro)']];
  tiers.forEach((x, i) => faixaRows.push([
    i === 0 ? (tiers[1] ? 'até ' + brl(tiers[1].min - 1) : 'qualquer valor') : 'a partir de ' + brl(x.min), pctTxt(x.pct)]));
  const faixas = mkTable([5600, 3806], faixaRows, (ri) => modelo && ri > 0);

  // ---- exemplos (calculados pelo gerador com preços e custo do dia) ----
  const pcts = metas ? tiers.map((x) => x.pct) : [d.comissaoFixa];
  const ex = d.exemplos;
  const exRows = [['Produto', 'Cliente paga', 'Lucro', ...pcts.map(pctTxt)]];
  for (const l of ex?.linhas || []) exRows.push([l.nome, brl(l.paga), brl(l.lucro), ...pcts.map((p) => (p == null ? '—' : brl(Math.round(l.lucro * p / 100))))]);
  const exemplos = mkTable(splitW([2306, 1500, 1400], pcts.length), exRows);

  const aviso = new Table({
    width: { size: LARG, type: WidthType.DXA }, columnWidths: [LARG],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: LARG, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'FFF8D6' },
      margins: { top: 140, bottom: 140, left: 180, right: 180 },
      children: modelo ? [
        P([b('Como usar este modelo (apague este quadro antes de enviar)')], { spacing: { after: 80 } }),
        LI([t('Preencha todos os campos '), f('EM AMARELO'), t(' e remova o destaque amarelo.')]),
        LI(t('A tabela de faixas traz as faixas padrão. Se o parceiro tiver faixas próprias (painel → Cupons → Editar → Faixas deste parceiro), troque os valores. Para comissão fixa, troque a tabela por "X% do lucro em todas as vendas" e apague as frases sobre faixas.')),
        LI(t('Dica: a skill "acordo-parceiro" gera este acordo já preenchido a partir do cupom.')),
        LI(t('Envie por mensagem ou e-mail e guarde a resposta de aceite do parceiro.')),
      ] : [
        P([b('Antes de enviar (apague este quadro)')], { spacing: { after: 80 } }),
        LI([t('Gerado a partir do cupom '), b(String(d.cupom)), t(` em ${d.geradoEm}. Confira os dados e preencha o que estiver `), f('EM AMARELO'), t(', se houver.')]),
        LI(t('Envie por mensagem ou e-mail e guarde a resposta de aceite do parceiro.')),
      ],
    })] })],
  });

  const clausula3 = metas ? [
    H('3. Comissão e metas'),
    P([t('O Parceiro recebe uma porcentagem do '), b('lucro'), t(' de cada venda paga e entregue com o cupom. A porcentagem depende do '),
      b('total vendido pelo Parceiro no mês'), t(' (soma do que os clientes pagaram com o cupom), conforme a tabela'
        + (d.tiersProprias ? ' (faixas combinadas para esta parceria)' : '') + ':')]),
    faixas,
    new Paragraph({ spacing: { after: 120 }, children: [] }),
    LI([b('A faixa atingida vale para todas as vendas do mês'), t(' — inclusive as feitas antes de bater a meta.')]),
    LI([b('Faixa garantida: '), t('quem atinge uma faixa começa o mês seguinte uma faixa abaixo dela (ex.: atingiu a 3ª faixa num mês → começa o seguinte na 2ª). A garantia vale só para o mês seguinte.')]),
    LI(t('Os meses são do calendário (horário de Brasília). Ao fechar o mês, a faixa daquele mês fica registrada e não muda depois.')),
  ] : [
    H('3. Comissão'),
    P([t('O Parceiro recebe '), v(d.comissaoFixa == null ? null : pctTxt(d.comissaoFixa), '% DE COMISSÃO'), t(' do '), b('lucro'), t(' de cada venda paga e entregue com o cupom.')]),
  ];

  const doc = new Document({
    creator: 'Recarga Flame', title: `Acordo de parceria — cupom ${d.cupom || ''}`.trim(),
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
          d.cupom ? new TextRun({ text: String(d.cupom), font: FONT, size: 34, bold: true }) : new TextRun({ text: '[CÓDIGO DO CUPOM]', font: FONT, size: 34, bold: true, highlight: 'yellow' })] }),
        P([t('Recarga Flame · recargaflame.com.br', { color: '777777', size: 20 })], { spacing: { after: 240 } }),
        P([t('Entre '), b('Recarga Flame'), ...(d.semResponsavel ? [] : [t(', representada por '), v(d.responsavel, 'SEU NOME COMPLETO')]), t(d.semResponsavel ? ' ("Loja") e ' : ' ("Loja"), e '), v(d.parceiroNome, 'NOME DO PARCEIRO'),
          t(', do canal/perfil '), v(d.canal, 'NOME DO CANAL OU PERFIL'), t(' ("Parceiro").')]),

        H('1. O que é'),
        P([t('O Parceiro divulga a Loja com o cupom '), v(d.cupom, 'CÓDIGO DO CUPOM'), t(' e o link '), v(linkCurto, 'recargaflame.com.br/CÓDIGO'),
          t('. Em troca, recebe comissão sobre as vendas feitas com o cupom.')]),

        H('2. Desconto para o cliente'),
        P([t('Quem usar o cupom tem '), v(d.desconto == null ? null : pctTxt(d.desconto), '5%'), t(' de desconto, calculado automaticamente pela Loja no momento do pagamento. O desconto nunca deixa o preço abaixo do custo do item.')]),

        ...clausula3,
        P([b('Lucro'), t(' = valor pago pelo cliente − custo das Stars usadas na compra − taxa do Mercado Pago (0,99%). O custo das Stars é o custo real pago pela Loja, '),
          b('registrado no momento de cada venda'), t(' — uma venda já feita não tem o lucro alterado depois.')], { spacing: { before: 120, after: 120 } }),
        P([t(`Exemplos de comissão por venda${metas ? ' em cada faixa' : ''}${ex?.data ? ` (preços e custos de ${ex.data}, cliente com o desconto do cupom)` : ''}:`, { italics: true, color: '555555', size: 20 })], { spacing: { after: 80 } }),
        exemplos,
        new Paragraph({ spacing: { after: 120 }, children: [] }),

        H('4. O que não conta'),
        LI(t(`Pedidos não pagos, cancelados, reembolsados ou estornados (inclusive contestação de Pix/MED) não ${metas ? 'contam para a meta nem geram' : 'geram'} comissão.`)),
        LI(t('Se uma venda já paga ao Parceiro for estornada depois, o valor é descontado do próximo pagamento.')),

        H('5. Acompanhamento'),
        P([t('O Parceiro acompanha tudo por um '), b('link privado'), t(metas
          ? ' com as vendas do mês, a faixa atual, quanto falta para a próxima, a comissão estimada, o histórico mensal e os pagamentos recebidos, atualizado na hora.'
          : ' com as vendas, a comissão, o histórico mensal e os pagamentos recebidos, atualizado na hora.'),
        t(' O link é pessoal: não compartilhe. Se ele vazar, a Loja gera um novo e o anterior para de funcionar.')]),

        H('6. Pagamento'),
        P([t('Mensalmente, '), b('no primeiro dia útil de cada mês'), t(', a Loja paga as comissões das vendas do mês anterior, por Pix para a chave '), v(d.chavePix, 'CHAVE PIX DO PARCEIRO'),
          t('. O valor de cada mês é o mostrado no link de acompanhamento. Valores abaixo de '), v(d.minimo == null ? null : brl(d.minimo), 'R$ 20'),
          t(' podem ser acumulados para o mês seguinte.')]),

        H('7. Divulgação'),
        P(t('O Parceiro divulga do jeito que preferir, desde que:')),
        LI(t('não prometa o que a Loja não oferece (por exemplo: reembolso após a entrega, preço "oficial" ou itens que a Loja não vende);')),
        LI(t('deixe claro que é uma parceria (por exemplo: "parceria" ou "#publi");')),
        LI(t('lembre que a Loja é uma revenda independente, sem vínculo com a Valve nem com a equipe do CounterFlame.')),
        P(t('O atendimento aos clientes é da Loja: dúvidas e problemas vão para recargaflame.com.br/suporte.')),

        H('8. Uso indevido'),
        P(t('Não geram comissão, e podem levar ao encerramento imediato deste acordo:')),
        LI(t('compras com Pix de terceiros sem autorização, ou que acabem estornadas ou contestadas;')),
        LI(t('spam ou envio de mensagens em massa com o cupom;')),
        LI(t('anúncios pagos usando o nome "Recarga Flame" (por exemplo, no Google) e páginas ou perfis que se passem pela Loja.')),
        P(t('Em caso de suspeita, a Loja pode segurar a comissão das vendas envolvidas até terminar a análise, avisando o Parceiro.')),

        H('9. Exclusividade e mudanças'),
        P(t(`Não há exclusividade para nenhum dos lados. Desconto${metas ? ', faixas' : ''} e comissão só mudam com acordo dos dois; uma mudança vale do mês seguinte em diante, nunca para meses já fechados.`)),

        H('10. Duração e encerramento'),
        P([t('Vale por tempo indeterminado. Qualquer um pode encerrar avisando com '), v(d.avisoDias, '7'),
          t(' dias de antecedência. As comissões das vendas feitas até o encerramento são pagas normalmente.')]),

        H('11. Independência'),
        P(t('Este acordo não cria vínculo de emprego, sociedade ou representação entre as partes.')),

        H('12. Dúvidas'),
        P([t('Dúvidas sobre a plataforma ou sobre este acordo podem ser consultadas nas páginas '), b('recargaflame.com.br/como-funciona'), t(' e '),
          b('recargaflame.com.br/perguntas-frequentes'), t('. O Parceiro também pode ficar à vontade para escrever para '), b('suporte@recargaflame.com.br'), t('.')]),

        H('Aceite'),
        P([t('Para aceitar, basta o Parceiro responder: '), b('"Li e concordo com o acordo de parceria do cupom '), v(d.cupom, 'CÓDIGO DO CUPOM'), b('".')]),
        P([t('Data: '), v(d.data, 'DD/MM/AAAA')], { spacing: { before: 200, after: 120 } }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildAcordo, TIERS_PADRAO };
