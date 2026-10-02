'use strict';
const $ = document.getElementById('adm');
const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = sessionStorage.getItem('adm_token') || '';
let aba = 'leads', filtro = 'todos';

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { token = ''; sessionStorage.removeItem('adm_token'); login(); throw new Error('Sessão expirada'); }
  if (!r.ok) throw new Error(data.erro || 'Erro');
  return data;
}

function login(msg = '') {
  $.innerHTML = `<form class="card login" id="f-login"><h2>Acesso administrativo</h2>
    <div class="field" style="margin-top:12px"><label>Senha</label><input type="password" name="senha" autocomplete="current-password" autofocus></div>
    <button class="btn">ENTRAR</button><p class="msg">${esc(msg)}</p></form>`;
  document.getElementById('f-login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { senha: e.target.senha.value } });
      token = r.token; sessionStorage.setItem('adm_token', token); shell();
    } catch (err) { e.target.querySelector('.msg').textContent = err.message; }
  };
}

function shell() {
  $.innerHTML = `<div class="tabs">
    ${[['leads', 'Leads'], ['planos', 'Planos de Simulação'], ['config', 'Configurações']].map(([k, l]) => `<button class="tab ${aba === k ? 'on' : ''}" data-aba="${k}">${l}</button>`).join('')}
    <span class="sp"></span><button class="tab" id="sair">Sair</button></div><div id="conteudo"></div>`;
  $.querySelectorAll('[data-aba]').forEach((b) => b.onclick = () => { aba = b.dataset.aba; shell(); });
  document.getElementById('sair').onclick = () => { token = ''; sessionStorage.removeItem('adm_token'); login(); };
  ({ leads: viewLeads, planos: viewPlanos, config: viewConfig })[aba]();
}

// ---------- LEADS ----------
const FILTROS = [['todos', 'Todos'], ['quentes', 'Quentes — quero fazer agora'], ['mornos', 'Mornos — quero conversar'], ['frios', 'Frios — ainda não']];
const INTERESSE = { agora: 'Quero fazer agora', conversar: 'Quero conversar', depois: 'Ainda não' };
const STATUS = { aguardando_pagamento: 'Aguardando pagamento', novo: 'Novo', contatado: 'Contatado', convertido: 'Convertido', perdido: 'Perdido' };
const tel = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d; };
const dt = (s) => s ? new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

async function viewLeads() {
  const c = document.getElementById('conteudo');
  c.innerHTML = `<div class="tabs">${FILTROS.map(([k, l]) => `<button class="tab ${filtro === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div><div class="tbl-wrap" id="tb">Carregando…</div>`;
  c.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { filtro = b.dataset.f; viewLeads(); });
  const { leads } = await api(`/api/admin/leads?filtro=${filtro}`);
  const tb = document.getElementById('tb');
  if (!leads.length) { tb.innerHTML = '<p class="loading">Nenhum lead neste filtro.</p>'; return; }
  tb.innerHTML = `<table><thead><tr><th>Nome</th><th>Telefone / WhatsApp</th><th>E-mail</th><th>Tipo</th><th>Crédito desejado</th><th>Capacidade mensal</th><th>Parcela escolhida</th><th>Resultado</th><th>Interesse</th><th>Data</th><th>Pagamento</th><th>Status</th></tr></thead><tbody>
  ${leads.map((l) => `<tr class="lead" data-id="${l.id}"><td><b>${esc(l.nome)}</b></td>
    <td><a href="https://wa.me/55${esc(l.telefone)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(tel(l.telefone))}</a></td>
    <td>${esc(l.email)}</td><td>${esc(l.tipo || '—')}</td><td>${l.credito ? brl(l.credito) : '—'}</td><td>${esc(l.capacidade_label || '—')}</td>
    <td>${esc(l.parcela_escolhida || '—')}</td><td>${esc(l.resultado || '—')}</td>
    <td>${l.interesse ? `<span class="badge ${l.interesse}">${INTERESSE[l.interesse]}</span>` : '—'}</td><td>${dt(l.simulado_em || l.criado_em)}</td>
    <td>${l.pagamento_status === 'informado' ? '<span class="badge conversar">conferir</span>' : `<span class="badge ${l.pagamento_status === 'pago' ? 'pago' : ''}">${esc(l.pagamento_status || '—')}</span>`}</td><td onclick="event.stopPropagation()"><select data-st="${l.id}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === l.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td></tr>
    <tr class="det" id="d${l.id}" hidden><td colspan="12"><dl>
      <div><dt>Telefone / WhatsApp</dt><dd>${esc(tel(l.telefone))}</dd></div><div><dt>CPF</dt><dd>${esc(l.cpf || '—')}</dd></div><div><dt>Nascimento</dt><dd>${esc(l.nascimento || '—')}</dd></div>
      <div><dt>Nome da mãe</dt><dd>${esc(l.nome_mae || '—')}</dd></div><div><dt>Cidade/UF</dt><dd>${esc(l.cidade || '—')} / ${esc(l.estado || '—')}</dd></div>
      <div><dt>Pagamento</dt><dd><span class="badge ${l.pagamento_status === 'pago' ? 'pago' : ''}">${esc(l.pagamento_status || '—')}</span> ${l.valor_centavos != null ? brl(l.valor_centavos / 100) : ''}${l.pagamento_status === 'informado' ? ` <button class="btn sm" data-pg="confirmar" data-lead="${l.id}">Confirmar recebimento</button> <button class="btn sm ghost" data-pg="recusar" data-lead="${l.id}">Não recebi</button>` : ''}</dd></div>
      <div><dt>Pago em</dt><dd>${dt(l.pago_em)}</dd></div><div><dt>Cadastro</dt><dd>${dt(l.criado_em)}</dd></div></dl></td></tr>`).join('')}
  </tbody></table>`;
  tb.querySelectorAll('tr.lead').forEach((tr) => tr.onclick = () => { const d = document.getElementById(`d${tr.dataset.id}`); d.hidden = !d.hidden; });
  tb.querySelectorAll('[data-pg]').forEach((b) => b.onclick = async (e) => { e.stopPropagation(); try { await api(`/api/admin/leads/${b.dataset.lead}/pagamento`, { method: 'POST', body: { acao: b.dataset.pg } }); viewLeads(); } catch (err) { alert(err.message); } });
  tb.querySelectorAll('[data-st]').forEach((s) => s.onchange = () => api(`/api/admin/leads/${s.dataset.st}`, { method: 'PATCH', body: { status: s.value } }).catch((e) => alert(e.message)));
}

