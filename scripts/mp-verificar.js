'use strict';
// Confere a configuração do Mercado Pago SEM criar nenhuma cobrança: npm run mp:verificar
// Usa as mesmas variáveis do Render (MP_ACCESS_TOKEN, PUBLIC_URL, MP_WEBHOOK_SECRET). Nunca imprime o token.
const path = require('node:path');
try { process.loadEnvFile?.(path.join(__dirname, '..', '.env')); } catch { /* .env é opcional */ }
const token = process.env.MP_ACCESS_TOKEN || '';
const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
(async () => {
  let falhou = false;
  const ok = (m) => console.log(`✓ ${m}`), ruim = (m) => { falhou = true; console.error(`✗ ${m}`); }, aviso = (m) => console.log(`⚠ ${m}`);
  if ((process.env.PAYMENT_PROVIDER || '').toLowerCase() !== 'mercadopago') aviso('PAYMENT_PROVIDER não é "mercadopago" neste ambiente (o site continua no Pix estático).');
  if (!token) return ruim('MP_ACCESS_TOKEN não definido.') || process.exit(1);
  if (token.startsWith('TEST-')) ruim('O token é de TESTE (TEST-…): pagamentos reais não serão reconhecidos. Use o token de PRODUÇÃO (APP_USR-…).');
  else if (token.startsWith('APP_USR-')) ok('Token de produção (APP_USR-…).');
  else aviso('Formato de token não reconhecido (esperado APP_USR-… em produção).');
  try {
    const r = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    const u = await r.json().catch(() => ({}));
    if (!r.ok) ruim(`O Mercado Pago recusou o token (HTTP ${r.status}): ${u.message || 'erro'}. Gere outro em "Suas integrações".`);
    else {
      ok(`Credencial válida. Conta ${u.id} (${u.site_id || '?'}), país ${u.country_id || '?'}.`);
      if (u.site_id && u.site_id !== 'MLB') aviso('A conta não é do Brasil (MLB): o Pix só funciona em contas brasileiras.');
    }
  } catch (e) { ruim(`Não foi possível falar com o Mercado Pago: ${e.message}`); }
  if (!publicUrl.startsWith('https://')) ruim('PUBLIC_URL precisa começar com https:// (ex.: https://ganhemaisno.online) para o aviso automático (webhook) funcionar.');
  else ok(`Endereço do aviso automático: ${publicUrl}/api/webhooks/mercadopago`);
  if (!process.env.MP_WEBHOOK_SECRET) aviso('MP_WEBHOOK_SECRET não definido: os avisos não terão a assinatura validada (o status continua sendo conferido direto na API, então é seguro; a assinatura é uma camada extra).');
  else ok('MP_WEBHOOK_SECRET definido (assinatura dos avisos será validada).');
  if (process.argv.includes('--testar-cobranca')) {
    // Reproduz EXATAMENTE a criação de uma cobrança do site (POST /v1/payments, R$ 5,00, Pix) e cancela em seguida.
    // Uma cobrança Pix pendente não cobra ninguém; é cancelada logo depois. Mostra o motivo exato se o Mercado Pago recusar.
    const { providers, dicaParaErro, mpFetch, validadeMinutos } = require('../lib/payment');
    try {
      const r = await providers.mercadopago.criar({ pagamentoId: `diag${Date.now()}`, valorCentavos: 500, email: process.env.MP_TESTE_EMAIL || 'comprador.teste@exemplo.com', nome: 'Diagnostico', expiraEm: new Date(Date.now() + validadeMinutos() * 60000) });
      ok(`O Mercado Pago ACEITOU criar a cobrança Pix (id ${r.provedorId}); código copia e cola recebido: ${r.pix?.copiaECola ? 'sim' : 'NÃO'}.`);
      try { await mpFetch(`/v1/payments/${r.provedorId}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) }); ok('Cobrança de teste cancelada (ninguém foi cobrado).'); }
      catch (e) { aviso(`Não consegui cancelar a cobrança de teste ${r.provedorId} (ela expira sozinha): ${e.message}`); }
    } catch (e) {
      ruim(`O Mercado Pago RECUSOU criar a cobrança: ${e.message}`);
      console.error(`  O que fazer: ${e.http !== undefined ? dicaParaErro(e) : 'erro inesperado'}`);
    }
  } else console.log('\n(Para reproduzir a criação de uma cobrança real de teste e ver o motivo exato do erro: npm run mp:verificar -- --testar-cobranca)');
  console.log(falhou ? '\nHá problemas a corrigir antes de usar.' : '\nConfiguração coerente. Próximo passo: um Pix real de R$ 5,00 pelo site.');
  process.exit(falhou ? 1 : 0);
})();
