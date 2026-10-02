'use strict';
process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mock';
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

const dados = { nome: 'João da Silva', telefone: '11999998888', email: 'joao@exemplo.com', cpf: '52998224725', nascimento: '1988-03-10', nome_mae: 'Maria da Silva', cidade: 'São Paulo', estado: 'SP', capacidade_label: 'R$500 a R$1.000', capacidade_valor: 1000 };

test('fluxo completo: pagamento → simulação → interesse → admin', async () => {
  const co = await call('/api/checkout', { method: 'POST', body: { nome: dados.nome, telefone: dados.telefone, email: dados.email } });
  assert.equal(co.status, 200);
  const h = { 'X-Lead-Token': co.data.token };

  assert.equal((await call('/api/checkout', { method: 'POST', body: { nome: dados.nome, telefone: '123', email: dados.email } })).status, 400);

  // sem pagamento, simulação bloqueada
  let r = await call(`/api/lead/${co.data.leadId}/simular`, { method: 'POST', headers: h, body: { ...dados, tipo: 'imovel', credito: 100000 } });
  assert.equal(r.status, 402);
  // token errado
  assert.equal((await call(`/api/lead/${co.data.leadId}/estado`, { headers: { 'X-Lead-Token': 'x' } })).status, 404);

  assert.equal((await call(`/api/lead/${co.data.leadId}/mock-pay`, { method: 'POST', headers: h })).data.pagamento, 'pago');

  assert.deepEqual((await call('/api/plano-info?tipo=imovel&credito=100000')).data, { disponivel: true, reduzida: true });
  assert.equal((await call('/api/plano-info?tipo=veiculo&credito=100000')).data.reduzida, false);

  r = await call(`/api/lead/${co.data.leadId}/simular`, { method: 'POST', headers: h, body: { ...dados, tipo: 'imovel', credito: 100000, parcela: 'reduzida' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.primeiroNome, 'João');
  const url = new URL(r.data.whatsappUrl);
  assert.equal(url.origin + url.pathname, 'https://wa.me/5541997446032'); // número do especialista, não o do cliente
  const msg = url.searchParams.get('text');
  assert.match(msg, /^Olá! Acabei de fazer minha simulação de consórcio e quero entender melhor as opções disponíveis\./);
  assert.match(msg, /Nome: João da Silva/); assert.match(msg, /Tipo: Imóvel/); assert.match(msg, /Parcela: reduzida/); assert.match(msg, /Valor estimado da parcela: R\$\s?496,19/);
  assert.ok(!url.pathname.includes('11999998888'));
  assert.ok(r.data.parcelaIntegral > r.data.parcelaReduzida);

  r = await call(`/api/lead/${co.data.leadId}/simular`, { method: 'POST', headers: h, body: { ...dados, cpf: '11111111111', tipo: 'imovel', credito: 100000 } });
  assert.equal(r.status, 400);

  r = await call(`/api/lead/${co.data.leadId}/interesse`, { method: 'POST', headers: h, body: { interesse: 'agora' } });
  assert.equal(r.status, 200);
  assert.equal(new URL(r.data.whatsappUrl).pathname, '/5541997446032'); // padrão do especialista

  // admin
  assert.equal((await call('/api/admin/leads')).status, 401);
  const login = await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } });
  const A = { Authorization: `Bearer ${login.data.token}` };
  await call('/api/admin/config', { method: 'PUT', headers: A, body: { whatsapp: '11988887777', learn_url: '' } });
  r = await call(`/api/lead/${co.data.leadId}/interesse`, { method: 'POST', headers: h, body: { interesse: 'agora' } });
  const wa = new URL(r.data.whatsappUrl);
  assert.equal(wa.pathname, '/5511988887777');
  assert.match(wa.searchParams.get('text'), /\(11\) 99999-8888/);
  assert.match(wa.searchParams.get('text'), /Crédito escolhido: R\$\s?100\.000,00/);

  const quentes = await call('/api/admin/leads?filtro=quentes', { headers: A });
  assert.equal(quentes.data.leads.length, 1);
  assert.equal(quentes.data.leads[0].pagamento_status, 'pago');
  assert.equal((await call('/api/admin/leads?filtro=frios', { headers: A })).data.leads.length, 0);
});

test('admin: senha errada e CRUD de plano', async () => {
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { senha: 'errada' } })).status, 401);
  const { data } = await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } });
  const A = { Authorization: `Bearer ${data.token}` };
  const plano = { nome: 'Teste', tipo: 'outros', prazo: 100, taxa_admin: 10, fundo_reserva: 1, seguro: 0.03, indice: 'IPCA', reduzida: true, reducao_pct: 30, reducao_regra: 'parcela_total', regra_texto: 'x', credito_min: 1000, credito_max: 500000, ativo: true };
  const c = await call('/api/admin/planos', { method: 'POST', headers: A, body: plano });
  assert.equal(c.status, 200);
  assert.equal((await call('/api/admin/planos', { method: 'POST', headers: A, body: { ...plano, credito_min: 9e6, credito_max: 1 } })).status, 400);
  assert.equal((await call(`/api/admin/planos/${c.data.id}`, { method: 'DELETE', headers: A })).status, 200);
});
