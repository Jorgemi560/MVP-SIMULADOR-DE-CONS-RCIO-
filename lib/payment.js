'use strict';
// Camada de pagamento. Para trocar de provedor, implemente { criar, consultar } e registre abaixo.
//  - mock:        apenas desenvolvimento/testes (aprovação manual por botão). Nunca use em produção.
//  - mercadopago: Pix via API de pagamentos do Mercado Pago.
const crypto = require('node:crypto');

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const mock = {
  nome: 'mock',
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

const providers = { mock, mercadopago };
const provider = providers[PROVIDER];
if (!provider) throw new Error(`PAYMENT_PROVIDER inválido: ${PROVIDER}`);
if (provider === mercadopago && !MP_TOKEN) throw new Error('MP_ACCESS_TOKEN é obrigatório com PAYMENT_PROVIDER=mercadopago');
if (provider === mock && process.env.NODE_ENV === 'production') {
  throw new Error('PAYMENT_PROVIDER=mock não é permitido em produção (ninguém pagaria de verdade).');
}

module.exports = { provider };
