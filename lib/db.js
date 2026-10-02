'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'simulador.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  telefone TEXT NOT NULL,
  cpf TEXT, nascimento TEXT, nome_mae TEXT, cidade TEXT, estado TEXT,
  tipo TEXT, credito REAL,
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
  regra_texto TEXT NOT NULL DEFAULT '',
  credito_min REAL NOT NULL,
  credito_max REAL NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
`);

if (!db.prepare('PRAGMA table_info(planos)').all().some((c) => c.name === 'reducao_meses')) {
  db.exec('ALTER TABLE planos ADD COLUMN reducao_meses INTEGER NOT NULL DEFAULT 0');
}

// Planos de EXEMPLO (valores ilustrativos): o administrador deve ajustá-los em /admin.
if (db.prepare('SELECT COUNT(*) n FROM planos').get().n === 0) {
  const ins = db.prepare(`INSERT INTO planos (nome,tipo,prazo,taxa_admin,fundo_reserva,seguro,indice,reduzida,reducao_pct,reducao_regra,regra_texto,credito_min,credito_max)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('Imóvel 219 meses (exemplo)', 'imovel', 219, 24, 2, 0.035, 'INCC', 1, 25, 'fundo_comum',
    'Redução de 25% sobre o fundo comum; a diferença é diluída no saldo devedor.', 60000, 1500000);
  ins.run('Veículo 80 meses (exemplo)', 'veiculo', 80, 16, 2, 0.045, 'IPCA', 0, 0, 'fundo_comum', '', 20000, 400000);
  ins.run('Outros bens 60 meses (exemplo)', 'outros', 60, 18, 2, 0.04, 'IPCA', 0, 0, 'fundo_comum', '', 5000, 200000);
}
const defaults = { whatsapp: '', learn_url: '' };
for (const [k, v] of Object.entries(defaults)) {
  db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)').run(k, v);
}

const getConfig = () => Object.fromEntries(db.prepare('SELECT chave, valor FROM config').all().map((r) => [r.chave, r.valor]));
const setConfig = (k, v) => db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(k, v);

module.exports = { db, getConfig, setConfig };
