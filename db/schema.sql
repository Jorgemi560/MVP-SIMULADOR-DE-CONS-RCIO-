-- Estrutura do banco do Simulador de Consórcio (PostgreSQL).
-- GERADO AUTOMATICAMENTE por "npm run db:schema" a partir de lib/esquema.js. Não edite à mão.
--
-- COMO USAR (Neon): Neon Console -> seu projeto -> SQL Editor -> cole TODO este arquivo -> Run.
--
-- É SEGURO: só usa CREATE ... IF NOT EXISTS e inserções condicionais. Não apaga, não altera e não sobrescreve nada.
-- Pode ser executado várias vezes. Os planos iniciais só entram se a tabela "planos" estiver vazia.
-- O servidor faz o mesmo sozinho ao iniciar; este arquivo é uma alternativa manual.

BEGIN;

CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    token TEXT NOT NULL,
    nome TEXT NOT NULL,
    email TEXT NOT NULL,
    telefone TEXT NOT NULL,
    cpf TEXT, nascimento TEXT, nome_mae TEXT, cidade TEXT, estado TEXT,
    tipo TEXT, credito DOUBLE PRECISION,
    renda_mensal DOUBLE PRECISION,
    capacidade_label TEXT, capacidade_valor DOUBLE PRECISION,
    parcela_escolhida TEXT,
    plano_id INTEGER,
    simulacao TEXT,
    resultado TEXT,
    interesse TEXT,
    status TEXT NOT NULL DEFAULT 'aguardando_pagamento',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    simulado_em TIMESTAMPTZ,
    excluido_em TIMESTAMPTZ
  );

CREATE TABLE IF NOT EXISTS pagamentos (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    provedor TEXT NOT NULL,
    provedor_id TEXT,
    valor_centavos INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    pago_em TIMESTAMPTZ
  );

CREATE TABLE IF NOT EXISTS exclusoes (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    motivo TEXT NOT NULL DEFAULT '',
    excluido_em TIMESTAMPTZ NOT NULL DEFAULT now()
  );

CREATE INDEX IF NOT EXISTS idx_pag_lead ON pagamentos(lead_id);

CREATE INDEX IF NOT EXISTS idx_pag_prov ON pagamentos(provedor, provedor_id);

CREATE INDEX IF NOT EXISTS idx_leads_criado ON leads(criado_em DESC);

CREATE TABLE IF NOT EXISTS planos (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('imovel','veiculo','outros')),
    prazo INTEGER NOT NULL,
    taxa_admin DOUBLE PRECISION NOT NULL,
    fundo_reserva DOUBLE PRECISION NOT NULL DEFAULT 0,
    seguro DOUBLE PRECISION NOT NULL DEFAULT 0,
    indice TEXT NOT NULL DEFAULT 'IPCA',
    reduzida INTEGER NOT NULL DEFAULT 0,
    reducao_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    reducao_regra TEXT NOT NULL DEFAULT 'fundo_comum',
    reducao_meses INTEGER NOT NULL DEFAULT 0,
    arredondamento TEXT NOT NULL DEFAULT 'cortar',
    regra_texto TEXT NOT NULL DEFAULT '',
    credito_min DOUBLE PRECISION NOT NULL,
    credito_max DOUBLE PRECISION NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1
  );

CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);

-- Planos iniciais (somente se ainda não houver nenhum plano)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM planos) THEN
    INSERT INTO planos (nome,tipo,prazo,taxa_admin,fundo_reserva,seguro,indice,reduzida,reducao_pct,reducao_regra,regra_texto,credito_min,credito_max,arredondamento) VALUES ('Imóvel 220 meses abaixo de R$500 mil (calibrado)', 'imovel', 220, 24.19, 0, 0, 'INCC', 1, 49.984, 'fundo_comum', 'Redução de 50% somente sobre o fundo comum; a taxa de administração permanece integral.', 60000, 499999.99, 'cortar');
    INSERT INTO planos (nome,tipo,prazo,taxa_admin,fundo_reserva,seguro,indice,reduzida,reducao_pct,reducao_regra,regra_texto,credito_min,credito_max,arredondamento) VALUES ('Imóvel 220 meses 55% diluído, a partir de R$500 mil', 'imovel', 220, 24.19, 0, 0, 'INCC', 1, 45, 'fundo_comum', 'Parcela reduzida paga 55% do fundo comum; a taxa de administração permanece integral.', 500000, 1500000, 'cortar');
    INSERT INTO planos (nome,tipo,prazo,taxa_admin,fundo_reserva,seguro,indice,reduzida,reducao_pct,reducao_regra,regra_texto,credito_min,credito_max,arredondamento) VALUES ('Veículo 90 meses (calibrado)', 'veiculo', 90, 16.2, 0, 0, 'IPCA', 0, 0, 'fundo_comum', '', 20000, 400000, 'arredondar');
    INSERT INTO planos (nome,tipo,prazo,taxa_admin,fundo_reserva,seguro,indice,reduzida,reducao_pct,reducao_regra,regra_texto,credito_min,credito_max,arredondamento) VALUES ('Outros bens 60 meses (exemplo)', 'outros', 60, 18, 2, 0.04, 'IPCA', 0, 0, 'fundo_comum', '', 5000, 200000, 'cortar');
  END IF;
END $$;

-- Configurações iniciais (não altera as que já existem)
INSERT INTO config (chave, valor) VALUES ('whatsapp', ''), ('learn_url', '')
ON CONFLICT (chave) DO NOTHING;

COMMIT;
