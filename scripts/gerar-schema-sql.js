#!/usr/bin/env node
'use strict';
// Gera db/schema.sql a partir de lib/esquema.js (a mesma definição que o servidor usa).
// Para colar no "SQL Editor" do Neon (ou de outro PostgreSQL). Só CRIA o que não existe; não apaga nem altera dados.
//   npm run db:schema
const fs = require('node:fs');
const path = require('node:path');
const { ESQUEMA, PLANOS_INICIAIS, CONFIG_INICIAL, COLUNAS_PLANO } = require('../lib/esquema');

const lit = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function gerarSql() {
  const partes = [];
  partes.push(`-- Estrutura do banco do Simulador de Consórcio (PostgreSQL).
-- GERADO AUTOMATICAMENTE por "npm run db:schema" a partir de lib/esquema.js. Não edite à mão.
--
-- COMO USAR (Neon): Neon Console -> seu projeto -> SQL Editor -> cole TODO este arquivo -> Run.
--
-- É SEGURO: só usa CREATE ... IF NOT EXISTS e inserções condicionais. Não apaga, não altera e não sobrescreve nada.
-- Pode ser executado várias vezes. Os planos iniciais só entram se a tabela "planos" estiver vazia.
-- O servidor faz o mesmo sozinho ao iniciar; este arquivo é uma alternativa manual.
`);
  partes.push('BEGIN;\n');
  partes.push(ESQUEMA.map((d) => `${d.trim()};`).join('\n\n'));
  const planos = PLANOS_INICIAIS.map((p) => `    INSERT INTO planos (${COLUNAS_PLANO}) VALUES (${p.map(lit).join(', ')});`).join('\n');
  partes.push(`\n-- Planos iniciais (somente se ainda não houver nenhum plano)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM planos) THEN
${planos}
  END IF;
END $$;`);
  partes.push(`\n-- Configurações iniciais (não altera as que já existem)
INSERT INTO config (chave, valor) VALUES ${Object.entries(CONFIG_INICIAL).map(([k, v]) => `(${lit(k)}, ${lit(v)})`).join(', ')}
ON CONFLICT (chave) DO NOTHING;`);
  partes.push('\nCOMMIT;\n');
  return partes.join('\n');
}

const ARQUIVO = path.join(__dirname, '..', 'db', 'schema.sql');
module.exports = { gerarSql, ARQUIVO };

if (require.main === module) {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  fs.writeFileSync(ARQUIVO, gerarSql());
  console.log(`Gerado: ${path.relative(process.cwd(), ARQUIVO)}`);
}
