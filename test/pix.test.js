'use strict';
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'pix';
process.env.PIX_CHAVE = '11222333000181';
process.env.PIX_RECEBEDOR = 'EMPRESA DE TESTE LTDA';
process.env.PIX_CIDADE = 'CURITIBA';
process.env.PIX_WEBHOOK_SECRET = 'segredo-webhook-de-teste-123456';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crc16, brCode } = require('../lib/pix');
const { server } = require('../server');

// Leitor independente do formato BR Code (TLV) para validar o "copia e cola" gerado.
function tlv(str) {
  const out = {};
  for (let i = 0; i < str.length;) {
    const id = str.slice(i, i + 2), len = Number(str.slice(i + 2, i + 4));
    out[id] = str.slice(i + 4, i + 4 + len); i += 4 + len;
  }
  return out;
}

test('CRC16/CCITT-FALSE confere com o vetor padrão', () => assert.equal(crc16('123456789'), '29B1'));

test('BR Code gerado pelo servidor é válido (campos, CRC, nome e cidade dentro dos limites)', async () => {
  const c = brCode({ chave: '11222333000181', valorCentavos: 500, recebedor: 'Empresa de Teste Ltda', cidade: 'Curitiba', txid: 'SIM7' });
  const f = tlv(c);
  assert.equal(f['00'], '01'); assert.equal(f['52'], '0000'); assert.equal(f['53'], '986'); assert.equal(f['54'], '5.00'); assert.equal(f['58'], 'BR');
  assert.equal(tlv(f['26'])['00'], 'br.gov.bcb.pix'); assert.equal(tlv(f['26'])['01'], '11222333000181');
  assert.ok(f['59'].length <= 25 && f['60'].length <= 15);
  assert.equal(tlv(f['62'])['05'], 'SIM7');
  assert.equal(f['63'], crc16(c.slice(0, -4)));
  assert.match(f['63'], /^[0-9A-F]{4}$/);
});

