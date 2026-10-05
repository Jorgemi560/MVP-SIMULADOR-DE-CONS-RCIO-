'use strict';
// Navegador real (Playwright + Chromium), pagamento "mock" (sem cobrança real): hook de contemplação na entrada, explicação da
// parcela, aviso da parcela reduzida e "Alterar simulação" (novas simulações na mesma sessão, sem cobrar de novo).
// Pulado (com aviso) se Playwright/Chromium não estiverem instalados.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.TRUST_PROXY_HOPS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

let chromium = null;
const CAMINHO = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_DIR || `${execSync('npm root -g').toString().trim()}/playwright`));
  if (!fs.existsSync(CAMINHO)) chromium = null;
} catch { chromium = null; }
const opt = { skip: chromium ? false : 'Playwright/Chromium indisponível' };

const { server } = require('../server');
const db = require('../lib/db');
let base, browser;
test.before(async () => {
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  if (chromium) browser = await chromium.launch({ executablePath: CAMINHO });
});
test.after(async () => { await browser?.close(); server.close(); });
const texto = async (p, sel = 'main') => (await p.innerText(sel)).replace(/\s+/g, ' ');

async function novaPagina(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.5.0.${Math.floor(Math.random() * 200) + 1}` } });
  const p = await ctx.newPage();
  await p.goto(`${base}/`);
  return { ctx, p, email };
}
async function ateOCredito(p, email, tipo = 'imovel') {
  await p.click('[data-act=comecar]', { force: true });
  await p.fill('#nome', 'Cliente Fluxo'); await p.fill('#tel', '41987651212'); await p.fill('#email', email);
  await p.click('button[type=submit]');
  await p.click('[data-act=mock]');
  await p.click(`[data-act=tipo][data-v=${tipo}]`);
  await p.waitForSelector('[data-act=credito]');
}
async function preencherDados(p) {
  await p.waitForSelector('#f-dados');
  await p.fill('#cidade', 'Campo Belo'); await p.selectOption('#uf', 'MG'); await p.fill('#renda', '8000');
  await p.fill('#cpf', '52998224725'); await p.fill('#nasc', '1988-03-10'); await p.fill('#mae', 'Maria da Silva');
  await p.click('#f-dados button[type=submit]');
}

test('home: hook de contemplação curto e visível antes de começar, com o botão de iniciar preservado', opt, async () => {
  const { ctx, p } = await novaPagina('x@x.com');
  const t = await texto(p);
  assert.match(t, /Como você pode ser contemplado\?/);
  assert.match(t, /sorteio pela Loteria Federal ou .*lance/i);
  for (const l of ['Lance Livre', 'Lance Fixo (Embutido)', 'Lance Limitado']) assert.ok(t.includes(l), l);
  assert.match(t, /A contemplação não possui data garantida\./);
  assert.ok((await p.locator('.contemp').innerText()).length < 260, 'o hook deve ser curto');
  assert.equal(await p.locator('[data-act=comecar]').count(), 1);
  await ctx.close();
});

test('fluxo: explicação da parcela, aviso da reduzida (voltar/continuar) e Alterar simulação sem nova cobrança', opt, async () => {
  const email = `fluxo${Date.now()}@teste.com`;
  const { ctx, p } = await novaPagina(email);
  await ateOCredito(p, email);
  await p.click('[data-act=credito][data-v="100000"]');
  await preencherDados(p);
  await p.click('[data-act=cap]:first-of-type');

  // parcela: textos novos e mesma etapa de escolha (não há etapa extra)
  await p.waitForSelector('[data-act=parcela]');
  const escolha = await texto(p);
  assert.match(escolha, /PARCELA INTEGRAL Parcela normal do plano, sem redução\./);
  assert.match(escolha, /PARCELA REDUZIDA Menor parcela mensal até a contemplação\./);

  // reduzida → aviso; "voltar" retorna à escolha; "continuar" segue
  await p.click('[data-act=parcela][data-v=reduzida]');
  await p.waitForSelector('[data-act=parcela-confirma]');
  const aviso = await texto(p);
  assert.match(aviso, /⚠️ Atenção/);
  assert.match(aviso, /A parcela reduzida é válida somente até a contemplação\. Após a contemplação, a parcela será recalculada conforme as condições do plano e o prazo restante\./);
  assert.match(aviso, /CONTINUAR COM PARCELA REDUZIDA/); assert.match(aviso, /VOLTAR PARA PARCELA INTEGRAL/);
  assert.ok(!/R\$\s?\d/.test(aviso.replace('R$ 5,00', '')), 'não informa nenhum valor pós-contemplação');
  await p.click('[data-act=parcela-volta]');
  await p.waitForSelector('[data-act=parcela][data-v=integral]');
  await p.click('[data-act=parcela][data-v=reduzida]');
  await p.click('[data-act=parcela-confirma]');

  // resultado 1
  await p.waitForSelector('#btn-alterar', { timeout: 20000 });
  const r1 = await texto(p);
  assert.match(r1, /SUA SIMULAÇÃO ESTÁ PRONTA!/); assert.match(r1, /R\$\s?100\.000/); assert.match(r1, /parcela reduzida/i);
  assert.equal(await p.locator('#btn-especialista').count(), 1); // WhatsApp preservado
  assert.match(await texto(p, '#btn-alterar'), /ALTERAR SIMULAÇÃO/);
  const lead = await db.um('SELECT id, credito, parcela_escolhida FROM leads WHERE email = ?', [email]);
  assert.equal(Number(lead.credito), 100000); assert.equal(lead.parcela_escolhida, 'reduzida');

  // alterar: volta ao crédito, NÃO pede dados de novo nem paga de novo
  await p.click('#btn-alterar');
  await p.waitForSelector('[data-act=credito]');
  await p.click('[data-act=credito][data-v="150000"]');
  await p.waitForSelector('[data-act=cap]');            // pulou a tela de dados (já informados)
  assert.equal(await p.locator('#f-dados').count(), 0);
  await p.click('[data-act=cap]:first-of-type');
  await p.click('[data-act=parcela][data-v=integral]'); // integral: sem aviso
  await p.waitForSelector('#btn-alterar', { timeout: 20000 });
  const r2 = await texto(p);
  assert.match(r2, /R\$\s?150\.000/);
  const lead2 = await db.um('SELECT credito, parcela_escolhida FROM leads WHERE email = ?', [email]);
  assert.equal(Number(lead2.credito), 150000); assert.equal(lead2.parcela_escolhida, 'integral');

  // e de novo (o botão continua no novo resultado), agora trocando também o valor mensal
  await p.click('#btn-alterar');
  await p.click('[data-act=credito][data-v="200000"]');
  await p.waitForSelector('[data-act=cap]');
  await p.fill('#outro', '1500'); await p.click('[data-act=cap-outro]');
  await p.click('[data-act=parcela][data-v=integral]');
  await p.waitForSelector('#btn-alterar', { timeout: 20000 });
  assert.match(await texto(p), /R\$\s?200\.000/);

  // nenhuma cobrança nova: continua UM pagamento, pago
  const pags = await db.todos('SELECT status FROM pagamentos WHERE lead_id = ?', [lead.id]);
  assert.deepEqual(pags.map((x) => x.status), ['pago']);
  await ctx.close();
});

test('Alterar simulação: "Voltar" da tela de valor mensal leva ao crédito e a página recarregada pede os dados de novo (nada é perdido no servidor)', opt, async () => {
  const email = `volta${Date.now()}@teste.com`;
  const { ctx, p } = await novaPagina(email);
  await ateOCredito(p, email, 'veiculo');
  await p.click('[data-act=credito][data-v="50000"]');
  await preencherDados(p);
  await p.click('[data-act=cap]:first-of-type');
  await p.waitForSelector('#btn-alterar', { timeout: 20000 }); // veículo: sem parcela reduzida, vai direto ao resultado
  await p.click('#btn-alterar'); await p.click('[data-act=credito][data-v="60000"]');
  await p.waitForSelector('[data-act=cap]');
  await p.click('.back'); await p.waitForSelector('[data-act=credito]'); // voltar do valor mensal => crédito
  // recarregar: os dados sensíveis só existem em memória; pede de novo, mas o pagamento (pago) segue valendo
  await p.click('[data-act=credito][data-v="60000"]'); await p.waitForSelector('[data-act=cap]');
  await p.reload();
  await p.waitForSelector('#f-dados');
  assert.equal(await p.locator('[data-act=mock]').count(), 0); // não pede pagamento
  await ctx.close();
});
