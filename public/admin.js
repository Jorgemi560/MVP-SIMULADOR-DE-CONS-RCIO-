'use strict';
const $ = document.getElementById('adm');
const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SS = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignora */ } }, del(k) { try { sessionStorage.removeItem(k); } catch { /* ignora */ } } };
let token = SS.get('adm_token') || '';
let aba = 'leads';

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { token = ''; SS.del('adm_token'); login(); throw new Error('Sessão expirada'); }
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
      token = r.token; SS.set('adm_token', token); shell();
    } catch (err) { e.target.querySelector('.msg').textContent = err.message; }
  };
}

function shell() {
  $.innerHTML = `<div class="tabs">
    ${[['leads', 'Leads'], ['planos', 'Planos de Simulação'], ['config', 'Configurações']].map(([k, l]) => `<button class="tab ${aba === k ? 'on' : ''}" data-aba="${k}">${l}</button>`).join('')}
    <span class="sp"></span><button class="tab" id="sair">Sair</button></div><div id="conteudo"></div>`;
  $.querySelectorAll('[data-aba]').forEach((b) => b.onclick = () => { aba = b.dataset.aba; shell(); });
  document.getElementById('sair').onclick = () => { token = ''; SS.del('adm_token'); login(); };
  ({ leads: viewLeads, planos: viewPlanos, config: viewConfig })[aba]();
}

// ---------- LEADS ----------
const FILTROS = [['todos', 'Todos'], ['quentes', 'Quentes — quero fazer agora'], ['mornos', 'Mornos — quero conversar'], ['frios', 'Frios — ainda não']];
const INTERESSE = { agora: 'Quero fazer agora', conversar: 'Quero conversar', depois: 'Ainda não' };
const STATUS = { aguardando_pagamento: 'Aguardando pagamento', novo: 'Novo', contatado: 'Contatado', convertido: 'Convertido', perdido: 'Perdido' };
const SITUACAO = { pago: 'Pago', informado: 'A conferir', pendente: 'Pendente', expirado: 'Pix expirado', recusado: 'Não confirmado', cancelado: 'Cancelado' };
const tel = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d; };
const dt = (s) => s ? new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) : '—';
const badgePag = (st) => `<span class="badge ${st === 'pago' ? 'pago' : st === 'informado' ? 'conversar' : ''}">${esc(SITUACAO[st] || st || '—')}</span>`;
const F = { filtro: 'todos', q: '', de: '', ate: '', pagamento: '' }; // filtros atuais do painel

