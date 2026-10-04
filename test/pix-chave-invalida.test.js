'use strict';
// Chave Pix inválida em produção: o pagamento fica BLOQUEADO (sem QR Code) e o /admin explica o motivo.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'pix';
process.env.PIX_CHAVE = '12345';
process.env.PIX_RECEBEDOR = 'EMPRESA';
const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());
const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

test('chave inválida: checkout recusado (503) e /admin mostra o motivo', async () => {
  const co = await call('/api/checkout', { method: 'POST', body: { nome: 'Fulano de Tal', telefone: '11988887777', email: 'f@exemplo.com' } });
  assert.equal(co.status, 503);
  const A = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  const st = (await call('/api/admin/status', { headers: A })).data;
  assert.equal(st.pagamento.pronto, false); assert.ok(st.pagamento.chaveProblema);
});
