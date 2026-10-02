# Simulador de Consórcio (MVP)

Tráfego → pagamento de R$5 (Pix) → simulação → captura de lead → qualificação → WhatsApp.

Mobile-first, **zero dependências** (Node ≥ 22.13, SQLite embutido).

```bash
cp .env.example .env   # ajuste ADMIN_PASSWORD etc.
npm start              # http://localhost:3000   (admin: /admin)
npm test
```

## Fluxo
Home → checkout (nome/e-mail/WhatsApp) → Pix → tipo → crédito → dados → capacidade mensal →
(parcela integral/reduzida, só se o plano tiver redução) → processamento → resultado → intenção → WhatsApp ou "entender melhor".

O servidor bloqueia a simulação enquanto o pagamento não estiver `pago`.

## Painel `/admin` (senha = `ADMIN_PASSWORD`)
- **Leads**: filtros Todos / Quentes (quero fazer agora) / Mornos (clicou em "Quero entender melhor") / Frios (ainda não); clique na linha para ver CPF, pagamento etc.; status editável.
- **Planos de Simulação**: cadastro de parâmetros (prazo, taxa adm., fundo de reserva, seguro, índice, redução, faixa de crédito, ativo). Qualquer crédito dentro da faixa é calculado — nada é cadastrado por valor.
- **Configurações**: WhatsApp do especialista e link do guia ("Quero entender melhor").

## Motor de cálculo (`lib/calc.js`)
Por plano: fundo comum = crédito; taxa adm. e fundo de reserva = % do crédito diluídos no prazo; seguro = % ao mês sobre o crédito.
`parcela integral = (crédito + adm + reserva)/prazo + seguro`.
Redução (configurável por plano): `fundo_comum` (reduz X% só da parte do fundo comum) ou `parcela_total` (reduz X% da parcela).
Havendo vários planos para o tipo/valor, usa-se o de menor parcela. **Os planos iniciais são exemplos ilustrativos** — ajuste em /admin com as condições reais.

## Pagamento
- `PAYMENT_PROVIDER=mock`: só desenvolvimento (botão "simular pagamento"); é bloqueado com `NODE_ENV=production`.
- `PAYMENT_PROVIDER=mercadopago` + `MP_ACCESS_TOKEN` + `PUBLIC_URL`: Pix com QR/copia-e-cola, confirmação por polling e webhook (`/api/webhooks/mercadopago`, o status é sempre reconsultado na API). **Essa integração ainda não foi testada contra a API real** — valide com credenciais de teste antes de rodar anúncios.

## Notas
- Dados pessoais (CPF, etc.) ficam no SQLite (`data/`); proteja o disco/backup e publique política de privacidade (LGPD).
- Textos evitam "aprovado"/"contemplação garantida"; o resultado traz aviso de que é estimativa.
