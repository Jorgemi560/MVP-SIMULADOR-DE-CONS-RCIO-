# Publicar em ganhemaisno.online (passo a passo)

**Resumo:** o site roda no Render e os dados ficam num **banco PostgreSQL externo** (Neon, Supabase ou Render Postgres). Nenhum dado fica no disco do servidor: novos deploys e reinícios não apagam leads. O domínio na GoDaddy aponta para o Render. O HTTPS (cadeado) é gratuito e automático. Não precisa comprar hospedagem GoDaddy, e-mail, SSL nem o plano pago do site. **Não é preciso disco no Render.**

> Preços e limites dos planos mudam: confirme nos sites dos provedores antes de contratar.

## 1. Preparar o código
O projeto está no GitHub (`jorgemi560/MVP-SIMULADOR-DE-CONS-RCIO-`, branch `claude/charming-davinci-t7zlwy`). Faça o deploy dessa branch ou, melhor, junte-a à `main` (Pull request → Merge) e use a `main`.

## 2. Criar o serviço no Render

### Passo 0: criar o banco PostgreSQL (antes de qualquer deploy)
Escolha **um** provedor (todos têm plano gratuito ou barato; confira limites e política de backup):
- **Neon** (neon.tech): crie um projeto; em *Connection Details* copie a **Connection string** (`postgresql://...?sslmode=require`).
- **Supabase** (supabase.com): crie um projeto; em *Connect* copie a URI de conexão (use a do *pooler* se o Render reclamar de conexão) e troque `[YOUR-PASSWORD]` pela senha do projeto.
- **Render Postgres**: *New → PostgreSQL*, na mesma conta e região do serviço; copie a **Internal Database URL** (o plano grátis do Render costuma expirar: confira antes de usar para dados reais).

### Conferir a conexão e criar as tabelas
O site cria as tabelas sozinho ao iniciar com a `DATABASE_URL` definida. Para **conferir antes** (ou se o banco estiver vazio), use as ferramentas do projeto. Elas **nunca mostram a senha** e **nunca apagam nem alteram dados**:

| Comando | O que faz |
|---|---|
| `npm run db:verificar` | Testa a conexão e lista as 5 tabelas (`leads`, `pagamentos`, `planos`, `config`, `exclusoes`). Não altera nada. Sai com "Estrutura completa" ou diz o que falta. |
| `npm run db:criar` | Cria só o que falta (as tabelas existentes e seus dados ficam como estão) e mostra o antes e o depois. |
| `npm run db:schema` | Gera de novo o arquivo `db/schema.sql` (só para desenvolvedores). |

**Onde rodar:** no Render, abra o serviço → **Shell** e digite o comando (a `DATABASE_URL` já está lá). Ou no seu computador, com o projeto baixado e `npm install` feito: `DATABASE_URL="postgresql://..." npm run db:verificar`.

**Sem terminal?** Abra o arquivo `db/schema.sql`, copie tudo e cole em **Neon → SQL Editor → Run**. É seguro e pode ser executado mais de uma vez. O resultado é idêntico ao do site.

**Erros comuns** (o comando explica em português): senha ou usuário errados (Neon: *Roles → Reset password* e atualize a URL), host errado, banco inexistente (o padrão do Neon é `neondb`), usuário sem permissão para criar tabelas (use o `neondb_owner`) e "tempo esgotado" (o Neon "dorme" quando fica parado; tente de novo em alguns segundos).

Dicas: escolha a região mais próxima do seu serviço no Render; a senha vai dentro da URL (**não a envie a ninguém**; ela só vai nas variáveis do Render). As tabelas são criadas sozinhas na primeira inicialização, e os planos iniciais também.

1. Crie conta em render.com e conecte o GitHub (autorize só esse repositório).
2. **New → Web Service** → escolha o repositório e a branch.
3. **Language/Runtime: Docker** (ele usa o `Dockerfile` do projeto). **Instance Type: Starter**.
4. **Health Check Path:** `/healthz`.
5. **Não adicione disco.** O banco é externo (Passo 0).
6. **Environment Variables** (Settings → Environment):