const qs = () => new URLSearchParams(Object.entries(F).filter(([, v]) => v && v !== 'todos')).toString();
function abrirBlob(blob, nome, abrir) {
  const url = URL.createObjectURL(blob);
  if (abrir) { const w = window.open(url, '_blank'); if (w) return; }
  const a = document.createElement('a'); a.href = url; a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function baixar(caminho, nome, tipo, abrir) {
  const r = await fetch(caminho, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('Não foi possível gerar o arquivo');
  abrirBlob(new Blob([await r.arrayBuffer()], { type: tipo }), nome, abrir);
}

async function viewLeads() {
  const c = document.getElementById('conteudo');
  c.innerHTML = `<div id="alertas"></div>
    <div class="tabs no-print">${FILTROS.map(([k, l]) => `<button class="tab ${F.filtro === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="filtros no-print">
      <div class="field"><label for="q">Buscar</label><input id="q" type="search" placeholder="Nome, telefone ou e-mail" value="${esc(F.q)}" autocomplete="off"></div>
      <div class="field"><label for="de">Cadastro de</label><input id="de" type="date" value="${esc(F.de)}"></div>
      <div class="field"><label for="ate">até</label><input id="ate" type="date" value="${esc(F.ate)}"></div>
      <div class="field"><label for="pag">Pagamento</label><select id="pag"><option value="">Todos</option>${Object.entries(SITUACAO).map(([k, v]) => `<option value="${k}" ${F.pagamento === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="acoes no-print"><button class="btn sm ghost" id="csv">Exportar CSV</button><button class="btn sm ghost" id="imprimir">Imprimir lista</button><button class="btn sm ghost" id="limpar">Limpar filtros</button><span id="contagem" class="muted"></span></div>
    <div class="print-only"><h2>Relatório de leads</h2><p id="print-info"></p></div>
    <div class="tbl-wrap" id="tb">Carregando…</div>`;
  c.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { F.filtro = b.dataset.f; viewLeads(); });
  let t; const ao = (id, k) => document.getElementById(id).addEventListener('input', (e) => { F[k] = e.target.value; clearTimeout(t); t = setTimeout(carregarLeads, 300); });
  ao('q', 'q'); ao('de', 'de'); ao('ate', 'ate'); ao('pag', 'pagamento');
  document.getElementById('limpar').onclick = () => { Object.assign(F, { filtro: 'todos', q: '', de: '', ate: '', pagamento: '' }); viewLeads(); };
  document.getElementById('csv').onclick = () => baixar(`/api/admin/leads.csv?${qs()}`, 'leads.csv', 'text/csv', false).catch((e) => alert(e.message));
  document.getElementById('imprimir').onclick = () => window.print();
  mostrarAlertas();
  carregarLeads();
}

async function mostrarAlertas() {
  try {
    const st = await api('/api/admin/status'), el = document.getElementById('alertas'); if (!el) return;
    const av = [], info = [];
    if (st.pagamento.provedor === 'pix' && !st.pagamento.pronto) av.push('<b>Pagamento indisponível:</b> defina <code>PIX_CHAVE</code> e <code>PIX_RECEBEDOR</code> nas variáveis do Render. Enquanto isso, ninguém consegue pagar.');
    else if (st.pagamento.conta) info.push(`<b>Conta que recebe os pagamentos Pix:</b> ${esc(st.pagamento.conta.recebedor)} · chave ${esc(st.pagamento.conta.chave)}. Confira se é a conta correta; o titular é definido pela chave Pix (<code>PIX_CHAVE</code>).`);
    if (!st.banco.persistente) av.push('<b>Atenção:</b> o banco de dados atual é local e não persistente (somente para testes). Os leads seriam perdidos. Defina <code>DATABASE_URL</code> com o PostgreSQL externo.');
    if (st.senhaFraca) av.push('A senha do painel tem menos de 10 caracteres. Troque a variável <code>ADMIN_PASSWORD</code> por uma mais forte.');
    if (st.pagamento.confirmacao === 'manual' && st.aConferir) av.push(`<b>${st.aConferir} pagamento(s) a conferir.</b> Confira o recebimento no extrato do banco e confirme no cadastro do lead. O cliente só é liberado depois da confirmação.`);
    el.innerHTML = info.map((m) => `<div class="alerta info">${m}</div>`).join('') + av.map((m) => `<div class="alerta ${/Pagamento indisponível/.test(m) ? 'erro' : ''}">${m}</div>`).join('');
  } catch { /* alertas são opcionais */ }
}

async function carregarLeads() {
  const tb = document.getElementById('tb'); if (!tb) return;
  let r;
  try { r = await api(`/api/admin/leads?${qs()}`); } catch (e) { tb.innerHTML = `<p class="loading">${esc(e.message)}</p>`; return; }
  const { leads, total } = r;
  document.getElementById('contagem').textContent = total > leads.length ? `Mostrando ${leads.length} de ${total} leads (refine os filtros)` : `${total} lead(s)`;
  document.getElementById('print-info').textContent = `Emitido em ${dt(new Date().toISOString())} · ${total} lead(s)${F.q ? ` · busca: ${F.q}` : ''}${F.pagamento ? ` · pagamento: ${SITUACAO[F.pagamento]}` : ''}${F.de ? ` · de ${F.de}` : ''}${F.ate ? ` · até ${F.ate}` : ''}`;
  if (!leads.length) { tb.innerHTML = '<p class="loading">Nenhum lead encontrado.</p>'; return; }
  tb.innerHTML = `<table><thead><tr><th>Nome</th><th>Telefone / WhatsApp</th><th>E-mail</th><th class="np">Tipo</th><th>Renda mensal</th><th>Crédito desejado</th><th class="np">Capacidade mensal</th><th class="np">Parcela escolhida</th><th class="np">Resultado</th><th class="np">Interesse</th><th>Data</th><th>Pagamento</th><th class="np">Status</th></tr></thead><tbody>
  ${leads.map((l) => `<tr class="lead" data-id="${l.id}"><td><b>${esc(l.nome)}</b></td>
    <td><a href="https://wa.me/55${esc(l.telefone)}" target="_blank" rel="noopener">${esc(tel(l.telefone))}</a></td>
    <td>${esc(l.email)}</td><td class="np">${esc(l.tipo || '—')}</td><td>${l.renda_mensal ? brl(l.renda_mensal) : '—'}</td><td>${l.credito ? brl(l.credito) : '—'}</td><td class="np">${esc(l.capacidade_label || '—')}</td>
    <td class="np">${esc(l.parcela_escolhida || '—')}</td><td class="np">${esc(l.resultado || '—')}</td>
    <td class="np">${l.interesse ? `<span class="badge ${l.interesse}">${INTERESSE[l.interesse]}</span>` : '—'}</td><td>${dt(l.simulado_em || l.criado_em)}</td>
    <td>${badgePag(l.pagamento_status)}</td><td class="np"><select data-st="${l.id}" aria-label="Status do lead">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === l.status ? 'selected' : ''}>${v}</option>`).join('')}</select></td></tr>
    <tr class="det" id="d${l.id}" hidden><td colspan="13">Carregando…</td></tr>`).join('')}
  </tbody></table>`;
}

function detalheHtml(r) {
  const l = r.lead, sim = r.simulacao;
  const pagBtns = l.pagamento_status === 'informado'
    ? ` <button class="btn sm" data-pg="confirmar" data-lead="${l.id}">Confirmar recebimento</button> <button class="btn sm ghost" data-pg="recusar" data-lead="${l.id}">Não recebi</button>`
    : ['pendente', 'expirado', 'recusado'].includes(l.pagamento_status) ? ` <button class="btn sm ghost" data-pg="confirmar" data-lead="${l.id}">Marcar como pago</button>` : '';
  const historico = (r.tentativas || []).length > 1 || (r.tentativas || []).some((t) => t.status === 'expirado') ? `
  <div class="hist"><b>Tentativas de pagamento (${r.tentativas.length})</b>
    <table><thead><tr><th>Nº</th><th>Criada em</th><th>Validade</th><th>Situação</th><th>Pago em</th><th class="no-print"></th></tr></thead><tbody>
    ${r.tentativas.map((t, i) => `<tr><td>${r.tentativas.length - i}</td><td>${dt(t.criado_em)}</td><td>${t.expira_em ? dt(t.expira_em) : '—'}</td><td>${badgePag(t.status)}</td><td>${dt(t.pago_em)}</td>
      <td class="no-print">${t.status === 'pago' ? '' : `<button class="btn sm ghost" data-pg="confirmar" data-pagto="${t.id}">Marcar como pago</button>`}</td></tr>`).join('')}
    </tbody></table></div>` : '';
  return `<dl>
    <div><dt>Telefone / WhatsApp</dt><dd>${esc(tel(l.telefone))}</dd></div><div><dt>E-mail</dt><dd>${esc(l.email)}</dd></div>
    <div><dt>Renda mensal</dt><dd>${l.renda_mensal ? brl(l.renda_mensal) : '—'}</dd></div><div><dt>Crédito desejado</dt><dd>${l.credito ? brl(l.credito) : '—'}</dd></div>
    <div><dt>Capacidade mensal informada</dt><dd>${esc(l.capacidade_label || '—')}</dd></div>
    <div><dt>Plano / prazo</dt><dd>${sim ? `${esc(sim.plano)} · ${sim.prazo} meses` : '—'}</dd></div>
    <div><dt>Parcela integral</dt><dd>${sim?.parcelaIntegral != null ? brl(sim.parcelaIntegral) : '—'}</dd></div><div><dt>Parcela reduzida</dt><dd>${sim?.parcelaReduzida != null ? brl(sim.parcelaReduzida) : '—'}</dd></div>
    <div><dt>CPF</dt><dd>${esc(l.cpf || '—')}</dd></div><div><dt>Nascimento</dt><dd>${esc(l.nascimento || '—')}</dd></div>
    <div><dt>Nome da mãe</dt><dd>${esc(l.nome_mae || '—')}</dd></div><div><dt>Cidade/UF</dt><dd>${esc(l.cidade || '—')} / ${esc(l.estado || '—')}</dd></div>
    <div><dt>Pagamento</dt><dd>${badgePag(l.pagamento_status)} ${l.valor_centavos != null ? brl(l.valor_centavos / 100) : ''}${pagBtns}</dd></div>
    <div><dt>Pago/confirmado em</dt><dd>${dt(l.pago_em)}</dd></div><div><dt>Cadastro</dt><dd>${dt(l.criado_em)}</dd></div><div><dt>Simulação</dt><dd>${dt(l.simulado_em)}</dd></div>
  </dl>${historico}<p class="no-print"><button class="btn sm" data-pdf="${l.id}">Gerar PDF / imprimir</button> <button class="btn sm ghost" data-excluir="${l.id}">Excluir cadastro…</button></p>
  <div class="excluir-box no-print" id="ex${l.id}" hidden>
    <p><b>Excluir os dados pessoais de ${esc(l.nome)}?</b> Esta ação é <b>definitiva e não pode ser desfeita</b>. Serão apagados nome, WhatsApp, e-mail, CPF, nascimento, nome da mãe, cidade, renda e a simulação. Fica apenas o registro financeiro do pagamento, sem identificação, e um registro de que a exclusão ocorreu.</p>
    <div class="form-grid">
      <div class="field"><label for="mt${l.id}">Motivo</label><select id="mt${l.id}"><option value="solicitacao_titular">Solicitação do titular dos dados</option><option value="cadastro_duplicado_ou_teste">Cadastro duplicado ou de teste</option><option value="outro">Outro</option></select></div>
      <div class="field"><label for="cf${l.id}">Para confirmar, digite EXCLUIR</label><input id="cf${l.id}" data-confirma="${l.id}" autocomplete="off" placeholder="EXCLUIR"></div>
    </div>
    <p class="muted">Não é necessário digitar dados pessoais em nenhum campo. O que já foi baixado (CSV, PDF) e a conversa no WhatsApp ficam fora do sistema e precisam ser apagados à parte.</p>
    <button class="btn sm danger" data-excluir-ok="${l.id}" disabled>Excluir definitivamente</button> <button class="btn sm ghost" data-excluir-cancela="${l.id}">Cancelar</button>
  </div>`;
}

// Eventos da tabela (delegação; o CSP do site bloqueia atributos onclick inline)
document.addEventListener('click', async (e) => {
  const tb = e.target.closest('#tb'); if (!tb) return;
  const btn = e.target.closest('button[data-pg], button[data-pdf], button[data-excluir], button[data-excluir-ok], button[data-excluir-cancela]');
  try {
    if (btn?.dataset.pg) {
      const rota = btn.dataset.pagto ? `/api/admin/pagamentos/${btn.dataset.pagto}` : `/api/admin/leads/${btn.dataset.lead}/pagamento`;
      if (btn.dataset.pagto && !confirm('Confirmar que este pagamento foi RECEBIDO na conta? Isso libera a simulação do cliente.')) return;
      await api(rota, { method: 'POST', body: { acao: btn.dataset.pg } });
      return viewLeads();
    }
    if (btn?.dataset.excluir) { const bx = document.getElementById(`ex${btn.dataset.excluir}`); bx.hidden = false; bx.querySelector('input').focus(); return; }
    if (btn?.dataset.excluirCancela) { const bx = document.getElementById(`ex${btn.dataset.excluirCancela}`); bx.hidden = true; bx.querySelector('input').value = ''; bx.querySelector('[data-excluir-ok]').disabled = true; return; }
    if (btn?.dataset.excluirOk) {
      const id = btn.dataset.excluirOk; btn.disabled = true;
      await api(`/api/admin/leads/${id}`, { method: 'DELETE', body: { confirmar: document.getElementById(`cf${id}`).value.trim(), motivo: document.getElementById(`mt${id}`).value } });
      return viewLeads();
    }
    if (btn?.dataset.pdf) {
      const id = btn.dataset.pdf; btn.disabled = true;
      try { await baixar(`/api/admin/leads/${id}.pdf`, `simulacao-${String(id).padStart(5, '0')}.pdf`, 'application/pdf', true); } finally { btn.disabled = false; }
      return;
    }
  } catch (err) { return alert(err.message); }
  if (e.target.closest('a, select, button')) return;
  const tr = e.target.closest('tr.lead'); if (!tr) return;
  const det = document.getElementById(`d${tr.dataset.id}`);
  det.hidden = !det.hidden;
  if (!det.hidden && !det.dataset.ok) {
    try { det.firstElementChild.innerHTML = detalheHtml(await api(`/api/admin/leads/${tr.dataset.id}`)); det.dataset.ok = '1'; }
    catch (err) { det.firstElementChild.textContent = err.message; }
  }
});
document.addEventListener('input', (e) => {
  const inp = e.target.closest('input[data-confirma]'); if (!inp) return;
  inp.closest('.excluir-box').querySelector('[data-excluir-ok]').disabled = inp.value.trim() !== 'EXCLUIR';
});
document.addEventListener('change', (e) => {
  const sel = e.target.closest('#tb select[data-st]');
  if (sel) api(`/api/admin/leads/${sel.dataset.st}`, { method: 'PATCH', body: { status: sel.value } }).catch((err) => alert(err.message));
});

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
    <div class="field"><label>Arredondamento da parcela</label><select name="arredondamento">${[['cortar', 'Cortar centavos'], ['arredondar', 'Arredondar ao centavo'], ['cortar_menos_1', 'Cortar e subtrair 1 centavo']].map(([k, l]) => `<option value="${k}" ${(p.arredondamento || 'cortar') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
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
  const novo = { nome: '', tipo: 'imovel', prazo: 180, taxa_admin: 20, fundo_reserva: 2, seguro: 0.04, indice: 'IPCA', reduzida: 0, reducao_pct: 0, reducao_regra: 'fundo_comum', reducao_meses: 0, arredondamento: 'cortar', regra_texto: '', credito_min: 50000, credito_max: 500000, ativo: 1 };
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
    <p class="note">Número em uso agora: <b>${esc(cfg.whatsapp_em_uso)}</b>${cfg.whatsapp_origem === 'padrao' ? ' (número padrão do sistema, nenhum foi salvo aqui; confirme se é o do especialista ou informe o correto acima)' : ''}.</p>
    <button class="btn sm">Salvar</button><p class="msg"></p></form>`;
  document.getElementById('f-cfg').onsubmit = async (e) => {
    e.preventDefault(); const m = e.target.querySelector('.msg');
    try { await api('/api/admin/config', { method: 'PUT', body: { whatsapp: e.target.whatsapp.value, learn_url: e.target.learn_url.value } }); m.className = 'ok-msg'; m.textContent = 'Salvo!'; }
    catch (err) { m.className = 'msg'; m.textContent = err.message; }
  };
}

token ? shell() : login();
