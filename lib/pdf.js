'use strict';
// Gerador mínimo de PDF (A4, 1 página, fontes padrão Helvetica) sem dependências externas.
// Texto em WinAnsi (cobre acentos do português). Usado para o relatório individual da simulação.

const W = 595.28, H = 841.89, M = 48;

// Larguras (por 1000 unidades) da Helvetica para ASCII 32..126
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

function larg(str, size, bold) {
  let t = 0;
  for (const ch of String(str).normalize('NFD').replace(/[̀-ͯ]/g, '')) {
    const c = ch.charCodeAt(0);
    t += c >= 32 && c <= 126 ? HW[c - 32] : 556;
  }
  return (t / 1000) * size * (bold ? 1.07 : 1);
}

const WIN = { 0x2014: 0x97, 0x2013: 0x96, 0x2022: 0x95, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x20ac: 0x80 };
function enc(str) { // string cujos char codes são bytes WinAnsi, já escapada para o PDF
  let out = '';
  for (const ch of String(str)) {
    let c = ch.codePointAt(0);
    if (c > 255) c = WIN[c] || 63;
    if (c < 32) c = 32;
    const s = String.fromCharCode(c);
    out += s === '\\' || s === '(' || s === ')' ? `\\${s}` : s;
  }
  return out;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const cor = (c) => c.map((x) => num(x)).join(' ');

class Pagina {
  constructor() { this.ops = []; }
  retangulo(x, y, w, h, { fill, stroke, lw = 0.7 } = {}) {
    if (fill) this.ops.push(`${cor(fill)} rg`);
    if (stroke) this.ops.push(`${cor(stroke)} RG ${num(lw)} w`);
    this.ops.push(`${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
  }
  linha(x1, y1, x2, y2, c, lw = 0.7) { this.ops.push(`${cor(c)} RG ${num(lw)} w ${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S`); }
  // y = linha de base do texto, medido do topo da página
  texto(str, x, y, { size = 10, bold = false, color = [0, 0, 0], align = 'left' } = {}) {
    const w = larg(str, size, bold);
    const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${cor(color)} rg ${num(px)} ${num(H - y)} Td (${enc(str)}) Tj ET`);
  }
  quebrar(str, size, maxW, bold) {
    const palavras = String(str).split(/\s+/).filter(Boolean), linhas = [];
    let atual = '';
    for (const p of palavras) {
      const teste = atual ? `${atual} ${p}` : p;
      if (larg(teste, size, bold) <= maxW || !atual) atual = teste; else { linhas.push(atual); atual = p; }
    }
    if (atual) linhas.push(atual);
    return linhas.length ? linhas : [''];
  }
}

function montarPdf(pagina, titulo) {
  const stream = Buffer.from(pagina.ops.join('\n'), 'latin1');
  const corpo = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    null, // contents
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${enc(titulo)}) /Producer (Simulador de Consorcio) >>`,
  ];
  const partes = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = partes[0].length;
  corpo.forEach((o, i) => {
    offsets.push(pos);
    const b = o === null
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    partes.push(b); pos += b.length;
  });
  const xref = [`xref\n0 ${corpo.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  partes.push(Buffer.from(`${xref}trailer\n<< /Size ${corpo.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(partes);
}

const AZUL = [0.043, 0.141, 0.278], VERDE = [0.07, 0.66, 0.44], CINZA = [0.36, 0.42, 0.51], CLARO = [0.945, 0.96, 0.98], LINHA = [0.84, 0.88, 0.93], BRANCO = [1, 1, 1];

/**
 * dados: { id, nome, telefone, email, renda, credito, tipo, capacidade, parcela, parcelaIntegral, parcelaReduzida,
 *          prazo, plano, interesse, simuladoEm, criadoEm, pagamentoSituacao, pagamentoCor('ok'|'aviso'|'neutro'),
 *          valorPago, pagoEm, emitidoEm }
 * Nunca inclui CPF, nascimento nem nome da mãe (minimização de dados).
 */
function relatorioSimulacao(d) {
  const p = new Pagina();
  const brl = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

  // Cabeçalho
  p.retangulo(0, 0, W, 98, { fill: AZUL });
  p.retangulo(0, 98, W, 4, { fill: VERDE });
  p.texto('SIMULADOR DE CONSÓRCIO', M, 46, { size: 18, bold: true, color: BRANCO });
  p.texto('Relatório individual da simulação', M, 66, { size: 11, color: [0.78, 0.84, 0.93] });
  p.texto(`Nº ${String(d.id).padStart(5, '0')}`, W - M, 46, { size: 13, bold: true, color: BRANCO, align: 'right' });
  p.texto(`Emitido em ${d.emitidoEm}`, W - M, 66, { size: 8.5, color: [0.78, 0.84, 0.93], align: 'right' });

  let y = 136;
  const colW = (W - 2 * M - 22) / 2, x2 = M + colW + 22;
  const secao = (titulo) => {
    p.texto(titulo.toUpperCase(), M, y, { size: 10.5, bold: true, color: AZUL });
    p.linha(M, y + 6, W - M, y + 6, VERDE, 1.4);
    y += 26;
  };
  const campo = (rot, valor, x, w, { destaque = false, cor: c = [0.07, 0.13, 0.2] } = {}) => {
    p.texto(rot.toUpperCase(), x, y, { size: 7.5, bold: true, color: CINZA });
    const linhas = p.quebrar(valor || '—', destaque ? 14 : 11.5, w, destaque);
    linhas.slice(0, 2).forEach((l, i) => p.texto(l, x, y + 16 + i * 14, { size: destaque ? 14 : 11.5, bold: destaque, color: c }));
    return Math.min(linhas.length, 2);
  };
  const linhaCampos = (a, b) => {
    const n1 = campo(a[0], a[1], M, b ? colW : W - 2 * M, a[2] || {});
    const n2 = b ? campo(b[0], b[1], x2, colW, b[2] || {}) : 1;
    y += 22 + Math.max(n1, n2) * 14 + 6;
  };

  secao('Dados do interessado');
  linhaCampos(['Nome completo', d.nome, { destaque: true }]);
  linhaCampos(['WhatsApp', d.telefone], ['E-mail', d.email]);
  linhaCampos(['Renda mensal informada', brl(d.renda)], ['Cadastro realizado em', d.criadoEm]);

  y += 4;
  secao('Simulação');
  linhaCampos(['Modalidade', d.tipo], ['Valor do crédito desejado', brl(d.credito), { destaque: true }]);
  linhaCampos(['Capacidade mensal informada', d.capacidade], ['Parcela escolhida', d.parcela]);
  // Quadro de parcelas
  const altura = d.parcelaReduzida != null ? 78 : 62;
  p.retangulo(M, y - 6, W - 2 * M, altura, { fill: CLARO, stroke: LINHA });
  p.texto('PARCELA ESTIMADA (INTEGRAL)', M + 16, y + 10, { size: 7.5, bold: true, color: CINZA });
  p.texto(brl(d.parcelaIntegral), M + 16, y + 34, { size: 20, bold: true, color: AZUL });
  if (d.parcelaReduzida != null) {
    p.texto('PARCELA REDUZIDA', x2 - 6, y + 10, { size: 7.5, bold: true, color: CINZA });
    p.texto(brl(d.parcelaReduzida), x2 - 6, y + 34, { size: 20, bold: true, color: VERDE });
  }
  p.texto(d.plano ? `${d.plano}${d.prazo ? ` · ${d.prazo} meses` : ''}` : 'Sem plano disponível para este valor', M + 16, y + (d.parcelaReduzida != null ? 60 : 52), { size: 8.5, color: CINZA });
  y += altura + 16;
  linhaCampos(['Interesse em contratar', d.interesse], ['Data da simulação', d.simuladoEm]);

  y += 4;
  secao('Pagamento da simulação');
  const corPag = d.pagamentoCor === 'ok' ? [0.05, 0.54, 0.36] : d.pagamentoCor === 'aviso' ? [0.7, 0.45, 0.02] : [0.07, 0.13, 0.2];
  linhaCampos(['Situação do pagamento', d.pagamentoSituacao, { destaque: true, cor: corPag }], ['Valor', brl(d.valorPago)]);
  linhaCampos(['Forma de pagamento', 'Pix'], ['Confirmado em', d.pagoEm || '—']);

  // Rodapé
  const fy = H - 92;
  p.linha(M, fy, W - M, fy, LINHA, 0.8);
  const aviso = 'Os valores apresentados são estimativos e podem variar conforme o plano, grupo e condições vigentes. A proposta definitiva será apresentada por um especialista. Esta simulação não representa aprovação de crédito nem garantia de contemplação.';
  p.quebrar(aviso, 7.8, W - 2 * M, false).forEach((l, i) => p.texto(l, M, fy + 16 + i * 10.5, { size: 7.8, color: CINZA }));
  p.texto('Documento com dados pessoais: uso interno e confidencial, em conformidade com a LGPD. Não compartilhe.', M, fy + 52, { size: 7.8, bold: true, color: CINZA });
  p.texto('Página 1 de 1', W - M, fy + 66, { size: 7.8, color: CINZA, align: 'right' });

  return montarPdf(p, `Relatorio da simulacao ${String(d.id).padStart(5, '0')}`);
}

module.exports = { relatorioSimulacao, larg };
