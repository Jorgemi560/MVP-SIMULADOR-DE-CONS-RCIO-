'use strict';
const $app = document.getElementById('app');
const $prog = document.getElementById('progress');
const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digits = (s) => String(s || '').replace(/\D/g, '');

const CREDITOS = {
  imovel: [80000, 100000, 150000, 200000, 300000, 400000, 500000, 700000, 1000000],
  veiculo: [30000, 40000, 50000, 60000, 80000, 100000, 150000, 200000],
  outros: [10000, 20000, 30000, 50000, 80000, 100000, 150000, 200000],
};
const TIPOS = { imovel: ['🏠', 'Imóvel'], veiculo: ['🚗', 'Veículo'], outros: ['📦', 'Outros'] };
const CAPACIDADES = [
  ['Até R$500', 500], ['R$500 a R$1.000', 1000], ['R$1.000 a R$1.500', 1500],
  ['R$1.500 a R$2.000', 2000], ['R$2.000 a R$3.000', 3000], ['Acima de R$3.000', 5000],
];
const ETAPAS = ['Objetivo', 'Crédito', 'Seus dados', 'Simulação', 'Resultado'];
const ETAPA_DA_TELA = { tipo: 1, credito: 2, dados: 3, capacidade: 3, parcela: 3, processando: 4, resultado: 5, sim: 5, nao: 5 };
const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

