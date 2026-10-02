'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcular, escolherPlano } = require('../lib/calc');
const V = require('../lib/validate');

const plano = { prazo: 219, taxa_admin: 24, fundo_reserva: 2, seguro: 0.035, reduzida: 1, reducao_pct: 25, reducao_regra: 'fundo_comum', ativo: 1, tipo: 'imovel', credito_min: 60000, credito_max: 1500000 };

test('parcela integral separa fundo comum, taxa, fundo de reserva e seguro', () => {
  const r = calcular(plano, 100000);
  assert.equal(r.fundoComum, 100000);
  assert.equal(r.taxaAdmin, 24000);
  assert.equal(r.fundoReserva, 2000);
  assert.equal(r.parcelaIntegral, 610.34); // (100000+24000+2000)/219 + 35
});

test('redução sobre o fundo comum mantém taxas e seguro', () => {
  const r = calcular(plano, 100000);
  assert.equal(r.parcelaReduzida, 496.19); // 456.62*0.75 + 109.59 + 9.13 + 35
});

test('redução sobre a parcela total', () => {
  const r = calcular({ ...plano, reducao_regra: 'parcela_total' }, 100000);
  assert.equal(r.parcelaReduzida, 457.76);
});

test('sem redução configurada não há parcela reduzida', () => {
  assert.equal(calcular({ ...plano, reduzida: 0 }, 100000).parcelaReduzida, null);
  assert.equal(calcular({ ...plano, reducao_pct: 0 }, 100000).parcelaReduzida, null);
});

test('escala linearmente: qualquer crédito é calculado sem cadastro', () => {
  const a = calcular(plano, 100000).parcelaIntegral, b = calcular(plano, 237500).parcelaIntegral;
  assert.ok(Math.abs(b - a * 2.375) < 0.05);
});

test('escolherPlano respeita tipo, faixa e ativo', () => {
  assert.ok(escolherPlano([plano], 'imovel', 100000));
  assert.equal(escolherPlano([plano], 'veiculo', 100000), null);
  assert.equal(escolherPlano([plano], 'imovel', 10000), null);
  assert.equal(escolherPlano([{ ...plano, ativo: 0 }], 'imovel', 100000), null);
});

test('validações', () => {
  assert.ok(V.cpfValido('529.982.247-25'));
  assert.ok(!V.cpfValido('111.111.111-11'));
  assert.ok(!V.cpfValido('529.982.247-24'));
  assert.ok(V.telefoneValido('(11) 99999-9999'));
  assert.ok(!V.telefoneValido('1234'));
  assert.ok(V.dataNascimentoValida('1990-05-20'));
  assert.ok(!V.dataNascimentoValida('2015-05-20'));
  assert.ok(!V.dataNascimentoValida('1990-02-31'));
});
