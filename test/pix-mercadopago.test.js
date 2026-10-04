'use strict';
// Mercado Pago (API simulada, nenhuma chamada real): validade enviada ao provedor, expiração detectada e pagamento de última hora não perdido.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mercadopago';
process.env.MP_ACCESS_TOKEN = 'TEST-token-falso';
process.env.TRUST_PROXY_HOPS = '1';
process.env.MP_WEBHOOK_SECRET = 'segredo-webhook-mp-teste';
process.env.PUBLIC_URL = 'https://exemplo.test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const mp = new Map(); // id -> { status, status_detail, external_reference, transaction_amount }
const setMp = (id, patch) => mp.set(String(id), { ...mp.get(String(id)), ...patch });
const criados = [];
let seq = 1000;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.mercadopago.com')) return realFetch(url, opts);
  const resp = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
  if (opts.method === 'POST') {
    const b = JSON.parse(opts.body); const id = ++seq;
    mp.set(String(id), { status: 'pending', external_reference: b.external_reference, transaction_amount: b.transaction_amount }); criados.push(b);
    return resp({ id, status: 'pending', point_of_interaction: { transaction_data: { qr_code: `000201MP${id}`, qr_code_base64: 'QUJD' } } });
  }
  const id = String(url).split('/').pop();
  return resp({ id, ...(mp.get(id) || { status: 'pending' }) });
};

const { server, varrerMercadoPago } = require('../server');
const db = require('../lib/db');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => { global.fetch = realFetch; server.close(); });

const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await realFetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
let ip = 0;
async function cliente() {
  const xff = { 'X-Forwarded-For': `10.8.0.${++ip}` };
  const co = await call('/api/checkout', { method: 'POST', headers: xff, body: { nome: 'Bia Lima', telefone: `1197777${String(ip).padStart(4, '0')}`, email: `bia${ip}@exemplo.com` } });
  assert.equal(co.status, 200);
  const h = { ...xff, 'X-Lead-Token': co.data.token };
  return { id: co.data.leadId, co, h, estado: () => call(`/api/lead/${co.data.leadId}/estado`, { headers: h }), novoPix: () => call(`/api/lead/${co.data.leadId}/novo-pix`, { method: 'POST', headers: h }) };
}

test('a validade é enviada ao Mercado Pago (date_of_expiration com folga sobre o mínimo de 30 min)', async () => {
  const c = await cliente();
  const corpo = criados.at(-1);
  const falta = Date.parse(corpo.date_of_expiration) - Date.now();
  assert.match(corpo.date_of_expiration, /\+00:00$/);
  assert.ok(falta > 33 * 60000 && falta <= 35 * 60000 + 5000, `validade ${falta}ms`); // sempre acima do mínimo de 30 min do MP
  assert.equal(corpo.transaction_amount, 5);
  assert.ok(c.co.data.pix.copiaECola.startsWith('000201MP'));
});

test('MP informa "expired": vira expirado; novo Pix cria outra cobrança no MP; reabrir mostra o novo código', async () => {
  const c = await cliente();
  const antigo = c.co.data.pix.copiaECola;
  const pg1 = await db.um('SELECT provedor_id FROM pagamentos WHERE lead_id = ?', [c.id]);
  setMp(pg1.provedor_id, { status: 'cancelled', status_detail: 'expired' });
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'expirado'); assert.equal(e.pix, null); assert.equal(e.podeRenovar, true);
  const n = await c.novoPix();
  assert.equal(n.data.novo, true); assert.notEqual(n.data.pix.copiaECola, antigo);
  const e2 = (await c.estado()).data;
  assert.equal(e2.pagamento, 'pendente'); assert.equal(e2.pix.copiaECola, n.data.pix.copiaECola); // código guardado: sobrevive ao recarregar
  // paga o novo no MP → liberado
  const pg2 = await db.um("SELECT provedor_id FROM pagamentos WHERE lead_id = ? AND status = 'pendente'", [c.id]);
  setMp(pg2.provedor_id, { status: 'approved' });
  const e3 = (await c.estado()).data;
  assert.equal(e3.pagamento, 'pago'); assert.equal(e3.liberado, true);
});