// Estado persistido (sem dados sensíveis como CPF/nome da mãe)
const KEY = 'sc_state_v1';
let S = { tela: 'home', lead: null, tipo: null, credito: null, capacidade: null, parcela: null, resultado: null, contato: {} };
try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignora */ }
let sensivel = {}; // somente memória
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* ignora */ } };
const reset = () => { try { localStorage.removeItem(KEY); } catch { /* ignora */ } S = { tela: 'home', lead: null, tipo: null, credito: null, capacidade: null, parcela: null, resultado: null, contato: {} }; sensivel = {}; };

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.lead) headers['X-Lead-Token'] = S.lead.token;
  let r;
  try { r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('Sem conexão. Verifique sua internet e tente novamente.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.erro || 'Algo deu errado.'); e.status = r.status; throw e; }
  return data;
}

function go(tela) { S.tela = tela; save(); render(); window.scrollTo(0, 0); }

function renderProgress() {
  const n = ETAPA_DA_TELA[S.tela];
  $prog.hidden = !n;
  if (!n) return;
  $prog.innerHTML = ETAPAS.map((t, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'on' : ''}"><span>${i + 1} — ${t}</span></li>`).join('');
}

// ---- máscaras ----
const mask = {
  cpf: (v) => digits(v).slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'),
  tel: (v) => { const d = digits(v).slice(0, 11); return d.length > 10 ? d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3') : d.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3').replace(/-$/, ''); },
  moeda: (v) => { const d = digits(v).slice(0, 10); return d ? Number(d).toLocaleString('pt-BR') : ''; },
};
function bindMasks(root) {
  root.querySelectorAll('[data-mask]').forEach((el) => el.addEventListener('input', () => { el.value = mask[el.dataset.mask](el.value); }));
}
const setMsg = (root, t) => { const m = root.querySelector('.msg'); if (m) m.textContent = t || ''; };
async function busy(btn, fn) {
  const txt = btn.textContent; btn.disabled = true; btn.textContent = 'Aguarde…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = txt; }
}

// ---- telas ----
const T = {};

T.home = () => `
  <section class="screen center">
    <h1>Está pensando em fazer um consórcio de imóvel ou veículo?</h1>
    <p class="sub">Faça uma simulação personalizada e descubra uma estimativa da parcela para o crédito que você procura.</p>
    <div class="price-tag">SIMULAÇÃO PERSONALIZADA — <b>R$5</b></div>
    <button class="btn" data-act="comecar">FAZER MINHA SIMULAÇÃO POR R$5</button>
    <p class="hint">Leva menos de 2 minutos.</p>
  </section>`;

T.checkout = () => `
  <section class="screen">
    <button class="back" data-act="home">← Voltar</button>
    <h2>Quase lá! Seus dados de contato</h2>
    <p class="sub" style="margin-top:4px">Para liberar sua simulação, finalize o pagamento de <b>R$5</b> via Pix.</p>
    <form class="card" id="f-checkout" novalidate>
      <div class="field"><label for="nome">Nome completo</label><input id="nome" name="nome" autocomplete="name" value="${esc(S.contato.nome)}" required></div>
      <div class="field"><label for="tel">Telefone / WhatsApp</label><input id="tel" name="telefone" type="tel" data-mask="tel" inputmode="tel" autocomplete="tel-national" placeholder="(00) 00000-0000" maxlength="15" value="${esc(mask.tel(S.contato.telefone))}" required></div>
      <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" value="${esc(S.contato.email)}" required></div>
      <button class="btn" type="submit">IR PARA O PAGAMENTO</button>
      <p class="msg" role="alert"></p>
      <div class="secure">🔒 Pagamento seguro via Pix</div>
    </form>
  </section>`;

T.pagamento = () => `
  <section class="screen center">
    <h2>Pague R$5 para liberar sua simulação</h2>
    <div class="card" id="pay-box"><p class="loading">Gerando pagamento…</p></div>
    <p class="hint">Assim que o pagamento for confirmado, sua simulação é liberada automaticamente.</p>
  </section>`;

T.tipo = () => `
  <section class="screen">
    <h2>O que você pretende adquirir?</h2>
    <p class="sub" style="margin-top:4px">Toque em uma opção.</p>
    <div class="grid">
      ${Object.entries(TIPOS).map(([k, [e, l]]) => `<button class="choice" data-act="tipo" data-v="${k}"><span class="em">${e}</span>${l.toUpperCase()}</button>`).join('')}
    </div>
  </section>`;

T.credito = () => `
  <section class="screen">
    <button class="back" data-act="tipo-volta">← Voltar</button>
    <h2>Qual valor de crédito você procura?</h2>
    <div class="grid two" style="margin-top:16px">
      ${CREDITOS[S.tipo].map((v) => `<button class="choice chip" data-act="credito" data-v="${v}">${brl(v).replace(',00', '')}</button>`).join('')}
    </div>
    <div class="other">
      <label for="outro">OUTRO VALOR</label>
      <div class="row"><input id="outro" data-mask="moeda" inputmode="numeric" placeholder="Digite o valor (R$)"><button class="btn sm" data-act="credito-outro" style="flex:0 0 auto">Continuar</button></div>
      <p class="msg" role="alert"></p>
    </div>
  </section>`;

const optsUF = (sel) => `<option value="">UF</option>${UFS.map((u) => `<option ${u === sel ? 'selected' : ''}>${u}</option>`).join('')}`;
T.dados = () => {
  const d = { ...S.contato, ...sensivel };
  return `
  <section class="screen">
    <button class="back" data-act="credito-volta">← Voltar</button>
    <h2>Agora vamos preparar sua simulação personalizada.</h2>
    <form class="card" id="f-dados" novalidate style="margin-top:14px">
      <div class="field"><label for="nome">Nome completo</label><input id="nome" name="nome" autocomplete="name" value="${esc(d.nome)}"></div>
      <div class="field"><label for="tel">Telefone / WhatsApp</label><input id="tel" name="telefone" type="tel" data-mask="tel" inputmode="tel" autocomplete="tel-national" placeholder="(00) 00000-0000" maxlength="15" value="${esc(mask.tel(d.telefone))}"></div>
      <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" value="${esc(d.email)}"></div>
      <div class="row">
        <div class="field" style="flex:2"><label for="cidade">Cidade</label><input id="cidade" name="cidade" autocomplete="address-level2" value="${esc(d.cidade)}"></div>
        <div class="field"><label for="uf">Estado</label><select id="uf" name="estado" autocomplete="address-level1">${optsUF(d.estado)}</select></div>
      </div>
      <div class="field"><label for="cpf">CPF</label><input id="cpf" name="cpf" data-mask="cpf" inputmode="numeric" placeholder="000.000.000-00" value="${esc(mask.cpf(d.cpf))}"></div>
      <div class="field"><label for="nasc">Data de nascimento</label><input id="nasc" name="nascimento" type="date" autocomplete="bday" value="${esc(d.nascimento)}"></div>
      <div class="field"><label for="mae">Nome da mãe</label><input id="mae" name="nome_mae" value="${esc(d.nome_mae)}"></div>
      <p class="note">Seus dados serão utilizados para preparar sua simulação e, caso você solicite atendimento, para que um especialista possa entrar em contato.</p>
      <button class="btn" type="submit">CONTINUAR</button>
      <p class="msg" role="alert"></p>
    </form>
  </section>`;
};

T.capacidade = () => `
  <section class="screen">
    <button class="back" data-act="dados">← Voltar</button>
    <h2>Quanto você pretende investir por mês?</h2>
    <div class="grid two" style="margin-top:16px">
      ${CAPACIDADES.map(([l, v]) => `<button class="choice chip" data-act="cap" data-l="${esc(l)}" data-v="${v}">${l}</button>`).join('')}
    </div>
    <div class="other">
      <label for="outro">Outro valor mensal</label>
      <div class="row"><input id="outro" data-mask="moeda" inputmode="numeric" placeholder="Digite o valor (R$)"><button class="btn sm" data-act="cap-outro" style="flex:0 0 auto">Continuar</button></div>
      <p class="msg" role="alert"></p>
    </div>
  </section>`;

T.parcela = () => `
  <section class="screen">
    <h2>Como você gostaria de visualizar sua simulação?</h2>
    <div class="grid" style="margin-top:16px">
      <button class="choice int" data-act="parcela" data-v="integral"><span class="em">🔵</span><span>PARCELA INTEGRAL<small>Valor completo do plano</small></span></button>
      <button class="choice red" data-act="parcela" data-v="reduzida"><span class="em">🟢</span><span>PARCELA REDUZIDA<small>Parcela menor até a contemplação, conforme regra do plano</small></span></button>
    </div>
    <p class="msg" role="alert"></p>
  </section>`;

const PASSOS = ['Analisando valor desejado', 'Calculando cenário de parcela', 'Verificando informações fornecidas', 'Preparando seu resultado'];
T.processando = () => `
  <section class="screen">
    <h2 class="center">Preparando sua simulação...</h2>
    <ul class="steps" id="steps">${PASSOS.map((p) => `<li><i>✓</i>${p}</li>`).join('')}</ul>
    <p class="msg center" role="alert"></p>
  </section>`;

T.resultado = () => {
  const r = S.resultado;
  const rotulo = { imovel: 'Imóvel', veiculo: 'Veículo', outros: 'Outros' }[r.tipo];
  return `
  <section class="screen">
    <div class="result">
      <div class="party">🎉</div>
      <h2>SUA SIMULAÇÃO ESTÁ PRONTA!</h2>
      <p class="hi">Olá, ${esc(r.primeiroNome)}!</p>
      <div class="kv"><span>Crédito desejado</span><b>${brl(r.credito)}</b></div>
      <div class="kv"><span>Modalidade</span><b>${rotulo}</b></div>
      ${r.disponivel ? `
        <div class="big"><small>Parcela estimada</small><strong>${brl(r.parcelaIntegral)}</strong></div>
        ${r.parcelaReduzida ? `<div class="big red"><small>Parcela reduzida</small><strong>${brl(r.parcelaReduzida)}</strong></div>${r.regraReducao ? `<p class="fine">${esc(r.regraReducao)}</p>` : ''}${r.reducaoMeses ? `<p class="fine">Redução válida por ${r.reducaoMeses} meses.</p>` : ''}` : ''}
        <div class="kv"><span>Prazo</span><b>${r.prazo} meses</b></div>
      ` : `<div class="big"><strong style="font-size:1.2rem">Para este valor, um especialista vai preparar a simulação sob medida.</strong></div>`}
      <p class="fine">Os valores apresentados são estimativos e podem variar conforme o plano, grupo e condições vigentes${r.indice ? `, além do reajuste pelo ${esc(r.indice)}` : ''}. A proposta definitiva será apresentada por um especialista. Esta simulação não representa aprovação de crédito nem garantia de contemplação.</p>
    </div>
    <div class="qual center">
      <h2>Parabéns!</h2>
      <p class="sub" style="margin:6px 0 0">Com base nas informações fornecidas, você pode avançar para uma análise personalizada de consórcio.</p>
      ${r.whatsappUrl ? `<a class="btn" id="btn-especialista" href="${esc(r.whatsappUrl)}" target="_blank" rel="noopener" style="margin-top:16px">QUERO FALAR COM UM ESPECIALISTA</a>` : ''}
    </div>
    <div class="card center" style="margin-top:18px">
      <h2 style="font-size:1.2rem">Você tem interesse em fazer seu consórcio ainda hoje?</h2>
      <div class="grid" style="margin-top:14px">
        <button class="btn" data-act="intent" data-v="agora">🟢 SIM, QUERO FAZER AGORA</button>
        <button class="btn ghost" data-act="intent" data-v="depois">⚪ AINDA NÃO</button>
      </div>
      <p class="msg" role="alert"></p>
    </div>
  </section>`;
};

T.sim = () => `
  <section class="screen center">
    <div class="party" style="font-size:3rem">🤝</div>
    <h2>Perfeito! Vamos colocar você em contato com um especialista para verificar as opções disponíveis para o seu perfil.</h2>
    <div style="margin-top:22px">
      ${S.wa ? `<a class="btn" href="${esc(S.wa)}" target="_blank" rel="noopener">FALAR COM ESPECIALISTA NO WHATSAPP</a>`
        : `<p class="note">Nosso atendimento via WhatsApp ainda não está configurado. Um especialista entrará em contato pelo número informado.</p>`}
    </div>
  </section>`;

T.nao = () => `
  <section class="screen center">
    <h2>Sem problema. Antes de decidir, você pode entender melhor como funciona o consórcio.</h2>
    <div style="margin-top:22px">
      <button class="btn blue" data-act="entender">QUERO ENTENDER MELHOR</button>
      <p class="msg" role="alert"></p>
    </div>
  </section>`;

// ---- ações ----
const A = {};
A.comecar = () => go(S.lead ? 'pagamento' : 'checkout');
A.home = () => go('home');
A.tipo = (el) => { S.tipo = el.dataset.v; S.credito = null; go('credito'); };
A['tipo-volta'] = () => go('tipo');
A['credito-volta'] = () => go('credito');
A.dados = () => go('dados');
A.credito = (el) => { S.credito = Number(el.dataset.v); go('dados'); };
A['credito-outro'] = () => {
  const v = Number(digits($app.querySelector('#outro').value));
  if (!(v >= 1000)) return setMsg($app, 'Informe um valor a partir de R$ 1.000.');
  S.credito = v; go('dados');
};
A.cap = (el) => { S.capacidade = { label: el.dataset.l, valor: Number(el.dataset.v) }; return escolherParcela(); };
A['cap-outro'] = () => {
  const v = Number(digits($app.querySelector('#outro').value));
  if (!(v >= 50)) return setMsg($app, 'Informe quanto pretende investir por mês.');
  S.capacidade = { label: brl(v), valor: v }; return escolherParcela();
};
async function escolherParcela() {
  try {
    const info = await api(`/api/plano-info?tipo=${S.tipo}&credito=${S.credito}`);
    if (info.reduzida) return go('parcela');
  } catch { /* sem info: segue com integral */ }
  S.parcela = 'integral'; go('processando');
}
A.parcela = (el) => { S.parcela = el.dataset.v; go('processando'); };

A.intent = async (el) => {
  await busy(el, async () => {
    try {
      const r = await api(`/api/lead/${S.lead.id}/interesse`, { method: 'POST', body: { interesse: el.dataset.v } });
      S.wa = r.whatsappUrl; S.learn = r.learnUrl;
      go(el.dataset.v === 'agora' ? 'sim' : 'nao');
    } catch (e) { setMsg($app, e.message); }
  });
};
A.entender = async (el) => {
  await busy(el, async () => {
    let learn = S.learn;
    try { const r = await api(`/api/lead/${S.lead.id}/interesse`, { method: 'POST', body: { interesse: 'conversar' } }); learn = r.learnUrl; } catch (e) { return setMsg($app, e.message); }
    if (learn) window.location.href = learn;
    else setMsg($app, 'Em breve disponibilizaremos nosso guia. Obrigado pelo interesse!');
  });
};

// ---- formulários ----
function lerForm(form) { return Object.fromEntries(new FormData(form).entries()); }
function marcarErro(form, nomes) { form.querySelectorAll('.err').forEach((e) => e.classList.remove('err')); nomes.forEach((n) => form.elements[n]?.classList.add('err')); form.elements[nomes[0]]?.focus(); }

async function enviarCheckout(form) {
  const d = lerForm(form);
  S.contato = { nome: d.nome.trim(), telefone: digits(d.telefone), email: d.email.trim() };
  const btn = form.querySelector('button[type=submit]');
  await busy(btn, async () => {
    try {
      const r = await api('/api/checkout', { method: 'POST', body: S.contato });
      S.lead = { id: r.leadId, token: r.token }; S.pix = r.pix; S.mock = r.mock;
      go('pagamento');
    } catch (e) { setMsg(form, e.message); }
  });
}

const VALIDACOES = {
  cpf: (v) => { const c = digits(v); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false; for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); if (((s * 10) % 11) % 10 !== +c[n]) return false; } return true; },
};
function enviarDados(form) {
  const d = lerForm(form); d.telefone = digits(d.telefone); d.cpf = digits(d.cpf);
  const erros = [];
  if (d.nome.trim().length < 3) erros.push('nome');
  if (!/^[1-9]{2}9?\d{8}$/.test(d.telefone)) erros.push('telefone');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) erros.push('email');
  if (!VALIDACOES.cpf(d.cpf)) erros.push('cpf');
  if (!d.nascimento) erros.push('nascimento');
  if (d.nome_mae.trim().length < 3) erros.push('nome_mae');
  if (d.cidade.trim().length < 2) erros.push('cidade');
  if (!d.estado) erros.push('estado');
  sensivel = d;
  if (erros.length) { marcarErro(form, erros); return setMsg(form, 'Confira os campos destacados.'); }
  S.contato = { nome: d.nome.trim(), telefone: d.telefone, email: d.email.trim() };
  go('capacidade');
}

