'use strict';
// Camada de pagamento. Para trocar de provedor, implemente { criar, consultar } e registre abaixo.
//  - pix:         Pix estático com a chave configurada em PIX_* (confirmação manual no /admin ou via webhook).
//  - mock:        apenas desenvolvimento/testes (aprovação manual por botão). Nunca use em produção.
//  - mercadopago: Pix via API de pagamentos do Mercado Pago.
const crypto = require('node:crypto');

const { brCode } = require('./pix');
const { analisarChave } = require('./chavepix');

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'pix').toLowerCase();
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const mock = {
  nome: 'mock',
  confirmacao: 'manual',
  pronto: () => true,
  async criar() { return { provedorId: `mock_${crypto.randomUUID()}`, pix: null }; },
  async consultar() { return 'pendente'; }, // aprovação ocorre via /mock-pay
};

const MP_STATUS = { approved: 'pago', rejected: 'recusado', cancelled: 'cancelado', refunded: 'cancelado', charged_back: 'cancelado' };

// Validade de cada cobrança Pix, em minutos (PIX_VALIDADE_MINUTOS, padrão 30). O Mercado Pago aceita no mínimo 30.
function validadeMinutos() {
  const bruto = Number(process.env.PIX_VALIDADE_MINUTOS);
  let v = Number.isInteger(bruto) && bruto >= 1 && bruto <= 1440 ? bruto : 30;
  if (PROVIDER === 'mercadopago') v = Math.max(35, v); // o MP exige mínimo de 30 min contados no recebimento; sobra de segurança
  return v;
}

// Remove de textos de diagnóstico: e-mails, sequências longas de dígitos (CPF/telefone/cartão) e tokens do Mercado Pago.
const limpar = (t) => String(t ?? '').replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[e-mail]').replace(/\b(APP_USR|TEST)-[\w-]+/g, '[token]').replace(/\d{8,}/g, '[número]').slice(0, 300);

// Erro do Mercado Pago com os campos úteis para diagnóstico (status HTTP, código, causas e id da requisição), já sem dados pessoais.
class MpError extends Error {
  constructor({ http = 0, codigo = '', mensagem = '', causas = [], requestId = '' }) {
    super(`Mercado Pago ${http || 'sem resposta'}${codigo ? ` [${limpar(codigo)}]` : ''}: ${limpar(mensagem) || 'erro'}${causas.length ? ` | causas: ${causas.map(limpar).join('; ')}` : ''}`);
    Object.assign(this, { http, codigo: limpar(codigo), mensagemMp: limpar(mensagem), causas: causas.map(limpar), requestId: limpar(requestId) });
  }
}

