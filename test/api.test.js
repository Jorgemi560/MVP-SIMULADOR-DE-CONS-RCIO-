'use strict';
process.env.DB_FILE = ':memory:';
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

const dados = { nome: 'João da Silva', telefone: '11999998888', email: 'joao@exemplo.com', cpf: '52998224725', nascimento: '1988-03-10', nome_mae: 'Maria da Silva', cidade: 'São Paulo', estado: 'SP', capacidade_label: 'R$500 a R$1.000', capacidade_valor: 1000, renda_mensal: 8500 };

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
  assert.match(msg, /Nome: João da Silva/); assert.match(msg, /Tipo: Imóvel/); assert.match(msg, /Parcela: reduzida/); assert.match(msg, /Valor estimado da parcela: R\$\s?337,30/);
  assert.ok(!url.pathname.includes('11999998888'));
  assert.ok(r.data.parcelaIntegral > r.data.parcelaReduzida);
  assert.equal(r.data.parcelaIntegral, 564.5); assert.equal(r.data.parcelaReduzida, 337.3);

  r = await call(`/api/lead/${co.data.leadId}/simular`, { method: 'POST', headers: h, body: { ...dados, cpf: '11111111111', tipo: 'imovel', credito: 100000 } });
  assert.equal(r.status, 400);
  r = await call(`/api/lead/${co.data.leadId}/simular`, { method: 'POST', headers: h, body: { ...dados, renda_mensal: undefined, tipo: 'imovel', credito: 100000 } });
  assert.equal(r.status, 400); // renda mensal é obrigatória
  assert.match(r.data.erro, /renda/i);

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
  assert.match(wa.searchParams.get('text'), /Renda mensal: R\$\s?8\.500,00/);

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
  const salvo = (await call('/api/admin/planos', { headers: A })).data.planos.find((x) => x.id === c.data.id);
  assert.equal(salvo.reduzida, 0); // tipo 'outros': redução é forçada a desligada
  assert.equal((await call('/api/admin/planos', { method: 'POST', headers: A, body: { ...plano, credito_min: 9e6, credito_max: 1 } })).status, 400);
  assert.equal((await call(`/api/admin/planos/${c.data.id}`, { method: 'DELETE', headers: A })).status, 200);
});

test('faixas de imóvel: abaixo de R$500 mil paga 50%; a partir de R$500 mil, plano 55% diluído', async () => {
  const co = await call('/api/checkout', { method: 'POST', body: { nome: 'Ana Souza', telefone: '41987654321', email: 'ana@x.com' } });
  const h = { 'X-Lead-Token': co.data.token };
  await call(`/api/lead/${co.data.leadId}/mock-pay`, { method: 'POST', headers: h });
  const dados = { nome: 'Ana Souza', telefone: '41987654321', email: 'ana@x.com', cpf: '52998224725', nascimento: '1988-03-10', nome_mae: 'Maria', cidade: 'Curitiba', estado: 'PR', capacidade_label: 'x', capacidade_valor: 5000, renda_mensal: 12000, tipo: 'imovel', parcela: 'reduzida' };
  const sim = async (credito) => (await call(`/api/lead/${co.data.leadId}/simular`, { method: 'POST', headers: h, body: { ...dados, credito } })).data;
  assert.equal((await sim(250000)).parcelaReduzida, 843.25);       // 220 meses, 50%
  const r500 = await sim(500000);                                  // plano 55% diluído
  assert.equal(r500.parcelaIntegral, 2822.5);
  assert.equal(r500.parcelaReduzida, 1799.77);
  assert.equal(r500.prazo, 220); // sempre 220 meses
});

