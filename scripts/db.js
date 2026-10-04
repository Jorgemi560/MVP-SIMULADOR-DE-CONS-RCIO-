#!/usr/bin/env node
'use strict';
// Ferramentas do banco PostgreSQL (Neon etc.). Usam a variável DATABASE_URL e NUNCA mostram a senha.
//
//   DATABASE_URL="postgresql://..." npm run db:verificar   -> testa a conexão e lista as tabelas (não altera nada)
//   DATABASE_URL="postgresql://..." npm run db:criar       -> cria as tabelas que faltam (não apaga nem altera dados)
//
// No Render: abra o serviço -> Shell e rode "npm run db:verificar" (a DATABASE_URL já está lá).
const { TABELAS, aplicar } = require('../lib/esquema');
const { paraPg, sslDe, semSslmode, descrever, redigir, diagnosticar } = require('../lib/conexao');

// q(sql, params) -> linhas. Só leitura.
async function inspecionar(q) {
  const [meta] = await q(`SELECT current_database() AS banco, current_schema() AS esquema, current_user AS usuario, version() AS versao,
    has_schema_privilege(current_user, current_schema(), 'CREATE') AS pode_criar`);
  const existentes = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1")).map((r) => r.table_name);
  const tabelas = [];
  for (const nome of TABELAS) {
    if (existentes.includes(nome)) tabelas.push({ nome, linhas: (await q(`SELECT count(*)::int AS n FROM ${nome}`))[0].n }); // nome vem da lista fixa
  }
  return {
    ...meta,
    tabelas,
    faltando: TABELAS.filter((n) => !existentes.includes(n)),
    outras: existentes.filter((n) => !TABELAS.includes(n)),
  };
}

function imprimir(info, log = console.log) {
  log(`Banco: ${info.banco} · esquema: ${info.esquema} · usuário: ${info.usuario}`);
  log(`Servidor: ${String(info.versao).split(',')[0]}`);
  log(`Permissão para criar tabelas em "${info.esquema}": ${info.pode_criar ? 'sim' : 'NÃO'}`);
  log('Tabelas do simulador:');
  for (const n of TABELAS) {
    const t = info.tabelas.find((x) => x.nome === n);
    log(`  ${t ? '✔' : '✘'} ${n.padEnd(11)} ${t ? `${t.linhas} linha(s)` : 'NÃO EXISTE'}`);
  }
  if (info.outras.length) log(`Outras tabelas no esquema (não mexemos nelas): ${info.outras.join(', ')}`);
}

async function conectar(url) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: semSslmode(url), ssl: sslDe(url), connectionTimeoutMillis: 20000 });
  const t0 = Date.now();
  await client.connect();
  return { client, ms: Date.now() - t0, q: async (sql, p = []) => (await client.query(sql, p)).rows };
}

async function principal(args, env = process.env, log = console.log) {
  const comando = args[0];
  if (!['verificar', 'criar'].includes(comando)) { log('Uso: npm run db:verificar  |  npm run db:criar'); return 1; }
  const url = env.DATABASE_URL;
  if (!url) {
    log('DATABASE_URL não está definida.\nDefina com a URL do seu banco (Neon: Connection Details → Connection string), por exemplo:\n  DATABASE_URL="postgresql://usuario:senha@host/neondb?sslmode=require" npm run db:' + comando);
    return 2;
  }
  const d = descrever(url);
  log(`Conectando a ${d.host}:${d.porta}, banco ${d.banco}, usuário ${d.usuario} (a senha não é exibida)…`);
  let conexao;
  try { conexao = await conectar(url); }
  catch (e) { log(`✘ Falha na conexão: ${diagnosticar(e)}\n  Detalhe técnico: ${redigir(e.message, url)}`); return 2; }
  const { client, q, ms } = conexao;
  try {
    log(`✔ Conexão OK (${ms} ms)`);
    let info = await inspecionar(q);
    imprimir(info, log);
    if (comando === 'verificar') {
      if (info.faltando.length) { log(`\nFaltam ${info.faltando.length} tabela(s). Rode "npm run db:criar" (ou faça o deploy do site com a DATABASE_URL definida: ele cria sozinho).`); return 1; }
      log('\n✔ Estrutura completa.'); return 0;
    }
    // criar
    if (!info.pode_criar) { log(`\n✘ O usuário "${info.usuario}" não pode criar tabelas em "${info.esquema}". Use o usuário dono do banco (no Neon, neondb_owner).`); return 2; }
    const total = info.tabelas.reduce((s, t) => s + t.linhas, 0);
    log(`\nCriando o que falta (nada será apagado${total ? `; já existem ${total} linha(s) de dados, que serão mantidas` : ''})…`);
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7351042)');
      await aplicar({ exec: (sql, p) => client.query(paraPg(sql), p), um: async (sql, p) => (await client.query(paraPg(sql), p)).rows[0] });
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignora */ }
      log(`✘ Não foi possível criar: ${diagnosticar(e)}\n  Detalhe técnico: ${redigir(e.message, url)}\n  Nada foi alterado.`); return 2;
    }
    info = await inspecionar(q);
    log('\nDepois:'); imprimir(info, log);
    if (info.faltando.length) { log('\n✘ Ainda faltam tabelas.'); return 1; }
    log('\n✔ Estrutura pronta. O site pode usar este banco.'); return 0;
  } finally { await client.end().catch(() => {}); }
}

module.exports = { inspecionar, imprimir, principal };

if (require.main === module) {
  principal(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error('Erro inesperado:', redigir(e.message, process.env.DATABASE_URL)); process.exit(2); });
}
