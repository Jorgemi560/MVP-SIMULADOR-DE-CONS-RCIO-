'use strict';
// Motor de cálculo baseado em parâmetros do plano. Nenhum valor de crédito é cadastrado:
// qualquer crédito dentro da faixa [credito_min, credito_max] do plano é calculado na hora.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Plano: { prazo, taxa_admin (%), fundo_reserva (%), seguro (% ao mês sobre o crédito),
 *          reduzida (0/1), reducao_pct (%), reducao_regra ('fundo_comum'|'parcela_total') }
 * Regras de redução (configuráveis por plano):
 *  - fundo_comum:  reduz reducao_pct % apenas da parcela do fundo comum; taxas e seguro integrais
 *  - parcela_total: reduz reducao_pct % da parcela integral inteira
 */
function calcular(plano, credito) {
  const prazo = Number(plano.prazo);
  if (!(credito > 0) || !(prazo > 0)) throw new Error('Parâmetros inválidos');

  const fundoComum = credito;
  const taxaAdmin = credito * (plano.taxa_admin / 100);
  const fundoReserva = credito * (plano.fundo_reserva / 100);
  const seguroMensal = credito * (plano.seguro / 100);

  const mensal = {
    fundoComum: fundoComum / prazo,
    taxaAdmin: taxaAdmin / prazo,
    fundoReserva: fundoReserva / prazo,
    seguro: seguroMensal,
  };
  const integral = mensal.fundoComum + mensal.taxaAdmin + mensal.fundoReserva + mensal.seguro;

  let reduzida = null;
  if (plano.reduzida && plano.reducao_pct > 0 && plano.reducao_pct < 100) {
    const f = 1 - plano.reducao_pct / 100;
    reduzida = plano.reducao_regra === 'parcela_total'
      ? integral * f
      : mensal.fundoComum * f + mensal.taxaAdmin + mensal.fundoReserva + mensal.seguro;
  }

  return {
    credito, prazo,
    fundoComum: round2(fundoComum),
    taxaAdmin: round2(taxaAdmin),
    fundoReserva: round2(fundoReserva),
    seguroTotal: round2(seguroMensal * prazo),
    parcelaIntegral: round2(integral),
    parcelaReduzida: reduzida === null ? null : round2(reduzida),
  };
}

const planoServe = (p, tipo, credito) =>
  p.ativo && p.tipo === tipo && credito >= p.credito_min && credito <= p.credito_max;

/** Escolhe, entre os planos ativos do tipo que atendem ao crédito, o de menor parcela integral. */
function escolherPlano(planos, tipo, credito) {
  let melhor = null;
  for (const p of planos) {
    if (!planoServe(p, tipo, credito)) continue;
    const c = calcular(p, credito);
    if (!melhor || c.parcelaIntegral < melhor.calc.parcelaIntegral) melhor = { plano: p, calc: c };
  }
  return melhor;
}

module.exports = { calcular, escolherPlano, round2 };
