'use strict';
// Utilidades da conexão com o PostgreSQL, compartilhadas pelo servidor e pelas ferramentas (npm run db:verificar / db:criar).

const paraPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }; // "?" -> $1, $2…

// Lê host/banco/usuário da URL. O parâmetro sslmode é retirado antes para o pg não emitir o aviso de segurança sobre ele.
function analisar(url) {
  try { return require('pg-connection-string').parse(String(url).replace(/([?&])sslmode=[^&]*&?/i, '$1').replace(/[?&]$/, '')); } catch { return null; }
}

// SSL: bancos públicos (Neon, Supabase…) sempre criptografados e verificados; local/rede interna sem SSL.
// DATABASE_SSL=off|on|insecure força um modo.
function sslDe(url, modoForcado = process.env.DATABASE_SSL) {
  const modo = String(modoForcado || '').toLowerCase();
  if (modo === 'off') return false;
  if (modo === 'insecure') return { rejectUnauthorized: false };
  if (modo === 'on') return { rejectUnauthorized: true };
  if (/sslmode=disable/i.test(url)) return false;
  const host = (analisar(url)?.host || '').toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || !host.includes('.')) return false;
  return { rejectUnauthorized: true };
}

// A URL do Neon vem com ?sslmode=require&channel_binding=require. O SSL é decidido por sslDe; sslmode sai da URL.
const semSslmode = (url) => url.replace(/([?&])sslmode=[^&]*&?/i, '$1').replace(/[?&]$/, '');

// Dados para mostrar na tela SEM a senha.
function descrever(url) {
  const c = analisar(url) || {};
  return { host: c.host || '(não identificado)', porta: Number(c.port) || 5432, banco: c.database || '(não identificado)', usuario: c.user || '(não identificado)' };
}

// Remove a senha (e a URL inteira) de qualquer texto antes de mostrar.
function redigir(texto, url) {
  let t = String(texto ?? '');
  const c = analisar(url);
  if (url) t = t.split(url).join('[URL]');
  if (c?.password) t = t.split(c.password).join('***');
  return t;
}

// Explica em português o erro de conexão mais comum.
function diagnosticar(erro) {
  const m = `${erro?.code || ''} ${erro?.message || ''}`;
  const regras = [
    [/password authentication failed|28P01/i, 'Usuário ou senha incorretos na URL. No Neon: Roles → Reset password, copie a nova URL e atualize a variável DATABASE_URL.'],
    [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'O endereço (host) da URL não foi encontrado. Copie a URL de novo em Neon → Connection Details.'],
    [/ECONNREFUSED/i, 'A conexão foi recusada: confira o host e a porta da URL.'],
    [/database ".*" does not exist|3D000/i, 'O nome do banco na URL não existe. No Neon o padrão é neondb.'],
    [/permission denied for schema|42501/i, 'O usuário não tem permissão para criar tabelas no esquema public. Use o usuário dono do banco (no Neon, neondb_owner).'],
    [/self.signed|certificate|UNABLE_TO_VERIFY|SSL/i, 'Problema de SSL/certificado. Mantenha ?sslmode=require na URL. Só como último recurso defina DATABASE_SSL=insecure.'],
    [/no pg_hba|SSL (connection )?(is )?required|insecure connection/i, 'O banco exige conexão segura (SSL). Use a URL com ?sslmode=require.'],
    [/timeout|ETIMEDOUT|terminated|ECONNRESET/i, 'Tempo esgotado. Bancos serverless (Neon) "dormem" quando ficam parados: tente de novo em alguns segundos. Se persistir, confira a URL e a rede.'],
  ];
  for (const [re, texto] of regras) if (re.test(m)) return texto;
  return 'Erro inesperado ao conectar. Veja a mensagem abaixo.';
}

module.exports = { paraPg, sslDe, semSslmode, descrever, redigir, diagnosticar };
