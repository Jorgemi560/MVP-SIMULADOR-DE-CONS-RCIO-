'use strict';
// Pix vencido: detecção, nova cobrança, histórico, idempotência e a regra de que só pagamento confirmado libera a simulação.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'pix';
process.env.PIX_CHAVE = '11222333000181';
process.env.PIX_RECEBEDOR = 'EMPRESA DE TESTE LTDA';
process.env.PIX_CIDADE = 'CURITIBA';
process.env.PIX_WEBHOOK_SECRET = 'segredo-webhook-de-teste-123456';
process.env.TRUST_PROXY_HOPS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');
const db = require('../lib/db');

let base, ip = 0;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());

const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const dados = { nome: 'Ana Souza', telefone: '11988887777', email: 'ana@exemplo.com', cpf: '52998224725', nascimento: '1990-05-10', nome_mae: 'Maria Souza', cidade: 'Curitiba', estado: 'PR', capacidade_label: 'R$500 a R$1.000', capacidade_valor: 1000, renda_mensal: 6000 };

// Cada teste usa um "IP" próprio (X-Forwarded-For) para não dividir o limite de requisições.
async function novoCliente(contato = {}) {
  const xff = { 'X-Forwarded-For': `10.9.0.${++ip}` };
  const n = String(ip).padStart(4, '0');
  const co = await call('/api/checkout', { method: 'POST', headers: xff, body: { nome: dados.nome, telefone: `1198888${n}`, email: `ana${n}@exemplo.com`, ...contato } });
  assert.equal(co.status, 200);
  const h = { ...xff, 'X-Lead-Token': co.data.token };
  const id = co.data.leadId;
  return {
    id, co, h,
    estado: () => call(`/api/lead/${id}/estado`, { headers: h }),
    novoPix: () => call(`/api/lead/${id}/novo-pix`, { method: 'POST', headers: h }),
    vencer: () => db.exec("UPDATE pagamentos SET expira_em = now() - interval '1 minute' WHERE lead_id = ? AND status = 'pendente'", [id]),
    simular: () => call(`/api/lead/${id}/simular`, { method: 'POST', headers: h, body: { ...dados, tipo: 'imovel', credito: 100000 } }),
  };
}
const webhook = (txid, valor = 500) => call('/api/webhooks/pix', { method: 'POST', headers: { 'X-Webhook-Secret': process.env.PIX_WEBHOOK_SECRET }, body: { txid, valor_centavos: valor } });
const admin = async () => ({ Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` });

test('cobrança nasce com validade e o servidor informa o tempo restante', async () => {
  const c = await novoCliente();
  assert.equal(c.co.data.pagamento, 'pendente');
  const falta = Date.parse(c.co.data.expiraEm) - Date.parse(c.co.data.agora);
  assert.ok(falta > 29 * 60000 && falta <= 30 * 60000, `validade esperada ~30 min, veio ${falta}ms`);
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'pendente'); assert.equal(e.podeRenovar, false); assert.ok(e.pix.copiaECola); assert.equal(e.tentativas, 1);
});

test('Pix vencido é detectado: some o código, não libera, e "já paguei" é recusado', async () => {
  const c = await novoCliente();
  await c.vencer();
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'expirado'); assert.equal(e.pix, null); assert.equal(e.podeRenovar, true); assert.equal(e.liberado, false); assert.equal(e.expiraEm, null);
  assert.equal((await c.simular()).status, 402);
  assert.equal((await call(`/api/lead/${c.id}/informar-pagamento`, { method: 'POST', headers: c.h })).status, 409);
  // o vencimento foi gravado (não é só visual)
  assert.equal((await db.um('SELECT status FROM pagamentos WHERE lead_id = ?', [c.id])).status, 'expirado');
});

test('novo Pix: nova tentativa com outro código, histórico preservado, reabrir mostra o Pix novo', async () => {
  const c = await novoCliente();
  const antigo = (await c.estado()).data.pix.copiaECola;
  await c.vencer();
  const n = await c.novoPix();
  assert.equal(n.status, 200); assert.equal(n.data.novo, true); assert.equal(n.data.pagamento, 'pendente');
  assert.notEqual(n.data.pix.copiaECola, antigo);
  assert.match(n.data.pix.copiaECola, /5802BR/); assert.ok(n.data.pix.copiaECola.includes('54045.00')); // mesmo valor: R$ 5,00
  // "reabrir o site": estado com o mesmo cadastro devolve o Pix novo, nunca o vencido
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'pendente'); assert.equal(e.pix.copiaECola, n.data.pix.copiaECola); assert.equal(e.tentativas, 2);
  const A = await admin();
  const det = (await call(`/api/admin/leads/${c.id}`, { headers: A })).data;
  assert.deepEqual(det.tentativas.map((t) => t.status), ['pendente', 'expirado']);
  assert.ok(!JSON.stringify(det).includes(antigo)); // o painel não expõe o código Pix
  assert.equal(det.lead.nome, dados.nome); // cadastro intacto
});

test('sem cobranças duplicadas: cliques/abas simultâneos geram uma só cobrança', async () => {
  const c = await novoCliente();
  await c.vencer();
  const rs = await Promise.all([c.novoPix(), c.novoPix(), c.novoPix(), c.novoPix()]);
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.data.pix.copiaECola)).size, 1);
  assert.equal(rs.filter((r) => r.data.novo).length, 1);
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?", [c.id])).n, 2);
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ? AND status = 'pendente'", [c.id])).n, 1);
  // com um Pix ainda válido, pedir outro devolve o mesmo
  const outra = await c.novoPix();
  assert.equal(outra.data.novo, false); assert.equal(outra.data.pix.copiaECola, rs[0].data.pix.copiaECola);
});

test('só pagamento confirmado libera: o novo Pix pago libera, e depois o pago nunca é alterado', async () => {
  const c = await novoCliente();
  await c.vencer();
  const n = await c.novoPix();
  assert.equal((await c.simular()).status, 402);
  const txid = `SIM${/SIM(\d+?)6304[0-9A-F]{4}$/.exec(n.data.pix.copiaECola)[1]}`;
  assert.equal((await webhook(txid)).status, 200);
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'pago'); assert.equal(e.liberado, true); assert.equal(e.pix, null);
  assert.equal((await c.simular()).status, 200);
  // já pago: pedir novo Pix não cria cobrança; o admin não consegue recusar nem mudar
  const again = await c.novoPix();
  assert.equal(again.data.pagamento, 'pago'); assert.equal(again.data.novo, false);
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [c.id])).n, 2);
  const A = await admin();
  const pagoId = (await db.um("SELECT id FROM pagamentos WHERE lead_id = ? AND status = 'pago'", [c.id])).id;
  assert.equal((await call(`/api/admin/pagamentos/${pagoId}`, { method: 'POST', headers: A, body: { acao: 'recusar' } })).status, 409);
  assert.equal((await call(`/api/admin/leads/${c.id}/pagamento`, { method: 'POST', headers: A, body: { acao: 'recusar' } })).status, 409);
  assert.equal((await db.um('SELECT status FROM pagamentos WHERE id = ?', [pagoId])).status, 'pago');
});

test('pagamento tardio do Pix vencido (conta recebeu depois): o admin ainda pode confirmar a tentativa certa', async () => {
  const c = await novoCliente();
  const primeiro = (await db.um('SELECT id FROM pagamentos WHERE lead_id = ?', [c.id])).id;
  await c.vencer();
  await c.novoPix();
  const A = await admin();
  const r = await call(`/api/admin/pagamentos/${primeiro}`, { method: 'POST', headers: A, body: { acao: 'confirmar' } });
  assert.equal(r.status, 200);
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'pago'); assert.equal(e.liberado, true);
  // a cobrança nova, que ficou desnecessária, não fica "aguardando" para sempre
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ? AND status = 'pendente'", [c.id])).n, 0);
});

test('"já paguei" em conferência: novo Pix é recusado com explicação; passado o prazo de segurança o cliente não fica preso', async () => {
  const c = await novoCliente();
  const antigoId = (await db.um('SELECT id FROM pagamentos WHERE lead_id = ?', [c.id])).id;
  assert.equal((await call(`/api/lead/${c.id}/informar-pagamento`, { method: 'POST', headers: c.h })).data.pagamento, 'informado');
  await c.vencer(); // informado não vence
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'informado'); assert.equal(e.podeRenovar, false);
  // dentro do prazo de segurança: recusado, nada criado, mensagem clara
  const r = await c.novoPix();
  assert.equal(r.status, 409); assert.match(r.data.erro, /conferência/i); assert.match(r.data.erro, /duplicidade/i);
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [c.id])).n, 1);
  // 20 min depois (> prazo de 15 min): gera o novo; o antigo vira "expirado" (histórico) e continua confirmável pelo txid
  await db.exec("UPDATE pagamentos SET informado_em = now() - interval '20 minutes' WHERE lead_id = ?", [c.id]);
  const n = await c.novoPix();
  assert.equal(n.status, 200); assert.equal(n.data.novo, true); assert.equal(n.data.pagamento, 'pendente');
  assert.equal((await db.um('SELECT status FROM pagamentos WHERE id = ?', [antigoId])).status, 'expirado');
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ? AND status = 'pendente'", [c.id])).n, 1);
  assert.equal((await webhook(`SIM${antigoId}`)).status, 200); // o pagamento tardio do código antigo ainda é reconhecido
  assert.equal((await c.estado()).data.liberado, true);
});

test('"já paguei" gravado antes da coluna informado_em existir recebe prazo (não fica verificando para sempre)', async () => {
  const c = await novoCliente();
  await call(`/api/lead/${c.id}/informar-pagamento`, { method: 'POST', headers: c.h });
  await db.exec('UPDATE pagamentos SET informado_em = NULL WHERE lead_id = ?', [c.id]);
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'informado'); assert.ok(e.informadoEm, 'informadoEm deve ser preenchido');
  assert.equal((await c.estado()).data.informadoEm, e.informadoEm);
});

test('recusado pelo administrador libera gerar novo Pix na hora', async () => {
  const c = await novoCliente();
  await call(`/api/lead/${c.id}/informar-pagamento`, { method: 'POST', headers: c.h });
  const A = await admin();
  assert.equal((await call(`/api/admin/leads/${c.id}/pagamento`, { method: 'POST', headers: A, body: { acao: 'recusar' } })).status, 200);
  assert.equal((await c.estado()).data.podeRenovar, true);
  assert.equal((await c.novoPix()).data.novo, true);
});

test('painel: situação "expirado" na lista e no filtro, com contagem de tentativas', async () => {
  const c = await novoCliente();
  await c.vencer();
  const A = await admin();
  const lista = (await call('/api/admin/leads?pagamento=expirado', { headers: A })).data;
  const item = lista.leads.find((l) => l.id === c.id);
  assert.ok(item); assert.equal(item.pagamento_status, 'expirado'); assert.equal(item.tentativas, 1);
  assert.ok(!(await call('/api/admin/leads?pagamento=pendente', { headers: A })).data.leads.some((l) => l.id === c.id));
  assert.equal(lista.aConferir >= 0, true);
});

test('cobrança antiga sem validade gravada (criada antes desta versão) também vence', async () => {
  const c = await novoCliente();
  await db.exec("UPDATE pagamentos SET expira_em = NULL, criado_em = now() - interval '3 hours' WHERE lead_id = ?", [c.id]);
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'expirado'); assert.equal(e.podeRenovar, true);
  assert.equal((await c.novoPix()).data.novo, true);
});

test('limite de tentativas por cadastro', async () => {
  const c = await novoCliente();
  let ultimo;
  for (let i = 0; i < 10; i++) { await c.vencer(); ultimo = await c.novoPix(); if (ultimo.status !== 200) break; }
  assert.equal(ultimo.status, 429);
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [c.id])).n, 10);
});

test('novo Pix exige o token do cliente', async () => {
  const c = await novoCliente();
  assert.equal((await call(`/api/lead/${c.id}/novo-pix`, { method: 'POST', headers: { 'X-Lead-Token': 'x' } })).status, 404);
});

test('cliente que volta com o mesmo e-mail e telefone retoma o cadastro e a cobrança (sem duplicar)', async () => {
  const c = await novoCliente();
  const dadosCo = { nome: dados.nome, telefone: `1198888${String(ip).padStart(4, '0')}`, email: `ana${String(ip).padStart(4, '0')}@exemplo.com` };
  const xff = { 'X-Forwarded-For': `10.9.1.${ip}` };
  const volta = await call('/api/checkout', { method: 'POST', headers: xff, body: dadosCo });
  assert.equal(volta.status, 200); assert.equal(volta.data.retomado, true); assert.equal(volta.data.leadId, c.id);
  assert.equal(volta.data.novo, false); assert.equal(volta.data.pix.copiaECola, c.co.data.pix.copiaECola); // mesma cobrança
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [c.id])).n, 1);
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM leads WHERE email = ?', [dadosCo.email])).n, 1);
  // o token antigo deixa de valer; o novo acessa o cadastro
  assert.equal((await call(`/api/lead/${c.id}/estado`, { headers: c.h })).status, 404);
  assert.equal((await call(`/api/lead/${c.id}/estado`, { headers: { 'X-Lead-Token': volta.data.token } })).status, 200);
  // vencido: ao voltar, recebe um Pix novo no mesmo cadastro
  await c.vencer();
  const v2 = await call('/api/checkout', { method: 'POST', headers: xff, body: dadosCo });
  assert.equal(v2.data.leadId, c.id); assert.equal(v2.data.novo, true); assert.notEqual(v2.data.pix.copiaECola, c.co.data.pix.copiaECola);
  // pago: ao voltar, já vem liberado e nada é cobrado
  await webhook(`SIM${(await db.um("SELECT id FROM pagamentos WHERE lead_id = ? AND status = 'pendente'", [c.id])).id}`);
  const v3 = await call('/api/checkout', { method: 'POST', headers: xff, body: dadosCo });
  assert.equal(v3.data.pagamento, 'pago'); assert.equal(v3.data.liberado, true); assert.equal(v3.data.novo, false);
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [c.id])).n, 2);
});

test('mesmo e-mail com outro telefone NÃO retoma o cadastro alheio; envios simultâneos não duplicam', async () => {
  const c = await novoCliente();
  const email = `ana${String(ip).padStart(4, '0')}@exemplo.com`;
  const outro = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': '10.9.2.1' }, body: { nome: 'Outra Pessoa', telefone: '21977770000', email } });
  assert.notEqual(outro.data.leadId, c.id); assert.equal(outro.data.retomado, false);
  const corpo = { nome: 'Dupla Aba', telefone: '31966660000', email: 'dupla@exemplo.com' };
  const rs = await Promise.all([1, 2, 3].map((i) => call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': `10.9.3.${i}` }, body: corpo })));
  assert.equal(new Set(rs.map((r) => r.data.leadId)).size, 1);
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos p JOIN leads l ON l.id = p.lead_id WHERE l.email = 'dupla@exemplo.com'")).n, 1);
});

test('"já fiz o pagamento" não libera: fica em conferência, registra o horário e não mostra mais o código', async () => {
  const c = await novoCliente();
  const r = await call(`/api/lead/${c.id}/informar-pagamento`, { method: 'POST', headers: c.h });
  assert.equal(r.data.pagamento, 'informado');
  const e = (await c.estado()).data;
  assert.equal(e.pagamento, 'informado'); assert.equal(e.liberado, false); assert.equal(e.pix, null);
  assert.ok(Math.abs(Date.parse(e.informadoEm) - Date.parse(e.agora)) < 10000);
  assert.equal((await c.simular()).status, 402);
  // atualizar a página (novo estado): continua em conferência, com o mesmo horário
  assert.equal((await c.estado()).data.informadoEm, e.informadoEm);
  // confirmação com atraso (depois de muito tempo): reconhecida e libera
  await db.exec("UPDATE pagamentos SET informado_em = now() - interval '10 minutes' WHERE lead_id = ?", [c.id]);
  const id = (await db.um('SELECT id FROM pagamentos WHERE lead_id = ?', [c.id])).id;
  assert.equal((await webhook(`SIM${id}`)).status, 200);
  const f = (await c.estado()).data;
  assert.equal(f.pagamento, 'pago'); assert.equal(f.liberado, true);
});