test('pagamento aprovado no MP no último segundo não se perde, mesmo após o vencimento local', async () => {
  const c = await cliente();
  const pg = await db.um('SELECT provedor_id FROM pagamentos WHERE lead_id = ?', [c.id]);
  await db.exec("UPDATE pagamentos SET expira_em = now() - interval '1 minute' WHERE lead_id = ?", [c.id]);
  setMp(pg.provedor_id, { status: 'approved' });
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'pago'); assert.equal(e.liberado, true);
});

test('falha ao criar o novo Pix no MP: tentativa cancelada, erro claro e dá para tentar de novo', async () => {
  const c = await cliente();
  const pg = await db.um('SELECT provedor_id FROM pagamentos WHERE lead_id = ?', [c.id]);
  setMp(pg.provedor_id, { status: 'cancelled', status_detail: 'expired' });
  await c.estado();
  const f = global.fetch;
  global.fetch = async (url, opts = {}) => (opts.method === 'POST' && String(url).includes('mercadopago') ? { ok: false, status: 500, json: async () => ({ message: 'erro' }) } : f(url, opts));
  const r = await c.novoPix();
  global.fetch = f;
  assert.equal(r.status, 502);
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ? AND status = 'pendente'", [c.id])).n, 0);
  assert.equal((await c.novoPix()).data.novo, true);
});

test('vencido localmente mas o MP ainda diz "pendente": NÃO gera novo Pix (risco de pagamento do anterior)', async () => {
  const c = await cliente();
  await db.exec("UPDATE pagamentos SET expira_em = now() - interval '1 minute' WHERE lead_id = ?", [c.id]);
  const r = await c.novoPix();
  assert.equal(r.status, 409);
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [c.id])).n, 1);
  const pg = await db.um('SELECT provedor_id FROM pagamentos WHERE lead_id = ?', [c.id]);
  setMp(pg.provedor_id, { status: 'cancelled', status_detail: 'expired' }); // agora o provedor confirma o encerramento
  assert.equal((await c.novoPix()).data.novo, true);
});

