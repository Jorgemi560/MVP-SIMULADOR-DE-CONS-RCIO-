'use strict';
// Migração do SQLite antigo (disco do Render) para o PostgreSQL.
process.env.ADMIN_PASSWORD = 'segredo-teste';
process.env.PAYMENT_PROVIDER = 'mock';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const banco = require('../lib/db');
const { migrar } = require('../scripts/migrar-sqlite-para-postgres');

function sqliteAntigo() {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'antigo.db');
  const d = new DatabaseSync(arq);
  d.exec(`
    CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, nome TEXT NOT NULL, email TEXT NOT NULL, telefone TEXT NOT NULL,
      cpf TEXT, tipo TEXT, credito REAL, status TEXT NOT NULL DEFAULT 'aguardando_pagamento', interesse TEXT,
      criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), simulado_em TEXT);
    CREATE TABLE pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, provedor TEXT NOT NULL, provedor_id TEXT, valor_centavos INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente', criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), pago_em TEXT);
    CREATE TABLE planos (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, tipo TEXT NOT NULL, prazo INTEGER NOT NULL, taxa_admin REAL NOT NULL,
      fundo_reserva REAL NOT NULL DEFAULT 0, seguro REAL NOT NULL DEFAULT 0, indice TEXT NOT NULL DEFAULT 'IPCA', reduzida INTEGER NOT NULL DEFAULT 0,
      reducao_pct REAL NOT NULL DEFAULT 0, reducao_regra TEXT NOT NULL DEFAULT 'fundo_comum', regra_texto TEXT NOT NULL DEFAULT '', credito_min REAL NOT NULL, credito_max REAL NOT NULL, ativo INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    INSERT INTO planos (id, nome, tipo, prazo, taxa_admin, credito_min, credito_max) VALUES (7, 'Plano antigo', 'imovel', 200, 22.5, 1000, 900000);
    INSERT INTO leads (id, token, nome, email, telefone, cpf, tipo, credito, status, interesse, criado_em, simulado_em) VALUES
      (3, 'tk3', 'Maria Antiga', 'maria@x.com', '41911112222', '52998224725', 'imovel', 250000.5, 'novo', 'agora', '2026-09-20T12:30:45.123Z', '2026-09-20T12:35:00.000Z'),
      (9, 'tk9', 'João Antigo', 'joao@x.com', '11933334444', NULL, NULL, NULL, 'aguardando_pagamento', NULL, '2026-09-21T10:00:00.000Z', NULL);
    INSERT INTO pagamentos (id, lead_id, provedor, provedor_id, valor_centavos, status, criado_em, pago_em) VALUES
      (4, 3, 'pix', 'SIM4', 500, 'pago', '2026-09-20T12:30:46.000Z', '2026-09-20T12:40:00.000Z'),
      (5, 9, 'pix', 'SIM5', 500, 'pendente', '2026-09-21T10:00:01.000Z', NULL);
    INSERT INTO config (chave, valor) VALUES ('whatsapp', '41997446032'), ('learn_url', 'https://exemplo.com/guia');
  `);
  d.close();
  return arq;
}

test.after(() => banco.fechar());

test('migra leads, pagamentos, planos e config mantendo IDs, datas e valores; depois continua a numeração', async () => {
  const arq = sqliteAntigo();
  const r = await migrar(arq);
  assert.deepEqual({ leads: r.leads, pagamentos: r.pagamentos, planos: r.planos }, { leads: 2, pagamentos: 2, planos: 1 });

  const m = await banco.um('SELECT * FROM leads WHERE id = 3');
  assert.equal(m.nome, 'Maria Antiga'); assert.equal(m.cpf, '52998224725'); assert.equal(m.credito, 250000.5); assert.equal(m.interesse, 'agora');
  assert.equal(m.criado_em.toISOString(), '2026-09-20T12:30:45.123Z');
  assert.equal(m.renda_mensal, null);                                                      // coluna nova: vazia nos dados antigos
  assert.equal((await banco.um('SELECT valor_centavos, status, pago_em FROM pagamentos WHERE id = 4')).status, 'pago');
  assert.equal((await banco.todos('SELECT id, nome FROM planos')).map((p) => `${p.id}:${p.nome}`).join(), '7:Plano antigo'); // exemplos substituídos
  assert.equal((await banco.getConfig()).learn_url, 'https://exemplo.com/guia');

  const novo = await banco.um('INSERT INTO leads (token, nome, email, telefone) VALUES (?,?,?,?) RETURNING id', ['t', 'Novo', 'n@x.com', '41900000000']);
  assert.ok(novo.id > 9, `novo lead deveria continuar depois do ID 9 (veio ${novo.id})`);
  assert.ok((await banco.um("INSERT INTO pagamentos (lead_id, provedor, valor_centavos) VALUES (?, 'pix', 500) RETURNING id", [novo.id])).id > 5);
});

test('recusa migrar sobre um PostgreSQL que já tem leads (sem --forcar) e não altera nada', async () => {
  const antes = (await banco.um('SELECT COUNT(*)::int AS n FROM leads')).n;
  await assert.rejects(() => migrar(sqliteAntigo()), /já tem \d+ lead/);
  assert.equal((await banco.um('SELECT COUNT(*)::int AS n FROM leads')).n, antes);
});

test('arquivo SQLite inexistente gera erro claro', async () => {
  await assert.rejects(() => migrar('/caminho/que/nao/existe.db', { forcar: true }), /não encontrado/);
});
