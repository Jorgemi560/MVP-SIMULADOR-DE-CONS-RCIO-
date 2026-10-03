# Simulador de Consórcio (MVP)

Tráfego → pagamento de R$5 (Pix) → simulação → captura de lead → qualificação → WhatsApp.

Mobile-first, **zero dependências** (Node ≥ 22.13, SQLite embutido).

```bash
cp .env.example .env   # ajuste ADMIN_PASSWORD etc.
PAYMENT_PROVIDER=mock npm start   # teste local: http://localhost:3000 (admin: /admin, senha admin123 só em desenvolvimento)
npm test
```

Para publicar na internet, veja o [DEPLOY.md](DEPLOY.md).

## Fluxo
Home → checkout (nome/e-mail/WhatsApp) → Pix → tipo → crédito → dados (inclui renda mensal) → capacidade mensal →
(parcela integral/reduzida, só se o plano tiver redução) → processamento → resultado → intenção → WhatsApp ou "entender melhor".

O servidor bloqueia a simulação enquanto o pagamento não estiver `pago`.

## Painel `/admin` (senha = `ADMIN_PASSWORD`)
- **Leads**: busca (nome/telefone/e-mail), período, situação do pagamento e filtros Quentes / Mornos (clicou em "Quero entender melhor") / Frios; detalhes ao clicar na linha; PDF individual; CSV; impressão; status editável.
- **Planos de Simulação**: cadastro de parâmetros (prazo, taxa adm., fundo de reserva, seguro, índice, redução, faixa de crédito, ativo). Qualquer crédito dentro da faixa é calculado — nada é cadastrado por valor.
- **Configurações**: WhatsApp do especialista e link do guia ("Quero entender melhor").

## Motor de cálculo (`lib/calc.js`)
Por plano: fundo comum = crédito; taxa adm. e fundo de reserva = % do crédito diluídos no prazo; seguro = % ao mês sobre o crédito.
`parcela integral = (crédito + adm + reserva + seguro) / prazo`, centavos cortados (como no material das administradoras).
Redução (só imóvel, configurável por plano): `fundo_comum` → `(crédito × (1 − %) + taxas integrais) / prazo` ou `parcela_total` (reduz X% da parcela).
Cada plano escolhe o arredondamento da parcela (cortar, arredondar ou cortar −1 centavo) para espelhar a tabela da administradora; os planos iniciais foram calibrados com simulações reais.
Havendo vários planos para o tipo/valor, usa-se o de menor parcela. **Os planos iniciais são exemplos ilustrativos** — ajuste em /admin com as condições reais.

## Pagamento
- `PAYMENT_PROVIDER=pix` (padrão): Pix estático, com a conta definida em `PIX_CHAVE`, `PIX_RECEBEDOR` e `PIX_CIDADE`. QR Code e "copia e cola" de R$ 5,00. **O cliente não se libera sozinho**: o pagamento só vira "pago" quando o administrador confirma em `/admin` ou quando um serviço autorizado chama `POST /api/webhooks/pix` (`PIX_WEBHOOK_SECRET`). Veja o [DEPLOY.md](DEPLOY.md).
- `PAYMENT_PROVIDER=mercadopago` + `MP_ACCESS_TOKEN` + `PUBLIC_URL`: Pix dinâmico com confirmação automática (polling + webhook). Ainda não testado contra a API real.
- `PAYMENT_PROVIDER=mock`: só desenvolvimento; bloqueado com `NODE_ENV=production`.

## Notas
- Dados pessoais (CPF, etc.) ficam no SQLite (`data/`); proteja o disco/backup e publique política de privacidade (LGPD).
- Textos evitam "aprovado"/"contemplação garantida"; o resultado traz aviso de que é estimativa.
