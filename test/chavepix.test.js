'use strict';
// Chave Pix: normalização para o formato do DICT e integridade do BR Code gerado a partir dela.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analisarChave } = require('../lib/chavepix');
const { brCode, crc16 } = require('../lib/pix');

test('chaves digitadas "como no app" são normalizadas para o formato exato do Pix', () => {
  const casos = [
    ['11222333000181', 'cnpj', '11222333000181', false],
    ['11.222.333/0001-81', 'cnpj', '11222333000181', true],
    ['12ABC34501DE35', 'cnpj', '12ABC34501DE35', false],            // CNPJ alfanumérico
    ['529.982.247-25', 'cpf', '52998224725', true],
    ['(41) 99744-6032', 'celular', '+5541997446032', true],
    ['41997446032', 'celular', '+5541997446032', true],
    ['5541997446032', 'celular', '+5541997446032', true],
    ['+55 41 99744-6032', 'celular', '+5541997446032', true],
    ['  Fulano@Exemplo.COM ', 'email', 'fulano@exemplo.com', true],
    ['123E4567-E89B-12D3-A456-426614174000', 'aleatoria', '123e4567-e89b-12d3-a456-426614174000', true],
  ];
  for (const [entrada, tipo, valor, ajustada] of casos) {
    const r = analisarChave(entrada);
    assert.deepEqual([r.ok, r.tipo, r.valor, r.ajustada], [true, tipo, valor, ajustada], `entrada: ${entrada}`);
  }
});

test('chaves que não dá para reconhecer são recusadas (nada de QR Code inválido para o cliente)', () => {
  for (const ruim of ['', '   ', '1234', 'abc', '11111111111', 'sem-arroba.com', 'a@b', '+1 202 555 0100']) {
    const r = analisarChave(ruim);
    assert.equal(r.ok, false, `deveria recusar: "${ruim}"`);
    assert.ok(r.motivo);
  }
});

test('BR Code gerado com a chave normalizada: campos, CRC e chave no campo certo', () => {
  const k = analisarChave('(41) 99744-6032').valor;
  const c = brCode({ chave: k, valorCentavos: 500, recebedor: 'Minha Empresa Ltda', cidade: 'Curitiba', txid: 'SIM9' });
  const lerTlv = (s) => { const o = {}; for (let i = 0; i < s.length;) { const l = Number(s.slice(i + 2, i + 4)); o[s.slice(i, i + 2)] = s.slice(i + 4, i + 4 + l); i += 4 + l; } return o; };
  const f = lerTlv(c), conta = lerTlv(f['26']);
  assert.equal(conta['00'], 'br.gov.bcb.pix'); assert.equal(conta['01'], '+5541997446032');
  assert.equal(f['54'], '5.00'); assert.equal(f['63'], crc16(c.slice(0, -4)));
});
