'use strict';
// Sem PIX_CHAVE/PIX_RECEBEDOR o serviço NÃO cai: o site abre e o admin avisa, mas ninguém consegue iniciar pagamento.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'pix';
delete process.env.PIX_CHAVE; delete process.env.PIX_RECEBEDOR;
const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');
const { um } = require('../lib/db');

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());

test('sem conta Pix configurada: site e healthz funcionam, checkout é bloqueado sem criar lead e o admin avisa', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal(await (await fetch(base + '/healthz')).text(), 'ok');
  const co = await fetch(base + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: 'Fulano de Tal', telefone: '41987654321', email: 'f@x.com' }) });
  assert.equal(co.status, 503);
  assert.equal((await um('SELECT COUNT(*)::int AS n FROM leads')).n, 0);
  const { token } = await (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'segredo-teste' }) })).json();
  const st = await (await fetch(base + '/api/admin/status', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(st.pagamento.pronto, false);
  assert.equal(st.pagamento.conta, null);
});
