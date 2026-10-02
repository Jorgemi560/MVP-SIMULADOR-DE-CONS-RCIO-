'use strict';
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'pix';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crc16, brCode } = require('../lib/pix');
const { server } = require('../server');

test('CRC16/CCITT-FALSE confere com o vetor padrão', () => assert.equal(crc16('123456789'), '29B1'));

test('BR Code: chave CNPJ, valor 5.00, recebedor e CRC válidos', () => {
  const c = brCode({ chave: '49753831000123', valorCentavos: 500, recebedor: 'LATRYKA INDUSTRIAL E COMERCIOS LTDA', cidade: 'CURITIBA', txid: 'SIM1' });
  assert.match(c, /^000201/);
  assert.ok(c.includes('br.gov.bcb.pix0114' + '49753831000123'));
  assert.ok(c.includes('54045.00') && c.includes('5802BR') && c.includes('5303986'));
  assert.equal(c.slice(-4), crc16(c.slice(0, -4)));
});

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());
const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

test('Pix estático: informar pagamento libera; admin confirma ou recusa', async () => {
  const co = await call('/api/checkout', { method: 'POST', body: { nome: 'João da Silva', telefone: '11999998888', email: 'j@x.com' } });
  assert.equal(co.status, 200);
  assert.ok(co.data.pix.copiaECola.includes('49753831000123'));
  assert.equal(co.data.mock, false);
  const h = { 'X-Lead-Token': co.data.token }, id = co.data.leadId;
  const dados = { nome: 'João da Silva', telefone: '11999998888', email: 'j@x.com', cpf: '52998224725', nascimento: '1988-03-10', nome_mae: 'Maria', cidade: 'Curitiba', estado: 'PR', capacidade_label: 'x', capacidade_valor: 1000, tipo: 'veiculo', credito: 90000 };

  assert.equal((await call(`/api/lead/${id}/simular`, { method: 'POST', headers: h, body: dados })).status, 402);
  assert.equal((await call(`/api/lead/${id}/mock-pay`, { method: 'POST', headers: h })).status, 404); // mock não existe neste modo

  const est = await call(`/api/lead/${id}/estado`, { headers: h });
  assert.equal(est.data.liberado, false);
  assert.ok(est.data.pix.copiaECola); // permite retomar após recarregar a página

  assert.equal((await call(`/api/lead/${id}/informar-pagamento`, { method: 'POST', headers: h })).data.pagamento, 'informado');
  const sim = await call(`/api/lead/${id}/simular`, { method: 'POST', headers: h, body: dados });
  assert.equal(sim.status, 200);
  assert.equal(sim.data.parcelaIntegral, 1162);
  assert.equal(sim.data.parcelaReduzida, null);

  const A = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  let lead = (await call('/api/admin/leads', { headers: A })).data.leads[0];
  assert.equal(lead.pagamento_status, 'informado');
  assert.equal((await call(`/api/admin/leads/${id}/pagamento`, { method: 'POST', headers: A, body: { acao: 'confirmar' } })).status, 200);
  lead = (await call('/api/admin/leads', { headers: A })).data.leads[0];
  assert.equal(lead.pagamento_status, 'pago');
  assert.equal((await call(`/api/admin/leads/${id}/pagamento`, { method: 'POST', body: { acao: 'confirmar' } })).status, 401);
});
