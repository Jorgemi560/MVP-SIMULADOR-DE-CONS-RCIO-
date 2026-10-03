'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'simulador.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
// secure_delete: apaga de fato (zera) o conteúdo removido/alterado, importante para pedidos de exclusão de dados pessoais.
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  telefone TEXT NOT NULL,
  cpf TEXT, nascimento TEXT, nome_mae TEXT, cidade TEXT, estado TEXT,
  tipo TEXT, credito REAL,
  renda_mensal REAL,
  capacidade_label TEXT, capacidade_valor REAL,
  parcela_escolhida TEXT,
  plano_id INTEGER,
  simulacao TEXT,            -- JSON com o detalhamento do cálculo
  resultado TEXT,            -- resumo legível (ex.: "R$ 612,34 integral")
  interesse TEXT,            -- agora | conversar | depois
  status TEXT NOT NULL DEFAULT 'aguardando_pagamento',
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  simulado_em TEXT
);
CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  provedor TEXT NOT NULL,
  provedor_id TEXT,
  valor_centavos INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',   -- pendente | pago | recusado | cancelado
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  pago_em TEXT
);
-- Registro das exclusões (SEM dados pessoais): só quando, de qual cadastro e o motivo informado pelo administrador.
CREATE TABLE IF NOT EXISTS exclusoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  motivo TEXT NOT NULL DEFAULT '',
  excluido_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pag_lead ON pagamentos(lead_id);
CREATE INDEX IF NOT EXISTS idx_pag_prov ON pagamentos(provedor, provedor_id);
CREATE TABLE IF NOT EXISTS planos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('imovel','veiculo','outros')),
  prazo INTEGER NOT NULL,
  taxa_admin REAL NOT NULL,
  fundo_reserva REAL NOT NULL DEFAULT 0,
  seguro REAL NOT NULL DEFAULT 0,
  indice TEXT NOT NULL DEFAULT 'IPCA',
  reduzida INTEGER NOT NULL DEFAULT 0,
  reducao_pct REAL NOT NULL DEFAULT 0,
  reducao_regra TEXT NOT NULL DEFAULT 'fundo_comum',
  reducao_meses INTEGER NOT NULL DEFAULT 0,   -- 0 = sem prazo definido
  arredondamento TEXT NOT NULL DEFAULT 'cortar',
  regra_texto TEXT NOT NULL DEFAULT '',
  credito_min REAL NOT NULL,
  credito_max REAL NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
`);

if (!db.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'excluido_em')) {
  db.exec('ALTER TABLE leads ADD COLUMN excluido_em TEXT');
}
if (!db.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'renda_mensal')) {
  db.exec('ALTER TABLE leads ADD COLUMN renda_mensal REAL');
}
if (!db.prepare('PRAGMA table_info(planos)').all().some((c) => c.name === 'reducao_meses')) {
  db.exec('ALTER TABLE planos ADD COLUMN reducao_meses INTEGER NOT NULL DEFAULT 0');
}

if (!db.prepare('PRAGMA table_info(planos)').all().some((c) => c.name === 'arredondamento')) {
  db.exec("ALTER TABLE planos ADD COLUMN arredondamento TEXT NOT NULL DEFAULT 'cortar'");
}

// Planos de EXEMPLO (valores ilustrativos): o administrador deve ajustá-los em /admin.
if (db.prepare('SELECT COUNT(*) n FROM planos').get().n === 0) {
  const ins = db.prepare(`INSERT INTO planos (nome,tipo,prazo,taxa_admin,fundo_reserva,seguro,indice,reduzida,reducao_pct,reducao_regra,regra_texto,credito_min,credito_max,arredondamento)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // Parâmetros calibrados com simulações reais (imóvel 220 meses: R$80 mil 451,60/269,84; R$160 mil 903,20/539,68; R$250 mil 1.411,25/843,25).
  // taxa_admin = taxa total efetiva (24,19%); reducao_pct = 49,984% (equivale a ~50% do fundo comum).
  // Imóvel abaixo de R$500 mil: parcela reduzida paga 50% do fundo comum.
  ins.run('Imóvel 220 meses abaixo de R$500 mil (calibrado)', 'imovel', 220, 24.19, 0, 0, 'INCC', 1, 49.984, 'fundo_comum',
    'Redução de 50% somente sobre o fundo comum; a taxa de administração permanece integral.', 60000, 499999.99, 'cortar');
  // Imóvel a partir de R$500 mil: plano "55% diluído" — a parcela reduzida paga 55% do fundo comum (redução de 45%).
  // O prazo é sempre 220 meses (o "219" que aparece no simulador da administradora é só a 1ª parcela já paga na assinatura).
  // Calibrado com a simulação real de R$500.000 (1.808,00 em 219 meses ⇒ fundo comum pago = 55,000% com taxa de 24,19%).
  ins.run('Imóvel 220 meses 55% diluído, a partir de R$500 mil', 'imovel', 220, 24.19, 0, 0, 'INCC', 1, 45, 'fundo_comum',
    'Parcela reduzida paga 55% do fundo comum; a taxa de administração permanece integral.', 500000, 1500000, 'cortar');
  // Veículo 90 meses, taxa 16,2% (R$90 mil = 1.162,00; R$130 mil = 1.678,44; R$150 mil = 1.936,67).
  ins.run('Veículo 90 meses (calibrado)', 'veiculo', 90, 16.2, 0, 0, 'IPCA', 0, 0, 'fundo_comum', '', 20000, 400000, 'arredondar');
  ins.run('Outros bens 60 meses (exemplo)', 'outros', 60, 18, 2, 0.04, 'IPCA', 0, 0, 'fundo_comum', '', 5000, 200000, 'cortar');
}
const defaults = { whatsapp: '', learn_url: '' };
for (const [k, v] of Object.entries(defaults)) {
  db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)').run(k, v);
}

const getConfig = () => Object.fromEntries(db.prepare('SELECT chave, valor FROM config').all().map((r) => [r.chave, r.valor]));
const setConfig = (k, v) => db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(k, v);

// O banco só sobrevive a novos deploys se estiver num disco persistente (no Render: "Disk" montado em /data).
// Detecta o caso perigoso: arquivo no mesmo dispositivo do sistema de arquivos temporário do contêiner.
function persistencia() {
  if (file === ':memory:') return { persistente: false, motivo: 'memória' };
  if (process.env.DB_PERSISTENTE === '1') return { persistente: true };
  if (process.env.NODE_ENV !== 'production') return { persistente: true };
  try {
    const mesmoDisco = fs.statSync(path.dirname(file)).dev === fs.statSync('/').dev;
    return mesmoDisco ? { persistente: false, motivo: 'sem disco persistente montado' } : { persistente: true };
  } catch { return { persistente: true }; }
}

module.exports = { db, getConfig, setConfig, persistencia };
