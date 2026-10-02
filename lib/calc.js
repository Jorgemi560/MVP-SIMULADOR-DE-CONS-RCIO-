'use strict';
// Motor de cálculo baseado em parâmetros do plano. Nenhum valor de crédito é cadastrado:
// qualquer crédito dentro da faixa [credito_min, credito_max] do plano é calculado na hora.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Plano: { prazo, taxa_admin (%), fundo_reserva (%), seguro (% ao mês sobre o crédito),
 *          reduzida (0/1), reducao_pct (%), reducao_regra ('fundo_comum'|'parcela_total'),
 *          reducao_meses (0 = vigência indefinida) }
 *
 * Cada componente mensal é arredondado a centavos e a parcela é a soma deles
 * (como a parcela é de fato cobrada). Ex.: 500.000 / 220 meses / 24% adm →
 *   fundo comum 2.272,73 + administração 545,45 = integral 2.818,18
 *   reduzida 50% (só fundo comum): 1.136,36 + 545,45 = 1.681,81
 *
 * A modalidade de parcela reduzida existe somente para planos de tipo 'imovel'.
 *
 * Exemplo (R$100.000, 220 meses, adm 24,2%, redução 50%): taxa total 24.200 integral;
 *   (100.000 × 50% + 24.200) / 220 = 337,27 — a taxa NÃO é reduzida.
 *
 * Regras de redução (configuráveis por plano):
 *  - fundo_comum:  o percentual incide SOMENTE sobre o fundo comum; administração,
 *                  fundo de reserva e seguro continuam integrais (calculados sobre 100% do crédito)
 *  - parcela_total: o percentual incide sobre a parcela integral inteira
 */
function calcular(plano, credito) {
  const prazo = Number(plano.prazo);
  if (!(credito > 0) || !(prazo > 0)) throw new Error('Parâmetros inválidos');

  const administracaoTotal = credito * (plano.taxa_admin / 100);
  const fundoReservaTotal = credito * (plano.fundo_reserva / 100);
  const seguroMensal = credito * (plano.seguro / 100);

  const mensal = {
    fundoComum: round2(credito / prazo),
    taxaAdmin: round2(administracaoTotal / prazo),
    fundoReserva: round2(fundoReservaTotal / prazo),
    seguro: round2(seguroMensal),
  };
  const taxas = mensal.taxaAdmin + mensal.fundoReserva + mensal.seguro;
  const integral = mensal.fundoComum + taxas;

  let reduzida = null;
  const pct = Number(plano.reducao_pct);
  // Parcela reduzida existe SOMENTE para imóvel.
  if (plano.tipo === 'imovel' && plano.reduzida && pct > 0 && pct < 100) {
    const f = 1 - pct / 100;
    reduzida = plano.reducao_regra === 'parcela_total'
      ? integral * f
      : round2((credito / prazo) * f) + taxas;
  }

  return {
    credito, prazo,
    fundoComum: round2(credito),
    taxaAdmin: round2(administracaoTotal),
    fundoReserva: round2(fundoReservaTotal),
    seguroTotal: round2(seguroMensal * prazo),
    fundoComumMensal: mensal.fundoComum,
    taxaAdminMensal: mensal.taxaAdmin,
    fundoReservaMensal: mensal.fundoReserva,
    seguroMensal: mensal.seguro,
    parcelaIntegral: round2(integral),
    parcelaReduzida: reduzida === null ? null : round2(reduzida),
    reducaoMeses: reduzida === null ? 0 : Number(plano.reducao_meses) || 0,
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
