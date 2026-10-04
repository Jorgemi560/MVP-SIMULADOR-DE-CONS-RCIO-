'use strict';
// Camada de banco de dados: PostgreSQL.
//  - Produção: PostgreSQL EXTERNO via DATABASE_URL (Neon, Supabase, Render Postgres, etc.). Os dados não dependem de
//    nenhum disco do servidor: um novo deploy ou reinício do Render não apaga nada.
//  - Desenvolvimento/testes (sem DATABASE_URL e fora de produção): PGlite, um PostgreSQL embutido (devDependency),
//    em memória ou numa pasta (PGLITE_DIR). Mesmo SQL do PostgreSQL de verdade.
// Os comandos usam "?" como marcador; a camada converte para $1, $2… do PostgreSQL.

const { paraPg, sslDe, semSslmode, descrever } = require('./conexao');
const { aplicar } = require('./esquema');

const URL_BANCO = process.env.DATABASE_URL || '';
const IS_PROD = process.env.NODE_ENV === 'production';

function aEspera(ms) { return new Promise((r) => setTimeout(r, ms)); }
const limpa = (params) => params.map((p) => (p === undefined ? null : p));

// ---------- drivers ----------
function driverPg() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: semSslmode(URL_BANCO),
    ssl: sslDe(URL_BANCO),
    max: Number(process.env.DB_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  // Bancos serverless encerram conexões ociosas: sem este tratador o erro derrubaria o processo.
  pool.on('error', (e) => console.error('Conexão ociosa com o banco encerrada:', e.message));
  const transitorio = (e) => /terminated|ECONNRESET|EPIPE|timeout|57P01|08006|08003/i.test(`${e.code} ${e.message}`);
  return {
    nome: 'pg',
    async query(sql, params) {
      for (let t = 0; ; t++) {
        try { return await pool.query(paraPg(sql), limpa(params)); }
        catch (e) { if (t >= 1 || !transitorio(e)) throw e; await aEspera(300); } // 1 nova tentativa se a conexão caiu
      }
    },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn({ query: (sql, params) => c.query(paraPg(sql), limpa(params)) });
        await c.query('COMMIT');
        return r;
      } catch (e) { try { await c.query('ROLLBACK'); } catch { /* conexão já perdida */ } throw e; }
      finally { c.release(); }
    },
    fechar: () => pool.end(),
  };
}

function driverPglite() {
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); }
  catch { throw new Error('Defina DATABASE_URL (PostgreSQL). Para desenvolvimento local sem Postgres, rode "npm install" (inclui o PGlite).'); }
  const dir = process.env.PGLITE_DIR || undefined; // sem pasta = em memória
  const pg = new PGlite(dir);
  const norm = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  return {
    nome: 'pglite',
    query: async (sql, params) => norm(await pg.query(paraPg(sql), limpa(params))),
    tx: (fn) => pg.transaction((t) => fn({ query: async (sql, params) => norm(await t.query(paraPg(sql), limpa(params))) })),
    fechar: () => pg.close(),
    emMemoria: !dir,
  };
}

function escolherDriver() {
  if (URL_BANCO) return driverPg();
  if (IS_PROD && process.env.DB_DRIVER !== 'pglite') {
    throw new Error('DATABASE_URL é obrigatória em produção: informe a URL do PostgreSQL externo (veja DEPLOY.md).');
  }
  return driverPglite();
}

const driver = escolherDriver();

// ---------- interface ----------
const todos = async (sql, params = []) => (await driver.query(sql, params)).rows;
const um = async (sql, params = []) => (await driver.query(sql, params)).rows[0];
const exec = async (sql, params = []) => (await driver.query(sql, params)).rowCount;
const tx = (fn) => driver.tx(async (t) => fn({
  todos: async (sql, params = []) => (await t.query(sql, params)).rows,
  um: async (sql, params = []) => (await t.query(sql, params)).rows[0],
  exec: async (sql, params = []) => (await t.query(sql, params)).rowCount,
}));

// ---------- esquema (idempotente: pode rodar a cada inicialização; definição em lib/esquema.js) ----------
async function criarEsquema() {
  await tx(async (t) => {
    await t.exec('SELECT pg_advisory_xact_lock(7351042)'); // evita corrida se duas instâncias iniciarem juntas
    await aplicar(t);
  });
}

// Inicialização com novas tentativas (o banco pode demorar a "acordar", como no Neon).
async function iniciar() {
  let ultimo;
  for (let t = 1; t <= 6; t++) {
    try { await criarEsquema(); return; }
    catch (e) { ultimo = e; console.error(`Banco indisponível (tentativa ${t}/6): ${e.message}`); await aEspera(2500); }
  }
  throw ultimo;
}
const pronto = iniciar();
pronto.catch(() => { /* o erro é tratado em quem aguarda (servidor/inicialização) */ });

const getConfig = async () => Object.fromEntries((await todos('SELECT chave, valor FROM config')).map((r) => [r.chave, r.valor]));
const setConfig = (k, v) => exec('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor', [k, v]);

// Onde os dados ficam (para o aviso do painel). Nunca devolve a URL nem a senha.
function persistencia() {
  if (driver.nome === 'pg') {
    return { persistente: true, tipo: 'PostgreSQL', host: descrever(URL_BANCO).host };
  }
  return { persistente: !driver.emMemoria, tipo: 'PGlite (desenvolvimento)', motivo: driver.emMemoria ? 'banco local em memória (somente testes/desenvolvimento)' : null };
}

module.exports = { pronto, todos, um, exec, tx, getConfig, setConfig, persistencia, fechar: () => driver.fechar() };
