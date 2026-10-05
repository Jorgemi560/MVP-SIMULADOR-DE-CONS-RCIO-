'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

try { process.loadEnvFile?.(path.join(__dirname, '.env')); } catch { /* .env é opcional */ }

const { pronto: bancoPronto, todos, um, exec, tx, getConfig, setConfig, persistencia } = require('./lib/db');
const { provider, codigoPix, contaPix, chavePixProblema, validadeMinutos, assinaturaMpValida, mpInfo, dicaParaErro, limpar } = require('./lib/payment');
const { relatorioSimulacao } = require('./lib/pdf');
const { calcular, escolherPlano, ARREDONDAMENTOS } = require('./lib/calc');
const V = require('./lib/validate');

const PORT = Number(process.env.PORT) || 3000;
// Valor da simulação em CENTAVOS (500 = R$ 5,00). Valor inválido impede a inicialização: nunca cobramos um valor errado.
const PRICE_CENTS = process.env.PRICE_CENTS ? Number(process.env.PRICE_CENTS) : 500;
if (!Number.isInteger(PRICE_CENTS) || PRICE_CENTS < 100 || PRICE_CENTS > 100000) {
  throw new Error(`PRICE_CENTS inválido (${process.env.PRICE_CENTS}): informe o valor em centavos, de 100 a 100000 (R$ 5,00 = 500).`);
}
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PROD ? '' : 'admin123');
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD é obrigatória em produção');
if (!process.env.ADMIN_PASSWORD) console.warn('⚠ ADMIN_PASSWORD não definida: usando "admin123" (somente desenvolvimento).');
const SENHA_FRACA = IS_PROD && ADMIN_PASSWORD.length < 10;
if (SENHA_FRACA) console.warn('⚠ ADMIN_PASSWORD tem menos de 10 caracteres: use uma senha mais forte.');
const PERSISTENCIA = persistencia();
console.log(`Banco de dados: ${PERSISTENCIA.tipo}${PERSISTENCIA.host ? ` (${PERSISTENCIA.host})` : ''}`);
if (!PERSISTENCIA.persistente && IS_PROD) console.warn('⚠ Banco de dados local, sem persistência: os leads seriam perdidos. Defina DATABASE_URL.');
const ADMIN_SECRET = crypto.createHash('sha256').update(`adm:${ADMIN_PASSWORD}`).digest();

// A simulação só é liberada com pagamento CONFIRMADO ('pago'). 'informado' (cliente avisou que pagou)
// apenas sinaliza ao administrador que há um recebimento a conferir: nunca libera sozinho.
const pagamentoLiberado = (status) => status === 'pago';

const TIPOS = ['imovel', 'veiculo', 'outros'];
const TIPO_LABEL = { imovel: 'imóvel', veiculo: 'veículo', outros: 'outros bens' };
const MOTIVOS_EXCLUSAO = ['solicitacao_titular', 'cadastro_duplicado_ou_teste', 'outro'];
const INTERESSES = ['agora', 'conversar', 'depois'];
const STATUS_LEAD = ['aguardando_pagamento', 'novo', 'contatado', 'convertido', 'perdido'];
const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------- util ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

// Atrás de um proxy/CDN (Render, Railway, Cloudflare…) todas as conexões chegam do IP do proxy.
// TRUST_PROXY_HOPS=1 (nº de proxies confiáveis) usa o IP do cliente informado em X-Forwarded-For.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS) || 0;
function clientIp(req) {
  if (TRUST_PROXY_HOPS > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[Math.max(0, xff.length - TRUST_PROXY_HOPS)];
  }
  return req.socket.remoteAddress || '?';
}

