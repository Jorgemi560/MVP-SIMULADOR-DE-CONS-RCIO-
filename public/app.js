'use strict';
const $app = document.getElementById('app');
const $prog = document.getElementById('progress');
const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Valor da simulação: vem do servidor (centavos), o mesmo usado na cobrança; padrão R$ 5,00.
let PRECO_TXT = 'R$ 5,00';
let PROVEDOR = ''; // 'mercadopago' = confirmação automática; 'pix' = Pix estático (o cliente avisa e o servidor aguarda a confirmação)
const digits = (s) => String(s || '').replace(/\D/g, '');

const CREDITOS = {
  imovel: [80000, 100000, 150000, 200000, 300000, 400000, 500000, 700000, 1000000],
  veiculo: [30000, 40000, 50000, 60000, 80000, 100000, 150000, 200000],
};
const TIPOS = { imovel: ['🏠', 'Imóvel'], veiculo: ['🚗', 'Veículo'] }; // o MVP trabalha somente com imóvel e veículo
const CAPACIDADES = [
  ['Até R$500', 500], ['R$500 a R$1.000', 1000], ['R$1.000 a R$1.500', 1500],
  ['R$1.500 a R$2.000', 2000], ['R$2.000 a R$3.000', 3000], ['Acima de R$3.000', 5000],
];
const ETAPAS = ['Objetivo', 'Crédito', 'Seus dados', 'Simulação', 'Resultado'];
const ETAPA_DA_TELA = { tipo: 1, credito: 2, dados: 3, capacidade: 3, parcela: 3, 'parcela-aviso': 3, processando: 4, resultado: 5, sim: 5, nao: 5 };
const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

// Estado persistido (sem dados sensíveis como CPF/nome da mãe)
const KEY = 'sc_state_v1';
let S = { tela: 'home', lead: null, tipo: null, credito: null, capacidade: null, parcela: null, resultado: null, contato: {} };
try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignora */ }
let sensivel = {}; // somente memória
let rascunhoDados = {}; // o que foi digitado em "Dados" e ainda não enviado (somente memória); só preenche o formulário ao voltar
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* ignora */ } };
const reset = () => { try { localStorage.removeItem(KEY); } catch { /* ignora */ } S = { tela: 'home', lead: null, tipo: null, credito: null, capacidade: null, parcela: null, resultado: null, contato: {} }; sensivel = {}; };

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.lead) headers['X-Lead-Token'] = S.lead.token;
  let r, data;
  // Nenhuma chamada fica esperando para sempre: passados 12 s ela é abortada (erro sem status = falha de rede/timeout).
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
  try {
    r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    data = await r.json().catch(() => ({}));
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'O servidor demorou a responder. Tente novamente.' : 'Sem conexão. Verifique sua internet e tente novamente.'); }
  finally { clearTimeout(t); }
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