| Nome | Valor |
|---|---|
| `DATABASE_URL` | a URL do PostgreSQL do Passo 0. **Obrigatória:** sem ela o serviço não inicia em produção |
| `ADMIN_PASSWORD` | senha forte, 10+ caracteres (será a do `/admin`) |
| `PAYMENT_PROVIDER` | `pix` |
| `PIX_CHAVE` | chave Pix da conta que vai receber (hoje: a conta de testes) |
| `PIX_RECEBEDOR` | nome do titular dessa conta, como no banco |
| `PIX_CIDADE` | cidade do titular |
| `PUBLIC_URL` | `https://ganhemaisno.online` |
| `PIX_WEBHOOK_SECRET` | *(opcional)* segredo de 16+ caracteres, só se um banco/automação for confirmar pagamentos sozinho |
| `DATABASE_SSL` | *(opcional)* `off`, `on` ou `insecure`. O padrão (`on`, verificado) serve para Neon e Supabase; use `off` só se o provedor mandar |
| `WHATSAPP_ESPECIALISTA` | *(opcional)* WhatsApp do especialista, com DDD; também dá para definir em `/admin → Configurações` |

O Dockerfile já define `NODE_ENV=production` e `TRUST_PROXY_HOPS=1`. Se `PIX_CHAVE` ou `PIX_RECEBEDOR` faltarem, o site abre normalmente, mas o pagamento fica **bloqueado** (o cliente vê "Pagamento temporariamente indisponível") e o `/admin` mostra um aviso vermelho; o log também avisa.

7. **Create Web Service.** Quando terminar, abra o endereço `https://NOME.onrender.com` e confira o site.

## 3. Domínio na GoDaddy (ganhemaisno.online)

**Como o DNS está hoje** (consulta feita em 03/10/2026): os servidores de nomes são os da GoDaddy (`ns09/ns10.domaincontrol.com`), então é na GoDaddy que se edita. `ganhemaisno.online` tem dois registros `A` (`13.248.243.5` e `76.223.105.230`), e `www` é um `CNAME` para `ganhemaisno.online`. Não há registros de e-mail (`MX`) nem `TXT`. Ou seja: o domínio ainda aponta para o site grátis da GoDaddy e **não** para o Render.

**Você não precisa inventar valor nenhum: quem informa os valores certos é o próprio Render.**

**Passo 1: pedir os registros ao Render**
1. Render → seu serviço → **Settings → Custom Domains → Add Custom Domain**.
2. Digite `ganhemaisno.online` e confirme. Repita com `www.ganhemaisno.online`.
3. Para cada domínio o Render mostra uma tabela com **Type**, **Name** e **Value**. Anote exatamente o que aparecer. Normalmente é:

| Tipo | Nome (Host) na GoDaddy | Valor |
|---|---|---|
| `A` | `@` | o endereço IP que o Render mostrar para `ganhemaisno.online` |
| `CNAME` | `www` | o endereço `algo.onrender.com` que o Render mostrar para `www.ganhemaisno.online` |

Se o Render mostrar um tipo diferente (por exemplo `ALIAS`/`ANAME` para `@`, que a GoDaddy não aceita), use só o `www` e a alternativa do Passo 6.

**Passo 2: anotar os registros atuais (para poder desfazer)**
1. Entre em godaddy.com → **Meus Produtos** → ao lado de `ganhemaisno.online`, **DNS** (ou *Gerenciar DNS*).
2. Tire um print da lista de registros.

**Passo 3: liberar o domínio do site grátis**
1. Se os registros `A` aparecerem como "WebsiteBuilder Site" ou "Parked" e **não deixarem editar**, o domínio está ligado ao site grátis. Desligue em **Websites + Marketing → seu site → Configurações → Domínio** (desconectar), ou exclua o site grátis.
2. Volte ao **DNS**.

**Passo 4: trocar os registros** (na tela DNS da GoDaddy)
1. **Apague os dois registros `A` de nome `@`** (`13.248.243.5` e `76.223.105.230`), ou edite um deles e apague o outro.
2. **Crie o `A`:** *Adicionar novo registro* → Tipo `A` → Nome `@` → Valor = o IP do Render → TTL 1 hora (ou o padrão) → Salvar.
3. **Troque o `www`:** apague o `CNAME www` que aponta para `ganhemaisno.online` e crie `CNAME` → Nome `www` → Valor = o endereço `.onrender.com` do Render → Salvar. (Também pode editar o existente.)
4. **Não mexa** nos servidores de nomes (NS) nem em outros registros que não sejam esses.

