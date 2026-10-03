'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

try { process.loadEnvFile?.(path.join(__dirname, '.env')); } catch { /* .env é opcional */ }

const { db, getConfig, setConfig, persistencia } = require('./lib/db');
const { provider, codigoPix } = require('./lib/payment');
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
if (!PERSISTENCIA.persistente && IS_PROD) console.warn('⚠ Banco de dados SEM disco persistente: os leads serão perdidos no próximo deploy. Monte um disco em /data.');
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
function leadAutenticado(req, id) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
  const tok = req.headers['x-lead-token'] || '';
  if (!lead || lead.excluido_em || !safeEq(tok, lead.token)) throw new HttpError(404, 'Simulação não encontrada');
  return lead;
}
const ultimoPagamento = (leadId) => db.prepare('SELECT * FROM pagamentos WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(leadId);

function marcarPago(pagamentoId) {
  const pg = db.prepare('SELECT * FROM pagamentos WHERE id = ?').get(pagamentoId);
  if (!pg || pg.status === 'pago') return;
  db.prepare("UPDATE pagamentos SET status='pago', pago_em=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(pg.id);
  db.prepare("UPDATE leads SET status='novo' WHERE id=? AND status='aguardando_pagamento'").run(pg.lead_id);
}

async function sincronizarPagamento(pg) {
  if (pg.status === 'pendente' && pg.provedor === provider.nome && pg.provedor_id && provider.nome !== 'mock') {
    const novo = await provider.consultar(pg.provedor_id);
    if (novo === 'pago') marcarPago(pg.id);
    else if (novo !== 'pendente') db.prepare('UPDATE pagamentos SET status=? WHERE id=?').run(novo, pg.id);
  }
  return db.prepare('SELECT status FROM pagamentos WHERE id=?').get(pg.id).status;
}

// Número do especialista (destino do atendimento). Pode ser alterado em /admin → Configurações.
const ESPECIALISTA_PADRAO = V.digits(process.env.WHATSAPP_ESPECIALISTA) || '5541997446032';

function whatsappEspecialista() {
  const configurado = V.digits(getConfig().whatsapp);
  const num = configurado || ESPECIALISTA_PADRAO;
  return { numero: num.startsWith('55') ? num : `55${num}`, origem: configurado ? 'configurado' : 'padrao' };
}

function whatsappUrl(lead, texto) {
  const { numero } = whatsappEspecialista();
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
  const planos = db.prepare('SELECT * FROM planos WHERE ativo = 1').all();
  const esc = escolherPlano(planos, tipo, credito);
  return { disponivel: !!esc, reduzida: !!esc?.calc.parcelaReduzida };
});

route('POST', '/api/checkout', async (req, { body }) => {
  limit(req, 'checkout', 10, 600000);
  const nome = String(body.nome ?? '').trim(), email = String(body.email ?? '').trim().toLowerCase(), telefone = V.digits(body.telefone);
  if (!V.textoValido(nome, 3)) throw bad('Informe seu nome completo.');
  if (!V.emailValido(email)) throw bad('E-mail inválido.');
  if (!V.telefoneValido(telefone)) throw bad('Telefone inválido. Informe DDD + número.');

  const token = crypto.randomBytes(24).toString('hex');
  const leadId = Number(db.prepare('INSERT INTO leads (token, nome, email, telefone) VALUES (?,?,?,?)').run(token, nome, email, telefone).lastInsertRowid);
  const pagId = Number(db.prepare('INSERT INTO pagamentos (lead_id, provedor, valor_centavos) VALUES (?,?,?)').run(leadId, provider.nome, PRICE_CENTS).lastInsertRowid);
  try {
    const r = await provider.criar({ pagamentoId: pagId, valorCentavos: PRICE_CENTS, email, nome });
    db.prepare('UPDATE pagamentos SET provedor_id=? WHERE id=?').run(r.provedorId, pagId);
    return { leadId, token, status: 'pendente', pix: r.pix, mock: provider.nome === 'mock' };
  } catch (e) {
    console.error('Falha ao criar pagamento:', e.message);
    db.prepare("UPDATE pagamentos SET status='cancelado' WHERE id=?").run(pagId);
    throw new HttpError(502, 'Não foi possível iniciar o pagamento agora. Tente novamente em instantes.');
  }
});

route('GET', '/api/lead/:id/estado', async (req, { params }) => {
  const lead = leadAutenticado(req, params.id);
  const pg = ultimoPagamento(lead.id);
  const status = pg ? await sincronizarPagamento(pg) : 'pendente';
  return {
    pagamento: status, liberado: pagamentoLiberado(status),
    pix: provider.nome === 'pix' && pg && status !== 'pago' ? { copiaECola: codigoPix(pg.id, pg.valor_centavos) } : null,
    nome: lead.nome, email: lead.email, telefone: lead.telefone, simulado: !!lead.simulacao,
  };
});

route('POST', '/api/lead/:id/mock-pay', async (req, { params }) => {
  if (provider.nome !== 'mock') throw new HttpError(404, 'Não encontrado');
  const lead = leadAutenticado(req, params.id);
  const pg = ultimoPagamento(lead.id);
  marcarPago(pg.id);
  return { pagamento: 'pago' };
});

route('POST', '/api/lead/:id/informar-pagamento', async (req, { params }) => {
  if (provider.nome !== 'pix') throw new HttpError(404, 'Não encontrado');
  limit(req, 'informar', 10, 600000);
  const lead = leadAutenticado(req, params.id);
  const pg = ultimoPagamento(lead.id);
  if (pg.status === 'pendente') {
    db.prepare("UPDATE pagamentos SET status='informado' WHERE id=?").run(pg.id);
    db.prepare("UPDATE leads SET status='novo' WHERE id=? AND status='aguardando_pagamento'").run(lead.id);
  }
  return { pagamento: db.prepare('SELECT status FROM pagamentos WHERE id=?').get(pg.id).status };
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
  const pg = db.prepare("SELECT * FROM pagamentos WHERE id = ? AND provedor = 'pix'").get(Number(m[1]));
  if (!pg) throw new HttpError(404, 'Pagamento não encontrado');
  if (!(Number(body.valor_centavos) >= pg.valor_centavos)) throw bad('Valor inferior ao cobrado');
  marcarPago(pg.id);
  return { ok: true };
});

route('POST', '/api/webhooks/mercadopago', async (req, { body, url }) => {
  if (provider.nome !== 'mercadopago') return { ok: true };
  const id = body?.data?.id ?? url.searchParams.get('data.id') ?? url.searchParams.get('id');
  if (!id || !/^\d+$/.test(String(id))) return { ok: true };
  // Não confiamos no corpo: consultamos o status direto na API do provedor.
  const pg = db.prepare('SELECT * FROM pagamentos WHERE provedor = ? AND provedor_id = ?').get('mercadopago', String(id));
  if (pg) await sincronizarPagamento(pg);
  return { ok: true };
});

route('POST', '/api/lead/:id/simular', async (req, { body, params }) => {
  limit(req, 'simular', 30, 600000);
  const lead = leadAutenticado(req, params.id);
  const pg = ultimoPagamento(lead.id);
  if (!pg || !pagamentoLiberado(await sincronizarPagamento(pg))) throw new HttpError(402, 'Pagamento não confirmado.');

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

  const planos = db.prepare('SELECT * FROM planos WHERE ativo = 1').all();
  const esc = escolherPlano(planos, tipo, credito);
  const reducaoDisponivel = !!esc?.calc.parcelaReduzida;
  const escolha = body.parcela === 'reduzida' && reducaoDisponivel ? 'reduzida' : 'integral';

  const sim = esc ? { ...esc.calc, plano: esc.plano.nome, indice: esc.plano.indice, regraReducao: esc.plano.regra_texto } : null;
  const parcelaBase = sim ? (escolha === 'reduzida' ? sim.parcelaReduzida : sim.parcelaIntegral) : null;
  const resultado = sim
    ? `${escolha === 'reduzida' ? 'Reduzida' : 'Integral'} ${brl(parcelaBase)} — ${parcelaBase <= capValor ? 'cabe' : 'acima do'} orçamento`
    : 'Sem plano para este valor';

  db.prepare(`UPDATE leads SET nome=?, email=?, telefone=?, cpf=?, nascimento=?, nome_mae=?, cidade=?, estado=?, tipo=?, credito=?, renda_mensal=?,
      capacidade_label=?, capacidade_valor=?, parcela_escolhida=?, plano_id=?, simulacao=?, resultado=?, simulado_em=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      status=CASE WHEN status='aguardando_pagamento' THEN 'novo' ELSE status END WHERE id=?`)
    .run(nome, email, telefone, cpf, body.nascimento, String(body.nome_mae).trim(), cidade, estado, tipo, credito, renda,
      capLabel, capValor, escolha, esc?.plano.id ?? null, sim ? JSON.stringify(sim) : null, resultado, lead.id);

  const salvo = db.prepare('SELECT * FROM leads WHERE id=?').get(lead.id);
  return {
    whatsappUrl: whatsappUrl(salvo, textoWhatsapp(salvo)),
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
  const lead = leadAutenticado(req, params.id);
  if (!lead.simulacao && !lead.tipo) throw bad('Conclua a simulação primeiro.');
  if (!INTERESSES.includes(body.interesse)) throw bad('Valor inválido.');
  db.prepare('UPDATE leads SET interesse=? WHERE id=?').run(body.interesse, lead.id);
  const atual = db.prepare('SELECT * FROM leads WHERE id=?').get(lead.id);
  return {
    ok: true,
    whatsappUrl: body.interesse === 'agora' ? whatsappUrl(atual, textoWhatsapp(atual)) : null,
    learnUrl: getConfig().learn_url || null,
  };
});

// ---------- rotas admin ----------
route('POST', '/api/admin/login', async (req, { body }) => {
  limit(req, 'login', 8, 600000);
  if (!safeEq(String(body.senha ?? ''), ADMIN_PASSWORD)) throw new HttpError(401, 'Senha incorreta');
  return { token: signAdmin() };
});

const FILTROS = { quentes: "l.interesse = 'agora'", mornos: "l.interesse = 'conversar'", frios: "l.interesse = 'depois'" };
const SITUACOES = ['pago', 'informado', 'pendente', 'recusado', 'cancelado'];
const LEAD_BASE = `FROM leads l LEFT JOIN pagamentos p ON p.id = (SELECT MAX(id) FROM pagamentos WHERE lead_id = l.id)`;
const LEAD_LISTA = `l.id, l.nome, l.telefone, l.email, l.tipo, l.credito, l.renda_mensal, l.capacidade_label, l.parcela_escolhida, l.resultado,
  l.interesse, l.status, l.criado_em, l.simulado_em, p.valor_centavos, p.status AS pagamento_status, p.pago_em`;
const escLike = (t) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

// Filtros do painel: busca (nome/telefone/e-mail), período (datas no horário de Brasília), situação do pagamento e interesse.
function filtrosLeads(sp) {
  const cond = ['l.excluido_em IS NULL'], args = [];
  if (FILTROS[sp.get('filtro')]) cond.push(FILTROS[sp.get('filtro')]);
  if (SITUACOES.includes(sp.get('pagamento'))) { cond.push('p.status = ?'); args.push(sp.get('pagamento')); }
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
function listarLeads(sp, limite) {
  const { where, args } = filtrosLeads(sp);
  const leads = db.prepare(`SELECT ${LEAD_LISTA} ${LEAD_BASE} ${where} ORDER BY l.id DESC LIMIT ?`).all(...args, limite);
  const total = db.prepare(`SELECT COUNT(*) n ${LEAD_BASE} ${where}`).get(...args).n;
  return { leads, total };
}
const contarAConferir = () => db.prepare("SELECT COUNT(*) n FROM pagamentos p JOIN leads l ON l.id = p.lead_id WHERE p.status = 'informado' AND l.excluido_em IS NULL").get().n;

route('GET', '/api/admin/leads', async (req, { url }) => {
  checkAdmin(req);
  return { ...listarLeads(url.searchParams, 500), aConferir: contarAConferir() };
});

// Exportação em CSV (Excel/Google Planilhas, separador ";"). Por privacidade NÃO inclui CPF, nascimento nem nome da mãe.
const CSV_COLS = [['id', 'ID'], ['criado_em', 'Cadastro'], ['simulado_em', 'Data da simulação'], ['nome', 'Nome'], ['telefone', 'WhatsApp'], ['email', 'E-mail'],
  ['renda_mensal', 'Renda mensal'], ['credito', 'Crédito desejado'], ['tipo', 'Tipo'], ['capacidade_label', 'Capacidade mensal'], ['parcela_escolhida', 'Parcela escolhida'],
  ['resultado', 'Resultado'], ['interesse', 'Interesse'], ['status', 'Status do lead'], ['pagamento_status', 'Situação do pagamento'], ['valor_centavos', 'Valor pago (centavos)'], ['pago_em', 'Pago em']];
const csvCell = (v) => {
  let t = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // evita execução de fórmula ao abrir na planilha
  return `"${t.replace(/"/g, '""')}"`;
};
route('GET', '/api/admin/leads.csv', async (req, { url }) => {
  checkAdmin(req);
  const { leads } = listarLeads(url.searchParams, 100000);
  const linhas = leads.map((l) => CSV_COLS.map(([c]) => csvCell(l[c])).join(';'));
  return { __csv: `﻿${CSV_COLS.map(([, r]) => r).join(';')}\r\n${linhas.join('\r\n')}\r\n` };
});

const SITUACAO_PAG = {
  pago: ['Pago (confirmado)', 'ok'], informado: ['Aguardando conferência', 'aviso'], pendente: ['Aguardando pagamento', 'aviso'],
  recusado: ['Não confirmado', 'neutro'], cancelado: ['Cancelado', 'neutro'],
};
const INTERESSE_LABEL = { agora: 'Quer fazer agora (quente)', conversar: 'Quer conversar (morno)', depois: 'Ainda não (frio)' };
const fmtData = (iso) => (iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)).replace(', ', ' ') : '');

function leadCompleto(id) {
  const l = db.prepare(`SELECT l.*, p.valor_centavos, p.status AS pagamento_status, p.pago_em ${LEAD_BASE} WHERE l.id = ?`).get(Number(id));
  if (!l || l.excluido_em) throw new HttpError(404, 'Lead não encontrado');
  return l;
}

// Relatório individual em PDF (sem CPF, nascimento ou nome da mãe).
route('GET', '/api/admin/leads/:id\\.pdf', async (req, { params }) => {
  checkAdmin(req);
  const l = leadCompleto(params.id);
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
  const l = leadCompleto(params.id);
  const sim = l.simulacao ? JSON.parse(l.simulacao) : null;
  const { token, simulacao, ...lead } = l; // nunca devolve o token do cliente
  return { lead, simulacao: sim ? { plano: sim.plano, prazo: sim.prazo, parcelaIntegral: sim.parcelaIntegral, parcelaReduzida: sim.parcelaReduzida, indice: sim.indice } : null };
});

route('GET', '/api/admin/status', async (req) => {
  checkAdmin(req);
  const w = whatsappEspecialista();
  return {
    banco: { tipo: 'SQLite', persistente: PERSISTENCIA.persistente, motivo: PERSISTENCIA.motivo || null },
    senhaFraca: SENHA_FRACA,
    pagamento: { provedor: provider.nome, confirmacao: provider.confirmacao, webhook: provider.nome === 'pix' && (process.env.PIX_WEBHOOK_SECRET || '').length >= 16 },
    whatsapp: { numero: fmtTel(w.numero.replace(/^55/, '')), origem: w.origem },
    aConferir: contarAConferir(),
  };
});

route('POST', '/api/admin/leads/:id/pagamento', async (req, { body, params }) => {
  checkAdmin(req);
  leadCompleto(params.id); // 404 se o lead não existe ou já foi excluído
  const pg = ultimoPagamento(Number(params.id));
  if (!pg) throw new HttpError(404, 'Pagamento não encontrado');
  if (body.acao === 'confirmar') marcarPago(pg.id);
  else if (body.acao === 'recusar') db.prepare("UPDATE pagamentos SET status='recusado' WHERE id=?").run(pg.id);
  else throw bad('Ação inválida');
  return { ok: true };
});

// Exclusão de dados pessoais (LGPD). Anonimiza o cadastro de forma irreversível: apaga nome, contato, CPF, nascimento,
// nome da mãe, cidade, renda, valores e resultado da simulação. Mantém apenas o registro financeiro do pagamento
// (sem identificação), para fins contábeis, e um registro da exclusão sem dados pessoais.
route('DELETE', '/api/admin/leads/:id', async (req, { body, params }) => {
  checkAdmin(req);
  limit(req, 'excluir-lead', 30, 600000);
  const id = Number(params.id);
  const lead = db.prepare('SELECT id, excluido_em FROM leads WHERE id = ?').get(id);
  if (!lead || lead.excluido_em) throw new HttpError(404, 'Lead não encontrado');
  if (body.confirmar !== 'EXCLUIR') throw bad('Confirmação ausente: digite EXCLUIR para apagar os dados pessoais.');
  const motivo = MOTIVOS_EXCLUSAO.includes(body.motivo) ? body.motivo : 'outro';
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE leads SET nome='[cadastro excluído]', email='', telefone='', token=?, cpf=NULL, nascimento=NULL, nome_mae=NULL,
      cidade=NULL, estado=NULL, tipo=NULL, credito=NULL, renda_mensal=NULL, capacidade_label=NULL, capacidade_valor=NULL, parcela_escolhida=NULL,
      plano_id=NULL, simulacao=NULL, resultado=NULL, interesse=NULL, status='excluido', simulado_em=NULL,
      excluido_em=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(crypto.randomBytes(24).toString('hex'), id);
    db.prepare('INSERT INTO exclusoes (lead_id, motivo) VALUES (?, ?)').run(id, motivo);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* melhor esforço */ }
  console.log(`Lead ${id} excluído (motivo: ${motivo}).`); // sem dados pessoais no log
  return { ok: true };
});