const IC = (d, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICONES = {
  casa: IC('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  carro: IC('<path d="M5 16l1.5-5.2A2 2 0 0 1 8.4 9.4h7.2a2 2 0 0 1 1.9 1.4L19 16"/><path d="M3.5 16h17v3h-17z"/><circle cx="7.5" cy="19" r="1.2"/><circle cx="16.5" cy="19" r="1.2"/>'),
  relogio: IC('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  cadeado: IC('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  seta: IC('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  escolher: IC('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  valor: IC('<path d="M12 3v18"/><path d="M16 7.5c0-1.7-1.8-3-4-3s-4 1.1-4 2.8c0 4 8 2 8 6.2 0 1.8-1.8 3-4 3s-4-1.3-4-3"/>'),
  resultado: IC('<path d="M5 12l4 4 10-10"/>'),
};

T.home = () => `
  <section class="screen home">
    <div class="hero">
      <div class="hero-in">
        <p class="eyebrow"><span>${ICONES.casa} Imóvel</span><i aria-hidden="true"></i><span>${ICONES.carro} Veículo</span></p>
        <h1>Descubra <em>quanto pode ficar</em> a parcela do consórcio que você procura.</h1>
        <div class="offer">
          <p class="offer-text">Faça sua simulação personalizada por apenas <b class="gold">${PRECO_TXT}</b>.</p>
          <button class="btn cta" data-act="comecar"><span>FAZER MINHA SIMULAÇÃO POR ${PRECO_TXT}</span><i>${ICONES.seta}</i></button>
          <p class="offer-note"><span>${ICONES.relogio} Leva menos de 2 minutos</span><span>${ICONES.cadeado} Pagamento seguro por Pix</span></p>
        </div>
      </div>
    </div>
    <div class="contemp">
      <div class="contemp-in">
        <h2>Como você pode ser contemplado?</h2>
        <p class="contemp-via">🎟️ Por <b>sorteio</b> pela Loteria Federal <span>ou</span> 💰 por <b>lance</b>.</p>
        <ul class="contemp-lances" aria-label="Tipos de lance">
          <li>Lance Livre</li><li>Lance Fixo <small>(Embutido)</small></li><li>Lance Limitado</li>
        </ul>
        <p class="contemp-nota">A contemplação não possui data garantida.</p>
      </div>
    </div>
    <div class="how">
      <ol class="how-in">
        <li><b>${ICONES.escolher}</b><strong>Escolha</strong><span>imóvel ou veículo</span></li>
        <li><b>${ICONES.valor}</b><strong>Informe</strong><span>o crédito que você deseja</span></li>
        <li><b>${ICONES.resultado}</b><strong>Receba</strong><span>a estimativa de parcelas</span></li>
      </ol>
    </div>
  </section>`;

T.checkout = () => `
  <section class="screen">
    <button class="back" data-act="home">← Voltar</button>
    <h2>Quase lá! Seus dados de contato</h2>
    <p class="sub" style="margin-top:4px">Para liberar sua simulação, finalize o pagamento de <b>${PRECO_TXT}</b> via Pix.</p>
    ${S.lead ? '<p class="note" style="margin-top:8px">Confira ou corrija seus dados. Seu Pix continua o mesmo: nenhuma nova cobrança é criada.</p>' : ''}
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
    <div class="left"><button class="back" data-act="pag-volta" id="pay-back" hidden>← Voltar</button></div>
    <h2>Pague ${PRECO_TXT} para liberar sua simulação</h2>
    <div class="card" id="pay-box"><p class="loading">Gerando pagamento…</p></div>
    <p class="hint">Assim que o pagamento for confirmado, sua simulação é liberada automaticamente.</p>
  </section>`;

T.tipo = () => `
  <section class="screen">
    ${S.refazendo ? '<button class="back" data-act="tipo-cancela">← Voltar</button>' : ''}
    <h2>O que você pretende adquirir?</h2>
    <p class="sub" style="margin-top:4px">Toque em uma opção.</p>
    <div class="grid">
      ${Object.entries(TIPOS).map(([k, [e, l]]) => `<button class="choice" data-act="tipo" data-v="${k}"><span class="em">${e}</span>${l.toUpperCase()}</button>`).join('')}
    </div>
  </section>`;

T.credito = () => `
  <section class="screen">
    <button class="back" data-act="tipo-volta">← Voltar</button>
    ${S.refazendo ? '<button class="linklike" data-act="trocar-tipo" style="margin:0 0 6px">Trocar imóvel / veículo</button>' : ''}
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
  const d = { ...S.contato, ...sensivel, ...rascunhoDados };
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
      <div class="field"><label for="renda">Qual é a sua renda mensal?</label><input id="renda" name="renda_mensal" data-mask="moeda" inputmode="numeric" placeholder="R$ 0" autocomplete="off" value="${esc(mask.moeda(d.renda_mensal))}"></div>
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
    <button class="back" data-act="cap-volta">← Voltar</button>
    <h2>Como você gostaria de visualizar sua simulação?</h2>
    <div class="grid" style="margin-top:16px">
      <button class="choice int" data-act="parcela" data-v="integral"><span class="em">🔵</span><span>PARCELA INTEGRAL<small>Parcela normal do plano, sem redução.</small></span></button>
      <button class="choice red" data-act="parcela" data-v="reduzida"><span class="em">🟢</span><span>PARCELA REDUZIDA<small>Menor parcela mensal até a contemplação.</small></span></button>
    </div>
    <p class="msg" role="alert"></p>
  </section>`;

// Parcela reduzida: confirmação curta antes de seguir (não calcula nem informa parcela pós-contemplação).
T['parcela-aviso'] = () => `
  <section class="screen">
    <button class="back" data-act="parcela-volta">← Voltar</button>
    <div class="card aviso-reduzida" role="alertdialog" aria-labelledby="av-t">
      <h2 id="av-t">⚠️ Atenção</h2>
      <p>A parcela reduzida é válida somente até a contemplação. Após a contemplação, a parcela será recalculada conforme as condições do plano e o prazo restante.</p>
      <div class="grid" style="margin-top:16px">
        <button class="btn" data-act="parcela-confirma">CONTINUAR COM PARCELA REDUZIDA</button>
        <button class="btn ghost" data-act="parcela-volta">VOLTAR PARA PARCELA INTEGRAL</button>
      </div>
    </div>
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
      <button class="btn ghost alterar" data-act="alterar" id="btn-alterar">← ALTERAR SIMULAÇÃO</button>
      <p class="fine" style="margin-top:6px">Quer testar outro valor? Sem nova cobrança.</p>
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
    <div class="left"><button class="back" data-act="resultado-volta">← Voltar</button></div>
    <div class="party" style="font-size:3rem">🤝</div>
    <h2>Perfeito! Vamos colocar você em contato com um especialista para verificar as opções disponíveis para o seu perfil.</h2>
    <div style="margin-top:22px">
      ${S.wa ? `<a class="btn" href="${esc(S.wa)}" target="_blank" rel="noopener">FALAR COM ESPECIALISTA NO WHATSAPP</a>`
        : `<p class="note">Nosso atendimento via WhatsApp ainda não está configurado. Um especialista entrará em contato pelo número informado.</p>`}
    </div>
  </section>`;

T.nao = () => `
  <section class="screen center">
    <div class="left"><button class="back" data-act="resultado-volta">← Voltar</button></div>
    <h2>Sem problema. Antes de decidir, você pode entender melhor como funciona o consórcio.</h2>
    <div style="margin-top:22px">
      <button class="btn blue" data-act="entender">QUERO ENTENDER MELHOR</button>
      <p class="msg" role="alert"></p>
    </div>
  </section>`;

// ---- ações ----
const A = {};
A.comecar = () => go(S.lead ? 'pagamento' : 'checkout');
// "Voltar" não apaga o que o cliente já digitou: guarda o rascunho do formulário aberto (sem validar) antes de sair da tela.
function guardarRascunho() {
  const f = document.getElementById('f-dados') || document.getElementById('f-checkout'); if (!f) return;
  const d = lerForm(f);
  const t = { nome: String(d.nome ?? '').trim(), telefone: digits(d.telefone), email: String(d.email ?? '').trim() };
  S.contato = { ...S.contato, ...t };
  if (f.id === 'f-dados') rascunhoDados = { ...d, telefone: t.telefone };
  save();
}
A.home = () => { guardarRascunho(); go('home'); };
// Alterar simulação: volta ao crédito (pode trocar o tipo pelo "Voltar") e refaz crédito/valor mensal/parcela na MESMA sessão.
// O pagamento confirmado e os dados já informados (guardados em memória) são mantidos: nada é cobrado de novo.
A.alterar = () => { S.refazendo = true; S.parcela = null; S.capacidade = null; go('credito'); };
const depoisDoCredito = () => go(S.refazendo && sensivel.cpf ? 'capacidade' : 'dados');
A.tipo = (el) => { S.tipo = el.dataset.v; S.credito = null; go('credito'); };
// Voltar do crédito: fluxo normal -> tipo; em "Alterar simulação" -> cancela a alteração e volta ao resultado (restaura o tipo dele).
A['tipo-volta'] = () => { if (S.refazendo && S.resultado) { S.tipo = S.resultado.tipo; S.refazendo = false; return go('resultado'); } go('tipo'); };
A['trocar-tipo'] = () => go('tipo');
A['tipo-cancela'] = () => go('credito'); // em "Alterar simulação", o Voltar do tipo retorna ao crédito
A['cap-volta'] = () => go('capacidade');
A['resultado-volta'] = () => go('resultado');
A['pag-volta'] = () => go('checkout'); // só aparece com o Pix pendente/expirado; não cria cobrança (o Pix atual segue valendo)
A['credito-volta'] = () => { guardarRascunho(); go('credito'); };
A.dados = () => go(S.refazendo && sensivel.cpf ? 'credito' : 'dados'); // "Voltar" da tela de valor mensal
A.credito = (el) => { S.credito = Number(el.dataset.v); depoisDoCredito(); };
A['credito-outro'] = () => {
  const v = Number(digits($app.querySelector('#outro').value));
  if (!(v >= 1000)) return setMsg($app, 'Informe um valor a partir de R$ 1.000.');
  S.credito = v; depoisDoCredito();
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
A.parcela = (el) => { S.parcela = el.dataset.v; go(S.parcela === 'reduzida' ? 'parcela-aviso' : 'processando'); };
A['parcela-confirma'] = () => { S.parcela = 'reduzida'; go('processando'); };
A['parcela-volta'] = () => { S.parcela = null; go('parcela'); }; // volta para a escolha entre reduzida e integral

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
      if (S.lead) { // voltou do Pix para rever os dados: atualiza o MESMO cadastro (sem novo Pix nem nova cobrança)
        try { await api(`/api/lead/${S.lead.id}/contato`, { method: 'POST', body: S.contato }); return go('pagamento'); }
        catch (e) { if (e.status !== 404) throw e; S.lead = null; S.pix = null; S.conf = null; } // cadastro antigo não existe mais: segue como novo
      }
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
  const d = lerForm(form); d.telefone = digits(d.telefone); d.cpf = digits(d.cpf); d.renda_mensal = Number(digits(d.renda_mensal));
  const erros = [];
  if (d.nome.trim().length < 3) erros.push('nome');
  if (!/^[1-9]{2}9?\d{8}$/.test(d.telefone)) erros.push('telefone');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) erros.push('email');
  if (!VALIDACOES.cpf(d.cpf)) erros.push('cpf');
  if (!d.nascimento) erros.push('nascimento');
  if (d.nome_mae.trim().length < 3) erros.push('nome_mae');
  if (d.cidade.trim().length < 2) erros.push('cidade');
  if (!(d.renda_mensal > 0)) erros.push('renda_mensal');
  if (!d.estado) erros.push('estado');
  sensivel = d; rascunhoDados = {};
  if (erros.length) { marcarErro(form, erros); return setMsg(form, 'Confira os campos destacados.'); }
  S.contato = { nome: d.nome.trim(), telefone: d.telefone, email: d.email.trim() };
  go('capacidade');
}

// ---- telas com lógica própria ----
// Tela de pagamento. Os estados vêm do servidor (situação real da tentativa), mas o PRAZO DE 3 MINUTOS da conferência é do
// front-end: conta a partir do clique em "Já fiz o pagamento" (ou do horário gravado no servidor, ao recarregar) e a troca de
// tela acontece por um relógio local, sem depender de resposta do servidor. Visões: pendente (contagem do Pix), verificando
// (até 3 min), tardia (sem confirmação após 3 min), renovar (expirado/recusado/cancelado) e pago (libera a simulação).
let payLoop = 0, payVerificarAgora = null, payRedesenhar = null;
const INTERVALO = () => (PROVEDOR === 'mercadopago' ? 2000 : 3000); // com confirmação automática, consulta mais rápido
const VERIFICANDO_MS = 3 * 60 * 1000;
const ICONE_RELOGIO = '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
async function montarPagamento() {
  const box = document.getElementById('pay-box');
  const eu = ++payLoop;
  const vivo = () => eu === payLoop && S.tela === 'pagamento' && document.body.contains(box);
  const qrSvg = (txt) => { try { const q = qrcode(0, 'M'); q.addData(txt); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { return ''; } };
  let offset = 0, expiraMs = null, chave = '', consultando = false, proximo = null, ultimo = null, semRede = false;

  // Início da conferência em relógio LOCAL (S.conf é gravado ao clicar e acompanha recarregamentos).
  const desde = () => (S.conf && S.lead && S.conf.lead === S.lead.id ? S.conf.desde : null);
  const limparConf = () => { if (S.conf) { S.conf = null; save(); } };
  const fase = () => (Date.now() - desde() >= VERIFICANDO_MS ? 'tardia' : 'verificando');
  const visao = () => {
    if (ultimo?.podeRenovar) return 'renovar';
    if (desde() || ultimo?.pagamento === 'informado') return fase();
    return ultimo ? 'pendente' : 'carregando';
  };

  const htmlConferencia = (f) => f === 'verificando' ? `
    <div class="verify" role="status" aria-live="polite">
      <div class="verify-ico"><span class="ring"></span>${ICONE_RELOGIO}</div>
      <h3>Verificando seu pagamento</h3>
      <p>Estamos consultando o sistema. Aguarde alguns instantes.</p>
      <div class="dots" aria-hidden="true"><i></i><i></i><i></i></div>
      <p class="hint">Mantenha esta página aberta: a liberação é automática.</p>
    </div>` : `
    <div class="verify warn" role="status" aria-live="polite">
      <div class="verify-ico still">${ICONE_RELOGIO}</div>
      <h3>Verificando seu pagamento</h3>
      <p>Ainda não identificamos seu pagamento. Estamos consultando o sistema. Aguarde alguns instantes…</p>
      <hr class="verify-sep">
      <p class="nao-pagar">Se você já pagou, <b>não faça outro Pix agora.</b></p>
      <button class="btn outline-green" data-act="verificar" id="btn-verificar">VERIFICAR NOVAMENTE</button>
      <button class="btn outline-gray" data-act="novopix" id="btn-novopix">GERAR NOVO PIX</button>
      <p class="msg" role="alert"></p>
      <p class="hint">O novo Pix só deve ser disponibilizado quando for seguro gerar outra cobrança.</p>
    </div>`;

  const htmlRenovar = (r) => `
    <div class="aviso-exp" role="alert"><b>${r.pagamento === 'expirado' ? 'Pix expirado' : 'Pagamento não confirmado'}</b><p>${r.pagamento === 'expirado' ? 'O tempo para pagar este Pix terminou.' : 'Este pagamento não foi confirmado.'} Nenhum valor é cobrado por um Pix vencido. Gere um novo código para continuar.</p></div>
    <button class="btn" data-act="novopix" id="btn-novopix">GERAR NOVO PIX</button>
    <button class="btn ghost" data-act="home" style="margin-top:10px">Voltar ao início</button>
    <button class="linklike" data-act="novocadastro">Usar outros dados de contato</button>
    <p class="msg" role="alert"></p>
    <p class="hint">Já pagou este código? Não pague de novo: aguarde a conferência ou fale com o atendimento. Seu cadastro e o histórico das tentativas ficam guardados.</p>`;

  const htmlPendente = () => {
    const pix = S.pix;
    return `
      <span class="pill">Valor: ${PRECO_TXT}</span>
      ${expiraMs ? '<p class="timer" id="pay-timer" aria-live="off"></p>' : ''}
      ${pix?.qrBase64 ? `<img class="qr" alt="QR Code Pix" src="data:image/png;base64,${esc(pix.qrBase64)}">` : ''}
      ${pix?.copiaECola && !pix.qrBase64 ? `<div class="qr" role="img" aria-label="QR Code Pix">${qrSvg(pix.copiaECola)}</div>` : ''}
      ${pix?.copiaECola ? `<p style="font-size:.9rem;margin-top:6px">Pix copia e cola:</p><div class="copy">${esc(pix.copiaECola)}</div><button class="btn ghost" data-act="copiar">COPIAR CÓDIGO PIX</button>` : ''}
      ${pix?.copiaECola && !S.mock && PROVEDOR !== 'mercadopago' ? `<button class="btn" data-act="paguei" id="btn-paguei" style="margin-top:10px">JÁ FIZ O PAGAMENTO</button><p class="hint">Abra o app do seu banco, escolha Pix → Pix copia e cola (ou leia o QR Code), pague ${PRECO_TXT} e volte aqui. Sua simulação é liberada assim que o pagamento for confirmado.</p>` : ''}
      ${pix?.copiaECola && PROVEDOR === 'mercadopago' ? `<div class="auto-wait" role="status" aria-live="polite"><span class="mini-ring" aria-hidden="true"></span><div><b>Aguardando o pagamento…</b><br>Abra o app do seu banco, escolha Pix → Pix copia e cola (ou leia o QR Code) e pague ${PRECO_TXT}. <b>Você não precisa clicar em nada:</b> assim que o Pix for aprovado, a próxima etapa abre sozinha.</div></div>` : ''}
      ${S.mock ? `<div class="test"><b>Modo de teste:</b> nenhum pagamento real é cobrado. Em produção, configure o provedor Pix (veja o README).</div><button class="btn" data-act="mock">SIMULAR PAGAMENTO APROVADO</button>` : ''}
      ${!pix && !S.mock ? `<p class="loading">Aguardando dados do pagamento…</p>` : ''}
      <p class="msg" role="alert"></p>${PROVEDOR === 'mercadopago' ? '' : '<p class="hint" id="pay-status">Aguardando confirmação…</p>'}`;
  };

  // Redesenha só quando a visão muda (sem piscar). Chamado a cada segundo pelo relógio local e a cada resposta.
  const desenhar = () => {
    const v = visao();
    // "Voltar" só com o Pix pendente/expirado: em conferência ou depois de pago, voltar poderia gerar inconsistência de pagamento.
    const vb = document.getElementById('pay-back'); if (vb) vb.hidden = !['pendente', 'renovar'].includes(v);
    const k = `${v}|${ultimo?.pagamento || ''}|${ultimo?.pix?.copiaECola || ''}|${v === 'carregando' && semRede}`;
    if (k === chave) return;
    chave = k;
    box.innerHTML = v === 'verificando' || v === 'tardia' ? htmlConferencia(v)
      : v === 'renovar' ? htmlRenovar(ultimo)
      : v === 'pendente' ? htmlPendente()
      : `<p class="loading">${semRede ? 'Não conseguimos consultar o servidor agora. Tentando novamente…' : 'Verificando seu pagamento…'}</p>`;
  };
  payRedesenhar = () => { chave = ''; desenhar(); };

  const aplicar = (r) => {
    offset = r.agora ? Date.parse(r.agora) - Date.now() : 0; // relógio do servidor serve de referência (o do celular pode estar errado)
    expiraMs = r.expiraEm ? Date.parse(r.expiraEm) - offset : null; // convertido para o relógio local
    ultimo = r;
    S.mock = !!r.mock;
    if (r.pagamento === 'informado' && r.informadoEm) { // horário gravado no servidor vale ao recarregar/reabrir
      // Já temos o instante do clique (relógio local)? Vale o mais antigo: a resposta nunca "reinicia" os 3 minutos.
      const doServidor = Date.parse(r.informadoEm) - offset;
      S.conf = { lead: S.lead.id, desde: desde() ? Math.min(desde(), doServidor) : doServidor };
    } else if (r.podeRenovar || r.liberado) limparConf();
    if (r.pix) S.pix = S.pix?.copiaECola === r.pix.copiaECola ? S.pix : r.pix;
    else if (r.podeRenovar || r.pagamento === 'pendente') { if (!S.mock) S.pix = null; } // código vencido nunca fica na tela
    save();
    desenhar();
  };

  // Consulta o servidor. "consultando" nunca prende o ciclo: a chamada aborta em 12 s e o relógio local segue independente.
  const verificar = async () => {
    clearTimeout(proximo);
    if (!vivo()) return;
    if (consultando) return;
    consultando = true;
    let r;
    try { r = await api(`/api/lead/${S.lead.id}/estado`); semRede = false; }
    catch (e) {
      consultando = false; semRede = true;
      if (e.status === 404) { reset(); return go('home'); }
      desenhar();
      if (vivo()) proximo = setTimeout(verificar, INTERVALO());
      return;
    }
    consultando = false;
    if (!vivo()) return;
    if (r.liberado) { // só a confirmação do servidor libera
      limparConf();
      box.innerHTML = '<div class="verify" role="status"><div class="verify-ico ok">✔</div><h3>Pagamento confirmado!</h3><p>Liberando sua simulação…</p></div>';
      return setTimeout(() => { if (S.tela === 'pagamento') go('tipo'); }, 700);
    }
    // Cliente clicou em "já paguei" mas o aviso não chegou ao servidor (rede): reenvia, sem alterar o prazo de 3 min.
    if (r.pagamento === 'pendente' && desde() && S.mock !== true) {
      try { await api(`/api/lead/${S.lead.id}/informar-pagamento`, { method: 'POST' }); } catch (e) { if (e.status) limparConf(); }
    }
    aplicar(r);
    if (!r.podeRenovar && vivo()) proximo = setTimeout(verificar, INTERVALO()); // expirado/recusado: para até gerar novo Pix
  };

  // Relógio local (1 s): contagem do Pix e troca automática para "ainda não identificado" aos 3 min.
  const contar = () => {
    if (!vivo()) return;
    desenhar();
    const el = document.getElementById('pay-timer');
    if (expiraMs && el) {
      const falta = Math.max(0, expiraMs - Date.now());
      if (falta === 0) { el.textContent = 'Verificando a validade do Pix…'; verificar(); }
      else { const m = Math.floor(falta / 60000), sec = Math.floor((falta % 60000) / 1000); el.textContent = `Tempo para pagar: ${m}:${String(sec).padStart(2, '0')}`; el.classList.toggle('urgente', falta < 60000); }
    }
    setTimeout(contar, 1000);
  };
  // Aba em segundo plano tem timers atrasados: ao voltar, redesenha e consulta na hora.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && vivo()) { desenhar(); verificar(); } });
  payVerificarAgora = () => verificar();
  desenhar();
  contar();
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
    S.resultado = r; S.refazendo = false; go('resultado'); // os dados informados continuam em memória (não em disco) para uma nova simulação sem digitar tudo de novo
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
// "Já fiz o pagamento" só AVISA que o Pix foi feito: a simulação continua bloqueada até a confirmação real do recebimento.
// A tela de verificação aparece NA HORA (não espera o servidor) e o prazo de 3 min começa neste clique.
A.paguei = async () => {
  S.conf = { lead: S.lead.id, desde: Date.now() }; save();
  payRedesenhar?.();
  try { await api(`/api/lead/${S.lead.id}/informar-pagamento`, { method: 'POST' }); }
  catch (e) {
    if (e.status) { S.conf = null; save(); payRedesenhar?.(); setMsg($app, e.message); } // recusado pelo servidor (ex.: Pix expirou)
    // sem status = rede/timeout: a tela continua e o aviso é reenviado na próxima consulta
  }
  payVerificarAgora?.();
};
// Consulta imediata. Não reinicia o prazo e não esconde "Gerar novo Pix"; a tela também consulta sozinha a cada 3 s.
A.verificar = async (el) => { await busy(el, async () => { await payVerificarAgora?.(); await new Promise((r) => setTimeout(r, 900)); }); };
A.copiar = async (el) => { try { await navigator.clipboard.writeText(S.pix.copiaECola); el.textContent = 'CÓDIGO COPIADO ✓'; } catch { el.textContent = 'Selecione e copie o código acima'; } };
// Gera uma nova cobrança (o servidor só cria se não houver outra em aberto: cliques repetidos não duplicam).
A.novopix = async (el) => {
  await busy(el, async () => {
    try {
      const r = await api(`/api/lead/${S.lead.id}/novo-pix`, { method: 'POST' });
      S.pix = r.pix; S.conf = null; if (r.mock !== undefined) S.mock = r.mock; save();
      render();
    } catch (e) { setMsg($app, e.message); }
  });
};
// Cadastro novo com outros dados de contato: o anterior e o histórico de pagamentos continuam guardados.
A.novocadastro = () => { S.lead = null; S.conf = null; S.pix = null; S.mock = false; go('checkout'); };
A.mock = async (el) => { await busy(el, async () => { try { await api(`/api/lead/${S.lead.id}/mock-pay`, { method: 'POST' }); go('tipo'); } catch (e) { setMsg($app, e.message); } }); };

// ---- render ----
function render() {
  document.body.classList.toggle('is-home', S.tela === 'home');
  // Guardas de fluxo: não pular etapas após recarregar a página
  if (S.tipo && !TIPOS[S.tipo]) { S.tipo = null; S.credito = null; } // sessão antiga guardada com um tipo que não existe mais
  const precisaLead = !['home', 'checkout'].includes(S.tela);
  if (precisaLead && !S.lead) S.tela = 'checkout';
  if (['credito', 'dados', 'capacidade', 'parcela', 'parcela-aviso', 'processando'].includes(S.tela) && !S.tipo) S.tela = 'tipo';
  if (['dados', 'capacidade', 'parcela', 'parcela-aviso', 'processando'].includes(S.tela) && !S.credito) S.tela = 'credito';
  if (['capacidade', 'parcela', 'parcela-aviso', 'processando'].includes(S.tela) && !sensivel.cpf) S.tela = 'dados';
  if (['parcela', 'parcela-aviso', 'processando'].includes(S.tela) && !S.capacidade) S.tela = 'capacidade';
  if (['resultado', 'sim', 'nao'].includes(S.tela) && !S.resultado) S.tela = 'tipo';
  if (S.tela === 'tipo' && S.resultado && !S.refazendo) S.resultado = null;

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

api('/api/config').then((c) => { PROVEDOR = c.provedor || ''; if (Number.isInteger(c.precoCentavos) && c.precoCentavos > 0) PRECO_TXT = brl(c.precoCentavos / 100); }).catch(() => {}).finally(render);
