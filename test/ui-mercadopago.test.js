'use strict';
// Navegador real (Playwright + Chromium) com Mercado Pago simulado: o cliente paga e a próxima etapa abre SOZINHA,
// sem clicar em nada. Pulado (com aviso) se Playwright/Chromium não estiverem instalados.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mercadopago';
process.env.MP_ACCESS_TOKEN = 'APP_USR-token-falso-de-teste';
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

const mp = new Map(); let seq = 5000;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.mercadopago.com')) return realFetch(url, opts);
  const resp = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
  if (opts.method === 'POST') {
    const b = JSON.parse(opts.body); const id = ++seq;
    mp.set(String(id), { status: 'pending', external_reference: b.external_reference, transaction_amount: b.transaction_amount });
    return resp({ id, status: 'pending', point_of_interaction: { transaction_data: { qr_code: `00020126MPTESTE${id}`, qr_code_base64: '' } } });
  }
  const id = String(url).split('/').pop();
  return resp({ id, ...(mp.get(id) || { status: 'pending' }) });
};

const { server } = require('../server');
const db = require('../lib/db');
let base, browser, n = 0;
test.before(async () => {
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  if (chromium) browser = await chromium.launch({ executablePath: CAMINHO });
});
test.after(async () => { await browser?.close(); global.fetch = realFetch; server.close(); });

async function iniciar() {
  n++;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.6.0.${n}` } });
  const p = await ctx.newPage();
  await p.goto(`${base}/`);
  await p.click('[data-act=comecar]', { force: true });
  await p.fill('#nome', 'Cliente MP'); await p.fill('#tel', `4198760${String(1000 + n)}`); await p.fill('#email', `mp${n}@teste.com`);
  await p.click('button[type=submit]');
  await p.waitForSelector('.auto-wait');
  const leadId = (await db.um('SELECT id FROM leads WHERE email = ?', [`mp${n}@teste.com`])).id;
  const pg = await db.um('SELECT * FROM pagamentos WHERE lead_id = ?', [leadId]);
  return { ctx, p, leadId, mpId: pg.provedor_id };
}
const aprovar = (mpId) => mp.set(mpId, { ...mp.get(mpId), status: 'approved' });
const proxima = (p, t = 12000) => p.waitForSelector('text=O que você pretende', { timeout: t });

test('tela com Mercado Pago: QR + espera automática, SEM botão "Já fiz o pagamento"', opt, async () => {
  const { ctx, p } = await iniciar();
  assert.equal(await p.locator('#btn-paguei').count(), 0);
  assert.match(await p.innerText('.auto-wait'), /Você não precisa clicar em nada/);
  assert.equal(await p.locator('.qr').count(), 1);
  assert.match(await p.innerText('.copy'), /^00020126MPTESTE/);
  await ctx.close();
});

test('pagamento aprovado: a próxima etapa (imóvel/veículo) abre sozinha, sem nenhum clique', opt, async () => {
  const { ctx, p, mpId } = await iniciar();
  aprovar(mpId);
  await proxima(p); // só espera: a tela consulta sozinha a cada 2 s
  assert.match(await p.innerText('main'), /IMÓVEL/);
  await ctx.close();
});

test('o cliente atualiza a página enquanto aguarda: continua aguardando e depois avança sozinho', opt, async () => {
  const { ctx, p, mpId } = await iniciar();
  await p.reload(); await p.waitForSelector('.auto-wait');
  aprovar(mpId);
  await proxima(p);
  await ctx.close();
});

test('o cliente fecha o site, o pagamento é aprovado, e ao voltar já está liberado (não perde a simulação paga)', opt, async () => {
  const { ctx, p, mpId } = await iniciar();
  await p.close();
  aprovar(mpId);
  const { varrerMercadoPago } = require('../server');
  await varrerMercadoPago(); // a varredura em segundo plano confirma sem ninguém na página
  const nova = await ctx.newPage(); await nova.goto(`${base}/`);
  await proxima(nova, 8000); // reabre direto na etapa liberada
  await ctx.close();
});

test('pagamento pendente não libera, mesmo esperando: continua na tela de espera', opt, async () => {
  const { ctx, p } = await iniciar();
  await p.waitForTimeout(5000);
  assert.equal(await p.locator('.auto-wait').count(), 1);
  assert.equal(await p.locator('text=O que você pretende').count(), 0);
  await ctx.close();
});
