'use strict';
// Testes de navegador (Playwright + Chromium) da tela de conferência do Pix: prazo de 3 minutos no front-end,
// servidor lento/mudo, "Verificar novamente", "Gerar novo Pix", recarregar a página e confirmação antes/depois dos 3 min.
// Pulados (com aviso) se o Playwright/Chromium não estiverem instalados na máquina.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'pix';
process.env.PIX_CHAVE = '11222333000181';
process.env.PIX_RECEBEDOR = 'EMPRESA DE TESTE LTDA';
process.env.PIX_CIDADE = 'CURITIBA';
process.env.PIX_WEBHOOK_SECRET = 'segredo-webhook-de-teste-123456';
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
let base, browser, n = 0;
test.before(async () => {
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  if (chromium) browser = await chromium.launch({ executablePath: CAMINHO });
});
test.after(async () => { await browser?.close(); server.close(); });

const webhook = (txid) => fetch(`${base}/api/webhooks/pix`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': process.env.PIX_WEBHOOK_SECRET }, body: JSON.stringify({ txid, valor_centavos: 500 }) });

// Abre o site, preenche o cadastro e chega na tela do Pix. O relógio do navegador é simulado (avança, mas também corre).
async function iniciar() {
  n++;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.7.0.${n}` } });
  const p = await ctx.newPage();
  await p.clock.install();
  await p.goto(`${base}/`);
  await p.click('[data-act=comecar]', { force: true });
  await p.fill('#nome', 'Cliente Teste'); await p.fill('#tel', `4198765${String(1000 + n)}`); await p.fill('#email', `ui${n}@teste.com`);
  await p.click('button[type=submit]');
  await p.waitForSelector('#btn-paguei');
  const codigo = await p.innerText('.copy');
  const leadId = (await db.um("SELECT id FROM leads WHERE email = ?", [`ui${n}@teste.com`])).id;
  const txid = `SIM${/SIM(\d+?)6304[0-9A-F]{4}$/.exec(codigo)[1]}`;
  return { ctx, p, codigo, leadId, txid };
}
const tela1 = (p) => p.waitForSelector('.verify:not(.warn) .ring', { timeout: 5000 });
const tela2 = (p) => p.waitForSelector('.verify.warn #btn-verificar', { timeout: 5000 });

test('1+2: clicou em "já fiz" sem pagar → tela 1 na hora; após 3 min muda sozinha para a tela 2 (todos os elementos)', opt, async () => {
  const { ctx, p } = await iniciar();
  await p.click('#btn-paguei'); await tela1(p);
  assert.match(await p.innerText('.verify h3'), /Verificando seu pagamento/);
  assert.equal(await p.locator('.verify.warn').count(), 0);
  await p.clock.fastForward(2 * 60 * 1000); await p.waitForTimeout(1500);
  await tela1(p); // 2 min: ainda na tela 1
  await p.clock.fastForward(61 * 1000);   // passa de 3 min, sem recarregar e sem clicar
  await tela2(p);
  const txt = (await p.innerText('.verify.warn')).replace(/\s+/g, ' ');
  assert.match(txt, /Verificando seu pagamento/);
  assert.match(txt, /Ainda não identificamos seu pagamento\. Estamos consultando o sistema\. Aguarde alguns instantes…/);
  assert.match(txt, /Se você já pagou, não faça outro Pix agora\./);
  assert.match(txt, /VERIFICAR NOVAMENTE/); assert.match(txt, /GERAR NOVO PIX/);
  assert.match(txt, /O novo Pix só deve ser disponibilizado quando for seguro gerar outra cobrança\./);
  assert.equal(await p.locator('.verify.warn hr').count(), 1);
  assert.equal(await p.locator('.copy').count(), 0); // o código antigo não volta à tela
  await ctx.close();
});

test('3: servidor lento — a troca aos 3 min acontece mesmo com a consulta pendurada', opt, async () => {
  const { ctx, p } = await iniciar();
  await p.route('**/api/lead/*/estado', async (route) => { await new Promise((r) => setTimeout(r, 6000)); route.continue().catch(() => {}); });
  await p.click('#btn-paguei'); await tela1(p);
  await p.clock.fastForward(181 * 1000);
  await tela2(p);
  await ctx.close();
});

test('4: servidor não responde (consulta nunca volta) — mesmo assim muda aos 3 min e não trava', opt, async () => {
  const { ctx, p } = await iniciar();
  await p.route('**/api/lead/*/estado', () => { /* nunca responde */ });
  await p.click('#btn-paguei'); await tela1(p);
  await p.clock.fastForward(181 * 1000);
  await tela2(p);
  // as consultas penduradas são abortadas em 12 s (timeout) e a tela continua utilizável
  await p.clock.fastForward(13 * 1000); await p.waitForTimeout(500);
  await tela2(p);
  await ctx.close();
});

test('5: "Verificar novamente" mantém a tela 2, sem reiniciar os 3 min nem esconder "Gerar novo Pix"', opt, async () => {
  const { ctx, p } = await iniciar();
  await p.click('#btn-paguei'); await tela1(p);
  await p.clock.fastForward(181 * 1000); await tela2(p);
  await p.click('#btn-verificar'); await p.waitForTimeout(1500);
  await tela2(p);
  assert.equal(await p.locator('#btn-novopix').count(), 1);
  assert.equal(await p.locator('.verify:not(.warn) .ring').count(), 0); // não voltou ao carregamento
  await ctx.close();
});

test('6+10: "Gerar novo Pix" — recusado com explicação enquanto não é seguro; liberado depois do prazo, sem cobrança duplicada', opt, async () => {
  const { ctx, p, codigo, leadId } = await iniciar();
  await p.click('#btn-paguei'); await tela1(p);
  await p.clock.fastForward(181 * 1000); await tela2(p);
  await p.click('#btn-novopix');
  await p.waitForFunction(() => /conferência/i.test(document.querySelector('.verify.warn .msg')?.textContent || ''), null, { timeout: 5000 });
  assert.match(await p.innerText('.verify.warn .msg'), /duplicidade/i);
  await tela2(p);
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [leadId])).n, 1);
  // passado o prazo de segurança (servidor), o cliente consegue gerar o novo Pix
  await db.exec("UPDATE pagamentos SET informado_em = now() - interval '20 minutes' WHERE lead_id = ?", [leadId]);
  await p.click('#btn-novopix');
  await p.waitForSelector('#btn-paguei', { timeout: 5000 });
  assert.notEqual(await p.innerText('.copy'), codigo);
  assert.equal((await db.um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [leadId])).n, 2);
  assert.equal((await db.um("SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ? AND status = 'pendente'", [leadId])).n, 1);
  await ctx.close();
});

test('7: atualizar/reabrir depois dos 3 min mostra direto a tela 2 (não reinicia os 3 min)', opt, async () => {
  const { ctx, p, leadId } = await iniciar();
  await p.click('#btn-paguei'); await tela1(p);
  // recarregar ainda dentro dos 3 min: continua na tela 1
  await p.reload(); await tela1(p);
  // "volta depois de algum tempo": o horário do aviso fica gravado no servidor
  await db.exec("UPDATE pagamentos SET informado_em = now() - interval '4 minutes' WHERE lead_id = ?", [leadId]);
  const nova = await ctx.newPage(); await nova.clock.install();
  await nova.goto(`${base}/`);
  await tela2(nova);
  assert.equal(await nova.locator('.verify:not(.warn) .ring').count(), 0);
  // sem nenhum dado local (outro aparelho/navegador limpo): o servidor reconstrói o estado
  await nova.evaluate(() => { const s = JSON.parse(localStorage.getItem('sc_state_v1')); delete s.conf; localStorage.setItem('sc_state_v1', JSON.stringify(s)); });
  await nova.reload(); await tela2(nova);
  await ctx.close();
});

test('8: pagamento confirmado antes dos 3 min libera a simulação', opt, async () => {
  const { ctx, p, txid } = await iniciar();
  await p.click('#btn-paguei'); await tela1(p);
  assert.equal((await webhook(txid)).status, 200);
  await p.clock.fastForward(4000);
  await p.waitForSelector('text=O que você pretende', { timeout: 10000 });
  await ctx.close();
});

test('9: pagamento confirmado depois dos 3 min (tela 2) é reconhecido e libera a simulação', opt, async () => {
  const { ctx, p, txid } = await iniciar();
  await p.click('#btn-paguei'); await tela1(p);
  await p.clock.fastForward(181 * 1000); await tela2(p);
  assert.equal((await webhook(txid)).status, 200);
  await p.clock.fastForward(4000);
  await p.waitForSelector('text=O que você pretende', { timeout: 10000 });
  await ctx.close();
});

test('rede cai ao clicar em "já fiz": a tela de verificação continua e o aviso é reenviado quando a rede volta', opt, async () => {
  const { ctx, p, leadId } = await iniciar();
  await p.route('**/informar-pagamento', (r) => r.abort());
  await p.click('#btn-paguei'); await tela1(p);
  await p.waitForTimeout(500);
  assert.equal((await db.um('SELECT status FROM pagamentos WHERE lead_id = ?', [leadId])).status, 'pendente'); // servidor ainda não sabe
  await p.unroute('**/informar-pagamento');
  await p.clock.fastForward(4000);
  await p.waitForFunction(async (id) => true, leadId);
  for (let i = 0; i < 20; i++) { if ((await db.um('SELECT status FROM pagamentos WHERE lead_id = ?', [leadId])).status === 'informado') break; await p.waitForTimeout(300); }
  assert.equal((await db.um('SELECT status FROM pagamentos WHERE lead_id = ?', [leadId])).status, 'informado');
  await tela1(p);
  await ctx.close();
});

test('Voltar do Pix: visível com o Pix pendente e ESCONDIDO em conferência (evita inconsistência de pagamento)', opt, async () => {
  const { ctx, p } = await iniciar();
  assert.equal(await p.locator('#pay-back:visible').count(), 1);
  await p.click('#btn-paguei'); await tela1(p);
  assert.equal(await p.locator('#pay-back:visible').count(), 0);
  await p.clock.fastForward(181 * 1000); await tela2(p);
  assert.equal(await p.locator('#pay-back:visible').count(), 0);
  await ctx.close();
});