// ---------- webhook, varredura e segurança da confirmação ----------
const ids = async (leadId) => (await db.um('SELECT id, provedor_id, status, pago_em FROM pagamentos WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [leadId]));
const assinar = (dataId, reqId = 'req-1', ts = String(Date.now()), segredo = process.env.MP_WEBHOOK_SECRET) =>
  ({ 'x-signature': `ts=${ts},v1=${crypto.createHmac('sha256', segredo).update(`id:${dataId};request-id:${reqId};ts:${ts};`).digest('hex')}`, 'x-request-id': reqId });
const aviso = (dataId, headers = {}, body = { type: 'payment', data: { id: String(dataId) } }) =>
  call(`/api/webhooks/mercadopago?data.id=${dataId}&type=payment`, { method: 'POST', headers: { 'X-Forwarded-For': '10.8.9.9', ...headers }, body });

test('webhook assinado + aprovado: confirma NA HORA, sem o cliente consultar nada, e a tela avança (liberado)', async () => {
  const c = await cliente(); const p = await ids(c.id);
  setMp(p.provedor_id, { status: 'approved' });
  const r = await aviso(p.provedor_id, assinar(p.provedor_id));
  assert.equal(r.status, 200);
  assert.equal((await ids(c.id)).status, 'pago'); // gravado pelo webhook, antes de qualquer consulta do cliente
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'pago'); assert.equal(e.liberado, true); assert.equal(e.pix, null);
});

test('webhook com assinatura inválida/ausente é rejeitado e nada é confirmado', async () => {
  const c = await cliente(); const p = await ids(c.id);
  setMp(p.provedor_id, { status: 'approved' }); // mesmo "aprovado" no MP, o aviso falso não passa
  assert.equal((await aviso(p.provedor_id, assinar(p.provedor_id, 'r', '1', 'outro-segredo'))).status, 401);
  assert.equal((await aviso(p.provedor_id, {})).status, 401);
  assert.equal((await ids(c.id)).status, 'pendente');
});

test('aviso falso ("approved" no corpo) não libera: vale só o que a API do MP diz', async () => {
  const c = await cliente(); const p = await ids(c.id); // MP continua "pending"
  const r = await aviso(p.provedor_id, assinar(p.provedor_id), { type: 'payment', action: 'payment.updated', data: { id: p.provedor_id }, status: 'approved' });
  assert.equal(r.status, 200);
  assert.equal((await ids(c.id)).status, 'pendente'); assert.equal((await c.estado()).data.liberado, false);
});

test('pagamento aprovado que NÃO confere (valor menor ou referência de outra cobrança) não libera', async () => {
  const a = await cliente(), pa = await ids(a.id);
  setMp(pa.provedor_id, { status: 'approved', transaction_amount: 1 });           // pagou R$ 1,00 em vez de R$ 5,00
  assert.equal((await a.estado()).data.liberado, false);
  const b = await cliente(), pb = await ids(b.id);
  setMp(pb.provedor_id, { status: 'approved', external_reference: '999999' });    // referência de outra cobrança
  assert.equal((await b.estado()).data.liberado, false);
  assert.equal((await ids(a.id)).status, 'pendente'); assert.equal((await ids(b.id)).status, 'pendente');
});

test('confirmações duplicadas são inofensivas (webhook repetido não muda a data de pagamento)', async () => {
  const c = await cliente(); const p = await ids(c.id);
  setMp(p.provedor_id, { status: 'approved' });
  await aviso(p.provedor_id, assinar(p.provedor_id));
  const primeiro = (await ids(c.id)).pago_em;
  await new Promise((r) => setTimeout(r, 20));
  await Promise.all([aviso(p.provedor_id, assinar(p.provedor_id, 'r2')), aviso(p.provedor_id, assinar(p.provedor_id, 'r3')), c.estado()]);
  assert.equal(new Date((await ids(c.id)).pago_em).getTime(), new Date(primeiro).getTime());
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ? AND status = 'pago'", [c.id])).n, 1);
});

test('webhook NÃO recebido: a varredura em segundo plano confirma sozinha (cliente nem precisa estar na página)', async () => {
  const c = await cliente(); const p = await ids(c.id);
  setMp(p.provedor_id, { status: 'approved' });
  assert.equal((await ids(c.id)).status, 'pendente');
  const n = await varrerMercadoPago();
  assert.ok(n >= 1);
  assert.equal((await ids(c.id)).status, 'pago');
  assert.equal((await c.estado()).data.liberado, true); // ao voltar ao site, já está liberado
});

test('situações do MP: pendente não libera; recusado e expirado mostram nova tentativa; aprovado libera', async () => {
  const pend = await cliente(), rec = await cliente(), exp = await cliente(), ok = await cliente();
  const set = async (c, patch) => setMp((await ids(c.id)).provedor_id, patch);
  await set(rec, { status: 'rejected' }); await set(exp, { status: 'cancelled', status_detail: 'expired' }); await set(ok, { status: 'approved' });
  await set(pend, { status: 'in_process' });
  const e = { pend: (await pend.estado()).data, rec: (await rec.estado()).data, exp: (await exp.estado()).data, ok: (await ok.estado()).data };
  assert.deepEqual([e.pend.pagamento, e.pend.liberado], ['pendente', false]);
  assert.deepEqual([e.rec.pagamento, e.rec.liberado, e.rec.podeRenovar], ['recusado', false, true]);
  assert.deepEqual([e.exp.pagamento, e.exp.liberado, e.exp.podeRenovar], ['expirado', false, true]);
  assert.deepEqual([e.ok.pagamento, e.ok.liberado], ['pago', true]);
});

test('MP fora do ar: a consulta falha sem derrubar a tela nem liberar; ao voltar, reconhece', async () => {
  const c = await cliente(); const p = await ids(c.id);
  const f = global.fetch;
  global.fetch = async (url, opts = {}) => (String(url).includes('mercadopago') ? Promise.reject(new Error('rede')) : f(url, opts));
  const e = await c.estado();
  global.fetch = f;
  assert.equal(e.status, 200); assert.equal(e.data.liberado, false); assert.equal(e.data.pagamento, 'pendente');
  setMp(p.provedor_id, { status: 'approved' });
  assert.equal((await c.estado()).data.liberado, true);
});

test('o botão "já fiz o pagamento" não existe com Mercado Pago (endpoint recusa) e outro evento do MP é ignorado', async () => {
  const c = await cliente();
  assert.equal((await call(`/api/lead/${c.id}/informar-pagamento`, { method: 'POST', headers: c.h })).status, 404);
  const p = await ids(c.id);
  assert.equal((await aviso(p.provedor_id, assinar(p.provedor_id), { type: 'merchant_order', data: { id: p.provedor_id } })).status, 200);
});