async function mpFetch(url, opts = {}) {
  let r;
  try {
    r = await fetch(`https://api.mercadopago.com${url}`, {
      ...opts,
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { // rede, DNS, TLS ou tempo esgotado: não houve resposta do Mercado Pago
    throw new MpError({ http: 0, codigo: e.cause?.code || e.name, mensagem: e.name === 'TimeoutError' ? 'tempo esgotado (8 s) esperando o Mercado Pago' : e.message });
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const causas = Array.isArray(body.cause) ? body.cause.map((c) => `${c.code ?? ''} ${c.description ?? ''}`.trim()) : [];
    throw new MpError({ http: r.status, codigo: body.error || body.code || '', mensagem: body.message || '', causas, requestId: r.headers?.get?.('x-request-id') || '' });
  }
  return body;
}

// Tradução do erro em orientação objetiva (aparece no /admin, nunca para o cliente).
function dicaParaErro(e) {
  const t = `${e.http} ${e.codigo} ${e.mensagemMp} ${(e.causas || []).join(' ')}`.toLowerCase();
  if (!e.http) return /enotfound|eai_again|econn|timeout|tempo esgotado|fetch failed/.test(t) ? 'Sem comunicação com o Mercado Pago (rede/DNS/tempo esgotado). Costuma ser passageiro; se persistir, veja o status do Mercado Pago.' : 'Falha de comunicação com o Mercado Pago.';
  if (/collector user without key|without key enabled|qr render/.test(t)) return 'A conta do Mercado Pago não tem uma CHAVE PIX cadastrada. No app/site do Mercado Pago: Seu dinheiro → Pix → Suas chaves → cadastre uma chave (ex.: aleatória) e tente de novo.';
  if (e.http === 401 || /invalid.*(token|credential)|unauthorized/.test(t)) return 'Token recusado pelo Mercado Pago. Confira MP_ACCESS_TOKEN no Render (sem espaços, token de PRODUÇÃO APP_USR-…, da aplicação certa).';
  if (e.http === 403 || /live credentials|not.*authorized|forbidden|pa_unauthorized/.test(t)) return 'Credencial sem permissão para criar pagamentos reais. Ative as credenciais de PRODUÇÃO da aplicação e confirme que a conta está verificada.';
  if (/notification_url|notification url/.test(t)) return 'O endereço de aviso (notification_url) foi recusado. Confira PUBLIC_URL no Render: deve ser https://ganhemaisno.online (sem barra no fim, sem localhost).';
  if (/date_of_expiration|expiration/.test(t)) return 'A validade da cobrança foi recusada. Confira PIX_VALIDADE_MINUTOS (use entre 35 e 1440).';
  if (/payer|email/.test(t)) return 'O e-mail do pagador foi recusado. Pode ser inválido, ou igual ao e-mail da própria conta do Mercado Pago (o pagador não pode ser o vendedor).';
  if (e.http === 400) return 'O Mercado Pago recusou os dados da cobrança (400). Veja a mensagem e as causas acima.';
  if (e.http >= 500) return 'Instabilidade no Mercado Pago (erro 5xx). Tente de novo em instantes.';
  return 'Erro não classificado; veja a mensagem acima.';
}

const mercadopago = {
  nome: 'mercadopago',
  confirmacao: 'automatica',
  pronto: () => true,
  async criar({ pagamentoId, valorCentavos, email, nome, expiraEm }) {
    const body = await mpFetch('/v1/payments', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': `sim-${pagamentoId}` },
      body: JSON.stringify({
        transaction_amount: valorCentavos / 100,
        description: 'Simulação personalizada de consórcio',
        payment_method_id: 'pix',
        external_reference: String(pagamentoId),
        // Validade da cobrança no próprio Mercado Pago (depois dela o código não pode mais ser pago)
        ...(expiraEm ? { date_of_expiration: new Date(expiraEm).toISOString().replace('Z', '+00:00') } : {}),
        payer: { email, first_name: nome.split(' ')[0] },
        ...(PUBLIC_URL ? { notification_url: `${PUBLIC_URL}/api/webhooks/mercadopago` } : {}),
      }),
    });
    const t = body.point_of_interaction?.transaction_data || {};
    return { provedorId: String(body.id), pix: { copiaECola: t.qr_code, qrBase64: t.qr_code_base64 } };
  },
  // Consulta o status REAL no Mercado Pago. "esperado" ({ pagamentoId, valorCentavos }) amarra a resposta à nossa cobrança:
  // só vale como pago se o external_reference for o nosso id e o valor pago for pelo menos o cobrado.
  async consultar(provedorId, esperado) {
    const body = await mpFetch(`/v1/payments/${encodeURIComponent(provedorId)}`);
    if (body.status === 'cancelled' && body.status_detail === 'expired') return 'expirado'; // Pix vencido
    const st = MP_STATUS[body.status] || 'pendente';
    if (st === 'pago' && esperado) {
      const pago = Math.round(Number(body.transaction_amount) * 100);
      if (String(body.external_reference) !== String(esperado.pagamentoId) || !(pago >= esperado.valorCentavos)) {
        console.error(`⚠ Pagamento ${provedorId} aprovado no Mercado Pago, mas NÃO confere com a cobrança (ref=${body.external_reference}, valor=${body.transaction_amount}). Ignorado.`);
        return 'pendente';
      }
    }
    return st;
  },
};

// Assinatura dos avisos (webhooks) do Mercado Pago: cabeçalho x-signature "ts=…,v1=…". O v1 é o HMAC-SHA256 (chave = MP_WEBHOOK_SECRET)
// do texto "id:<data.id>;request-id:<x-request-id>;ts:<ts>;". Mesmo com assinatura válida, o status é sempre reconsultado na API.
function assinaturaMpValida({ dataId, xSignature, xRequestId }, segredo = MP_WEBHOOK_SECRET) {
  if (!segredo) return null; // sem segredo configurado não há como validar
  const partes = Object.fromEntries(String(xSignature || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  if (!partes.ts || !partes.v1) return false;
  const id = /^[a-z0-9]+$/i.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  const esperado = crypto.createHmac('sha256', segredo).update(`id:${id};request-id:${xRequestId || ''};ts:${partes.ts};`).digest('hex');
  const a = Buffer.from(esperado), b = Buffer.from(String(partes.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Situação da configuração do Mercado Pago para o painel (nunca devolve o token).
const mpInfo = () => ({
  tokenTipo: MP_TOKEN.startsWith('TEST-') ? 'teste' : MP_TOKEN.startsWith('APP_USR-') ? 'producao' : 'desconhecido',
  publicUrl: !!PUBLIC_URL, webhookSecret: !!MP_WEBHOOK_SECRET,
});

// Pix estático (sem API de banco): gera o "copia e cola" com valor, chave e identificador (txid "SIM<id>").
// A conta recebedora é só configuração (variáveis PIX_*): para trocar de conta, altere as variáveis no Render.
// IMPORTANTE: não há como o sistema ver o extrato do banco. O pagamento só passa a "pago" quando
//  (a) o administrador confirma em /admin, ou
//  (b) um serviço autorizado chama POST /api/webhooks/pix com o segredo PIX_WEBHOOK_SECRET.
// O cliente NUNCA se declara pagante: "Já fiz o pagamento" só avisa o administrador.
// A conta que RECEBE o dinheiro é definida pela CHAVE Pix (PIX_CHAVE): é o banco que decide quem é o titular da chave.
// PIX_RECEBEDOR e PIX_CIDADE só alimentam o texto do código; os apps de banco mostram o titular REAL da chave.
// A chave é normalizada para o formato exato do DICT (ver lib/chavepix.js). Chave que não dá para reconhecer BLOQUEIA o
// pagamento (o cliente nunca recebe um QR Code que o banco vai recusar) e o /admin explica o motivo.
function pixChaveInfo() { return analisarChave(process.env.PIX_CHAVE); }
function pixConfigOuNulo() {
  const info = pixChaveInfo();
  const recebedor = (process.env.PIX_RECEBEDOR || '').trim();
  if (!info.ok || !recebedor) return null;
  return { chave: info.valor, recebedor, cidade: (process.env.PIX_CIDADE || 'BRASIL').trim() };
}
function pixConfig() {
  const c = pixConfigOuNulo();
  if (!c) throw new Error('Com PAYMENT_PROVIDER=pix defina PIX_CHAVE e PIX_RECEBEDOR (veja .env.example).');
  return c;
}
const mascarar = (t) => (t.length <= 6 ? '••••' : `${t.slice(0, 2)}•••${t.slice(-4)}`);
// Conta que está recebendo agora (para o administrador conferir em /admin; nunca aparece para o cliente).
const contaPix = () => {
  const c = pixConfigOuNulo();
  return c ? { recebedor: c.recebedor, chave: mascarar(c.chave), cidade: c.cidade, tipoChave: pixChaveInfo().tipo, chaveAjustada: pixChaveInfo().ajustada } : null;
};
// Motivo de a chave configurada ser recusada (null se está ok ou ainda não foi informada).
const chavePixProblema = () => { if (!(process.env.PIX_CHAVE || '').trim()) return null; const i = pixChaveInfo(); return i.ok ? null : i.motivo; };
const codigoPix = (pagamentoId, valorCentavos) => {
  const c = pixConfig();
  return brCode({ chave: c.chave, valorCentavos, recebedor: c.recebedor, cidade: c.cidade, txid: `SIM${pagamentoId}` });
};
const pix = {
  nome: 'pix',
  confirmacao: 'manual',
  pronto: () => !!pixConfigOuNulo(),
  async criar({ pagamentoId, valorCentavos }) {
    return { provedorId: `SIM${pagamentoId}`, pix: { copiaECola: codigoPix(pagamentoId, valorCentavos) } };
  },
  async consultar() { return 'pendente'; },
};

const providers = { mock, mercadopago, pix };
const provider = providers[PROVIDER];
if (!provider) throw new Error(`PAYMENT_PROVIDER inválido: ${PROVIDER}`);
if (provider === pix && chavePixProblema()) console.error(`⚠ PIX_CHAVE inválida: ${chavePixProblema()} Pagamentos Pix ficam INDISPONÍVEIS até corrigir.`);
else if (provider === pix && pixConfigOuNulo() && pixChaveInfo().ajustada) console.warn(`⚠ PIX_CHAVE foi normalizada para o formato do Pix (tipo: ${pixChaveInfo().tipo}). Confira em /admin e atualize a variável no Render.`);
if (provider === pix && !pixConfigOuNulo()) {
  // Não derruba o serviço (com disco no Render isso causaria indisponibilidade): o site abre, mas o pagamento fica
  // bloqueado com aviso no /admin até PIX_CHAVE e PIX_RECEBEDOR serem definidos.
  console.error('⚠ PIX_CHAVE e/ou PIX_RECEBEDOR não definidos: pagamentos Pix ficam INDISPONÍVEIS até configurar (veja .env.example).');
}
if (provider === mercadopago) {
  let host = '(não definido)'; try { host = PUBLIC_URL ? new URL(PUBLIC_URL).host : host; } catch { host = '(inválido)'; }
  console.log(`Mercado Pago: token=${mpInfo().tokenTipo} PUBLIC_URL=${host} webhookSecret=${MP_WEBHOOK_SECRET ? 'sim' : 'não'} validade=${validadeMinutos()}min`);
  if (mpInfo().tokenTipo !== 'producao') console.error('⚠ MP_ACCESS_TOKEN não parece de PRODUÇÃO (esperado APP_USR-…): pagamentos reais podem falhar.');
  if (PUBLIC_URL && !PUBLIC_URL.startsWith('https://')) console.error('⚠ PUBLIC_URL deve começar com https:// (o Mercado Pago recusa notification_url sem https).');
}
if (provider === mercadopago && !MP_TOKEN) throw new Error('MP_ACCESS_TOKEN é obrigatório com PAYMENT_PROVIDER=mercadopago');
if (provider === mock && process.env.NODE_ENV === 'production') {
  throw new Error('PAYMENT_PROVIDER=mock não é permitido em produção (ninguém pagaria de verdade).');
}

module.exports = { provider, providers, codigoPix, contaPix, chavePixProblema, validadeMinutos, assinaturaMpValida, mpInfo, dicaParaErro, limpar, MpError, mpFetch };