const hits = new Map();
function limit(req, key, max, windowMs) {
  const ip = clientIp(req);
  const k = `${key}:${ip}`, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, 'Muitas tentativas. Aguarde um instante.');
  arr.push(now); hits.set(k, arr);
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 600000)) hits.delete(k); }, 300000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 50_000) { reject(new HttpError(413, 'Requisição grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- admin auth (token assinado, 12h) ----------
function signAdmin() {
  const exp = Date.now() + 12 * 3600e3;
  return `${exp}.${crypto.createHmac('sha256', ADMIN_SECRET).update(String(exp)).digest('hex')}`;
}
function checkAdmin(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const [exp, sig] = t.split('.');
  const ok = exp && sig && Number(exp) > Date.now() &&
    safeEq(sig, crypto.createHmac('sha256', ADMIN_SECRET).update(exp).digest('hex'));
  if (!ok) throw new HttpError(401, 'Não autorizado');
}

// ---------- leads / pagamento ----------
async function leadAutenticado(req, id) {
  const lead = Number.isInteger(Number(id)) ? await um('SELECT * FROM leads WHERE id = ?', [Number(id)]) : null;
  const tok = req.headers['x-lead-token'] || '';
  if (!lead || lead.excluido_em || !safeEq(tok, lead.token)) throw new HttpError(404, 'Simulação não encontrada');
  return lead;
}
// ---- Validade do Pix ----
// Cada cobrança vale VALIDADE_MIN minutos (coluna expira_em). Vencida e sem pagamento, vira 'expirado': o cliente gera um
// novo Pix (nova tentativa) e o histórico das anteriores é mantido. Cobranças antigas, criadas antes desta coluna
// (expira_em nulo), contam a validade a partir de criado_em. Só 'pendente' vence: 'informado' e 'pago' nunca expiram.
const VALIDADE_MIN = validadeMinutos();
// Pix estático: o sistema não vê o banco, então um "já paguei" não pode ser descartado na hora. Enquanto a conferência é recente,
// "Gerar novo Pix" é recusado (risco de cobrança dupla); passado este prazo o cliente deixa de ficar preso: a tentativa
// antiga vira "expirado" (continua confirmável pelo txid) e uma nova é criada.
const CONFERENCIA_MIN = (() => { const n = Number(process.env.PIX_CONFERENCIA_MINUTOS); return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : 15; })();
const MAX_TENTATIVAS = 10; // limite de cobranças por cliente (evita abuso/geração infinita)
const VENCE_EM = (a) => `COALESCE(${a}.expira_em, ${a}.criado_em + interval '${VALIDADE_MIN} minutes')`;
// Situação "efetiva" no SQL: 'pendente' vencida aparece como 'expirado' mesmo antes de ser gravada.
const STATUS_EF = (a) => `CASE WHEN ${a}.status = 'pendente' AND ${VENCE_EM(a)} < now() THEN 'expirado' ELSE ${a}.status END`;
// Qual tentativa vale para o cliente: a paga; senão a informada (aguardando conferência); senão a mais recente.
const ORDEM_ATUAL = "ORDER BY (status = 'pago') DESC, (status = 'informado') DESC, id DESC LIMIT 1";

async function marcarPago(pagamentoId) {
  const pg = await um('SELECT * FROM pagamentos WHERE id = ?', [pagamentoId]);
  if (!pg || pg.status === 'pago') return;
  await tx(async (t) => {
    await t.exec("UPDATE pagamentos SET status='pago', pago_em=now() WHERE id=? AND status <> 'pago'", [pg.id]);
    // Outra cobrança em aberto do mesmo cliente deixa de ser necessária (a confirmada nunca é alterada).
    await t.exec("UPDATE pagamentos SET status='cancelado' WHERE lead_id=? AND id<>? AND status='pendente'", [pg.lead_id, pg.id]);
    await t.exec("UPDATE leads SET status='novo' WHERE id=? AND status='aguardando_pagamento'", [pg.lead_id]);
  });
}

// Consulta o provedor (quando há API), confirma se pagou e grava a expiração. Devolve a tentativa atualizada.
// Mesmo vencida, ainda perguntamos ao provedor: um pagamento feito no último segundo não pode ser perdido.
const consultasEmVoo = new Map(); // várias consultas simultâneas da mesma cobrança dividem uma só chamada ao provedor
const esperadoDe = (pg) => ({ pagamentoId: pg.id, valorCentavos: pg.valor_centavos });
function consultarProvedor(pg) {
  if (!consultasEmVoo.has(pg.id)) consultasEmVoo.set(pg.id, provider.consultar(pg.provedor_id, esperadoDe(pg)).finally(() => consultasEmVoo.delete(pg.id)));
  return consultasEmVoo.get(pg.id);
}
async function sincronizarPagamento(pg) {
  if (['pendente', 'expirado'].includes(pg.status) && pg.provedor === provider.nome && pg.provedor_id && !['mock', 'pix'].includes(provider.nome)) {
    try {
      const novo = await consultarProvedor(pg);
      if (novo === 'pago') await marcarPago(pg.id);
      else if (novo !== 'pendente' && pg.status === 'pendente') await exec("UPDATE pagamentos SET status=? WHERE id=? AND status='pendente'", [novo, pg.id]);
    } catch (e) { console.error('Falha ao consultar o provedor de pagamento:', e.message); } // segue com o que já sabemos
  }
  await exec(`UPDATE pagamentos p SET status = 'expirado' WHERE p.id = ? AND p.status = 'pendente' AND ${VENCE_EM('p')} < now()`, [pg.id]);
  // 'informado' gravado antes da coluna informado_em existir: conta a conferência a partir da criação (nunca fica sem prazo).
  await exec("UPDATE pagamentos SET informado_em = criado_em WHERE id = ? AND status = 'informado' AND informado_em IS NULL", [pg.id]);
  return um('SELECT * FROM pagamentos WHERE id = ?', [pg.id]);
}

async function pagamentoAtual(leadId) {
  const pg = await um(`SELECT * FROM pagamentos WHERE lead_id = ? ${ORDEM_ATUAL}`, [leadId]);
  return pg ? sincronizarPagamento(pg) : null;
}

// Cria a cobrança no provedor para uma tentativa já registrada. Se falhar, a tentativa é cancelada
// (libera nova tentativa) e o cliente recebe um erro claro.
let ultimoErroPagamento = null; // último erro ao criar cobrança (em memória; só para o /admin)
async function iniciarCobranca(pg, { email, nome }) {
  try {
    const r = await provider.criar({ pagamentoId: pg.id, valorCentavos: pg.valor_centavos, email, nome, expiraEm: pg.expira_em });
    await exec('UPDATE pagamentos SET provedor_id=?, pix_codigo=? WHERE id=?', [r.provedorId, r.pix?.copiaECola ?? null, pg.id]);
    console.log(`[pagamento] cobrança criada id=${pg.id} provedor=${provider.nome} provedor_id=${r.provedorId}`);
    return r;
  } catch (e) {
    // Diagnóstico seguro: sem token, e-mail, nome ou telefone. A mesma informação aparece no /admin (nunca para o cliente).
    const diag = { quando: new Date().toISOString(), pagamento: pg.id, provedor: provider.nome, http: e.http ?? null, codigo: e.codigo || e.code || null,
      mensagem: limpar(e.mensagemMp || e.message), causas: e.causas || [], requestId: e.requestId || null, dica: e.http !== undefined ? dicaParaErro(e) : 'Falha interna ao registrar a cobrança (veja o log do servidor).' };
    ultimoErroPagamento = diag;
    console.error(`[pagamento] FALHA ao criar cobrança id=${diag.pagamento} provedor=${diag.provedor} http=${diag.http} codigo=${diag.codigo} msg="${diag.mensagem}" causas=${JSON.stringify(diag.causas)} req=${diag.requestId} dica="${diag.dica}"`);
    await exec("UPDATE pagamentos SET status='cancelado' WHERE id=?", [pg.id]);
    throw new HttpError(502, `Não foi possível iniciar o pagamento agora. Tente novamente em instantes.${e.http !== undefined ? ` (código MP-${e.http || 'rede'})` : ''}`);
  }
}

// Código "copia e cola" de uma tentativa (o Pix estático é recalculado; o do provedor fica gravado).
const codigoDe = (pg) => pg.pix_codigo || (provider.nome === 'pix' ? codigoPix(pg.id, pg.valor_centavos) : null);
// Dados da tentativa para a tela do cliente. "agora" é o relógio do servidor (o do celular pode estar errado).
const publicoPagamento = (pg) => ({
  pagamento: pg.status, liberado: pagamentoLiberado(pg.status),
  expiraEm: pg.status === 'pendente' && pg.expira_em ? new Date(pg.expira_em).toISOString() : null,
  agora: new Date().toISOString(),
  informadoEm: pg.status === 'informado' && pg.informado_em ? new Date(pg.informado_em).toISOString() : null,
  // Em conferência o código não é mais exibido: evita um segundo pagamento por engano.
  pix: pg.status === 'pendente' && codigoDe(pg) ? { copiaECola: codigoDe(pg) } : null,
  podeRenovar: ['expirado', 'recusado', 'cancelado'].includes(pg.status),
  mock: provider.nome === 'mock',
});

// Número do especialista (destino do atendimento). Pode ser alterado em /admin → Configurações.
const ESPECIALISTA_PADRAO = V.digits(process.env.WHATSAPP_ESPECIALISTA) || '5541997446032';

async function whatsappEspecialista() {
  const configurado = V.digits((await getConfig()).whatsapp);
  const num = configurado || ESPECIALISTA_PADRAO;
  return { numero: num.startsWith('55') ? num : `55${num}`, origem: configurado ? 'configurado' : 'padrao' };
}

async function whatsappUrl(lead, texto) {
  const { numero } = await whatsappEspecialista();
  if (!numero) return null;
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

const fmtTel = (t) => { const d = V.digits(t); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d; };

function textoWhatsapp(lead) {
  const sim = lead.simulacao ? JSON.parse(lead.simulacao) : null;
  const linhas = ['Olá! Acabei de fazer minha simulação de consórcio e quero entender melhor as opções disponíveis.', '',
    `Nome: ${lead.nome}`,
    `Tipo: ${{ imovel: 'Imóvel', veiculo: 'Veículo', outros: 'Outros' }[lead.tipo] || lead.tipo}`,
    `Crédito escolhido: ${brl(lead.credito)}`,
    `Renda mensal: ${lead.renda_mensal ? brl(lead.renda_mensal) : 'não informada'}`];
  if (sim) {
    const reduzida = lead.parcela_escolhida === 'reduzida' && sim.parcelaReduzida;
    linhas.push(`Parcela: ${reduzida ? 'reduzida' : 'integral'}`, `Valor estimado da parcela: ${brl(reduzida ? sim.parcelaReduzida : sim.parcelaIntegral)}`);
  }
  linhas.push(`Meu telefone: ${fmtTel(lead.telefone)}`);
  return linhas.join('\n');
}

// ---------- rotas públicas ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/api/config', async () => ({
  precoCentavos: PRICE_CENTS,
  provedor: provider.nome,
}));

route('GET', '/api/plano-info', async (req, { url }) => {
  const tipo = url.searchParams.get('tipo'), credito = Number(url.searchParams.get('credito'));
  if (!TIPOS.includes(tipo) || !(credito > 0)) throw bad('Parâmetros inválidos');
  const planos = await todos('SELECT * FROM planos WHERE ativo = 1');
  const esc = escolherPlano(planos, tipo, credito);
  return { disponivel: !!esc, reduzida: !!esc?.calc.parcelaReduzida };
});

// Garante UMA cobrança válida para o cliente. Se já há uma aguardando, em conferência ou paga, devolve essa mesma
// (nunca cria outra); só gera nova quando a anterior venceu, foi recusada ou cancelada. Usada pelo "Gerar novo Pix"
// e pelo retorno do mesmo cliente (mesmo e-mail e telefone).
async function garantirCobranca(lead, { renovar = false } = {}) {
  const existente = async () => { const a = await pagamentoAtual(lead.id); return a && !['expirado', 'recusado', 'cancelado'].includes(a.status) ? a : null; };
  const reaproveita = (a) => ({ ...publicoPagamento(a), novo: false });
  let a = await existente();
  if (a && !(renovar && a.status === 'informado')) return reaproveita(a);
  if (a) { // "Gerar novo Pix" com um "já paguei" em conferência: só depois do prazo de segurança
    const faltaMs = new Date(a.informado_em).getTime() + CONFERENCIA_MIN * 60000 - Date.now();
    if (faltaMs > 0) {
      throw new HttpError(409, `Seu pagamento informado ainda está em conferência e gerar outro Pix agora poderia gerar cobrança em duplicidade. Aguarde a conferência ou tente novamente em ${Math.ceil(faltaMs / 60000)} min.`);
    }
  }
  // Só gera outro Pix quando não há risco de o anterior ainda ser pago. No Mercado Pago o vencimento é do próprio provedor:
  // confirmamos com ele. No Pix estático o banco não vence o código; o risco é mitigado porque o pagamento tardio
  // continua reconhecível pelo txid (webhook/admin) e a tela avisa para não pagar duas vezes.
  if (provider.nome === 'mercadopago') {
    const ult = await um('SELECT * FROM pagamentos WHERE lead_id = ? ORDER BY id DESC LIMIT 1', [lead.id]);
    if (ult?.status === 'expirado' && ult.provedor_id && provider.nome === ult.provedor) {
      let st = 'pendente';
      try { st = await provider.consultar(ult.provedor_id, esperadoDe(ult)); } catch { /* sem resposta: não arrisca */ }
      if (st === 'pago') { await marcarPago(ult.id); return reaproveita(await pagamentoAtual(lead.id)); }
      if (st === 'pendente') throw new HttpError(409, 'Ainda estamos confirmando o encerramento do Pix anterior. Tente novamente em instantes.');
    }
  }
  // Só contam as cobranças que chegaram a existir no provedor: falhas ao criar (provedor_id vazio) não gastam o limite do cliente.
  if ((await um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ? AND provedor_id IS NOT NULL', [lead.id])).n >= MAX_TENTATIVAS) {
    throw new HttpError(429, 'Muitas tentativas de pagamento neste cadastro. Fale com o nosso atendimento.');
  }
  let pg;
  try {
    pg = await tx(async (t) => {
      await t.um('SELECT id FROM leads WHERE id = ? FOR UPDATE', [lead.id]); // serializa cliques/abas simultâneos do mesmo cliente
      await t.exec(`UPDATE pagamentos p SET status = 'expirado' WHERE p.lead_id = ? AND p.status = 'pendente' AND ${VENCE_EM('p')} < now()`, [lead.id]);
      if (renovar) await t.exec(`UPDATE pagamentos SET status = 'expirado' WHERE lead_id = ? AND status = 'informado' AND informado_em <= now() - ?::int * interval '1 minute'`, [lead.id, CONFERENCIA_MIN]);
      const aberto = await t.um("SELECT id FROM pagamentos WHERE lead_id = ? AND status IN ('pendente','informado','pago')", [lead.id]);
      if (aberto) return null;
      return t.um("INSERT INTO pagamentos (lead_id, provedor, valor_centavos, expira_em) VALUES (?,?,?, now() + ?::int * interval '1 minute') RETURNING *", [lead.id, provider.nome, PRICE_CENTS, VALIDADE_MIN]);
    });
  } catch (e) {
    if (e.code !== '23505') throw e; // índice único: outra requisição criou a cobrança no mesmo instante
  }
  if (!pg) { a = await existente(); if (a) return reaproveita(a); throw new HttpError(409, 'Não foi possível gerar um novo Pix agora. Tente novamente.'); }
  const r = await iniciarCobranca(pg, { email: lead.email, nome: lead.nome });
  return { ...publicoPagamento({ ...pg, status: 'pendente' }), pix: r.pix, novo: true };
}

const MSG_INDISPONIVEL = 'Pagamento temporariamente indisponível. Tente novamente em alguns minutos.';

route('POST', '/api/checkout', async (req, { body }) => {
  limit(req, 'checkout', 10, 600000);
  console.log(`[checkout] requisição recebida (provedor=${provider.nome}, pronto=${provider.pronto()})`); // sem dados pessoais
  if (!provider.pronto()) throw new HttpError(503, MSG_INDISPONIVEL);
  const nome = String(body.nome ?? '').trim(), email = String(body.email ?? '').trim().toLowerCase(), telefone = V.digits(body.telefone);
  if (!V.textoValido(nome, 3)) throw bad('Informe seu nome completo.');
  if (!V.emailValido(email)) throw bad('E-mail inválido.');
  if (!V.telefoneValido(telefone)) throw bad('Telefone inválido. Informe DDD + número.');

  const token = crypto.randomBytes(24).toString('hex');
  const r0 = await tx(async (t) => {
    // Trava por e-mail: dois envios simultâneos do mesmo e-mail não criam dois cadastros.
    await t.exec('SELECT pg_advisory_xact_lock(hashtext(?))', [`checkout:${email}`]);
    // Cliente que volta (mesmo e-mail E mesmo telefone) retoma o cadastro e a cobrança que já existem. Exigir os dois dados e
    // trocar o token a cada retomada evita que alguém só com o e-mail de outra pessoa acesse o cadastro dela.
    const ja = await t.um('SELECT id FROM leads WHERE email = ? AND telefone = ? AND excluido_em IS NULL ORDER BY id DESC LIMIT 1', [email, telefone]);
    if (ja) { await t.exec('UPDATE leads SET token = ? WHERE id = ?', [token, ja.id]); return { leadId: ja.id, retomado: true }; }
    const l = await t.um('INSERT INTO leads (token, nome, email, telefone) VALUES (?,?,?,?) RETURNING id', [token, nome, email, telefone]);
    const pg = await t.um("INSERT INTO pagamentos (lead_id, provedor, valor_centavos, expira_em) VALUES (?,?,?, now() + ?::int * interval '1 minute') RETURNING *", [l.id, provider.nome, PRICE_CENTS, VALIDADE_MIN]);
    return { leadId: l.id, pg };
  });
  if (r0.retomado) {
    const lead = await um('SELECT * FROM leads WHERE id = ?', [r0.leadId]);
    return { leadId: lead.id, token, retomado: true, ...(await garantirCobranca(lead)) };
  }
  const r = await iniciarCobranca(r0.pg, { email, nome });
  return { leadId: r0.leadId, token, retomado: false, ...publicoPagamento({ ...r0.pg, status: 'pendente' }), pix: r.pix };
});

route('GET', '/api/lead/:id/estado', async (req, { params }) => {
  const lead = await leadAutenticado(req, params.id);
  const pg = await pagamentoAtual(lead.id);
  const n = (await um('SELECT COUNT(*)::int AS n FROM pagamentos WHERE lead_id = ?', [lead.id])).n;
  return {
    ...(pg ? publicoPagamento(pg) : { pagamento: 'pendente', liberado: false, expiraEm: null, agora: new Date().toISOString(), pix: null, podeRenovar: true, mock: provider.nome === 'mock' }),
    tentativas: n, nome: lead.nome, email: lead.email, telefone: lead.telefone, simulado: !!lead.simulacao,
  };
});

// Gera um NOVO Pix quando o anterior venceu (ou foi recusado/cancelado). Nunca cria cobrança se já houver uma
// aguardando pagamento, aguardando conferência ou paga: nesse caso devolve a que já existe (idempotente).
route('POST', '/api/lead/:id/novo-pix', async (req, { params }) => {
  limit(req, 'novo-pix', 10, 600000);
  const lead = await leadAutenticado(req, params.id);
  if (!provider.pronto()) throw new HttpError(503, MSG_INDISPONIVEL);
  return garantirCobranca(lead, { renovar: true });
});

route('POST', '/api/lead/:id/mock-pay', async (req, { params }) => {
  if (provider.nome !== 'mock') throw new HttpError(404, 'Não encontrado');
  const lead = await leadAutenticado(req, params.id);
  const pg = await pagamentoAtual(lead.id);
  if (!pg) throw new HttpError(404, 'Pagamento não encontrado');
  if (pg.status === 'expirado') throw new HttpError(409, 'Este Pix expirou. Gere um novo Pix.');
  await marcarPago(pg.id);
  return { pagamento: 'pago' };
});

route('POST', '/api/lead/:id/informar-pagamento', async (req, { params }) => {
  if (provider.nome !== 'pix') throw new HttpError(404, 'Não encontrado');
  limit(req, 'informar', 10, 600000);
  const lead = await leadAutenticado(req, params.id);
  const pg = await pagamentoAtual(lead.id);
  if (!pg) throw new HttpError(404, 'Pagamento não encontrado');
  if (pg.status === 'expirado') throw new HttpError(409, 'Este Pix expirou. Gere um novo Pix para pagar.');
  if (pg.status === 'pendente') {
    await exec("UPDATE pagamentos SET status='informado', informado_em=now() WHERE id=? AND status='pendente'", [pg.id]);
    await exec("UPDATE leads SET status='novo' WHERE id=? AND status='aguardando_pagamento'", [lead.id]);
  }
  return { pagamento: (await um('SELECT status FROM pagamentos WHERE id=?', [pg.id])).status };
});

// Confirmação automática por serviço autorizado (banco/PSP/automação). Desativado sem PIX_WEBHOOK_SECRET.
// Body: { "txid": "SIM12", "valor_centavos": 500 } + cabeçalho X-Webhook-Secret.
route('POST', '/api/webhooks/pix', async (req, { body }) => {
  const segredo = process.env.PIX_WEBHOOK_SECRET || '';
  if (provider.nome !== 'pix' || segredo.length < 16) throw new HttpError(404, 'Não encontrado');
  limit(req, 'webhook-pix', 60, 60000);
  if (!safeEq(req.headers['x-webhook-secret'] || '', segredo)) throw new HttpError(401, 'Não autorizado');
  const m = /^SIM(\d{1,12})$/.exec(String(body.txid ?? ''));
  if (!m) throw bad('txid inválido');
  const pg = await um("SELECT * FROM pagamentos WHERE id = ? AND provedor = 'pix'", [Number(m[1])]);
  if (!pg) throw new HttpError(404, 'Pagamento não encontrado');
  if (!(Number(body.valor_centavos) >= pg.valor_centavos)) throw bad('Valor inferior ao cobrado');
  await marcarPago(pg.id);
  return { ok: true };
});

// Aviso (webhook) do Mercado Pago. Autenticidade em duas camadas: (1) assinatura x-signature, quando MP_WEBHOOK_SECRET está definido;
// (2) o corpo NUNCA é confiado: o status é sempre consultado na API do Mercado Pago, com conferência de valor e referência.
route('POST', '/api/webhooks/mercadopago', async (req, { body, url }) => {
  if (provider.nome !== 'mercadopago') return { ok: true };
  limit(req, 'webhook-mp', 300, 60000);
  const id = url.searchParams.get('data.id') ?? body?.data?.id ?? url.searchParams.get('id');
  if (!id || !/^\d+$/.test(String(id))) return { ok: true };
  const ass = assinaturaMpValida({ dataId: url.searchParams.get('data.id') ?? id, xSignature: req.headers['x-signature'], xRequestId: req.headers['x-request-id'] });
  if (ass === false) { console.error('Webhook do Mercado Pago com assinatura inválida: ignorado.'); throw new HttpError(401, 'Assinatura inválida'); }
  const tipo = body?.type ?? url.searchParams.get('type') ?? url.searchParams.get('topic');
  if (tipo && tipo !== 'payment') return { ok: true }; // outros eventos (ex.: planos, merchant_order) não interessam
  const pg = await um('SELECT * FROM pagamentos WHERE provedor = ? AND provedor_id = ?', ['mercadopago', String(id)]);
  if (pg) { const antes = pg.status; const depois = await sincronizarPagamento(pg); if (antes !== 'pago' && depois.status === 'pago') console.log(`Pagamento ${pg.id} confirmado por webhook.`); }
  return { ok: true };
});

route('POST', '/api/lead/:id/simular', async (req, { body, params }) => {
  limit(req, 'simular', 30, 600000);
  const lead = await leadAutenticado(req, params.id);
  const pg = await pagamentoAtual(lead.id); // a tentativa paga (se houver) sempre vale
  if (!pg || !pagamentoLiberado(pg.status)) throw new HttpError(402, 'Pagamento não confirmado.');

  const tipo = body.tipo, credito = Number(body.credito);
  if (!TIPOS.includes(tipo)) throw bad('Escolha o que pretende adquirir.');
  if (!(credito >= 1000 && credito <= 100_000_000)) throw bad('Informe um valor de crédito válido (mínimo R$ 1.000).');

  const nome = String(body.nome ?? '').trim(), email = String(body.email ?? '').trim().toLowerCase(), telefone = V.digits(body.telefone);
  const cpf = V.digits(body.cpf), cidade = String(body.cidade ?? '').trim(), estado = String(body.estado ?? '').toUpperCase();
  if (!V.textoValido(nome, 3)) throw bad('Informe seu nome completo.');
  if (!V.telefoneValido(telefone)) throw bad('Telefone inválido. Informe DDD + número.');
  if (!V.emailValido(email)) throw bad('E-mail inválido.');
  if (!V.cpfValido(cpf)) throw bad('CPF inválido.');
  if (!V.dataNascimentoValida(body.nascimento)) throw bad('Data de nascimento inválida (é preciso ter 18 anos ou mais).');
  if (!V.textoValido(body.nome_mae, 3)) throw bad('Informe o nome da mãe.');
  if (!V.textoValido(cidade, 2, 80)) throw bad('Informe sua cidade.');
  if (!V.UFS.includes(estado)) throw bad('Selecione o estado.');

  const renda = Number(body.renda_mensal);
  if (!(renda > 0 && renda <= 10_000_000)) throw bad('Informe sua renda mensal.');

  const capValor = Number(body.capacidade_valor);
  if (!(capValor > 0 && capValor <= 10_000_000)) throw bad('Informe quanto pretende investir por mês.');
  const capLabel = String(body.capacidade_label ?? '').slice(0, 60) || brl(capValor);

  const planos = await todos('SELECT * FROM planos WHERE ativo = 1');
  const esc = escolherPlano(planos, tipo, credito);
  const reducaoDisponivel = !!esc?.calc.parcelaReduzida;
  const escolha = body.parcela === 'reduzida' && reducaoDisponivel ? 'reduzida' : 'integral';

  const sim = esc ? { ...esc.calc, plano: esc.plano.nome, indice: esc.plano.indice, regraReducao: esc.plano.regra_texto } : null;
  const parcelaBase = sim ? (escolha === 'reduzida' ? sim.parcelaReduzida : sim.parcelaIntegral) : null;
  const resultado = sim
    ? `${escolha === 'reduzida' ? 'Reduzida' : 'Integral'} ${brl(parcelaBase)} — ${parcelaBase <= capValor ? 'cabe' : 'acima do'} orçamento`
    : 'Sem plano para este valor';

  await exec(`UPDATE leads SET nome=?, email=?, telefone=?, cpf=?, nascimento=?, nome_mae=?, cidade=?, estado=?, tipo=?, credito=?, renda_mensal=?,
      capacidade_label=?, capacidade_valor=?, parcela_escolhida=?, plano_id=?, simulacao=?, resultado=?, simulado_em=now(),
      status=CASE WHEN status='aguardando_pagamento' THEN 'novo' ELSE status END WHERE id=?`,
    [nome, email, telefone, cpf, body.nascimento, String(body.nome_mae).trim(), cidade, estado, tipo, credito, renda,
      capLabel, capValor, escolha, esc?.plano.id ?? null, sim ? JSON.stringify(sim) : null, resultado, lead.id]);

  const salvo = await um('SELECT * FROM leads WHERE id=?', [lead.id]);
  return {
    whatsappUrl: await whatsappUrl(salvo, textoWhatsapp(salvo)),
    primeiroNome: nome.split(/\s+/)[0], tipo, credito, escolha,
    disponivel: !!sim,
    parcelaIntegral: sim?.parcelaIntegral ?? null,
    parcelaReduzida: reducaoDisponivel ? sim.parcelaReduzida : null,
    regraReducao: reducaoDisponivel ? sim.regraReducao : '',
    reducaoMeses: reducaoDisponivel ? sim.reducaoMeses : 0,
    indice: sim?.indice ?? null,
    prazo: sim?.prazo ?? null,
  };
});

route('POST', '/api/lead/:id/interesse', async (req, { body, params }) => {
  const lead = await leadAutenticado(req, params.id);
  if (!lead.simulacao && !lead.tipo) throw bad('Conclua a simulação primeiro.');
  if (!INTERESSES.includes(body.interesse)) throw bad('Valor inválido.');
  await exec('UPDATE leads SET interesse=? WHERE id=?', [body.interesse, lead.id]);
  const atual = await um('SELECT * FROM leads WHERE id=?', [lead.id]);
  return {
    ok: true,
    whatsappUrl: body.interesse === 'agora' ? await whatsappUrl(atual, textoWhatsapp(atual)) : null,
    learnUrl: (await getConfig()).learn_url || null,
  };
});

// ---------- rotas admin ----------
route('POST', '/api/admin/login', async (req, { body }) => {
  limit(req, 'login', 8, 600000);
  if (!safeEq(String(body.senha ?? ''), ADMIN_PASSWORD)) throw new HttpError(401, 'Senha incorreta');
  return { token: signAdmin() };
});

const FILTROS = { quentes: "l.interesse = 'agora'", mornos: "l.interesse = 'conversar'", frios: "l.interesse = 'depois'" };
const SITUACOES = ['pago', 'informado', 'pendente', 'expirado', 'recusado', 'cancelado'];
const LEAD_BASE = `FROM leads l LEFT JOIN pagamentos p ON p.id = (SELECT id FROM pagamentos WHERE lead_id = l.id ${ORDEM_ATUAL})`;
const LEAD_LISTA = `l.id, l.nome, l.telefone, l.email, l.tipo, l.credito, l.renda_mensal, l.capacidade_label, l.parcela_escolhida, l.resultado,
  l.interesse, l.status, l.criado_em, l.simulado_em, p.valor_centavos, ${STATUS_EF('p')} AS pagamento_status, p.pago_em,
  (SELECT COUNT(*)::int FROM pagamentos WHERE lead_id = l.id) AS tentativas`;
const escLike = (t) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

// Filtros do painel: busca (nome/telefone/e-mail), período (datas no horário de Brasília), situação do pagamento e interesse.
function filtrosLeads(sp) {
  const cond = ['l.excluido_em IS NULL'], args = [];
  if (FILTROS[sp.get('filtro')]) cond.push(FILTROS[sp.get('filtro')]);
  if (SITUACOES.includes(sp.get('pagamento'))) { cond.push(`${STATUS_EF('p')} = ?`); args.push(sp.get('pagamento')); }
  const de = sp.get('de'), ate = sp.get('ate');
  if (/^\d{4}-\d{2}-\d{2}$/.test(de || '')) { cond.push('l.criado_em >= ?'); args.push(`${de}T03:00:00.000Z`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(ate || '')) {
    const fim = new Date(`${ate}T03:00:00.000Z`);
    if (!Number.isNaN(fim.getTime())) { fim.setUTCDate(fim.getUTCDate() + 1); cond.push('l.criado_em < ?'); args.push(fim.toISOString()); }
  }
  const q = String(sp.get('q') || '').trim().slice(0, 80);
  if (q) {
    const partes = ["lower(l.nome) LIKE ? ESCAPE '\\'", "lower(l.email) LIKE ? ESCAPE '\\'"];
    const termo = `%${escLike(q.toLowerCase())}%`;
    const params = [termo, termo];
    const dig = V.digits(q);
    if (dig.length >= 3) { partes.push("l.telefone LIKE ? ESCAPE '\\'"); params.push(`%${escLike(dig)}%`); }
    cond.push(`(${partes.join(' OR ')})`); args.push(...params);
  }
  return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', args };
}
async function listarLeads(sp, limite) {
  const { where, args } = filtrosLeads(sp);
  const leads = await todos(`SELECT ${LEAD_LISTA} ${LEAD_BASE} ${where} ORDER BY l.id DESC LIMIT ?`, [...args, limite]);
  const total = (await um(`SELECT COUNT(*)::int AS n ${LEAD_BASE} ${where}`, args)).n;
  return { leads, total };
}
const contarAConferir = async () => (await um("SELECT COUNT(*)::int AS n FROM pagamentos p JOIN leads l ON l.id = p.lead_id WHERE p.status = 'informado' AND l.excluido_em IS NULL")).n;

route('GET', '/api/admin/leads', async (req, { url }) => {
  checkAdmin(req);
  return { ...(await listarLeads(url.searchParams, 500)), aConferir: await contarAConferir() };
});

// Exportação em CSV (Excel/Google Planilhas, separador ";"). Por privacidade NÃO inclui CPF, nascimento nem nome da mãe.
const CSV_COLS = [['id', 'ID'], ['criado_em', 'Cadastro'], ['simulado_em', 'Data da simulação'], ['nome', 'Nome'], ['telefone', 'WhatsApp'], ['email', 'E-mail'],
  ['renda_mensal', 'Renda mensal'], ['credito', 'Crédito desejado'], ['tipo', 'Tipo'], ['capacidade_label', 'Capacidade mensal'], ['parcela_escolhida', 'Parcela escolhida'],
  ['resultado', 'Resultado'], ['interesse', 'Interesse'], ['status', 'Status do lead'], ['pagamento_status', 'Situação do pagamento'], ['valor_centavos', 'Valor pago (centavos)'], ['pago_em', 'Pago em']];
const csvCell = (v) => {
  let t = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // evita execução de fórmula ao abrir na planilha
  return `"${t.replace(/"/g, '""')}"`;
};
route('GET', '/api/admin/leads.csv', async (req, { url }) => {
  checkAdmin(req);
  const { leads } = await listarLeads(url.searchParams, 100000);
  const linhas = leads.map((l) => CSV_COLS.map(([c]) => csvCell(l[c])).join(';'));
  return { __csv: `﻿${CSV_COLS.map(([, r]) => r).join(';')}\r\n${linhas.join('\r\n')}\r\n` };
});

const SITUACAO_PAG = {
  pago: ['Pago (confirmado)', 'ok'], informado: ['Aguardando conferência', 'aviso'], pendente: ['Aguardando pagamento', 'aviso'], expirado: ['Pix expirado', 'neutro'],
  recusado: ['Não confirmado', 'neutro'], cancelado: ['Cancelado', 'neutro'],
};
const INTERESSE_LABEL = { agora: 'Quer fazer agora (quente)', conversar: 'Quer conversar (morno)', depois: 'Ainda não (frio)' };
const fmtData = (iso) => (iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)).replace(', ', ' ') : '');

async function leadCompleto(id) {
  const l = Number.isInteger(Number(id)) ? await um(`SELECT l.*, p.valor_centavos, ${STATUS_EF('p')} AS pagamento_status, p.pago_em ${LEAD_BASE} WHERE l.id = ?`, [Number(id)]) : null;
  if (!l || l.excluido_em) throw new HttpError(404, 'Lead não encontrado');
  return l;
}

// Relatório individual em PDF (sem CPF, nascimento ou nome da mãe).
route('GET', '/api/admin/leads/:id\\.pdf', async (req, { params }) => {
  checkAdmin(req);
  const l = await leadCompleto(params.id);
  const sim = l.simulacao ? JSON.parse(l.simulacao) : null;
  const [situacao, corSit] = SITUACAO_PAG[l.pagamento_status] || ['—', 'neutro'];
  const reduzida = l.parcela_escolhida === 'reduzida';
  return { __pdf: relatorioSimulacao({
    id: l.id, nome: l.nome, telefone: fmtTel(l.telefone), email: l.email, renda: l.renda_mensal, credito: l.credito,
    tipo: l.tipo ? TIPO_LABEL[l.tipo].replace(/^./, (c) => c.toUpperCase()) : '—',
    capacidade: l.capacidade_label || '—', parcela: l.parcela_escolhida ? (reduzida ? 'Reduzida' : 'Integral') : '—',
    parcelaIntegral: sim?.parcelaIntegral ?? null, parcelaReduzida: sim?.parcelaReduzida ?? null, prazo: sim?.prazo, plano: sim?.plano,
    interesse: INTERESSE_LABEL[l.interesse] || 'Não respondeu', simuladoEm: fmtData(l.simulado_em) || 'Simulação não concluída',
    criadoEm: fmtData(l.criado_em), pagamentoSituacao: situacao, pagamentoCor: corSit, valorPago: (l.valor_centavos ?? 0) / 100,
    pagoEm: fmtData(l.pago_em), emitidoEm: fmtData(new Date().toISOString()),
  }), __nome: `simulacao-${String(l.id).padStart(5, '0')}.pdf` };
});

// Detalhes de um cadastro (inclui dados sensíveis; só sob demanda e com login).
route('GET', '/api/admin/leads/:id', async (req, { params }) => {
  checkAdmin(req);
  const l = await leadCompleto(params.id);
  const sim = l.simulacao ? JSON.parse(l.simulacao) : null;
  const { token, simulacao, ...lead } = l; // nunca devolve o token do cliente
  const tentativas = await todos(`SELECT p.id, p.provedor, p.valor_centavos, ${STATUS_EF('p')} AS status, p.criado_em, p.expira_em, p.pago_em FROM pagamentos p WHERE p.lead_id = ? ORDER BY p.id DESC`, [l.id]);
  return { lead, tentativas, simulacao: sim ? { plano: sim.plano, prazo: sim.prazo, parcelaIntegral: sim.parcelaIntegral, parcelaReduzida: sim.parcelaReduzida, indice: sim.indice } : null };
});

route('GET', '/api/admin/status', async (req) => {
  checkAdmin(req);
  const w = await whatsappEspecialista();
  return {
    banco: { tipo: PERSISTENCIA.tipo, persistente: PERSISTENCIA.persistente, motivo: PERSISTENCIA.motivo || null },
    senhaFraca: SENHA_FRACA,
    pagamento: { provedor: provider.nome, confirmacao: provider.confirmacao, pronto: provider.pronto(), conta: provider.nome === 'pix' ? contaPix() : null, chaveProblema: provider.nome === 'pix' ? chavePixProblema() : null, webhook: provider.nome === 'pix' && (process.env.PIX_WEBHOOK_SECRET || '').length >= 16, mp: provider.nome === 'mercadopago' ? mpInfo() : null, ultimoErro: ultimoErroPagamento },
    whatsapp: { numero: fmtTel(w.numero.replace(/^55/, '')), origem: w.origem },
    aConferir: await contarAConferir(),
  };
});

// Confirma ou recusa uma tentativa de pagamento. Um pagamento já confirmado ('pago') nunca é alterado.
// Confirmar uma tentativa vencida é permitido: o Pix estático não expira no banco e o dinheiro pode ter entrado depois.
async function decidirPagamento(pg, acao) {
  if (acao !== 'confirmar' && acao !== 'recusar') throw bad('Ação inválida');
  if (pg.status === 'pago') throw new HttpError(409, 'Pagamento já confirmado: não pode ser alterado.');
  if (acao === 'confirmar') await marcarPago(pg.id);
  else await exec("UPDATE pagamentos SET status='recusado' WHERE id=? AND status <> 'pago'", [pg.id]);
}

// Tentativa atual do cliente (a mesma exibida na lista).
route('POST', '/api/admin/leads/:id/pagamento', async (req, { body, params }) => {
  checkAdmin(req);
  await leadCompleto(params.id); // 404 se o lead não existe ou já foi excluído
  const pg = await pagamentoAtual(Number(params.id));
  if (!pg) throw new HttpError(404, 'Pagamento não encontrado');
  await decidirPagamento(pg, body.acao);
  return { ok: true };
});

// Uma tentativa específica (histórico do cliente).
route('POST', '/api/admin/pagamentos/:id', async (req, { body, params }) => {
  checkAdmin(req);
  const pg = Number.isInteger(Number(params.id)) ? await um('SELECT * FROM pagamentos WHERE id = ?', [Number(params.id)]) : null;
  if (!pg) throw new HttpError(404, 'Pagamento não encontrado');
  await leadCompleto(pg.lead_id);
  await decidirPagamento(pg, body.acao);
  return { ok: true };
});

// Exclusão de dados pessoais (LGPD). Anonimiza o cadastro de forma irreversível: apaga nome, contato, CPF, nascimento,
// nome da mãe, cidade, renda, valores e resultado da simulação. Mantém apenas o registro financeiro do pagamento
// (sem identificação), para fins contábeis, e um registro da exclusão sem dados pessoais.
route('DELETE', '/api/admin/leads/:id', async (req, { body, params }) => {
  checkAdmin(req);
  limit(req, 'excluir-lead', 30, 600000);
  const id = Number(params.id);
  const lead = Number.isInteger(id) ? await um('SELECT id, excluido_em FROM leads WHERE id = ?', [id]) : null;
  if (!lead || lead.excluido_em) throw new HttpError(404, 'Lead não encontrado');
  if (body.confirmar !== 'EXCLUIR') throw bad('Confirmação ausente: digite EXCLUIR para apagar os dados pessoais.');
  const motivo = MOTIVOS_EXCLUSAO.includes(body.motivo) ? body.motivo : 'outro';
  await tx(async (t) => { // tudo ou nada
    await t.exec(`UPDATE leads SET nome='[cadastro excluído]', email='', telefone='', token=?, cpf=NULL, nascimento=NULL, nome_mae=NULL,
      cidade=NULL, estado=NULL, tipo=NULL, credito=NULL, renda_mensal=NULL, capacidade_label=NULL, capacidade_valor=NULL, parcela_escolhida=NULL,
      plano_id=NULL, simulacao=NULL, resultado=NULL, interesse=NULL, status='excluido', simulado_em=NULL,
      excluido_em=now() WHERE id=?`, [crypto.randomBytes(24).toString('hex'), id]);
    await t.exec('INSERT INTO exclusoes (lead_id, motivo) VALUES (?, ?)', [id, motivo]);
  });
  console.log(`Lead ${id} excluído (motivo: ${motivo}).`); // sem dados pessoais no log
  return { ok: true };
});

route('PATCH', '/api/admin/leads/:id', async (req, { body, params }) => {
  checkAdmin(req);
  if (!STATUS_LEAD.includes(body.status)) throw bad('Status inválido');
  await exec('UPDATE leads SET status=? WHERE id=? AND excluido_em IS NULL', [body.status, Number(params.id)]);
  return { ok: true };
});

function planoDoCorpo(b) {
  const num = (v, min, max, nome) => { const n = Number(v); if (!(n >= min && n <= max)) throw bad(`${nome} inválido(a)`); return n; };
  if (!V.textoValido(b.nome, 2, 80)) throw bad('Nome do plano inválido');
  if (!TIPOS.includes(b.tipo)) throw bad('Tipo inválido');
  const reduzida = b.reduzida && b.tipo === 'imovel' ? 1 : 0; // parcela reduzida: somente imóvel
  const regra = ['fundo_comum', 'parcela_total'].includes(b.reducao_regra) ? b.reducao_regra : 'fundo_comum';
  const p = {
    nome: b.nome.trim(), tipo: b.tipo,
    prazo: Math.round(num(b.prazo, 1, 600, 'Prazo')),
    taxa_admin: num(b.taxa_admin, 0, 100, 'Taxa de administração'),
    fundo_reserva: num(b.fundo_reserva ?? 0, 0, 100, 'Fundo de reserva'),
    seguro: num(b.seguro ?? 0, 0, 5, 'Seguro'),
    indice: String(b.indice || 'IPCA').slice(0, 20),
    reduzida, reducao_pct: reduzida ? num(b.reducao_pct, 0.001, 99.999, 'Percentual da redução') : 0,
    arredondamento: Object.hasOwn(ARREDONDAMENTOS, b.arredondamento) ? b.arredondamento : 'cortar',
    reducao_regra: regra, reducao_meses: reduzida ? Math.round(num(b.reducao_meses || 0, 0, 600, 'Período da redução')) : 0, regra_texto: String(b.regra_texto ?? '').slice(0, 300),
    credito_min: num(b.credito_min, 1, 1e9, 'Crédito mínimo'), credito_max: num(b.credito_max, 1, 1e9, 'Crédito máximo'),
    ativo: b.ativo ? 1 : 0,
  };
  if (p.credito_min > p.credito_max) throw bad('Crédito mínimo maior que o máximo');
  return p;
}
const COLS = ['nome', 'tipo', 'prazo', 'taxa_admin', 'fundo_reserva', 'seguro', 'indice', 'reduzida', 'reducao_pct', 'reducao_regra', 'reducao_meses', 'arredondamento', 'regra_texto', 'credito_min', 'credito_max', 'ativo'];

route('GET', '/api/admin/planos', async (req) => { checkAdmin(req); return { planos: await todos('SELECT * FROM planos ORDER BY tipo, id') }; });
route('POST', '/api/admin/planos', async (req, { body }) => {
  checkAdmin(req);
  const p = planoDoCorpo(body);
  const id = (await um(`INSERT INTO planos (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')}) RETURNING id`, COLS.map((c) => p[c]))).id;
  return { id };
});
route('PUT', '/api/admin/planos/:id', async (req, { body, params }) => {
  checkAdmin(req);
  const p = planoDoCorpo(body);
  await exec(`UPDATE planos SET ${COLS.map((c) => `${c}=?`).join(',')} WHERE id=?`, [...COLS.map((c) => p[c]), Number(params.id)]);
  return { ok: true };
});
route('DELETE', '/api/admin/planos/:id', async (req, { params }) => {
  checkAdmin(req);
  await exec('DELETE FROM planos WHERE id=?', [Number(params.id)]);
  return { ok: true };
});
route('POST', '/api/admin/planos-teste', async (req, { body }) => { // pré-visualiza o cálculo de um plano
  checkAdmin(req);
  return calcular(planoDoCorpo(body), Number(body.credito_teste) || 100000);
});

route('GET', '/api/admin/config', async (req) => {
  checkAdmin(req);
  const w = await whatsappEspecialista();
  return { ...(await getConfig()), whatsapp_em_uso: fmtTel(w.numero.replace(/^55/, '')), whatsapp_origem: w.origem };
});
route('PUT', '/api/admin/config', async (req, { body }) => {
  checkAdmin(req);
  const w = V.digits(body.whatsapp);
  if (w && !V.telefoneValido(w)) throw bad('WhatsApp inválido');
  const url = String(body.learn_url ?? '').trim();
  if (url && !/^https?:\/\//i.test(url)) throw bad('O link deve começar com http:// ou https://');
  await setConfig('whatsapp', w); await setConfig('learn_url', url);
  return { ok: true };
});

// ---------- estáticos ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado');
  }
  // no-cache + ETag: o navegador sempre confere se há versão nova (304 quando igual). Assim, depois de um deploy,
  // ninguém continua vendo textos/preços antigos por causa de JS/CSS guardados em cache.
  const st = fs.statSync(file);
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`,
  };
  if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  if ((process.env.PUBLIC_URL || '').startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  try {
    await bancoPronto;
    // /healthz: o servidor só começa a escutar depois que o banco respondeu e as tabelas existem. Não consulta o banco a cada
    // verificação: uma falha momentânea do provedor não faz o Render reiniciar o serviço à toa.
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido');
      let caminho;
      try { caminho = decodeURIComponent(url.pathname); } catch { throw bad('Endereço inválido'); }
      return serveStatic(req, res, caminho);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler(req, { body, url, params: m.groups || {} });
      if (out && out.__pdf) {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${out.__nome}"`, 'Cache-Control': 'no-store' });
        return res.end(out.__pdf);
      }
      if (out && out.__csv !== undefined) {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
        return res.end(out.__csv);
      }
      return send(res, 200, out);
    }
    throw new HttpError(404, 'Não encontrado');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { erro: e instanceof HttpError ? e.message : 'Erro interno' });
  }
});