test('healthz responde ok', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('limite de tentativas é por cliente (X-Forwarded-For), não pelo IP do proxy', async () => {
  const tentar = (ip) => call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': ip }, body: {} });
  let ultimo;
  for (let i = 0; i < 12; i++) ultimo = await tentar('203.0.113.7');
  assert.equal(ultimo.status, 429);
  assert.equal((await tentar('203.0.113.8')).status, 400); // outro cliente não é afetado
});

test('exportação CSV exige login e neutraliza fórmulas', async () => {
  assert.equal((await fetch(base + '/api/admin/leads.csv')).status, 401);
  const { data } = await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } });
  const co = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.1' }, body: { nome: '=CMD() Teste', telefone: '41987654321', email: 'csv@x.com' } });
  await call(`/api/lead/${co.data.leadId}/mock-pay`, { method: 'POST', headers: { 'X-Lead-Token': co.data.token } });
  const r = await fetch(base + '/api/admin/leads.csv', { headers: { Authorization: `Bearer ${data.token}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const bytes = new Uint8Array(await r.clone().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // BOM para o Excel reconhecer UTF-8
  const txt = await r.text();
  assert.ok(txt.startsWith('ID;Cadastro;Data da simulação;Nome;WhatsApp;E-mail;Renda mensal'));
  assert.ok(txt.includes(`"'=CMD() Teste"`), txt.slice(0, 600));
});

test('painel: busca, período, situação do pagamento, detalhes, PDF e privacidade', async () => {
  const { data } = await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } });
  const A = { Authorization: `Bearer ${data.token}` };
  const novo = async (nome, tel, email, pagar) => {
    const co = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.77' }, body: { nome, telefone: tel, email } });
    if (pagar) await call(`/api/lead/${co.data.leadId}/mock-pay`, { method: 'POST', headers: { 'X-Lead-Token': co.data.token } });
    return co.data;
  };
  const ana = await novo('Ana Busca Teste', '41911112222', 'ana.busca@teste.com', true);
  await novo('Bruno Busca Teste', '11933334444', 'bruno@outro.com', false);
  const L = async (qs) => (await call(`/api/admin/leads?${qs}`, { headers: A })).data;

  assert.equal((await L('q=ana busca')).leads.length, 1);                 // nome
  assert.equal((await L('q=(11) 93333')).leads.length, 1);                // telefone com máscara
  assert.equal((await L('q=OUTRO.com')).leads.length, 1);                 // e-mail, sem diferenciar maiúsculas
  assert.equal((await L('q=%25')).leads.length, 0);                       // curinga do SQL é tratado como texto
  assert.equal((await L('q=Busca Teste&pagamento=pago')).leads.length, 1);
  assert.equal((await L('q=Busca Teste&pagamento=pendente')).leads.length, 1);
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  assert.ok((await L(`q=Busca Teste&de=${hoje}&ate=${hoje}`)).leads.length >= 2);
  assert.equal((await L('q=Busca Teste&de=2999-01-01')).leads.length, 0);
  const lista = await L('q=ana busca');
  assert.equal(lista.leads[0].cpf, undefined);                            // lista não traz dados sensíveis
  assert.equal(lista.leads[0].token, undefined);

  const det = (await call(`/api/admin/leads/${ana.leadId}`, { headers: A })).data;
  assert.equal(det.lead.token, undefined);
  assert.equal(det.lead.pagamento_status, 'pago');
  assert.equal((await call(`/api/admin/leads/${ana.leadId}`)).status, 401);

  const pdf = await fetch(`${base}/api/admin/leads/${ana.leadId}.pdf`, { headers: A });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.includes('Ana Busca Teste'));
  assert.equal((await fetch(`${base}/api/admin/leads/${ana.leadId}.pdf`)).status, 401);

  const st = (await call('/api/admin/status', { headers: A })).data;
  assert.equal(st.pagamento.provedor, 'mock');
  assert.equal((await call('/api/admin/status')).status, 401);
});

test('healthz não expõe informações', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(await r.text(), 'ok');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('arquivos privados não são servidos', async () => {
  for (const p of ['/.env', '/server.js', '/../package.json', '/data/simulador.db', '/lib/db.js', '/%2e%2e/package.json', '/%E0%A4%A']) {
    const r = await fetch(base + p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await fetch(base + '/robots.txt')).status, 200);
});

test('valor da simulação: 500 centavos (R$ 5,00) na cobrança, no banco e na configuração pública', async () => {
  assert.equal((await call('/api/config')).data.precoCentavos, 500);
  const co = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.50' }, body: { nome: 'Preço Teste', telefone: '41987650000', email: 'preco@x.com' } });
  const { data } = await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } });
  const det = (await call(`/api/admin/leads/${co.data.leadId}`, { headers: { Authorization: `Bearer ${data.token}` } })).data;
  assert.equal(det.lead.valor_centavos, 500);
});

test('PRICE_CENTS inválido impede a inicialização (nunca cobra valor errado)', () => {
  const { spawnSync } = require('node:child_process');
  for (const v of ['5', '5.5', '0', 'abc', '99999999']) {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "require('./server')"], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, DB_FILE: ':memory:', PAYMENT_PROVIDER: 'mock', PRICE_CENTS: v }, encoding: 'utf8' });
    assert.notEqual(r.status, 0, `PRICE_CENTS=${v} deveria falhar`);
    assert.match(r.stderr, /PRICE_CENTS inválido/);
  }
  const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "require('./server');process.exit(0)"], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, DB_FILE: ':memory:', PAYMENT_PROVIDER: 'mock', PRICE_CENTS: '500' }, encoding: 'utf8' });
  assert.equal(ok.status, 0);
});

test('botão do especialista: link wa.me/5541997446032 com nome, crédito, renda e aviso de simulação concluída', async () => {
  // volta à configuração padrão (testes anteriores salvaram outro número no banco em memória)
  const adm = { Authorization: `Bearer ${(await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } })).data.token}` };
  await call('/api/admin/config', { method: 'PUT', headers: adm, body: { whatsapp: '', learn_url: '' } });
  const co = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.51' }, body: { nome: 'Marina Costa Lima', telefone: '11955554444', email: 'marina@x.com' } });
  const h = { 'X-Lead-Token': co.data.token };
  await call(`/api/lead/${co.data.leadId}/mock-pay`, { method: 'POST', headers: h });
  const dados = { nome: 'Marina Costa Lima', telefone: '11955554444', email: 'marina@x.com', cpf: '52998224725', nascimento: '1990-02-02', nome_mae: 'Rita', cidade: 'Curitiba', estado: 'PR', capacidade_label: 'x', capacidade_valor: 2000, renda_mensal: 9300, tipo: 'veiculo', credito: 90000 };
  const r = await call(`/api/lead/${co.data.leadId}/simular`, { method: 'POST', headers: h, body: dados });
  const link = r.data.whatsappUrl;
  assert.match(link, /^https:\/\/wa\.me\/5541997446032\?text=[^\s]+$/);   // número internacional, só dígitos, texto codificado
  const texto = new URL(link).searchParams.get('text');
  assert.match(texto, /concluir|Acabei de fazer minha simulação de consórcio/);
  assert.match(texto, /Nome: Marina Costa Lima/);
  assert.match(texto, /Crédito escolhido: R\$\s?90\.000,00/);
  assert.match(texto, /Renda mensal: R\$\s?9\.300,00/);
  assert.ok(!texto.includes('41997446032') && !texto.includes('99744-6032')); // o número do especialista não vai dentro da mensagem
  // o mesmo link é devolvido ao registrar interesse
  const i = await call(`/api/lead/${co.data.leadId}/interesse`, { method: 'POST', headers: h, body: { interesse: 'agora' } });
  assert.equal(i.data.whatsappUrl, link);
});

test('exclusão de lead (LGPD): exige login e confirmação, anonimiza dados pessoais e preserva só o registro financeiro', async () => {
  const { db } = require('../lib/db');
  const { data } = await call('/api/admin/login', { method: 'POST', body: { senha: 'segredo-teste' } });
  const A = { Authorization: `Bearer ${data.token}` };
  const co = await call('/api/checkout', { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.60' }, body: { nome: 'Pessoa Para Excluir', telefone: '41944443333', email: 'excluir@x.com' } });
  const h = { 'X-Lead-Token': co.data.token }, id = co.data.leadId;
  await call(`/api/lead/${id}/mock-pay`, { method: 'POST', headers: h });
  const dados = { nome: 'Pessoa Para Excluir', telefone: '41944443333', email: 'excluir@x.com', cpf: '52998224725', nascimento: '1985-05-05', nome_mae: 'Mãe Sigilosa', cidade: 'Curitiba', estado: 'PR', capacidade_label: 'x', capacidade_valor: 1500, renda_mensal: 6500, tipo: 'imovel', credito: 200000, parcela: 'integral' };
  const simEx = await call(`/api/lead/${id}/simular`, { method: 'POST', headers: h, body: dados });
  assert.equal(simEx.status, 200, JSON.stringify(simEx.data));

  assert.equal((await call(`/api/admin/leads/${id}`, { method: 'DELETE', body: { confirmar: 'EXCLUIR' } })).status, 401);   // sem login
  assert.equal((await call(`/api/admin/leads/${id}`, { method: 'DELETE', headers: A, body: {} })).status, 400);              // sem confirmação
  assert.equal((await call(`/api/admin/leads/${id}`, { method: 'DELETE', headers: A, body: { confirmar: 'excluir' } })).status, 400);
  assert.equal((await call(`/api/admin/leads/${id}`, { headers: A })).status, 200);                                            // nada foi apagado ainda

  assert.equal((await call(`/api/admin/leads/${id}`, { method: 'DELETE', headers: A, body: { confirmar: 'EXCLUIR', motivo: 'solicitacao_titular' } })).status, 200);

  const linha = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  for (const c of ['email', 'telefone', 'cpf', 'nascimento', 'nome_mae', 'cidade', 'estado', 'tipo', 'credito', 'renda_mensal', 'capacidade_label', 'simulacao', 'resultado', 'interesse']) {
    assert.ok(linha[c] === null || linha[c] === '', `${c} deveria estar vazio`);
  }
  assert.notEqual(linha.nome, 'Pessoa Para Excluir');
  assert.equal(linha.status, 'excluido');
  assert.ok(linha.excluido_em);
  assert.notEqual(linha.token, co.data.token);
  const pg = db.prepare('SELECT * FROM pagamentos WHERE lead_id = ?').get(id);
  assert.equal(pg.valor_centavos, 500);                                                                                        // registro financeiro preservado
  assert.equal(pg.status, 'pago');
  const ex = db.prepare('SELECT * FROM exclusoes WHERE lead_id = ?').get(id);
  assert.equal(ex.motivo, 'solicitacao_titular');
  assert.ok(!JSON.stringify(ex).includes('Pessoa'));                                                                           // log sem dados pessoais

  assert.equal((await call(`/api/admin/leads/${id}`, { headers: A })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/leads/${id}.pdf`, { headers: A })).status, 404);
  assert.equal((await call(`/api/lead/${id}/estado`, { headers: h })).status, 404);                                            // o cliente perde o acesso
  assert.equal((await call(`/api/admin/leads?q=Excluir`, { headers: A })).data.leads.length, 0);
  const csv = await (await fetch(`${base}/api/admin/leads.csv`, { headers: A })).text();
  assert.ok(!csv.includes('Pessoa Para Excluir') && !csv.includes('excluir@x.com') && !csv.includes('41944443333'));
  assert.equal((await call(`/api/admin/leads/${id}`, { method: 'DELETE', headers: A, body: { confirmar: 'EXCLUIR' } })).status, 404); // já excluído
});

