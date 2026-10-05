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
async function escolherNascimento(p, dia, mes, ano) {
  await p.selectOption('#nasc-a', String(ano)); await p.selectOption('#nasc-m', String(mes)); await p.selectOption('#nasc-d', String(dia));
}
async function preencherDados(p) {
  await p.waitForSelector('#f-dados');
  await p.fill('#cidade', 'Campo Belo'); await p.selectOption('#uf', 'MG'); await p.fill('#renda', '8000');
  await p.fill('#cpf', '52998224725'); await escolherNascimento(p, 10, 3, 1988); await p.fill('#mae', 'Maria da Silva');
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

// ---------- "← Voltar" padronizado ----------
const temVoltar = (p) => p.locator('main .back:visible').count();

test('Voltar do Pix: rever/corrigir os dados volta ao MESMO Pix, sem nova cobrança', opt, async () => {
  const email = `pixvolta${Date.now()}@teste.com`;
  const { ctx, p } = await novaPagina(email);
  await p.click('[data-act=comecar]', { force: true });
  await p.fill('#nome', 'Cliente Voltar'); await p.fill('#tel', '41987651414'); await p.fill('#email', email);
  await p.click('button[type=submit]');
  await p.waitForSelector('[data-act=mock]');
  assert.equal(await p.locator('#pay-back:visible').count(), 1);          // Pix pendente: pode voltar
  await p.click('#pay-back');
  await p.waitForSelector('#f-checkout');
  assert.equal(await p.inputValue('#nome'), 'Cliente Voltar');             // nada foi apagado
  assert.equal(await p.inputValue('#email'), email);
  assert.match(await texto(p), /nenhuma nova cobrança é criada/i);
  await p.fill('#nome', 'Cliente Voltar Corrigido'); await p.click('button[type=submit]');
  await p.waitForSelector('[data-act=mock]');                              // de volta à tela do Pix
  const lead = await db.um('SELECT id, nome FROM leads WHERE email = ?', [email]);
  assert.equal(lead.nome, 'Cliente Voltar Corrigido');
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM leads WHERE email = ?', [email])).n, 1);
  assert.deepEqual((await db.todos('SELECT status FROM pagamentos WHERE lead_id = ?', [lead.id])).map((x) => x.status), ['pendente']);
  // e ainda dá para voltar até o início
  await p.click('#pay-back'); await p.waitForSelector('#f-checkout'); await p.click('.back'); await p.waitForSelector('[data-act=comecar]');
  await ctx.close();
});

test('Voltar em todas as etapas do fluxo (sem apagar o que foi preenchido) e nenhum Voltar onde não é seguro', opt, async () => {
  const email = `voltas${Date.now()}@teste.com`;
  const { ctx, p } = await novaPagina(email);
  await ateOCredito(p, email);
  assert.equal(await temVoltar(p), 1);                                       // crédito: tem
  await p.click('.back'); await p.waitForSelector('[data-act=tipo]');         // crédito -> tipo
  assert.equal(await temVoltar(p), 0);                                       // tipo (já pago): sem Voltar
  await p.click('[data-act=tipo][data-v=imovel]'); await p.click('[data-act=credito][data-v="100000"]');
  await p.waitForSelector('#f-dados'); assert.equal(await temVoltar(p), 1);
  await p.fill('#cidade', 'Campo Belo'); await p.selectOption('#uf', 'MG'); await p.fill('#renda', '8000');
  await p.fill('#cpf', '52998224725'); await escolherNascimento(p, 10, 3, 1988); await p.fill('#mae', 'Maria da Silva');
  await p.click('.back'); await p.waitForSelector('[data-act=credito]');      // dados -> crédito
  await p.click('[data-act=credito][data-v="100000"]'); await p.waitForSelector('#f-dados');
  assert.equal(await p.inputValue('#cidade'), 'Campo Belo');                  // dados preservados
  assert.equal(await p.inputValue('#cpf'), '529.982.247-25');
  await p.click('#f-dados button[type=submit]'); await p.waitForSelector('[data-act=cap]');
  await p.click('.back'); await p.waitForSelector('#f-dados');                // capacidade -> dados
  await p.click('#f-dados button[type=submit]'); await p.waitForSelector('[data-act=cap]');
  await p.click('[data-act=cap]:first-of-type'); await p.waitForSelector('[data-act=parcela]');
  assert.equal(await temVoltar(p), 1);
  await p.click('.back'); await p.waitForSelector('[data-act=cap]');          // parcela -> capacidade
  await p.click('[data-act=cap]:first-of-type'); await p.click('[data-act=parcela][data-v=reduzida]');
  await p.waitForSelector('[data-act=parcela-confirma]');
  await p.click('.back'); await p.waitForSelector('[data-act=parcela][data-v=integral]'); // aviso -> parcela
  await p.click('[data-act=parcela][data-v=integral]');
  await p.waitForSelector('#btn-alterar', { timeout: 20000 });
  assert.equal(await temVoltar(p), 0);                                       // resultado: usa "Alterar simulação"
  // Voltar e Alterar simulação são coisas diferentes:
  await p.click('#btn-alterar'); await p.waitForSelector('[data-act=credito]');
  await p.click('.back'); await p.waitForSelector('#btn-alterar');            // cancelar a alteração volta ao mesmo resultado
  assert.match(await texto(p), /R\$\s?100\.000/);
  await p.click('#btn-alterar'); await p.click('[data-act=trocar-tipo]'); await p.waitForSelector('[data-act=tipo]');
  assert.equal(await temVoltar(p), 1);                                       // tipo em "Alterar": volta ao crédito
  await p.click('.back'); await p.waitForSelector('[data-act=credito]');
  // telas pós-interesse voltam ao resultado
  await p.click('.back'); await p.waitForSelector('[data-act=intent][data-v=agora]');
  await p.click('[data-act=intent][data-v=agora]'); await p.waitForSelector('text=Perfeito!');
  await p.click('.back'); await p.waitForSelector('#btn-alterar');
  assert.deepEqual((await db.todos("SELECT p.status FROM pagamentos p JOIN leads l ON l.id = p.lead_id WHERE l.email = ?", [email])).map((x) => x.status), ['pago']);
  await ctx.close();
});

test('primeira etapa: somente Imóvel e Veículo (sem "Outros")', opt, async () => {
  const email = `tipos${Date.now()}@teste.com`;
  const { ctx, p } = await novaPagina(email);
  await p.click('[data-act=comecar]', { force: true });
  await p.fill('#nome', 'Cliente Tipos'); await p.fill('#tel', '41987651616'); await p.fill('#email', email);
  await p.click('button[type=submit]'); await p.click('[data-act=mock]');
  await p.waitForSelector('[data-act=tipo]');
  assert.equal(await p.locator('[data-act=tipo]').count(), 2);
  const t = await texto(p);
  assert.match(t, /IMÓVEL/); assert.match(t, /VEÍCULO/); assert.ok(!/outros/i.test(t));
  // sessão antiga guardada com tipo "outros": volta para a primeira etapa em vez de quebrar
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('sc_state_v1')); s.tipo = 'outros'; s.tela = 'credito'; localStorage.setItem('sc_state_v1', JSON.stringify(s)); });
  await p.reload(); await p.waitForSelector('[data-act=tipo]');
  assert.equal(await p.locator('[data-act=tipo]').count(), 2);
  await ctx.close();
});