**Passo 5: verificar**
1. Volte ao Render → Custom Domains → clique em **Verify** nos dois domínios. Pode levar de alguns minutos a algumas horas; o certificado HTTPS (cadeado) é emitido sozinho depois.
2. Confira em dnschecker.org (tipo `A` para `ganhemaisno.online` e `CNAME` para `www.ganhemaisno.online`) se já mostram os valores do Render.
3. Abra `https://ganhemaisno.online` e `https://www.ganhemaisno.online` no celular. Os dois devem abrir o simulador com cadeado (o Render costuma redirecionar um para o outro).
4. Só depois que o HTTPS funcionar nos dois, ajuste no Render a variável `PUBLIC_URL` para `https://ganhemaisno.online` (ela liga o HSTS, que obriga HTTPS nos navegadores).

**Passo 6 (só se a GoDaddy não aceitar o `A @`):** use apenas o `CNAME www` do Render e, na GoDaddy, em **Domínio → Encaminhamento**, encaminhe `ganhemaisno.online` para `https://www.ganhemaisno.online` (permanente, 301). O encaminhamento da GoDaddy bloqueia o `A @`; é esperado.

**Se algo der errado:** recrie os registros do print do Passo 2 e o site grátis volta.

## 4. Testar antes de anunciar
1. Abra o site no celular e faça uma simulação pagando **R$ 5,00 de verdade** pelo Pix.
2. Entre em `https://ganhemaisno.online/admin`, veja o lead, confirme o recebimento (sem isso a simulação não libera) e confira os planos.
3. Em **Configurações**, confirme o WhatsApp do especialista e o link do guia.

## 5. Pagamento: como a confirmação funciona
O Pix usa uma chave estática, e o sistema **não enxerga o extrato do banco**. Por isso o cliente **não consegue se liberar sozinho**: "Já fiz o pagamento" só avisa você. A simulação só libera quando o pagamento é **confirmado**:
1. Você abre `/admin`; o aviso amarelo mostra "N pagamento(s) a conferir".
2. Confere o recebimento no extrato do banco.
3. Abre o cadastro do lead (clique na linha) e toca em **Confirmar recebimento** (ou **Não recebi**). A tela do cliente libera sozinha em poucos segundos.

Confirmação automática (futuro): `POST /api/webhooks/pix` com o cabeçalho `X-Webhook-Secret` e o corpo `{"txid":"SIM12","valor_centavos":500}` confirma o pagamento (o `txid` é o campo 62/05 do código Pix). Só funciona se o banco/automação enviar o `txid`. Alternativa: `PAYMENT_PROVIDER=mercadopago` (confirmação 100% automática, precisa de conta e token do Mercado Pago).

## 6. Em qual conta o Pix cai (e por que aparece o nome de outra empresa)
**Quem recebe é sempre o titular da CHAVE Pix.** O sistema monta o código com a chave que está na variável `PIX_CHAVE`; o banco do cliente procura essa chave e mostra o **titular real dela** na tela de confirmação ("Pagar para: NOME"). O texto de `PIX_RECEBEDOR` só entra no código e **não muda para onde o dinheiro vai**. Por isso, se aparece o nome de uma empresa, é porque a chave configurada pertence a ela. Esconder o nome na tela não mudaria nada, e o sistema nunca faz isso.

Duas causas possíveis para o nome "errado":
1. `PIX_CHAVE` no Render é a chave da empresa de testes (é a configuração provisória atual).
2. O Render ainda roda uma versão **antiga** do código (anterior a 03/10/2026), que usava a conta de testes como padrão quando as variáveis não estavam definidas. Veja em Events qual commit está no ar.

**Para receber na conta correta**, no Render → Environment:
| Variável | O que colocar |
|---|---|
| `PIX_CHAVE` | uma chave Pix **cadastrada na conta que deve receber** (CNPJ, e-mail, telefone ou chave aleatória, como está no app do banco). **É isto que define o destino do dinheiro.** |
| `PIX_RECEBEDOR` | nome do titular dessa conta, como no banco |
| `PIX_CIDADE` | cidade do titular |