if (require.main === module) {
  bancoPronto
    .then(() => server.listen(PORT, () => console.log(`Simulador de Consórcio em http://localhost:${PORT}  (pagamento: ${provider.nome})  admin: /admin`)))
    .catch((e) => { console.error('Não foi possível iniciar o banco de dados:', e.message); process.exit(1); });
  if (provider.nome === 'mercadopago') {
    const seg = Math.max(10, Number(process.env.MP_VARREDURA_SEGUNDOS) || 30);
    setInterval(() => { varrerMercadoPago(); }, seg * 1000).unref();
    bancoPronto.then(() => varrerMercadoPago()).catch(() => {}); // ao iniciar (ex.: depois de um deploy), recupera o que ficou pendente
  }
  // O Render envia SIGTERM em cada deploy/reinício: encerra com calma (termina requisições e fecha as conexões do banco).
  process.on('SIGTERM', () => {
    setTimeout(() => process.exit(0), 8000).unref();
    server.close(() => require('./lib/db').fechar().catch(() => {}).finally(() => process.exit(0)));
  });
}
// Varredura em segundo plano (rede de segurança): reconcilia com o Mercado Pago as cobranças recentes ainda sem desfecho.
// Garante a liberação mesmo que o webhook não chegue e o cliente tenha fechado a página.
let varrendo = false;
async function varrerMercadoPago() {
  if (provider.nome !== 'mercadopago' || varrendo) return 0;
  varrendo = true; let confirmados = 0;
  try {
    const abertos = await todos("SELECT * FROM pagamentos WHERE provedor = 'mercadopago' AND provedor_id IS NOT NULL AND status IN ('pendente','expirado') AND criado_em > now() - interval '24 hours' ORDER BY id DESC LIMIT 100");
    for (const pg of abertos) {
      try { const r = await sincronizarPagamento(pg); if (r.status === 'pago') { confirmados++; console.log(`Pagamento ${pg.id} confirmado pela varredura.`); } }
      catch (e) { console.error('Varredura: falha ao reconciliar um pagamento:', e.message); }
    }
  } catch (e) { console.error('Varredura de pagamentos falhou:', e.message); }
  finally { varrendo = false; }
  return confirmados;
}
module.exports = { server, varrerMercadoPago };
