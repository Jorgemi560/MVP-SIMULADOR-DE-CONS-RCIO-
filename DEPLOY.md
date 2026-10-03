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
6. **Environment Variables:**

| Nome | Valor |
|---|---|
| `ADMIN_PASSWORD` | uma senha forte (será a do `/admin`) |
| `PAYMENT_PROVIDER` | `pix` |
| `PIX_CHAVE` | `49753831000123` |
| `PIX_RECEBEDOR` | `LATRYKA INDUSTRIAL E COMERCIOS LTDA` |
| `PIX_CNPJ` | `49.753.831/0001-23` |
| `PIX_CIDADE` | cidade da empresa (ex.: `CURITIBA`) |
| `PIX_LIBERAR` | `informado` (libera ao tocar "Já fiz o pagamento") ou `confirmado` |
| `PUBLIC_URL` | `https://ganhemaisno.online` |

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
2. Entre em `https://ganhemaisno.online/admin`, veja o lead, confirme o recebimento e confira os planos.
3. Em **Configurações**, confirme o WhatsApp do especialista e o link do guia.

## 5. Rotina
- **Cópia de segurança:** no `/admin → Leads → Exportar CSV`, toda semana.
- **Conferir Pix:** os leads com pagamento "conferir" precisam da sua confirmação, olhando o extrato.
- **Atualizar o site:** cada `push` na branch do deploy atualiza o serviço (leva ~1–2 min; o disco `/data` é preservado).
