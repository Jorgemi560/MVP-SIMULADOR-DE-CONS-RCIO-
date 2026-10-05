'use strict';
// Mercado Pago (API simulada, nenhuma chamada real): validade enviada ao provedor, expiração detectada e pagamento de última hora não perdido.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mercadopago';
process.env.MP_ACCESS_TOKEN = 'TEST-token-falso-de-teste-1234567890';
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

// ---------- diagnóstico de falhas na criação da cobrança ----------
async function checkoutComFalha(respostaMp, contato) {
  const f = global.fetch, linhas = [], origErr = console.error;
  global.fetch = async (url, opts = {}) => (opts.method === 'POST' && String(url).includes('mercadopago')
    ? (typeof respostaMp === 'function' ? respostaMp() : { ok: false, status: respostaMp.status, headers: { get: (h) => (h === 'x-request-id' ? 'req-abc-123' : null) }, json: async () => respostaMp.body })
    : f(url, opts));
  console.error = (...a) => { linhas.push(a.join(' ')); };
  let r;
  try { r = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': `10.8.8.${++ip}` }, body: contato }); }
  finally { global.fetch = f; console.error = origErr; }
  const A = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  const st = (await call('/api/admin/status', { headers: A })).data;
  return { r, log: linhas.join('\n'), ultimo: st.pagamento.ultimoErro };
}
const contatoDiag = { nome: 'Maria Segredo Silva', telefone: '11955554444', email: 'maria.segredo@exemplo.com' };

test('diagnóstico: conta sem chave Pix no MP → erro claro no /admin e no log, sem dados pessoais', async () => {
  const { r, log, ultimo } = await checkoutComFalha({ status: 400, body: { error: 'bad_request', message: 'Collector user without key enabled for QR render', cause: [{ code: 13253, description: 'Collector user without key enabled for QR render' }] } }, contatoDiag);
  assert.equal(r.status, 502); assert.match(r.data.erro, /Não foi possível iniciar o pagamento agora/); assert.match(r.data.erro, /MP-400/);
  assert.equal(ultimo.http, 400); assert.match(ultimo.dica, /CHAVE PIX/i); assert.equal(ultimo.requestId, 'req-abc-123');
  assert.match(log, /\[pagamento\] FALHA ao criar cobrança/); assert.match(log, /http=400/);
  for (const segredo of ['maria.segredo', 'Maria', 'Segredo', '11955554444', 'APP_USR-token-falso']) {
    assert.ok(!log.includes(segredo) && !JSON.stringify(ultimo).includes(segredo), `vazou: ${segredo}`);
  }
});

test('diagnóstico: token recusado (401) e e-mail do pagador no texto do MP é mascarado', async () => {
  const { r, ultimo } = await checkoutComFalha({ status: 401, body: { message: 'invalid access token APP_USR-1234567890-abc for maria.segredo@exemplo.com' } }, { ...contatoDiag, email: 'outra@exemplo.com' });
  assert.equal(r.status, 502); assert.match(ultimo.dica, /MP_ACCESS_TOKEN/);
  assert.ok(!JSON.stringify(ultimo).includes('maria.segredo@exemplo.com') && !JSON.stringify(ultimo).includes('APP_USR-1234567890'));
});

test('diagnóstico: sem rede/DNS com o MP → código MP-rede e orientação', async () => {
  const f = global.fetch;
  global.fetch = async (url, opts = {}) => { if (opts.method === 'POST' && String(url).includes('mercadopago')) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; } return f(url, opts); };
  const A = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  let r; const origErr = console.error; console.error = () => {};
  try { r = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': `10.8.8.${++ip}` }, body: { ...contatoDiag, email: 'rede@exemplo.com', telefone: '11955550001' } }); }
  finally { global.fetch = f; console.error = origErr; }
  assert.equal(r.status, 502); assert.match(r.data.erro, /MP-rede/);
  const st = (await call('/api/admin/status', { headers: A })).data;
  assert.equal(st.pagamento.ultimoErro.http, 0); assert.match(st.pagamento.ultimoErro.dica, /rede|comunicação/i);
});

test('falha não deixa lixo: a tentativa fica "cancelada" e, corrigido o problema, o mesmo cliente consegue pagar', async () => {
  const contato = { nome: 'Cliente Retry', telefone: '11955550002', email: 'retry@exemplo.com' };
  const { r } = await checkoutComFalha({ status: 500, body: { message: 'internal' } }, contato);
  assert.equal(r.status, 502);
  const lead = await db.um('SELECT id FROM leads WHERE email = ?', [contato.email]);
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ? AND status = 'cancelado'", [lead.id])).n, 1);
  const ok = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': `10.8.8.${++ip}` }, body: contato });
  assert.equal(ok.status, 200); assert.equal(ok.data.leadId, lead.id); assert.equal(ok.data.novo, true); assert.ok(ok.data.pix.copiaECola);
});

test('tentativas que falharam ao criar no provedor não consomem o limite de cobranças do cliente', async () => {
  const contato = { nome: 'Cliente Falhas', telefone: '11955550003', email: 'falhas@exemplo.com' };
  const { r } = await checkoutComFalha({ status: 500, body: { message: 'internal' } }, contato);
  assert.equal(r.status, 502);
  const lead = await db.um('SELECT id FROM leads WHERE email = ?', [contato.email]);
  for (let i = 0; i < 12; i++) await db.exec("INSERT INTO pagamentos (lead_id, provedor, valor_centavos, status) VALUES (?, 'mercadopago', 500, 'cancelado')", [lead.id]); // 12 falhas sem provedor_id
  const ok = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': `10.8.8.${++ip}` }, body: contato });
  assert.equal(ok.status, 200); assert.ok(ok.data.pix.copiaECola);
});

test('o cabeçalho Authorization enviado ao Mercado Pago é "Bearer <token>" com o valor da variável (nunca em branco)', async () => {
  const f = global.fetch; let auth = null;
  global.fetch = async (url, opts = {}) => { if (opts.method === 'POST' && String(url).includes('mercadopago')) auth = opts.headers.Authorization; return f(url, opts); };
  try { await cliente(); } finally { global.fetch = f; }
  assert.equal(auth, 'Bearer TEST-token-falso-de-teste-1234567890');
});

// ---------- "Voltar" da tela do Pix: corrigir contato sem nova cobrança ----------
test('corrigir os dados de contato (Voltar do Pix) atualiza o MESMO cadastro: nenhuma nova cobrança no Mercado Pago', async () => {
  const c = await cliente(); const antes = await db.um('SELECT id, pix_codigo FROM pagamentos WHERE lead_id = ?', [c.id]);
  const f = global.fetch; let chamadasMp = 0;
  global.fetch = async (url, opts = {}) => { if (String(url).includes('mercadopago') && opts.method === 'POST') chamadasMp++; return f(url, opts); }; // só criações de cobrança contam (consultar o status é leitura)
  let r;
  try { r = await call(`/api/lead/${c.id}/contato`, { method: 'POST', headers: c.h, body: { nome: 'Nome Corrigido Silva', telefone: '11944445555', email: 'corrigido@exemplo.com' } }); }
  finally { global.fetch = f; }
  assert.equal(r.status, 200); assert.equal(chamadasMp, 0);
  const lead = await db.um('SELECT nome, email, telefone FROM leads WHERE id = ?', [c.id]);
  assert.deepEqual([lead.nome, lead.email, lead.telefone], ['Nome Corrigido Silva', 'corrigido@exemplo.com', '11944445555']);
  const pags = await db.todos('SELECT id, pix_codigo, status FROM pagamentos WHERE lead_id = ?', [c.id]);
  assert.equal(pags.length, 1); assert.equal(pags[0].id, antes.id); assert.equal(pags[0].pix_codigo, antes.pix_codigo); assert.equal(pags[0].status, 'pendente');
  assert.equal((await c.estado()).data.pix.copiaECola, antes.pix_codigo); // o mesmo Pix continua valendo
});

test('contato: valida os campos, exige o token e recusa dados que já pertencem a outro cadastro', async () => {
  const a = await cliente(), b = await cliente();
  const dadosB = await db.um('SELECT email, telefone FROM leads WHERE id = ?', [b.id]);
  assert.equal((await call(`/api/lead/${a.id}/contato`, { method: 'POST', headers: a.h, body: { nome: 'Fulano de Tal', telefone: '123', email: 'x@exemplo.com' } })).status, 400);
  assert.equal((await call(`/api/lead/${a.id}/contato`, { method: 'POST', headers: a.h, body: { nome: 'Fu', telefone: '11944445555', email: 'x@exemplo.com' } })).status, 400);
  assert.equal((await call(`/api/lead/${a.id}/contato`, { method: 'POST', headers: { 'X-Lead-Token': 'x' }, body: { nome: 'Fulano de Tal', telefone: '11944445555', email: 'x@exemplo.com' } })).status, 404);
  assert.equal((await call(`/api/lead/${a.id}/contato`, { method: 'POST', headers: a.h, body: { nome: 'Fulano de Tal', telefone: dadosB.telefone, email: dadosB.email } })).status, 409);
});
