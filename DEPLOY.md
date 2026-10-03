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

O Dockerfile já define `NODE_ENV=production`, `DB_FILE=/data/simulador.db` e `TRUST_PROXY_HOPS=1`. Se `PIX_CHAVE` ou `PIX_RECEBEDOR` faltarem, o site abre normalmente, mas o pagamento fica **bloqueado** (o cliente vê "Pagamento temporariamente indisponível") e o `/admin` mostra um aviso vermelho; o log também avisa.

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
- **Cópia de segurança:** exporte o CSV toda semana. Os leads ficam no disco `/data` do Render; sem o disco montado eles se perdem a cada deploy (o painel avisa se detectar isso).
- **Conferir Pix:** os leads com pagamento "conferir" precisam da sua confirmação, olhando o extrato.
- **Atualizar o site:** cada `push` na branch do deploy atualiza o serviço (leva ~1–2 min; o disco `/data` é preservado).

## 9. Exclusão de dados pessoais (LGPD)
No `/admin`, clique na linha do lead → **Excluir cadastro…** → escolha o motivo → digite `EXCLUIR` → **Excluir definitivamente**.
- **O que é apagado, sem volta:** nome, WhatsApp, e-mail, CPF, nascimento, nome da mãe, cidade, renda, valores e resultado da simulação. O lead some das listas, do CSV e do PDF, e o link do cliente deixa de funcionar.
- **O que fica:** só o registro financeiro do pagamento (data e valor de R$ 5,00, sem identificação), para a contabilidade, e um registro de que a exclusão aconteceu (data e motivo, sem dados pessoais).
- **O que o sistema não alcança:** CSVs e PDFs que você já baixou, a conversa no WhatsApp com o especialista, e cópias de segurança do disco do Render. Apague esses itens à parte.
- **Ao atender um pedido do titular:** confirme a identidade de quem pede antes de excluir, responda dentro do prazo da LGPD (consulte seu advogado sobre o prazo) e guarde apenas o registro de que o pedido foi atendido.