Salve (o serviço reinicia sozinho) e faça um Pix de teste de R$ 5,00: no app do banco, confira o nome do titular **antes de confirmar** e, depois, veja se o valor caiu na conta certa. No `/admin` há um aviso azul "Conta que recebe os pagamentos Pix" com o recebedor e o final da chave em uso, para você conferir a qualquer momento (o cliente não vê isso).

**Conta definitiva (Cispect):** quando ela tiver conta e chave Pix, é só trocar as três variáveis acima. Nenhum código muda, e leads e pagamentos antigos continuam intactos. A confirmação continua manual (ou por webhook/Mercado Pago, veja a seção 5).

## 7. Painel `/admin`
- **Buscar** por nome, telefone ou e-mail; **filtrar** por período do cadastro e situação do pagamento; chips de interesse (quentes/mornos/frios).
- **Clique na linha** para ver detalhes (inclui CPF, só com login) e gerar o **PDF individual** (sem CPF) para baixar ou imprimir.
- **Exportar CSV** respeita os filtros (não inclui CPF, nascimento nem nome da mãe). **Imprimir lista** imprime a tabela filtrada (sem dados sensíveis).
- **Planos de Simulação** e **Configurações** (WhatsApp do especialista, link do guia).

## 8. Rotina
- **Cópia de segurança:** os leads ficam no PostgreSQL; confira o backup que o seu plano do provedor oferece (alguns planos grátis têm pouco ou nenhum). Faça também um backup seu: `pg_dump "$DATABASE_URL" -Fc -f backup.dump` (no seu computador, com o cliente do Postgres instalado) e o CSV do `/admin` toda semana.
- **Conferir Pix:** os leads com pagamento "conferir" precisam da sua confirmação, olhando o extrato.
- **Atualizar o site:** cada `push` na branch do deploy atualiza o serviço (leva ~1–2 min; os dados ficam no banco externo e não são afetados).

## 9. Exclusão de dados pessoais (LGPD)
No `/admin`, clique na linha do lead → **Excluir cadastro…** → escolha o motivo → digite `EXCLUIR` → **Excluir definitivamente**.
- **O que é apagado, sem volta:** nome, WhatsApp, e-mail, CPF, nascimento, nome da mãe, cidade, renda, valores e resultado da simulação. O lead some das listas, do CSV e do PDF, e o link do cliente deixa de funcionar.
- **O que fica:** só o registro financeiro do pagamento (data e valor de R$ 5,00, sem identificação), para a contabilidade, e um registro de que a exclusão aconteceu (data e motivo, sem dados pessoais).
- **O que o sistema não alcança:** CSVs e PDFs que você já baixou, a conversa no WhatsApp com o especialista, e as cópias de segurança do provedor do banco (guardam versões antigas por alguns dias, conforme o plano; no PostgreSQL, linhas alteradas só somem de vez depois da limpeza automática do banco). Apague esses itens à parte.
- **Ao atender um pedido do titular:** confirme a identidade de quem pede antes de excluir, responda dentro do prazo da LGPD (consulte seu advogado sobre o prazo) e guarde apenas o registro de que o pedido foi atendido.

## 10. Mudando do SQLite (disco do Render) para o PostgreSQL
**Se ainda não há leads de clientes reais, pule este passo:** crie o banco (Passo 0), defina `DATABASE_URL`, faça o deploy e remova o disco depois.

**Se já há leads reais no disco antigo**, siga esta ordem para não perder nada:
1. Crie o PostgreSQL e **defina `DATABASE_URL`** no Render. **Não remova o disco ainda.**
2. Faça o deploy desta versão (ela inicia no PostgreSQL, vazio, com os planos iniciais).
3. No Render, abra o serviço → **Shell** e rode: `node scripts/migrar-sqlite-para-postgres.js /data/simulador.db`.
   O script copia leads, pagamentos, planos e configurações **mantendo os mesmos números**, **substitui os planos de exemplo pelos seus** e **só roda se o PostgreSQL ainda não tiver leads** (se alguém já se cadastrou depois do deploy, ele recusa e não mexe em nada; fale comigo). Ele nunca altera o arquivo SQLite.
