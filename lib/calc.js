'use strict';
// Motor de cálculo baseado em parâmetros do plano. Nenhum valor de crédito é cadastrado:
// qualquer crédito dentro da faixa [credito_min, credito_max] do plano é calculado na hora.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// Parcela: centavos são CORTADOS (não arredondados), como nas simulações das administradoras.
// O epsilon evita que 109,99999999… (erro de ponto flutuante) perca 1 centavo.
const trunc2 = (n) => Math.floor(n * 100 + 1e-6) / 100;

/**
 * Plano: { tipo, prazo, taxa_admin (%), fundo_reserva (%), seguro (% ao mês sobre o crédito),
 *          reduzida (0/1), reducao_pct (%), reducao_regra ('fundo_comum'|'parcela_total'),
 *          reducao_meses (0 = vigência indefinida) }
 *
 * Parcela = (total a pagar) ÷ prazo, com os centavos cortados:
 *   integral  = (crédito + administração + fundo de reserva + seguro) ÷ prazo
 *   reduzida  = (crédito × (1 − redução) + administração + fundo de reserva + seguro) ÷ prazo
 * A administração é sempre calculada sobre 100% do crédito e NÃO é reduzida.
 *
 * Exemplo: R$500.000, 220 meses, adm 24% (R$120.000):
 *   integral = 620.000 / 220 = 2.818,18      reduzida 50% = (250.000 + 120.000) / 220 = 1.681,81
 * Exemplo: R$100.000, adm 24,2% (R$24.200): reduzida 50% = (50.000 + 24.200) / 220 = 337,27
 *
 * A parcela reduzida existe somente para planos de tipo 'imovel'.
 * Regras de redução (configuráveis por plano):
 *  - fundo_comum:  o percentual incide SOMENTE sobre o crédito (fundo comum)
 *  - parcela_total: o percentual incide sobre a parcela integral inteira
 */
function calcular(plano, credito) {
  const prazo = Number(plano.prazo);
  if (!(credito > 0) || !(prazo > 0)) throw new Error('Parâmetros inválidos');

  const administracaoTotal = credito * (plano.taxa_admin / 100);
  const fundoReservaTotal = credito * (plano.fundo_reserva / 100);
  const seguroMensal = credito * (plano.seguro / 100);
  const seguroTotal = seguroMensal * prazo;
  const encargos = administracaoTotal + fundoReservaTotal + seguroTotal; // tudo, menos o fundo comum

  const integralExata = (credito + encargos) / prazo;

  let reduzidaExata = null;
  const pct = Number(plano.reducao_pct);
  if (plano.tipo === 'imovel' && plano.reduzida && pct > 0 && pct < 100) {
    const f = 1 - pct / 100;
    reduzidaExata = plano.reducao_regra === 'parcela_total'
      ? integralExata * f
      : (credito * f + encargos) / prazo;
  }

  return {
    credito, prazo,
    fundoComum: round2(credito),
    taxaAdmin: round2(administracaoTotal),
    fundoReserva: round2(fundoReservaTotal),
    seguroTotal: round2(seguroTotal),
    fundoComumMensal: trunc2(credito / prazo),
    taxaAdminMensal: trunc2(administracaoTotal / prazo),
    fundoReservaMensal: trunc2(fundoReservaTotal / prazo),
    seguroMensal: trunc2(seguroMensal),
    parcelaIntegral: trunc2(integralExata),
    parcelaReduzida: reduzidaExata === null ? null : trunc2(reduzidaExata),
    reducaoMeses: reduzidaExata === null ? 0 : Number(plano.reducao_meses) || 0,
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
