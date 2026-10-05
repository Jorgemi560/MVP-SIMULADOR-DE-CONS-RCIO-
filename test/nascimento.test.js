'use strict';
// A validação de data de nascimento continua no servidor: só maiores de 18 anos e nunca data futura.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.TRUST_PROXY_HOPS = '1';
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
const ymd = (anosAtras, dias = 0) => { const d = new Date(); d.setFullYear(d.getFullYear() - anosAtras); d.setDate(d.getDate() + dias); return d.toISOString().slice(0, 10); };

test('data de nascimento: futura e menor de 18 são recusadas; exatamente 18 e 1979 passam', async () => {
  const co = await call('/api/checkout', { method: 'POST', body: { nome: 'Teste Idade', telefone: '11988887777', email: 'idade@exemplo.com' } });
  const h = { 'X-Lead-Token': co.data.token };
  await call(`/api/lead/${co.data.leadId}/mock-pay`, { method: 'POST', headers: h });
  const base = { nome: 'Teste Idade', telefone: '11988887777', email: 'idade@exemplo.com', cpf: '52998224725', nome_mae: 'Maria da Silva', cidade: 'Campo Belo', estado: 'MG', capacidade_label: 'R$500 a R$1.000', capacidade_valor: 1000, renda_mensal: 8000, tipo: 'imovel', credito: 100000 };
  const tenta = (nascimento) => call(`/api/lead/${co.data.leadId}/simular`, { method: 'POST', headers: h, body: { ...base, nascimento } });
  assert.equal((await tenta(ymd(-1))).status, 400);        // data futura
  assert.equal((await tenta(ymd(17))).status, 400);        // 17 anos
  assert.match((await tenta(ymd(17))).data.erro, /18 anos/);
  assert.equal((await tenta('1979-05-20')).status, 200);   // 1979
  assert.equal((await tenta(ymd(18, -1))).status, 200);    // 18 anos completos
});
