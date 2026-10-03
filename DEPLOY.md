# Publicar em ganhemaisno.online (passo a passo)

**Resumo:** hospedagem num serviço com disco persistente (Render, ~US$ 7/mês + ~US$ 0,25 por GB de disco — confirme os preços atuais no site) + DNS do domínio na GoDaddy apontando para ela. O HTTPS (cadeado) é gratuito e automático. Não precisa comprar hospedagem GoDaddy, e-mail, SSL nem o plano pago do site.

> Não use plano grátis: o disco dele apaga a cada atualização e os leads seriam perdidos.

## 1. Preparar o código
O projeto está no GitHub (`jorgemi560/MVP-SIMULADOR-DE-CONS-RCIO-`, branch `claude/charming-davinci-t7zlwy`). Faça o deploy dessa branch ou, melhor, junte-a à `main` (Pull request → Merge) e use a `main`.

## 2. Criar o serviço no Render
1. Crie conta em render.com e conecte o GitHub (autorize só esse repositório).
2. **New → Web Service** → escolha o repositório e a branch.
3. **Language/Runtime: Docker** (ele usa o `Dockerfile` do projeto). **Instance Type: Starter**.
4. **Health Check Path:** `/healthz`.
5. **Disks → Add Disk:** nome `dados`, **Mount Path `/data`**, 1 GB. (É onde ficam os leads.)
6. **Environment Variables** (Settings → Environment):

| Nome | Valor |
|---|---|
| `ADMIN_PASSWORD` | senha forte, 10+ caracteres (será a do `/admin`) |
| `PAYMENT_PROVIDER` | `pix` |
| `PIX_CHAVE` | chave Pix da conta que vai receber (hoje: a conta de testes) |
| `PIX_RECEBEDOR` | nome do titular dessa conta, como no banco |
| `PIX_CIDADE` | cidade do titular |
| `PUBLIC_URL` | `https://ganhemaisno.online` |
| `PIX_WEBHOOK_SECRET` | *(opcional)* segredo de 16+ caracteres, só se um banco/automação for confirmar pagamentos sozinho |
| `WHATSAPP_ESPECIALISTA` | *(opcional)* WhatsApp do especialista, com DDD; também dá para definir em `/admin → Configurações` |

O Dockerfile já define `NODE_ENV=production`, `DB_FILE=/data/simulador.db` e `TRUST_PROXY_HOPS=1`. Se `PIX_CHAVE` ou `PIX_RECEBEDOR` faltarem, o serviço **não inicia** e o log explica o motivo.

7. **Create Web Service.** Quando terminar, abra o endereço `https://NOME.onrender.com` e confira o site.

## 3. Domínio na GoDaddy
1. GoDaddy → **Meus Produtos** → `ganhemaisno.online` → **DNS / Gerenciar DNS**.
2. **Liberar o domínio do site grátis:** se os registros `A @` e `CNAME www` aparecem como "WebsiteBuilder Site"/"Parked" e não deixam editar, desconecte o domínio no painel do site (Websites + Marketing → Configurações → Domínio → desconectar) ou exclua o site grátis. Depois apague o `A @` antigo e o `CNAME www` antigo.
3. **Não mexa** em registros `MX` e `TXT` (e-mail), se existirem.
4. No Render: **Settings → Custom Domains → Add** `ganhemaisno.online` e também `www.ganhemaisno.online`. O Render mostra os registros exatos a criar (use os valores que ele mostrar, não copie de outro lugar):
   - `A` com nome `@` → IP indicado pelo Render
   - `CNAME` com nome `www` → `NOME.onrender.com`
5. Volte à GoDaddy e crie esses dois registros (TTL padrão/1 hora).
6. No Render, clique em **Verify**. Pode levar de minutos a algumas horas. O certificado HTTPS é emitido sozinho.
7. Se a GoDaddy não aceitar o `A @`, use só `www` (CNAME) e, em **Domínio → Encaminhamento**, encaminhe `ganhemaisno.online` para `https://www.ganhemaisno.online` (301).

## 4. Testar antes de anunciar
1. Abra o site no celular e faça uma simulação pagando **R$ 5 de verdade** pelo Pix.
2. Entre em `https://ganhemaisno.online/admin`, veja o lead, confirme o recebimento (sem isso a simulação não libera) e confira os planos.
3. Em **Configurações**, confirme o WhatsApp do especialista e o link do guia.

## 5. Pagamento: como a confirmação funciona
O Pix usa uma chave estática, e o sistema **não enxerga o extrato do banco**. Por isso o cliente **não consegue se liberar sozinho**: "Já fiz o pagamento" só avisa você. A simulação só libera quando o pagamento é **confirmado**:
1. Você abre `/admin`; o aviso amarelo mostra "N pagamento(s) a conferir".
2. Confere o recebimento no extrato do banco.
3. Abre o cadastro do lead (clique na linha) e toca em **Confirmar recebimento** (ou **Não recebi**). A tela do cliente libera sozinha em poucos segundos.

Confirmação automática (futuro): `POST /api/webhooks/pix` com o cabeçalho `X-Webhook-Secret` e o corpo `{"txid":"SIM12","valor_centavos":500}` confirma o pagamento (o `txid` é o campo 62/05 do código Pix). Só funciona se o banco/automação enviar o `txid`. Alternativa: `PAYMENT_PROVIDER=mercadopago` (confirmação 100% automática, precisa de conta e token do Mercado Pago).

## 6. Trocar a conta Pix de testes pela conta definitiva
Nenhum código muda. No Render → Environment, altere `PIX_CHAVE`, `PIX_RECEBEDOR` e `PIX_CIDADE` para os dados da nova conta e salve (o serviço reinicia sozinho). Depois faça um Pix de R$ 5 de teste e confira se cai na conta nova. Leads e pagamentos antigos continuam intactos.

## 7. Painel `/admin`
- **Buscar** por nome, telefone ou e-mail; **filtrar** por período do cadastro e situação do pagamento; chips de interesse (quentes/mornos/frios).
- **Clique na linha** para ver detalhes (inclui CPF, só com login) e gerar o **PDF individual** (sem CPF) para baixar ou imprimir.
- **Exportar CSV** respeita os filtros (não inclui CPF, nascimento nem nome da mãe). **Imprimir lista** imprime a tabela filtrada (sem dados sensíveis).
- **Planos de Simulação** e **Configurações** (WhatsApp do especialista, link do guia).

## 8. Rotina
- **Cópia de segurança:** exporte o CSV toda semana. Os leads ficam no disco `/data` do Render; sem o disco montado eles se perdem a cada deploy (o painel avisa se detectar isso).
- **Conferir Pix:** os leads com pagamento "conferir" precisam da sua confirmação, olhando o extrato.
- **Atualizar o site:** cada `push` na branch do deploy atualiza o serviço (leva ~1–2 min; o disco `/data` é preservado).
