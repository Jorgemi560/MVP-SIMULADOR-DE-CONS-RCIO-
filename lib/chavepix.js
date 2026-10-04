'use strict';
// Normaliza e valida a CHAVE Pix informada em PIX_CHAVE. O banco só reconhece a chave no formato exato do DICT:
//   CPF / CNPJ: só dígitos (CNPJ alfanumérico: 12 letras/dígitos + 2 dígitos) · celular: +55DDDNÚMERO · e-mail: minúsculas ·
//   chave aleatória: UUID em minúsculas. Chave digitada "como aparece no app" (com pontos, traços, parênteses, sem +55,
//   com maiúsculas) gera um QR Code que o banco recusa ("QR Code inválido").
const cpfValido = (d) => {
  if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); if (((s * 10) % 11) % 10 !== +d[n]) return false; }
  return true;
};

function analisarChave(bruto) {
  const original = String(bruto ?? '').trim();
  const res = (tipo, valor) => ({ ok: true, tipo, valor, ajustada: valor !== original });
  const invalida = (motivo) => ({ ok: false, tipo: null, valor: original, ajustada: false, motivo });
  if (!original) return invalida('PIX_CHAVE está vazia.');
  if (original.includes('@')) {
    const v = original.toLowerCase();
    return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) && v.length <= 77 ? res('email', v) : invalida('Chave parece um e-mail, mas o formato é inválido.');
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(original)) return res('aleatoria', original.toLowerCase());
  const digitos = original.replace(/\D/g, '');
  if (original.startsWith('+')) return /^55[1-9]\d{9,10}$/.test(digitos) ? res('celular', `+${digitos}`) : invalida('Celular deve estar no formato +55 DDD número (ex.: +5541999999999).');
  const limpo = original.replace(/[\s.\-/()]/g, '').toUpperCase();
  if (/^\d{14}$/.test(limpo) || /^[A-Z0-9]{12}\d{2}$/.test(limpo)) return res('cnpj', limpo);
  if (/^\d{11}$/.test(limpo)) {
    if (cpfValido(limpo)) return res('cpf', limpo);
    if (/^[1-9]\d9\d{8}$/.test(limpo)) return res('celular', `+55${limpo}`);
    return invalida('Chave de 11 dígitos que não é um CPF válido nem um celular com DDD.');
  }
  if (/^[1-9]\d{9}$/.test(limpo)) return res('celular', `+55${limpo}`);
  if (/^55[1-9]\d{9,10}$/.test(limpo)) return res('celular', `+${limpo}`);
  return invalida('Formato de chave não reconhecido (use CPF, CNPJ, celular, e-mail ou chave aleatória).');
}

module.exports = { analisarChave, cpfValido };
