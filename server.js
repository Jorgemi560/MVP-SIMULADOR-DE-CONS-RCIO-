'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

try { process.loadEnvFile?.(path.join(__dirname, '.env')); } catch { /* .env é opcional */ }

const { db, getConfig, setConfig } = require('./lib/db');
const { provider, brCodeDoPagamento } = require('./lib/payment');
const { calcular, escolherPlano, ARREDONDAMENTOS } = require('./lib/calc');
const V = require('./lib/validate');

const PORT = Number(process.env.PORT) || 3000;
const PRICE_CENTS = Number(process.env.PRICE_CENTS) || 500;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PROD ? '' : 'admin123');
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD é obrigatória em produção');
if (!process.env.ADMIN_PASSWORD) console.warn('⚠ ADMIN_PASSWORD não definida: usando "admin123" (somente desenvolvimento).');
const ADMIN_SECRET = crypto.createHash('sha256').update(`adm:${ADMIN_PASSWORD}`).digest();

// Pix estático: 'informado' libera a simulação quando o cliente diz que pagou (o admin confere depois);
// 'confirmado' só libera depois que o admin confirmar o pagamento em /admin.
const PIX_LIBERAR = process.env.PIX_LIBERAR === 'confirmado' ? 'confirmado' : 'informado';
const pagamentoLiberado = (status) => status === 'pago' || (status === 'informado' && PIX_LIBERAR === 'informado');

const TIPOS = ['imovel', 'veiculo', 'outros'];
const TIPO_LABEL = { imovel: 'imóvel', veiculo: 'veículo', outros: 'outros bens' };
const INTERESSES = ['agora', 'conversar', 'depois'];
const STATUS_LEAD = ['aguardando_pagamento', 'novo', 'contatado', 'convertido', 'perdido'];
const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------- util ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

const hits = new Map();
function limit(req, key, max, windowMs) {
  const ip = req.socket.remoteAddress || '?';
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
  if (!lead || !safeEq(tok, lead.token)) throw new HttpError(404, 'Simulação não encontrada');
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
const ESPECIALISTA_PADRAO = '5541997446032';

function whatsappUrl(lead, texto) {
  const num = V.digits(getConfig().whatsapp) || ESPECIALISTA_PADRAO;
  if (!num) return null;
  return `https://wa.me/${num.startsWith('55') ? num : `55${num}`}?text=${encodeURIComponent(texto)}`;
}

const fmtTel = (t) => { const d = V.digits(t); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d; };

function textoWhatsapp(lead) {
  const sim = lead.simulacao ? JSON.parse(lead.simulacao) : null;
  const linhas = ['Olá! Acabei de fazer minha simulação de consórcio e quero entender melhor as opções disponíveis.', '',
    `Nome: ${lead.nome}`,
    `Tipo: ${{ imovel: 'Imóvel', veiculo: 'Veículo', outros: 'Outros' }[lead.tipo] || lead.tipo}`,
    `Crédito escolhido: ${brl(lead.credito)}`];
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
    pix: provider.nome === 'pix' && pg && status !== 'pago' ? brCodeDoPagamento(pg.id, pg.valor_centavos) : null,
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

  db.prepare(`UPDATE leads SET nome=?, email=?, telefone=?, cpf=?, nascimento=?, nome_mae=?, cidade=?, estado=?, tipo=?, credito=?,
      capacidade_label=?, capacidade_valor=?, parcela_escolhida=?, plano_id=?, simulacao=?, resultado=?, simulado_em=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      status=CASE WHEN status='aguardando_pagamento' THEN 'novo' ELSE status END WHERE id=?`)
    .run(nome, email, telefone, cpf, body.nascimento, String(body.nome_mae).trim(), cidade, estado, tipo, credito,
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

const FILTROS = { quentes: "interesse = 'agora'", mornos: "interesse = 'conversar'", frios: "interesse = 'depois'" };
route('GET', '/api/admin/leads', async (req, { url }) => {
  checkAdmin(req);
  const where = FILTROS[url.searchParams.get('filtro')];
  const rows = db.prepare(`
    SELECT l.id, l.nome, l.telefone, l.email, l.tipo, l.credito, l.capacidade_label, l.parcela_escolhida, l.resultado, l.interesse,
           l.status, l.criado_em, l.simulado_em, l.cpf, l.nascimento, l.nome_mae, l.cidade, l.estado,
           p.valor_centavos, p.status AS pagamento_status, p.pago_em
    FROM leads l LEFT JOIN pagamentos p ON p.id = (SELECT MAX(id) FROM pagamentos WHERE lead_id = l.id)
    WHERE ${where ? where : "(l.simulado_em IS NOT NULL OR p.status IN ('pago','informado'))"}
    ORDER BY l.id DESC LIMIT 1000`).all();
  return { leads: rows };
});

route('POST', '/api/admin/leads/:id/pagamento', async (req, { body, params }) => {
  checkAdmin(req);
  const pg = ultimoPagamento(Number(params.id));
  if (!pg) throw new HttpError(404, 'Pagamento não encontrado');
  if (body.acao === 'confirmar') marcarPago(pg.id);
  else if (body.acao === 'recusar') db.prepare("UPDATE pagamentos SET status='recusado' WHERE id=?").run(pg.id);
  else throw bad('Ação inválida');
  return { ok: true };
});

route('PATCH', '/api/admin/leads/:id', async (req, { body, params }) => {
  checkAdmin(req);
  if (!STATUS_LEAD.includes(body.status)) throw bad('Status inválido');
  db.prepare('UPDATE leads SET status=? WHERE id=?').run(body.status, Number(params.id));
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

route('GET', '/api/admin/config', async (req) => { checkAdmin(req); return getConfig(); });
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
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
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
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido');
      return serveStatic(req, res, decodeURIComponent(url.pathname));
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, await r.handler(req, { body, url, params: m.groups || {} }));
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