// ---- telas com lógica própria ----
async function montarPagamento() {
  const box = document.getElementById('pay-box');
  const qrSvg = (txt) => { try { const q = qrcode(0, 'M'); q.addData(txt); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { return ''; } };
  const pintar = () => {
    const pix = S.pix;
    box.innerHTML = `
      <span class="pill">Valor: R$ 5,00</span>
      ${pix?.qrBase64 ? `<img class="qr" alt="QR Code Pix" src="data:image/png;base64,${esc(pix.qrBase64)}">` : ''}
      ${pix?.copiaECola && !pix.qrBase64 ? `<div class="qr" role="img" aria-label="QR Code Pix">${qrSvg(pix.copiaECola)}</div>` : ''}
      ${pix?.recebedor ? `<p class="hint" style="margin:0 0 4px">Recebedor: <b>${esc(pix.recebedor)}</b><br>CNPJ ${esc(pix.cnpj)}</p>` : ''}
      ${pix?.copiaECola ? `<p style="font-size:.9rem;margin-top:6px">Pix copia e cola:</p><div class="copy">${esc(pix.copiaECola)}</div><button class="btn ghost" data-act="copiar">COPIAR CÓDIGO PIX</button>` : ''}
      ${S.pix?.recebedor ? `<button class="btn" data-act="paguei" style="margin-top:10px">JÁ FIZ O PAGAMENTO</button><p class="hint">Abra o app do seu banco, escolha Pix → Pix copia e cola (ou leia o QR Code), pague R$ 5,00 e volte aqui.</p>` : ''}
      ${S.mock ? `<div class="test"><b>Modo de teste:</b> nenhum pagamento real é cobrado. Em produção, configure o provedor Pix (veja o README).</div><button class="btn" data-act="mock">SIMULAR PAGAMENTO APROVADO</button>` : ''}
      ${!pix && !S.mock ? `<p class="loading">Aguardando dados do pagamento…</p>` : ''}
      <p class="msg" role="alert"></p><p class="hint" id="pay-status">Aguardando confirmação…</p>`;
  };
  pintar();
  const verificar = async () => {
    if (S.tela !== 'pagamento') return;
    try {
      const r = await api(`/api/lead/${S.lead.id}/estado`);
      if (r.pix) { S.pix = r.pix; if (!document.querySelector('.qr') && !document.getElementById('pay-box').querySelector('.copy')) pintar(); }
      if (r.liberado) return go('tipo');
      if (r.pagamento !== 'pendente') { const s = document.getElementById('pay-status'); if (s) s.textContent = 'Pagamento não concluído. Reinicie a simulação.'; return; }
    } catch (e) { if (e.status === 404) { reset(); return go('home'); } }
    setTimeout(verificar, 3000);
  };
  verificar();
}

async function processar() {
  const lis = [...document.querySelectorAll('#steps li')];
  const anima = (async () => { for (const li of lis) { li.className = 'on'; await new Promise((r) => setTimeout(r, 900)); li.className = 'ok'; } })();
  const d = sensivel;
  try {
    const [r] = await Promise.all([
      api(`/api/lead/${S.lead.id}/simular`, { method: 'POST', body: {
        ...d, tipo: S.tipo, credito: S.credito, parcela: S.parcela,
        capacidade_label: S.capacidade.label, capacidade_valor: S.capacidade.valor,
      } }),
      anima,
    ]);
    S.resultado = r; sensivel = {}; go('resultado');
  } catch (e) {
    await anima;
    setMsg($app, e.message);
    if (e.status === 400) $app.querySelector('.msg').insertAdjacentHTML('afterend', '<button class="btn ghost" data-act="dados" style="margin-top:12px">Corrigir meus dados</button>');
    else if (e.status === 404 || e.status === 402) { /* sessão inválida/pagamento */ $app.querySelector('.msg').insertAdjacentHTML('afterend', '<button class="btn ghost" data-act="home" style="margin-top:12px">Voltar ao início</button>'); }
    else $app.querySelector('.msg').insertAdjacentHTML('afterend', '<button class="btn ghost" data-act="retry" style="margin-top:12px">Tentar novamente</button>');
  }
}
// Clique no botão do WhatsApp: registra o lead como "quente" sem interromper a abertura do link.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#btn-especialista') || !S.lead) return;
  fetch(`/api/lead/${S.lead.id}/interesse`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Lead-Token': S.lead.token }, body: JSON.stringify({ interesse: 'agora' }) }).catch(() => {});
  S.wa = S.resultado.whatsappUrl; save();
});
A.retry = () => render();
A.paguei = async (el) => { await busy(el, async () => { try { await api(`/api/lead/${S.lead.id}/informar-pagamento`, { method: 'POST' }); const r = await api(`/api/lead/${S.lead.id}/estado`); if (r.liberado) go('tipo'); else setMsg($app, 'Pagamento registrado. Assim que for confirmado, sua simulação é liberada.'); } catch (e) { setMsg($app, e.message); } }); };
A.copiar = async (el) => { try { await navigator.clipboard.writeText(S.pix.copiaECola); el.textContent = 'CÓDIGO COPIADO ✓'; } catch { el.textContent = 'Selecione e copie o código acima'; } };
A.mock = async (el) => { await busy(el, async () => { try { await api(`/api/lead/${S.lead.id}/mock-pay`, { method: 'POST' }); go('tipo'); } catch (e) { setMsg($app, e.message); } }); };