test('arquivos do site são revalidados (ETag/304): um deploy novo aparece na hora, sem cache antigo', async () => {
  const r = await fetch(base + '/app.js');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetch(base + '/app.js', { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(base + '/style.css')).headers.get('cache-control'), 'no-cache');
});

test('preço: nenhum "R$ 5" sem centavos nos textos do site e a página inicial usa o valor do servidor', () => {
  const fs = require('node:fs'), path = require('node:path');
  const raiz = path.join(__dirname, '..');
  const arquivos = [...fs.readdirSync(path.join(raiz, 'public')).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => path.join('public', f)), 'README.md', 'DEPLOY.md', 'package.json', '.env.example', 'lib/pdf.js', 'lib/payment.js'];
  for (const f of arquivos) {
    const txt = fs.readFileSync(path.join(raiz, f), 'utf8');
    assert.ok(!/R\$\s?5(?![\d,.])/.test(txt), `${f} ainda tem "R$ 5" sem ,00`);
  }
  const app = fs.readFileSync(path.join(raiz, 'public/app.js'), 'utf8');
  assert.ok(app.includes('Descubra <em>quanto pode ficar</em> a parcela do consórcio que você procura.'));
  assert.ok(app.includes('Faça sua simulação personalizada por apenas <b class="gold">${PRECO_TXT}</b>.'));
  assert.ok(app.includes('FAZER MINHA SIMULAÇÃO POR ${PRECO_TXT}'));
  assert.ok(app.includes("let PRECO_TXT = 'R$ 5,00'"));
});
