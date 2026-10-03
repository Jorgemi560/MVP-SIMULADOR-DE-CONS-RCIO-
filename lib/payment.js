'use strict';
// Camada de pagamento. Para trocar de provedor, implemente { criar, consultar } e registre abaixo.
//  - pix:         Pix estático com a chave configurada em PIX_* (confirmação manual no /admin ou via webhook).
//  - mock:        apenas desenvolvimento/testes (aprovação manual por botão). Nunca use em produção.
//  - mercadopago: Pix via API de pagamentos do Mercado Pago.
const crypto = require('node:crypto');

const { brCode } = require('./pix');

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'pix').toLowerCase();
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const mock = {
  nome: 'mock',
  confirmacao: 'manual',
  pronto: () => true,
  async criar() { return { provedorId: `mock_${crypto.randomUUID()}`, pix: null }; },
  async consultar() { return 'pendente'; }, // aprovação ocorre via /mock-pay
};

const MP_STATUS = { approved: 'pago', rejected: 'recusado', cancelled: 'cancelado', refunded: 'cancelado', charged_back: 'cancelado' };

async function mpFetch(url, opts = {}) {
  const r = await fetch(`https://api.mercadopago.com${url}`, {
    ...opts,
    headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Mercado Pago ${r.status}: ${body.message || 'erro'}`);
  return body;
}

const mercadopago = {
  nome: 'mercadopago',
  confirmacao: 'automatica',
  pronto: () => true,
  async criar({ pagamentoId, valorCentavos, email, nome }) {
    const body = await mpFetch('/v1/payments', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': `sim-${pagamentoId}` },
      body: JSON.stringify({
        transaction_amount: valorCentavos / 100,
        description: 'Simulação personalizada de consórcio',
        payment_method_id: 'pix',
        external_reference: String(pagamentoId),
        payer: { email, first_name: nome.split(' ')[0] },
        ...(PUBLIC_URL ? { notification_url: `${PUBLIC_URL}/api/webhooks/mercadopago` } : {}),
      }),
    });
    const t = body.point_of_interaction?.transaction_data || {};
    return { provedorId: String(body.id), pix: { copiaECola: t.qr_code, qrBase64: t.qr_code_base64 } };
  },
  async consultar(provedorId) {
    const body = await mpFetch(`/v1/payments/${encodeURIComponent(provedorId)}`);
    return MP_STATUS[body.status] || 'pendente';
  },
};

// Pix estático (sem API de banco): gera o "copia e cola" com valor, chave e identificador (txid "SIM<id>").
// A conta recebedora é só configuração (variáveis PIX_*): para trocar de conta, altere as variáveis no Render.
// IMPORTANTE: não há como o sistema ver o extrato do banco. O pagamento só passa a "pago" quando
//  (a) o administrador confirma em /admin, ou
//  (b) um serviço autorizado chama POST /api/webhooks/pix com o segredo PIX_WEBHOOK_SECRET.
// O cliente NUNCA se declara pagante: "Já fiz o pagamento" só avisa o administrador.
// A conta que RECEBE o dinheiro é definida pela CHAVE Pix (PIX_CHAVE): é o banco que decide quem é o titular da chave.
// PIX_RECEBEDOR e PIX_CIDADE só alimentam o texto do código; os apps de banco mostram o titular REAL da chave.
function pixConfigOuNulo() {
  const chave = (process.env.PIX_CHAVE || '').replace(/\s/g, '');
  const recebedor = (process.env.PIX_RECEBEDOR || '').trim();
  if (!chave || !recebedor) return null;
  return { chave, recebedor, cidade: (process.env.PIX_CIDADE || 'BRASIL').trim() };
}
function pixConfig() {
  const c = pixConfigOuNulo();
  if (!c) throw new Error('Com PAYMENT_PROVIDER=pix defina PIX_CHAVE e PIX_RECEBEDOR (veja .env.example).');
  return c;
}
const mascarar = (t) => (t.length <= 6 ? '••••' : `${t.slice(0, 2)}•••${t.slice(-4)}`);
// Conta que está recebendo agora (para o administrador conferir em /admin; nunca aparece para o cliente).
const contaPix = () => { const c = pixConfigOuNulo(); return c ? { recebedor: c.recebedor, chave: mascarar(c.chave), cidade: c.cidade } : null; };
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
if (provider === pix && !pixConfigOuNulo()) {
  // Não derruba o serviço (com disco no Render isso causaria indisponibilidade): o site abre, mas o pagamento fica
  // bloqueado com aviso no /admin até PIX_CHAVE e PIX_RECEBEDOR serem definidos.
  console.error('⚠ PIX_CHAVE e/ou PIX_RECEBEDOR não definidos: pagamentos Pix ficam INDISPONÍVEIS até configurar (veja .env.example).');
}
if (provider === mercadopago && !MP_TOKEN) throw new Error('MP_ACCESS_TOKEN é obrigatório com PAYMENT_PROVIDER=mercadopago');
if (provider === mock && process.env.NODE_ENV === 'production') {
  throw new Error('PAYMENT_PROVIDER=mock não é permitido em produção (ninguém pagaria de verdade).');
}

module.exports = { provider, codigoPix, contaPix };