test('BR Code: chave CNPJ, valor 5.00, recebedor e CRC válidos', () => {
  const c = brCode({ chave: '11222333000181', valorCentavos: 500, recebedor: 'EMPRESA DE TESTE LTDA', cidade: 'CURITIBA', txid: 'SIM1' });
  assert.match(c, /^000201/);
  assert.ok(c.includes('br.gov.bcb.pix0114' + '11222333000181'));
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

test('Pix estático: cliente NÃO se libera sozinho; só a confirmação real libera', async () => {
  const co = await call('/api/checkout', { method: 'POST', body: { nome: 'João da Silva', telefone: '11999998888', email: 'j@x.com' } });
  assert.equal(co.status, 200);
  assert.ok(co.data.pix.copiaECola.includes('11222333000181'));
  assert.deepEqual(Object.keys(co.data.pix), ['copiaECola']);            // não expõe dados da empresa recebedora
  assert.equal(co.data.mock, false);
  const h = { 'X-Lead-Token': co.data.token }, id = co.data.leadId;
  const dados = { nome: 'João da Silva', telefone: '11999998888', email: 'j@x.com', cpf: '52998224725', nascimento: '1988-03-10', nome_mae: 'Maria', cidade: 'Curitiba', estado: 'PR', capacidade_label: 'x', capacidade_valor: 1000, renda_mensal: 7000, tipo: 'veiculo', credito: 90000 };

  assert.equal((await call(`/api/lead/${id}/simular`, { method: 'POST', headers: h, body: dados })).status, 402);
  assert.equal((await call(`/api/lead/${id}/mock-pay`, { method: 'POST', headers: h })).status, 404);

  const est = await call(`/api/lead/${id}/estado`, { headers: h });
  assert.equal(est.data.liberado, false);
  assert.ok(est.data.pix.copiaECola); // permite retomar após recarregar a página

  // "Já fiz o pagamento" só avisa o administrador: a simulação continua bloqueada
  assert.equal((await call(`/api/lead/${id}/informar-pagamento`, { method: 'POST', headers: h })).data.pagamento, 'informado');
  assert.equal((await call(`/api/lead/${id}/estado`, { headers: h })).data.liberado, false);
  assert.equal((await call(`/api/lead/${id}/simular`, { method: 'POST', headers: h, body: dados })).status, 402);

  const A = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  assert.equal((await call('/api/admin/leads', { headers: A })).data.aConferir, 1);
  assert.equal((await call(`/api/admin/leads/${id}/pagamento`, { method: 'POST', body: { acao: 'confirmar' } })).status, 401);
  assert.equal((await call(`/api/admin/leads/${id}/pagamento`, { method: 'POST', headers: A, body: { acao: 'confirmar' } })).status, 200);

  assert.equal((await call(`/api/lead/${id}/estado`, { headers: h })).data.liberado, true);
  const sim = await call(`/api/lead/${id}/simular`, { method: 'POST', headers: h, body: dados });
  assert.equal(sim.status, 200);
  assert.equal(sim.data.parcelaIntegral, 1162);
  assert.equal(sim.data.parcelaReduzida, null);
  const lead = (await call('/api/admin/leads', { headers: A })).data.leads[0];
  assert.equal(lead.pagamento_status, 'pago');
  assert.equal(lead.renda_mensal, 7000);
  assert.equal((await call('/api/admin/leads', { headers: A })).data.aConferir, 0);
});

test('Pix: "não recebi" bloqueia; webhook autorizado confirma por txid e valor', async () => {
  const mk = async () => (await call('/api/checkout', { method: 'POST', body: { nome: 'Carla Souza', telefone: '11988887777', email: 'c@x.com' } })).data;
  const A = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  const c1 = await mk();
  await call(`/api/lead/${c1.leadId}/informar-pagamento`, { method: 'POST', headers: { 'X-Lead-Token': c1.token } });
  await call(`/api/admin/leads/${c1.leadId}/pagamento`, { method: 'POST', headers: A, body: { acao: 'recusar' } });
  assert.equal((await call(`/api/lead/${c1.leadId}/estado`, { headers: { 'X-Lead-Token': c1.token } })).data.pagamento, 'recusado');

  const c2 = await mk();
  const pgId = (await call(`/api/admin/leads/${c2.leadId}`, { headers: A })).data.lead.id; // id do lead; txid usa o id do pagamento
  const wh = (body, secret) => call('/api/webhooks/pix', { method: 'POST', headers: secret ? { 'X-Webhook-Secret': secret } : {}, body });
  const txid = tlv(tlv(c2.pix.copiaECola)['62'])['05'];
  assert.match(txid, /^SIM\d+$/);
  assert.equal((await wh({ txid, valor_centavos: 500 })).status, 401);                          // sem segredo
  assert.equal((await wh({ txid, valor_centavos: 500 }, 'errado-errado-errado-1234')).status, 401);
  assert.equal((await wh({ txid, valor_centavos: 100 }, 'segredo-webhook-de-teste-123456')).status, 400); // valor menor
  assert.equal((await wh({ txid: 'XYZ', valor_centavos: 500 }, 'segredo-webhook-de-teste-123456')).status, 400);
  assert.equal((await call(`/api/lead/${c2.leadId}/estado`, { headers: { 'X-Lead-Token': c2.token } })).data.liberado, false);
  assert.equal((await wh({ txid, valor_centavos: 500 }, 'segredo-webhook-de-teste-123456')).status, 200);
  assert.equal((await call(`/api/lead/${c2.leadId}/estado`, { headers: { 'X-Lead-Token': c2.token } })).data.liberado, true);
  assert.ok(pgId > 0);
});

test('admin vê qual conta recebe (chave mascarada); o cliente nunca vê dados da conta', async () => {
  const A = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  const st = (await call('/api/admin/status', { headers: A })).data;
  assert.equal(st.pagamento.pronto, true);
  assert.equal(st.pagamento.conta.recebedor, 'EMPRESA DE TESTE LTDA');
  assert.equal(st.pagamento.conta.chave, '11•••0181');
  assert.ok(!JSON.stringify(st).includes('11222333000181'));          // chave completa nunca é devolvida
  assert.equal((await call('/api/admin/status')).status, 401);
  assert.equal((await call('/api/config')).data.recebedor, undefined); // endpoint público sem dados da conta
});