// ---------- PLANOS ----------
const NUM = (name, label, v, step = 'any') => `<div class="field"><label>${label}</label><input name="${name}" type="number" step="${step}" min="0" value="${esc(v)}"></div>`;
function planoForm(p) {
  return `<form class="card plan-card" data-id="${p.id || ''}"><h3>${p.id ? esc(p.nome) : 'Novo plano'}</h3><div class="form-grid">
    <div class="field"><label>Nome do plano</label><input name="nome" value="${esc(p.nome)}"></div>
    <div class="field"><label>Tipo</label><select name="tipo">${[['imovel', 'Imóvel'], ['veiculo', 'Veículo'], ['outros', 'Outros']].map(([k, l]) => `<option value="${k}" ${p.tipo === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${NUM('prazo', 'Prazo (meses)', p.prazo, 1)}${NUM('taxa_admin', 'Taxa de administração (% total)', p.taxa_admin)}
    ${NUM('fundo_reserva', 'Fundo de reserva (% total)', p.fundo_reserva)}${NUM('seguro', 'Seguro (% ao mês s/ crédito)', p.seguro)}
    <div class="field"><label>Índice de atualização</label><select name="indice">${['INCC', 'IPCA', 'INPC', 'IGP-M', 'Outro'].map((i) => `<option ${p.indice === i ? 'selected' : ''}>${i}</option>`).join('')}</select></div>
    ${NUM('credito_min', 'Crédito mínimo (R$)', p.credito_min)}${NUM('credito_max', 'Crédito máximo (R$)', p.credito_max)}
    <div class="field"><label>Parcela reduzida</label><label class="chk"><input type="checkbox" name="reduzida" ${p.reduzida ? 'checked' : ''}> Oferecer parcela reduzida (somente imóvel)</label></div>
    ${NUM('reducao_pct', 'Percentual da redução (%)', p.reducao_pct)}
    <div class="field"><label>Regra da redução</label><select name="reducao_regra"><option value="fundo_comum" ${p.reducao_regra === 'fundo_comum' ? 'selected' : ''}>Reduz % somente do fundo comum (taxas integrais)</option><option value="parcela_total" ${p.reducao_regra === 'parcela_total' ? 'selected' : ''}>Reduz % da parcela total</option></select></div>
    ${NUM('reducao_meses', 'Período da redução (meses; 0 = sem prazo definido)', p.reducao_meses || 0, 1)}
    <div class="field" style="grid-column:1/-1"><label>Texto da regra (exibido ao cliente)</label><input name="regra_texto" value="${esc(p.regra_texto)}"></div>
    <div class="field"><label>Situação</label><label class="chk"><input type="checkbox" name="ativo" ${p.ativo ? 'checked' : ''}> Plano ativo</label></div>
  </div>
  <div class="actions"><button class="btn sm" data-a="salvar">Salvar</button><button class="btn sm ghost" data-a="testar">Testar cálculo (R$ 100.000)</button>${p.id ? '<button class="btn sm danger" data-a="excluir">Excluir</button>' : ''}</div>
  <p class="msg"></p><div class="prev" hidden></div></form>`;
}
function lerPlano(f) {
  const o = {}; for (const el of f.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return o;
}
async function viewPlanos() {
  const c = document.getElementById('conteudo');
  const { planos } = await api('/api/admin/planos');
  const novo = { nome: '', tipo: 'imovel', prazo: 180, taxa_admin: 20, fundo_reserva: 2, seguro: 0.04, indice: 'IPCA', reduzida: 0, reducao_pct: 0, reducao_regra: 'fundo_comum', reducao_meses: 0, regra_texto: '', credito_min: 50000, credito_max: 500000, ativo: 1 };
  c.innerHTML = `<p class="sub" style="margin-top:0">Cadastre apenas os <b>parâmetros</b> do plano. Qualquer valor de crédito dentro da faixa é calculado automaticamente.</p>
    <button class="btn sm" id="novo" style="margin-bottom:14px">+ Novo plano</button><div id="novoBox"></div>${planos.map(planoForm).join('')}`;
  document.getElementById('novo').onclick = () => { document.getElementById('novoBox').innerHTML = planoForm(novo); };
  c.onclick = async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return; e.preventDefault();
    const f = b.closest('form'), msg = f.querySelector('.msg'), prev = f.querySelector('.prev'), id = f.dataset.id;
    msg.className = 'msg'; msg.textContent = '';
    try {
      if (b.dataset.a === 'salvar') { await api(id ? `/api/admin/planos/${id}` : '/api/admin/planos', { method: id ? 'PUT' : 'POST', body: lerPlano(f) }); viewPlanos(); }
      if (b.dataset.a === 'excluir' && confirm('Excluir este plano?')) { await api(`/api/admin/planos/${id}`, { method: 'DELETE' }); viewPlanos(); }
      if (b.dataset.a === 'testar') {
        const r = await api('/api/admin/planos-teste', { method: 'POST', body: lerPlano(f) });
        prev.hidden = false;
        prev.innerHTML = `Crédito ${brl(r.credito)} em ${r.prazo}x — Fundo comum ${brl(r.fundoComum)} · Taxa adm. ${brl(r.taxaAdmin)} · Fundo reserva ${brl(r.fundoReserva)} · Seguro total ${brl(r.seguroTotal)}<br><b>Parcela integral ${brl(r.parcelaIntegral)}</b>${r.parcelaReduzida ? ` · <b>Parcela reduzida ${brl(r.parcelaReduzida)}</b>` : ''}`;
      }
    } catch (err) { msg.textContent = err.message; }
  };
}

// ---------- CONFIG ----------
async function viewConfig() {
  const c = document.getElementById('conteudo');
  const cfg = await api('/api/admin/config');
  c.innerHTML = `<form class="card" style="max-width:520px" id="f-cfg"><h3>Atendimento</h3>
    <div class="field" style="margin-top:10px"><label>WhatsApp do especialista (com DDD)</label><input name="whatsapp" value="${esc(cfg.whatsapp)}" placeholder="11999999999"></div>
    <div class="field"><label>Link do “Guia Consórcio Descomplicado” / página de conteúdo</label><input name="learn_url" value="${esc(cfg.learn_url)}" placeholder="https://..."></div>
    <button class="btn sm">Salvar</button><p class="msg"></p></form>`;
  document.getElementById('f-cfg').onsubmit = async (e) => {
    e.preventDefault(); const m = e.target.querySelector('.msg');
    try { await api('/api/admin/config', { method: 'PUT', body: { whatsapp: e.target.whatsapp.value, learn_url: e.target.learn_url.value } }); m.className = 'ok-msg'; m.textContent = 'Salvo!'; }
    catch (err) { m.className = 'msg'; m.textContent = err.message; }
  };
}

token ? shell() : login();
