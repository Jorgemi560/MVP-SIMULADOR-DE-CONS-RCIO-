'use strict';
// Camada de banco de dados: PostgreSQL.
//  - Produção: PostgreSQL EXTERNO via DATABASE_URL (Neon, Supabase, Render Postgres, etc.). Os dados não dependem de
//    nenhum disco do servidor: um novo deploy ou reinício do Render não apaga nada.
//  - Desenvolvimento/testes (sem DATABASE_URL e fora de produção): PGlite, um PostgreSQL embutido (devDependency),
//    em memória ou numa pasta (PGLITE_DIR). Mesmo SQL do PostgreSQL de verdade.
// Os comandos usam "?" como marcador; a camada converte para $1, $2… do PostgreSQL.

const URL_BANCO = process.env.DATABASE_URL || '';
const IS_PROD = process.env.NODE_ENV === 'production';

function aEspera(ms) { return new Promise((r) => setTimeout(r, ms)); }
const paraPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const limpa = (params) => params.map((p) => (p === undefined ? null : p));

// ---------- drivers ----------
function sslDe(url) {
  const modo = (process.env.DATABASE_SSL || '').toLowerCase(); // off | on | insecure
  if (modo === 'off') return false;
  if (modo === 'insecure') return { rejectUnauthorized: false };
  if (modo === 'on') return { rejectUnauthorized: true };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* a senha pode ter caracteres especiais: o pg trata */ }
  if (/sslmode=disable/i.test(url)) return false;
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || !host.includes('.')) return false; // local ou rede interna
  return { rejectUnauthorized: true }; // bancos públicos (Neon, Supabase…): conexão criptografada e verificada
}

function driverPg() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: URL_BANCO.replace(/([?&])sslmode=[^&]*&?/i, '$1').replace(/[?&]$/, ''),
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

// ---------- esquema (idempotente: pode rodar a cada inicialização) ----------
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
    pago_em TIMESTAMPTZ
  )`,
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

async function criarEsquema() {
  await tx(async (t) => {
    await t.exec('SELECT pg_advisory_xact_lock(7351042)'); // evita corrida se duas instâncias iniciarem juntas
    for (const ddl of ESQUEMA) await t.exec(ddl);
    if ((await t.um('SELECT COUNT(*)::int AS n FROM planos')).n === 0) {
      for (const p of PLANOS_INICIAIS) {
        await t.exec(`INSERT INTO planos (nome,tipo,prazo,taxa_admin,fundo_reserva,seguro,indice,reduzida,reducao_pct,reducao_regra,regra_texto,credito_min,credito_max,arredondamento)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, p);
      }
    }
    for (const [k, v] of Object.entries({ whatsapp: '', learn_url: '' })) {
      await t.exec('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO NOTHING', [k, v]);
    }
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
    let host = '';
    try { host = new URL(URL_BANCO).hostname; } catch { /* ignora */ }
    return { persistente: true, tipo: 'PostgreSQL', host };
  }
  return { persistente: !driver.emMemoria, tipo: 'PGlite (desenvolvimento)', motivo: driver.emMemoria ? 'banco local em memória (somente testes/desenvolvimento)' : null };
}

module.exports = { pronto, todos, um, exec, tx, getConfig, setConfig, persistencia, fechar: () => driver.fechar() };
