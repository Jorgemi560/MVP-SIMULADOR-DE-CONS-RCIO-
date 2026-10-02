'use strict';
// Gera o BR Code do Pix ("copia e cola") estático, com valor e identificador (txid).
// Especificação: Manual do BR Code / Manual de Padrões para Iniciação do Pix (Banco Central).

const tlv = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`;

function crc16(str) { // CRC16/CCITT-FALSE
  let crc = 0xffff;
  for (const ch of Buffer.from(str, 'utf8')) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-]/g, '').toUpperCase();

function brCode({ chave, valorCentavos, recebedor, cidade, txid }) {
  const campos =
    tlv('00', '01') +
    tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', chave)) +
    tlv('52', '0000') +
    tlv('53', '986') +
    tlv('54', (valorCentavos / 100).toFixed(2)) +
    tlv('58', 'BR') +
    tlv('59', semAcento(recebedor).slice(0, 25).trim()) +
    tlv('60', semAcento(cidade).slice(0, 15).trim()) +
    tlv('62', tlv('05', String(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***'));
  const semCrc = `${campos}6304`;
  return semCrc + crc16(semCrc);
}

module.exports = { brCode, crc16 };
