'use strict';
// Estrutura do banco (tabelas, índices e dados iniciais). É a ÚNICA fonte: o servidor, o comando "npm run db:criar"
// e o arquivo db/schema.sql (gerado por "npm run db:schema") usam exatamente isto. Tudo é "criar se não existir":
// nada aqui apaga, altera ou sobrescreve dados.

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    token TEXT NOT NULL,
    nome TEXT NOT NULL,
    email TEXT NOT NULL,
    telefone TEXT NOT NULL,
    cpf TEXT, nascimento TEXT, nome_mae TEXT, cidade TEXT, estado TEXT,
    tipo TEXT, credito DOUBLE PRECISION,
    renda_mensal DOUBLE PRECISION,
    capacidade_label TEXT, capacidade_valor DOUBLE PRECISION,
    parcela_escolhida TEXT,
    plano_id INTEGER,
    simulacao TEXT,
    resultado TEXT,
    interesse TEXT,
    status TEXT NOT NULL DEFAULT 'aguardando_pagamento',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    simulado_em TIMESTAMPTZ,
    excluido_em TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS pagamentos (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    provedor TEXT NOT NULL,
    provedor_id TEXT,
    valor_centavos INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    pago_em TIMESTAMPTZ,
    expira_em TIMESTAMPTZ,
    pix_codigo TEXT,
    informado_em TIMESTAMPTZ
  )`,
  // Bancos criados antes da validade do Pix ganham as colunas novas (só adiciona; não mexe nos dados existentes).
  `ALTER TABLE pagamentos ADD COLUMN IF NOT EXISTS expira_em TIMESTAMPTZ`,
  `ALTER TABLE pagamentos ADD COLUMN IF NOT EXISTS pix_codigo TEXT`,
  `ALTER TABLE pagamentos ADD COLUMN IF NOT EXISTS informado_em TIMESTAMPTZ`,
  // No máximo UMA cobrança aguardando pagamento por cliente: impede cobranças simultâneas duplicadas, mesmo com cliques ou abas em paralelo.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pag_pendente_por_lead ON pagamentos(lead_id) WHERE status = 'pendente'`,
  // Registro das exclusões (SEM dados pessoais): quando, de qual cadastro e o motivo.
  `CREATE TABLE IF NOT EXISTS exclusoes (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    motivo TEXT NOT NULL DEFAULT '',
    excluido_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pag_lead ON pagamentos(lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pag_prov ON pagamentos(provedor, provedor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_criado ON leads(criado_em DESC)`,
  `CREATE TABLE IF NOT EXISTS planos (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('imovel','veiculo','outros')),
    prazo INTEGER NOT NULL,
    taxa_admin DOUBLE PRECISION NOT NULL,
    fundo_reserva DOUBLE PRECISION NOT NULL DEFAULT 0,
    seguro DOUBLE PRECISION NOT NULL DEFAULT 0,
    indice TEXT NOT NULL DEFAULT 'IPCA',
    reduzida INTEGER NOT NULL DEFAULT 0,
    reducao_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    reducao_regra TEXT NOT NULL DEFAULT 'fundo_comum',
    reducao_meses INTEGER NOT NULL DEFAULT 0,
    arredondamento TEXT NOT NULL DEFAULT 'cortar',
    regra_texto TEXT NOT NULL DEFAULT '',
    credito_min DOUBLE PRECISION NOT NULL,
    credito_max DOUBLE PRECISION NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`,
];

// Planos iniciais, calibrados com simulações reais (inseridos só quando a tabela está vazia). Ajuste em /admin.
const PLANOS_INICIAIS = [
  // Imóvel abaixo de R$500 mil: parcela reduzida paga 50% do fundo comum.
  ['Imóvel 220 meses abaixo de R$500 mil (calibrado)', 'imovel', 220, 24.19, 0, 0, 'INCC', 1, 49.984, 'fundo_comum',
    'Redução de 50% somente sobre o fundo comum; a taxa de administração permanece integral.', 60000, 499999.99, 'cortar'],
  // Imóvel a partir de R$500 mil: plano "55% diluído" (a reduzida paga 55% do fundo comum). Prazo sempre 220 meses.
  ['Imóvel 220 meses 55% diluído, a partir de R$500 mil', 'imovel', 220, 24.19, 0, 0, 'INCC', 1, 45, 'fundo_comum',
    'Parcela reduzida paga 55% do fundo comum; a taxa de administração permanece integral.', 500000, 1500000, 'cortar'],
  // Veículo 90 meses, taxa 16,2% (R$90 mil = 1.162,00; R$130 mil = 1.678,44; R$150 mil = 1.936,67).
  ['Veículo 90 meses (calibrado)', 'veiculo', 90, 16.2, 0, 0, 'IPCA', 0, 0, 'fundo_comum', '', 20000, 400000, 'arredondar'],
  ['Outros bens 60 meses (exemplo)', 'outros', 60, 18, 2, 0.04, 'IPCA', 0, 0, 'fundo_comum', '', 5000, 200000, 'cortar'],
];


const CONFIG_INICIAL = { whatsapp: '', learn_url: '' };
const TABELAS = ['leads', 'pagamentos', 'planos', 'config', 'exclusoes'];
const COLUNAS_PLANO = 'nome,tipo,prazo,taxa_admin,fundo_reserva,seguro,indice,reduzida,reducao_pct,reducao_regra,regra_texto,credito_min,credito_max,arredondamento';

// Aplica a estrutura. "t" precisa de exec(sql, params) e um(sql, params), com marcadores "?".
async function aplicar(t) {
  for (const ddl of ESQUEMA) await t.exec(ddl);
  if ((await t.um('SELECT COUNT(*)::int AS n FROM planos')).n === 0) { // só preenche os planos iniciais se a tabela estiver vazia
    for (const p of PLANOS_INICIAIS) await t.exec(`INSERT INTO planos (${COLUNAS_PLANO}) VALUES (${p.map(() => '?').join(',')})`, p);
  }
  for (const [k, v] of Object.entries(CONFIG_INICIAL)) {
    await t.exec('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO NOTHING', [k, v]);
  }
}

module.exports = { ESQUEMA, PLANOS_INICIAIS, CONFIG_INICIAL, TABELAS, COLUNAS_PLANO, aplicar };
