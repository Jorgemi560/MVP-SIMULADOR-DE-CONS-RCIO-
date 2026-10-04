#!/usr/bin/env node
'use strict';
// Copia os dados do banco SQLite antigo (disco do Render) para o PostgreSQL externo.
//
//   DATABASE_URL="postgres://..." node scripts/migrar-sqlite-para-postgres.js caminho/do/simulador.db
//
// - Só roda se o PostgreSQL ainda NÃO tiver leads (nunca mistura nem sobrescreve dados). Use --forcar para ignorar.
// - Mantém os mesmos números (IDs) de leads, pagamentos e planos, e acerta os contadores do PostgreSQL.
// - Os planos de exemplo criados no PostgreSQL vazio são substituídos pelos planos do SQLite.
// - Não altera nem apaga o arquivo SQLite: ele continua sendo a sua cópia de segurança.
const fs = require('node:fs');
const path = require('node:path');

async function migrar(arquivoSqlite, { forcar = false, log = () => {} } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const banco = require('../lib/db');
  await banco.pronto;
  if (!fs.existsSync(arquivoSqlite)) throw new Error(`Arquivo SQLite não encontrado: ${arquivoSqlite}`);
  const origem = new DatabaseSync(arquivoSqlite, { readOnly: true });
  const temTabela = (n) => !!origem.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);

  const existentes = (await banco.um('SELECT COUNT(*)::int AS n FROM leads')).n;
  if (existentes > 0 && !forcar) throw new Error(`O PostgreSQL já tem ${existentes} lead(s). Nada foi copiado (use --forcar apenas se tiver certeza).`);


  const resumo = {};
  await banco.tx(async (t) => {
    const copiar = async (tabela) => {
      if (!temTabela(tabela)) { resumo[tabela] = 0; return; }
      const linhas = origem.prepare(`SELECT * FROM ${tabela}`).all();
      const cols = (await t.todos('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', [tabela])).map((r) => r.column_name);
      for (const l of linhas) {
        const usar = Object.keys(l).filter((c) => cols.includes(c));
        await t.exec(`INSERT INTO ${tabela} (${usar.join(',')}) VALUES (${usar.map(() => '?').join(',')})`, usar.map((c) => l[c]));
      }
      resumo[tabela] = linhas.length;
    };
    // Planos: substitui os de exemplo pelos do SQLite (mantendo os IDs usados pelos leads).
    if (temTabela('planos') && origem.prepare('SELECT COUNT(*) n FROM planos').get().n > 0) await t.exec('DELETE FROM planos');
    if (forcar) { await t.exec('DELETE FROM exclusoes'); await t.exec('DELETE FROM pagamentos'); await t.exec('DELETE FROM leads'); }
    await copiar('planos');
    await copiar('leads');
    await copiar('pagamentos');
    await copiar('exclusoes');
    if (temTabela('config')) {
      for (const c of origem.prepare('SELECT chave, valor FROM config').all()) {
        await t.exec('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor', [c.chave, c.valor]);
      }
    }
    // Os próximos cadastros continuam a numeração, sem repetir IDs.
    for (const tabela of ['leads', 'pagamentos', 'planos', 'exclusoes']) {
      await t.exec(`SELECT setval(pg_get_serial_sequence('${tabela}', 'id'), COALESCE((SELECT MAX(id) FROM ${tabela}), 1), (SELECT MAX(id) FROM ${tabela}) IS NOT NULL)`);
    }
  });
  origem.close();
  for (const [tabela, n] of Object.entries(resumo)) log(`${tabela}: ${n} registro(s) copiado(s)`);
  return resumo;
}

module.exports = { migrar };

if (require.main === module) {
  const args = process.argv.slice(2);
  const arquivo = args.find((a) => !a.startsWith('--')) || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'simulador.db');
  if (!process.env.DATABASE_URL) { console.error('Defina DATABASE_URL com a URL do PostgreSQL de destino.'); process.exit(1); }
  migrar(arquivo, { forcar: args.includes('--forcar'), log: console.log })
    .then(async () => { console.log('Migração concluída. O arquivo SQLite não foi alterado.'); await require('../lib/db').fechar(); })
    .catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
}