// ---- render ----
function render() {
  // Guardas de fluxo: não pular etapas após recarregar a página
  const precisaLead = !['home', 'checkout'].includes(S.tela);
  if (precisaLead && !S.lead) S.tela = 'checkout';
  if (['credito', 'dados', 'capacidade', 'parcela', 'processando'].includes(S.tela) && !S.tipo) S.tela = 'tipo';
  if (['dados', 'capacidade', 'parcela', 'processando'].includes(S.tela) && !S.credito) S.tela = 'credito';
  if (['capacidade', 'parcela', 'processando'].includes(S.tela) && !sensivel.cpf) S.tela = 'dados';
  if (['parcela', 'processando'].includes(S.tela) && !S.capacidade) S.tela = 'capacidade';
  if (['resultado', 'sim', 'nao'].includes(S.tela) && !S.resultado) S.tela = 'tipo';
  if (S.tela === 'tipo' && S.resultado) S.resultado = null;

  renderProgress();
  $app.innerHTML = T[S.tela]();
  bindMasks($app);
  if (S.tela === 'pagamento') montarPagamento();
  if (S.tela === 'processando') processar();
}

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && A[el.dataset.act]) A[el.dataset.act](el);
});
$app.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'f-checkout') {
    const d = lerForm(e.target), erros = [];
    if (d.nome.trim().length < 3) erros.push('nome');
    if (!/^[1-9]{2}9?\d{8}$/.test(digits(d.telefone))) erros.push('telefone');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) erros.push('email');
    if (erros.length) { marcarErro(e.target, erros); return setMsg(e.target, 'Confira os campos destacados.'); }
    enviarCheckout(e.target);
  }
  if (e.target.id === 'f-dados') enviarDados(e.target);
});

render();