4. Confira no `/admin` se os leads e planos apareceram.
5. Só então remova o disco (Settings → Disks). Guarde o arquivo antes, se quiser.

**Atenção à ordem:** sem `DATABASE_URL` definida, a nova versão não inicia. Se isso acontecer, o site fica fora do ar até você definir a variável (o log mostra a mensagem). Por isso a variável vem **antes** do deploy.

## Se o banco diz "QR Code expirado ou inválido, entre em contato com o recebedor"
Com `PAYMENT_PROVIDER=pix` o código é **estático**: não existe validade no banco (a contagem do site é só do sistema). Essa mensagem do banco indica problema na **chave ou na conta**, não em prazo. Passo a passo:
1. Rode `npm run pix:verificar` (com as mesmas variáveis do Render) ou veja o aviso azul/vermelho em `/admin`: ele mostra o tipo da chave reconhecida e avisa se ela foi normalizada.
2. A chave precisa estar no formato do Pix: CPF/CNPJ só números · celular `+55DDDNÚMERO` · e-mail e chave aleatória em minúsculas. O sistema normaliza e **bloqueia o pagamento** se a chave não for reconhecível, mas atualize `PIX_CHAVE` no Render para o valor correto.
3. Confirme no app do banco **dono da chave** que ela está **cadastrada e ativa** para receber Pix (chave de conta de pagamento/instituição que não oferece Pix estático ou chave não registrada gera exatamente essa mensagem).
4. Cole o código de exemplo do passo 1 no "Pix copia e cola" de **outro** banco. Se o titular aparecer, o código está certo; se o erro persistir, é a conta/chave.
5. Se a conta não aceitar Pix estático, use `PAYMENT_PROVIDER=mercadopago` (Pix dinâmico, validade real, confirmação automática; ainda sem teste com credencial real).

## Confirmação 100% automática com Mercado Pago (sem você)
Com `PAYMENT_PROVIDER=mercadopago` cada cliente recebe uma cobrança Pix **própria** (com identificador). Quando ela é paga, o sistema reconhece sozinho e libera a simulação, 24 h por dia. O dinheiro cai na sua conta do Mercado Pago (você transfere para a Conta Simples por Pix/TED; confira tarifas e prazos de saque no Mercado Pago).

**Como o sistema se mantém confiável (três camadas):** (1) aviso automático do Mercado Pago (webhook); (2) a tela do cliente consulta o Mercado Pago a cada 2 s; (3) uma varredura em segundo plano a cada 30 s reconcilia tudo que está pendente (cobre webhook perdido e cliente que fechou a página). Só vale como pago se o Mercado Pago disser "approved", com a **referência** e o **valor** da nossa cobrança.

### O que configurar no Render (Environment)
| Variável | Valor |
|---|---|
| `PAYMENT_PROVIDER` | `mercadopago` |
| `MP_ACCESS_TOKEN` | token de **produção** (`APP_USR-…`) de Mercado Pago → Seu negócio → Configurações → Credenciais (nunca `TEST-…`) |
| `PUBLIC_URL` | `https://ganhemaisno.online` |
| `MP_WEBHOOK_SECRET` | *(recomendado)* "assinatura secreta" mostrada ao configurar o webhook (abaixo) |

### Webhook no painel do Mercado Pago
Suas integrações → sua aplicação → **Webhooks** → modo **Produção** → URL `https://ganhemaisno.online/api/webhooks/mercadopago` → evento **Pagamentos** → Salvar → copie a **assinatura secreta** para `MP_WEBHOOK_SECRET`. (Sem o painel o sistema ainda funciona: envia a URL em cada cobrança e tem as camadas 2 e 3.)

### Conferir antes de usar
1. No Shell do Render (ou local com as mesmas variáveis): `npm run mp:verificar`. Ele valida o token e o `PUBLIC_URL` **sem criar cobrança**.
2. `/admin` mostra o aviso: "Mercado Pago: confirmação automática ativa". Se aparecer aviso vermelho (token de teste, `PUBLIC_URL` faltando), corrija.
3. **Teste real:** faça um Pix de R$ 5,00 pelo site e **não clique em nada**: a tela deve avançar sozinha para a escolha imóvel/veículo em poucos segundos. Confira o log do Render ("Pagamento N confirmado por webhook" ou "pela varredura").
