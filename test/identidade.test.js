'use strict';
// Identidade própria: nenhuma referência a nomes de terceiros nos arquivos controlados pela aplicação,
// e o recebedor do código Pix vem somente da configuração (PIX_RECEBEDOR), sem valor embutido.
process.env.PAYMENT_PROVIDER = 'pix';
process.env.PIX_CHAVE = '11222333000181';
process.env.PIX_RECEBEDOR = 'MINHA EMPRESA LTDA';
process.env.PIX_CIDADE = 'CURITIBA';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { codigoPix } = require('../lib/payment');

const RAIZ = path.join(__dirname, '..');
const PROIBIDO = new RegExp(['lat', 'ryka'].join(''), 'i'); // montado em partes para o teste não se autodenunciar
function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (['node_modules', '.git'].includes(d.name)) return [];
    const p = path.join(dir, d.name);
    return d.isDirectory() ? arquivos(p) : [p];
  });
}

test('nenhum arquivo do projeto (código, textos, documentação, esquema) cita o nome de terceiro', () => {
  const achados = arquivos(RAIZ).filter((f) => /\.(js|json|md|html|css|sql|txt|example|yml|yaml)$|Dockerfile$/.test(f) && PROIBIDO.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(achados.map((f) => path.relative(RAIZ, f)), []);
});

test('o código Pix usa exatamente o recebedor configurado (nada embutido) e mantém o CRC íntegro', () => {
  const { crc16 } = require('../lib/pix');
  const c = codigoPix(7, 500);
  assert.ok(c.includes('MINHA EMPRESA LTDA'));
  assert.ok(!PROIBIDO.test(c));
  assert.equal(c.slice(-4), crc16(c.slice(0, -4)));
});