// ---------- Data de nascimento: seletores de dia / mês / ano ----------
async function ateOsDados(p, email) {
  await ateOCredito(p, email);
  await p.click('[data-act=credito][data-v="100000"]');
  await p.waitForSelector('#f-dados');
}

test('data de nascimento: ano escolhido direto (sem navegar mês a mês), só anos de maiores de 18 e valor AAAA-MM-DD', opt, async () => {
  const email = `nasc${Date.now()}@teste.com`;
  const { ctx, p } = await novaPagina(email);
  await ateOsDados(p, email);
  assert.equal(await p.locator('input[type=date]').count(), 0);                 // sem o calendário mês a mês
  const anos = await p.$$eval('#nasc-a option', (o) => o.map((x) => x.value).filter(Boolean).map(Number));
  const atual = new Date().getFullYear();
  assert.equal(anos[0], atual - 18); assert.equal(anos.at(-1), atual - 100);      // lista começa em (ano atual - 18): data futura/menor de 18 não aparece
  assert.ok(!anos.includes(atual) && !anos.includes(atual - 17));
  await p.selectOption('#nasc-a', '1979');                                        // UMA seleção leva a 1979
  await p.selectOption('#nasc-m', '5'); await p.selectOption('#nasc-d', '20');
  assert.equal(await p.inputValue('#nasc'), '1979-05-20');
  assert.equal(await p.locator('#nasc-m option:checked').innerText(), 'Maio');
  await ctx.close();
});

