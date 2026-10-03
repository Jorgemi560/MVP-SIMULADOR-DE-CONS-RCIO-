'use strict';
// Ferramentas do banco: db/schema.sql, npm run db:verificar / db:criar e utilidades de conexão (Neon).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { sslDe, semSslmode, descrever, redigir, diagnosticar, paraPg } = require('../lib/conexao');
const { TABELAS } = require('../lib/esquema');
const { gerarSql, ARQUIVO } = require('../scripts/gerar-schema-sql');
const { inspecionar, imprimir, principal } = require('../scripts/db');

const NEON = 'postgresql://neondb_owner:Sen%40ha-FICT1CIA@ep-cool-darkness-123456-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const consultar = (pg) => async (sql, p = []) => (await pg.query(paraPg(sql), p)).rows;

test('URL no formato do Neon: SSL verificado, sslmode retirado, senha nunca exibida', () => {
  assert.deepEqual(sslDe(NEON, ''), { rejectUnauthorized: true });
  assert.equal(semSslmode(NEON), 'postgresql://neondb_owner:Sen%40ha-FICT1CIA@ep-cool-darkness-123456-pooler.sa-east-1.aws.neon.tech/neondb?channel_binding=require');
  const d = descrever(NEON);
  assert.deepEqual(d, { host: 'ep-cool-darkness-123456-pooler.sa-east-1.aws.neon.tech', porta: 5432, banco: 'neondb', usuario: 'neondb_owner' });
  assert.ok(!JSON.stringify(d).includes('FICT1CIA'));
  const t = redigir(`falha em ${NEON} senha Sen@ha-FICT1CIA`, NEON);
  assert.ok(!t.includes('FICT1CIA') && !t.includes('neondb_owner:'));
});

test('SSL: local e rede interna sem SSL; modos forçados; sslmode=disable', () => {
  assert.equal(sslDe('postgres://u:p@localhost:5432/db', ''), false);
  assert.equal(sslDe('postgres://u:p@127.0.0.1/db', ''), false);
  assert.equal(sslDe('postgres://u:p@dpg-abc123-a/db', ''), false);           // host interno do Render (sem ponto)
  assert.equal(sslDe('postgres://u:p@host.exemplo.com/db?sslmode=disable', ''), false);
  assert.equal(sslDe(NEON, 'off'), false);
  assert.deepEqual(sslDe(NEON, 'insecure'), { rejectUnauthorized: false });
  assert.deepEqual(sslDe('postgres://u:p@localhost/db', 'on'), { rejectUnauthorized: true });
});

test('diagnóstico em português para os erros mais comuns', () => {
  const casos = [
    [{ message: 'password authentication failed for user "neondb_owner"' }, /senha incorretos/],
    [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND ep-x.neon.tech' }, /não foi encontrado/],
    [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, /recusada/],
    [{ message: 'database "abc" does not exist' }, /nome do banco/],
    [{ message: 'permission denied for schema public' }, /neondb_owner/],
    [{ message: 'self-signed certificate in certificate chain' }, /SSL/],
    [{ message: 'Connection terminated due to connection timeout' }, /dormem|Tempo esgotado/],
  ];
  for (const [erro, re] of casos) assert.match(diagnosticar(erro), re);
});

test('db/schema.sql está em dia com lib/esquema.js e é seguro (só cria o que não existe)', () => {
  const arquivo = fs.readFileSync(ARQUIVO, 'utf8');
  assert.equal(arquivo, gerarSql(), 'db/schema.sql está desatualizado: rode "npm run db:schema"');
  assert.ok(!/\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i.test(arquivo), 'o SQL não pode conter comandos destrutivos');
  assert.ok(!/CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/.test(arquivo), 'todo CREATE precisa de IF NOT EXISTS');
});

test('db/schema.sql cria as 5 tabelas num banco vazio, é repetível e não mexe em dados existentes', async () => {
  const sql = fs.readFileSync(ARQUIVO, 'utf8');
  const pg = new PGlite();
  const q = consultar(pg);
  let info = await inspecionar(q);
  assert.deepEqual(info.faltando, TABELAS);                                    // banco vazio, como o seu neondb
  assert.equal(info.pode_criar, true);

  await pg.exec(sql);
  info = await inspecionar(q);
  assert.deepEqual(info.faltando, []);
  assert.equal(info.tabelas.find((t) => t.nome === 'planos').linhas, 4);
  assert.equal(info.tabelas.find((t) => t.nome === 'config').linhas, 2);

  await pg.query("INSERT INTO leads (token,nome,email,telefone) VALUES ('t','Lead existente','a@a.com','41')");
  await pg.query("UPDATE planos SET nome = 'Meu plano editado' WHERE id = 1");
  await pg.query("UPDATE config SET valor = '41999990000' WHERE chave = 'whatsapp'");
  await pg.exec(sql);                                                           // segunda execução
  info = await inspecionar(q);
  assert.equal(info.tabelas.find((t) => t.nome === 'leads').linhas, 1);
  assert.equal(info.tabelas.find((t) => t.nome === 'planos').linhas, 4);       // não duplicou
  assert.equal((await q('SELECT nome FROM planos WHERE id = 1'))[0].nome, 'Meu plano editado');
  assert.equal((await q("SELECT valor FROM config WHERE chave = 'whatsapp'"))[0].valor, '41999990000');
  const saida = []; imprimir(info, (l) => saida.push(l));
  assert.ok(saida.some((l) => /✔ leads\s+1 linha/.test(l)));
  await pg.close();
});

test('npm run db:verificar / criar: sem DATABASE_URL explica; conexão que falha dá diagnóstico sem vazar a senha', async () => {
  const saida = [];
  const log = (l) => saida.push(l);
  assert.equal(await principal(['verificar'], {}, log), 2);
  assert.match(saida.join('\n'), /DATABASE_URL não está definida/);
  assert.equal(await principal(['abc'], {}, log), 1);

  saida.length = 0;
  const url = 'postgresql://neondb_owner:SEGREDO-NAO-VAZAR@127.0.0.1:1/neondb?sslmode=require';
  assert.equal(await principal(['verificar'], { DATABASE_URL: url }, log), 2);
  const texto = saida.join('\n');
  assert.match(texto, /Falha na conexão/);
  assert.match(texto, /recusada/);
  assert.ok(!texto.includes('SEGREDO-NAO-VAZAR'));
  saida.length = 0;
  assert.equal(await principal(['criar'], { DATABASE_URL: url }, log), 2);
  assert.ok(!saida.join('\n').includes('SEGREDO-NAO-VAZAR'));
});
