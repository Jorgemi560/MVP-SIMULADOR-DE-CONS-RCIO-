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

// ---- Parcela reduzida de imóvel: a redução incide SÓ no fundo comum ----
const imovel220 = { tipo: 'imovel', prazo: 220, taxa_admin: 24, fundo_reserva: 0, seguro: 0, reduzida: 1, reducao_pct: 50, reducao_regra: 'fundo_comum' };
const cents = (n) => Math.round(n * 100) / 100;

test('referência: R$500.000, 220 meses, adm 24%, redução 50% do fundo comum', () => {
  const r = calcular(imovel220, 500000);
  assert.equal(r.fundoComumMensal, 2272.73);   // 500.000 / 220
  assert.equal(r.taxaAdmin, 120000);           // 500.000 × 24%
  assert.equal(r.taxaAdminMensal, 545.45);     // 120.000 / 220
  assert.equal(r.parcelaIntegral, 2818.18);
  assert.equal(r.parcelaReduzida, 1681.81);    // 1.136,36 + 545,45
  assert.notEqual(r.parcelaReduzida, cents(r.parcelaIntegral * 0.5)); // NÃO é 50% da parcela total (1.409,09)
});

for (const credito of [100000, 200000, 300000, 500000, 1000000]) {
  test(`R$${credito}: administração segue sobre 100% do crédito com fundo comum reduzido`, () => {
    const r = calcular(imovel220, credito);
    const fundoComum = cents(credito / 220);
    const adm = cents((credito * 0.24) / 220);
    assert.equal(r.parcelaIntegral, cents(fundoComum + adm));
    assert.equal(r.parcelaReduzida, cents(cents((credito / 220) * 0.5) + adm));
    // a diferença entre as parcelas é exatamente metade do fundo comum: a taxa não mudou
    assert.ok(Math.abs(r.parcelaIntegral - r.parcelaReduzida - fundoComum / 2) <= 0.01);
    assert.equal(r.taxaAdminMensal, adm);
    assert.equal(r.taxaAdmin, credito * 0.24);
  });
}

test('fundo de reserva e seguro também permanecem integrais na parcela reduzida', () => {
  const r = calcular({ ...imovel220, fundo_reserva: 2, seguro: 0.03 }, 500000);
  const fc = 2272.73, adm = 545.45, fr = cents(10000 / 220), seg = 150;
  assert.equal(r.parcelaIntegral, cents(fc + adm + fr + seg));
  assert.equal(r.parcelaReduzida, cents(cents((500000 / 220) * 0.5) + adm + fr + seg));
});

test('percentual de redução é configurável (não fixo em 50%)', () => {
  assert.equal(calcular({ ...imovel220, reducao_pct: 25 }, 500000).parcelaReduzida, cents(cents((500000 / 220) * 0.75) + 545.45));
  assert.equal(calcular({ ...imovel220, reducao_pct: 70 }, 500000).parcelaReduzida, cents(cents((500000 / 220) * 0.3) + 545.45));
});

test('período da redução é informado no resultado do cálculo', () => {
  assert.equal(calcular({ ...imovel220, reducao_meses: 24 }, 500000).reducaoMeses, 24);
  assert.equal(calcular({ ...imovel220, reduzida: 0, reducao_meses: 24 }, 500000).reducaoMeses, 0);
});

// ---- Exemplo do negócio: R$100.000, 24,2% => taxa 24.200; reduzida = (50.000 + 24.200) / 220 ----
const ex100 = { tipo: 'imovel', prazo: 220, taxa_admin: 24.2, fundo_reserva: 0, seguro: 0, reduzida: 1, reducao_pct: 50, reducao_regra: 'fundo_comum' };

test('R$100.000 + 24,2% (taxa 24.200): reduzida = (50.000 + 24.200) / 220 = 337,27', () => {
  const r = calcular(ex100, 100000);
  assert.equal(r.taxaAdmin, 24200);
  assert.equal(r.parcelaReduzida, 337.27);
  assert.equal(r.parcelaIntegral, 564.55); // (100.000 + 24.200) / 220
  assert.equal(cents((50000 + 24200) / 220), 337.27);
});

test('a taxa não é reduzida: continua 24.200 na parcela reduzida (não 12.100)', () => {
  const r = calcular(ex100, 100000);
  assert.notEqual(r.parcelaReduzida, cents((50000 + 12100) / 220)); // 282,27 estaria errado
  assert.notEqual(r.parcelaReduzida, cents(r.parcelaIntegral / 2));  // 50% da parcela total estaria errado
  assert.equal(r.taxaAdminMensal, 110);
});

test('parcela reduzida existe somente para imóvel', () => {
  for (const tipo of ['veiculo', 'outros']) {
    const r = calcular({ ...ex100, tipo }, 100000);
    assert.equal(r.parcelaReduzida, null);
    assert.equal(r.reducaoMeses, 0);
  }
});
