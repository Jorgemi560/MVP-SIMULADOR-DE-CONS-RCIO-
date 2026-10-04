'use strict';
// Confere a configuração do Pix SEM cobrar nada: npm run pix:verificar
// Mostra o tipo da chave, o código "copia e cola" de exemplo (R$ 5,00) e valida a estrutura (campos e CRC).
// Cole o código de exemplo no "Pix copia e cola" do app do seu banco: o banco deve mostrar o titular da conta
// que você espera. NÃO confirme o pagamento (ou confirme só para o teste de R$ 5,00 que você mesmo quer fazer).
const path = require('node:path');
try { process.loadEnvFile?.(path.join(__dirname, '..', '.env')); } catch { /* .env é opcional */ }
const { analisarChave } = require('../lib/chavepix');
const { crc16, brCode } = require('../lib/pix');

const provedor = (process.env.PAYMENT_PROVIDER || 'pix').toLowerCase();
console.log(`Provedor: ${provedor}${provedor === 'pix' ? ' (Pix ESTÁTICO: o código não expira no banco; a validade do site é só do sistema)' : ''}`);
if (provedor !== 'pix') { console.log('Este verificador cobre o Pix estático. Com Mercado Pago, o QR Code vem da API do provedor.'); process.exit(0); }

const info = analisarChave(process.env.PIX_CHAVE);
if (!info.ok) { console.error(`✗ PIX_CHAVE inválida: ${info.motivo}`); process.exit(1); }
const mask = (t) => (t.length <= 6 ? '••••' : `${t.slice(0, 3)}•••${t.slice(-4)}`);
console.log(`✓ Chave reconhecida como ${info.tipo}: ${mask(info.valor)}${info.ajustada ? '  (⚠ a variável está fora do formato do Pix; o sistema a normaliza, mas atualize PIX_CHAVE para este valor)' : ''}`);
const recebedor = (process.env.PIX_RECEBEDOR || '').trim();
if (!recebedor) { console.error('✗ PIX_RECEBEDOR não definido.'); process.exit(1); }
const cidade = (process.env.PIX_CIDADE || 'BRASIL').trim();
const codigo = brCode({ chave: info.valor, valorCentavos: 500, recebedor, cidade, txid: 'SIMTESTE' });
const lerTlv = (s) => { const o = {}; for (let i = 0; i < s.length;) { const l = Number(s.slice(i + 2, i + 4)); o[s.slice(i, i + 2)] = s.slice(i + 4, i + 4 + l); i += 4 + l; } return o; };
const f = lerTlv(codigo), conta = lerTlv(f['26']);
const ok = f['63'] === crc16(codigo.slice(0, -4)) && conta['01'] === info.valor && f['54'] === '5.00' && f['58'] === 'BR';
console.log(`${ok ? '✓' : '✗'} Estrutura do BR Code: campos e CRC ${ok ? 'conferem' : 'NÃO conferem'}`);
console.log(`  Recebedor no código: ${f['59']} · Cidade: ${f['60']} · Valor: R$ ${f['54']}`);
console.log('\nCódigo de exemplo (copia e cola):\n' + codigo);
console.log('\nPróximo passo: cole no app do banco (Pix → Copia e cola). Se o banco disser "QR Code inválido/expirado", o problema é a chave ou a conta (veja DEPLOY.md), não o site.');