route('PATCH', '/api/admin/leads/:id', async (req, { body, params }) => {
  checkAdmin(req);
  if (!STATUS_LEAD.includes(body.status)) throw bad('Status inválido');
  db.prepare('UPDATE leads SET status=? WHERE id=? AND excluido_em IS NULL').run(body.status, Number(params.id));
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

route('GET', '/api/admin/planos', async (req) => { checkAdmin(req); return { planos: db.prepare('SELECT * FROM planos ORDER BY tipo, id').all() }; });
route('POST', '/api/admin/planos', async (req, { body }) => {
  checkAdmin(req);
  const p = planoDoCorpo(body);
  const id = Number(db.prepare(`INSERT INTO planos (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`).run(...COLS.map((c) => p[c])).lastInsertRowid);
  return { id };
});
route('PUT', '/api/admin/planos/:id', async (req, { body, params }) => {
  checkAdmin(req);
  const p = planoDoCorpo(body);
  db.prepare(`UPDATE planos SET ${COLS.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...COLS.map((c) => p[c]), Number(params.id));
  return { ok: true };
});
route('DELETE', '/api/admin/planos/:id', async (req, { params }) => {
  checkAdmin(req);
  db.prepare('DELETE FROM planos WHERE id=?').run(Number(params.id));
  return { ok: true };
});
route('POST', '/api/admin/planos-teste', async (req, { body }) => { // pré-visualiza o cálculo de um plano
  checkAdmin(req);
  return calcular(planoDoCorpo(body), Number(body.credito_teste) || 100000);
});

route('GET', '/api/admin/config', async (req) => {
  checkAdmin(req);
  const w = whatsappEspecialista();
  return { ...getConfig(), whatsapp_em_uso: fmtTel(w.numero.replace(/^55/, '')), whatsapp_origem: w.origem };
});
route('PUT', '/api/admin/config', async (req, { body }) => {
  checkAdmin(req);
  const w = V.digits(body.whatsapp);
  if (w && !V.telefoneValido(w)) throw bad('WhatsApp inválido');
  const url = String(body.learn_url ?? '').trim();
  if (url && !/^https?:\/\//i.test(url)) throw bad('O link deve começar com http:// ou https://');
  setConfig('whatsapp', w); setConfig('learn_url', url);
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
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': rel.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  });
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
    if (url.pathname === '/healthz') { db.prepare('SELECT 1').get(); res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
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
  server.listen(PORT, () => console.log(`Simulador de Consórcio em http://localhost:${PORT}  (pagamento: ${provider.nome})  admin: /admin`));
}
module.exports = { server };
