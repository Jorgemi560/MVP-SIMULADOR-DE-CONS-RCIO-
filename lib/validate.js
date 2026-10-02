'use strict';

const digits = (s) => String(s ?? '').replace(/\D/g, '');

function cpfValido(v) {
  const c = digits(v);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(c[n])) return false;
  }
  return true;
}

const emailValido = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v ?? '').trim()) && String(v).length <= 120;

function telefoneValido(v) {
  const d = digits(v).replace(/^55(?=\d{10,11}$)/, '');
  return /^[1-9]{2}9?\d{8}$/.test(d);
}

function dataNascimentoValida(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  if (!m) return false;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
  const idade = (Date.now() - d.getTime()) / (365.25 * 864e5);
  return idade >= 18 && idade <= 100;
}

const textoValido = (v, min = 2, max = 120) => {
  const s = String(v ?? '').trim();
  return s.length >= min && s.length <= max;
};

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

module.exports = { digits, cpfValido, emailValido, telefoneValido, dataNascimentoValida, textoValido, UFS };
