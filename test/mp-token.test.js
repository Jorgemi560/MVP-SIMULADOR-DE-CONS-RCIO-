'use strict';
// Token do Mercado Pago: nunca vai para o cabeçalho em branco ("Authorization: Bearer" sem valor => 401 "authorization value not present").
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mercadopago';
process.env.MP_ACCESS_TOKEN = '  \n'; // como se o Render tivesse guardado a variável só com espaço/quebra de linha
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarToken, tokenProblemaDe } = require('../lib/payment');
const { server } = require('../server');

test('normalizarToken: tira espaços, aspas e "Bearer " colado; recusa vazio/curto/com espaço no meio', () => {
  const t = 'APP_USR-1234567890123456-100412-abcdef0123456789abcdef0123456789-123456789';
  for (const entrada of [t, `  ${t}\n`, `"${t}"`, `'${t}'`, `Bearer ${t}`, ` "Bearer ${t}" `]) assert.equal(normalizarToken(entrada), t, `entrada: ${JSON.stringify(entrada)}`);
  assert.equal(tokenProblemaDe(t), null);
  for (const ruim of ['', '   ', '\n', undefined, 'APP_USR-curto', 'APP_USR-123 456-abcdefghijklmnopqrstuvwxyz']) {
    assert.ok(tokenProblemaDe(normalizarToken(ruim)), `deveria recusar: ${JSON.stringify(ruim)}`);
  }
});

let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());
const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

test('token em branco: o site NÃO chama o Mercado Pago, o checkout fica indisponível e o /admin explica o motivo', async () => {
  const f = global.fetch; let chamouMp = false;
  global.fetch = async (url, opts) => { if (String(url).includes('mercadopago')) chamouMp = true; return f(url, opts); };
  const co = await call('/api/checkout', { method: 'POST', body: { nome: 'Fulano de Tal', telefone: '11988887777', email: 'f@exemplo.com' } });
  global.fetch = f;
  assert.equal(co.status, 503); assert.equal(chamouMp, false);
  const A = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  const st = (await call('/api/admin/status', { headers: A })).data;
  assert.equal(st.pagamento.pronto, false); assert.match(st.pagamento.mp.tokenProblema, /vazio|espaço/i);
});