test('data de nascimento: dias se ajustam ao mês/ano (fev., bissexto, 30 dias) e nunca formam data inexistente', opt, async () => {
  const email = `dias${Date.now()}@teste.com`;
  const { ctx, p } = await novaPagina(email);
  await ateOsDados(p, email);
  await p.selectOption('#nasc-d', '31'); await p.selectOption('#nasc-m', '2'); await p.selectOption('#nasc-a', '2000');
  assert.equal(await p.inputValue('#nasc'), '2000-02-29');                        // bissexto
  await p.selectOption('#nasc-a', '1999');
  assert.equal(await p.inputValue('#nasc'), '1999-02-28');
  await p.selectOption('#nasc-d', '28'); await p.selectOption('#nasc-m', '4');
  assert.equal(await p.locator('#nasc-d option:not([hidden]):not([disabled])').count(), 31); // vazio + 1..30
  assert.equal(await p.inputValue('#nasc'), '1999-04-28');
  await p.selectOption('#nasc-d', ''); // data incompleta => campo oculto vazio
  assert.equal(await p.inputValue('#nasc'), '');
  await ctx.close();
});

test('data de nascimento: incompleta é recusada com os seletores destacados; completa segue; Voltar preserva a escolha', opt, async () => {
  const email = `inc${Date.now()}@teste.com`;
  const { ctx, p } = await novaPagina(email);
  await ateOsDados(p, email);
  await p.fill('#cidade', 'Campo Belo'); await p.selectOption('#uf', 'MG'); await p.fill('#renda', '8000'); await p.fill('#cpf', '52998224725'); await p.fill('#mae', 'Maria da Silva');
  await p.selectOption('#nasc-a', '1979');                                        // só o ano
  await p.click('#f-dados button[type=submit]');
  assert.equal(await p.locator('#f-dados').count(), 1);                           // não avançou
  assert.equal(await p.locator('.dn select.err').count(), 3);
  await p.selectOption('#nasc-m', '5'); await p.selectOption('#nasc-d', '20');
  assert.equal(await p.locator('.dn select.err').count(), 0);
  await p.click('.back'); await p.waitForSelector('[data-act=credito]');          // Voltar não apaga o que foi escolhido
  await p.click('[data-act=credito][data-v="100000"]'); await p.waitForSelector('#f-dados');
  assert.deepEqual([await p.inputValue('#nasc-d'), await p.inputValue('#nasc-m'), await p.inputValue('#nasc-a')], ['20', '5', '1979']);
  await p.click('#f-dados button[type=submit]');
  await p.waitForSelector('[data-act=cap]');                                       // seguiu o fluxo normal
  const lead = await db.um('SELECT nascimento FROM leads WHERE email = ?', [email]);
  assert.ok(lead); // (nascimento só é gravado na simulação; o fluxo continua normal)
  await ctx.close();
});

test('data de nascimento no iPhone (emulação de tela/toque): três seletores visíveis, sem rolagem lateral e com área de toque confortável', opt, async () => {
  const email = `iph${Date.now()}@teste.com`;
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    extraHTTPHeaders: { 'X-Forwarded-For': `10.5.9.${Math.floor(Math.random() * 200) + 1}` } });
  const p = await ctx.newPage(); await p.goto(`${base}/`);
  await ateOsDados(p, email);
  await p.locator('.dn').scrollIntoViewIfNeeded();
  const m = await p.evaluate(() => ({ larg: document.documentElement.scrollWidth, tela: window.innerWidth, alturas: [...document.querySelectorAll('.dn select')].map((s) => Math.round(s.getBoundingClientRect().height)), larguras: [...document.querySelectorAll('.dn select')].map((s) => Math.round(s.getBoundingClientRect().width)) }));
  assert.ok(m.larg <= m.tela, `rolagem lateral: ${m.larg} > ${m.tela}`);
  assert.ok(m.alturas.every((h) => h >= 44), `altura do toque: ${m.alturas}`);
  assert.ok(m.larguras.every((w) => w >= 70), `largura mínima: ${m.larguras}`);
  await p.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/nascimento-iphone.png` : undefined, ...(process.env.SHOT_DIR ? {} : { type: 'png' }) });
  await ctx.close();
});
