'use strict';
// Mercado Pago (API simulada, nenhuma chamada real): validade enviada ao provedor, expiração detectada e pagamento de última hora não perdido.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mercadopago';
process.env.MP_ACCESS_TOKEN = 'TEST-token-falso';
process.env.TRUST_PROXY_HOPS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');

const mp = new Map(); // id -> { status, status_detail }
const criados = [];
let seq = 1000;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.mercadopago.com')) return realFetch(url, opts);
  const resp = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
  if (opts.method === 'POST') {
    const b = JSON.parse(opts.body); const id = ++seq;
    mp.set(String(id), { status: 'pending' }); criados.push(b);
    return resp({ id, status: 'pending', point_of_interaction: { transaction_data: { qr_code: `000201MP${id}`, qr_code_base64: 'QUJD' } } });
  }
  const id = String(url).split('/').pop();
  return resp({ id, ...(mp.get(id) || { status: 'pending' }) });
};

const { server } = require('../server');
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
  mp.set(pg1.provedor_id, { status: 'cancelled', status_detail: 'expired' });
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'expirado'); assert.equal(e.pix, null); assert.equal(e.podeRenovar, true);
  const n = await c.novoPix();
  assert.equal(n.data.novo, true); assert.notEqual(n.data.pix.copiaECola, antigo);
  const e2 = (await c.estado()).data;
  assert.equal(e2.pagamento, 'pendente'); assert.equal(e2.pix.copiaECola, n.data.pix.copiaECola); // código guardado: sobrevive ao recarregar
  // paga o novo no MP → liberado
  const pg2 = await db.um("SELECT provedor_id FROM pagamentos WHERE lead_id = ? AND status = 'pendente'", [c.id]);
  mp.set(pg2.provedor_id, { status: 'approved' });
  const e3 = (await c.estado()).data;
  assert.equal(e3.pagamento, 'pago'); assert.equal(e3.liberado, true);
});

test('pagamento aprovado no MP no último segundo não se perde, mesmo após o vencimento local', async () => {
  const c = await cliente();
  const pg = await db.um('SELECT provedor_id FROM pagamentos WHERE lead_id = ?', [c.id]);
  await db.exec("UPDATE pagamentos SET expira_em = now() - interval '1 minute' WHERE lead_id = ?", [c.id]);
  mp.set(pg.provedor_id, { status: 'approved' });
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'pago'); assert.equal(e.liberado, true);
});

test('falha ao criar o novo Pix no MP: tentativa cancelada, erro claro e dá para tentar de novo', async () => {
  const c = await cliente();
  const pg = await db.um('SELECT provedor_id FROM pagamentos WHERE lead_id = ?', [c.id]);
  mp.set(pg.provedor_id, { status: 'cancelled', status_detail: 'expired' });
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
  mp.set(pg.provedor_id, { status: 'cancelled', status_detail: 'expired' }); // agora o provedor confirma o encerramento
  assert.equal((await c.novoPix()).data.novo, true);
});
