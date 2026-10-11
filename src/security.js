'use strict';
/**
 * Proteções do servidor. Cada função aqui fecha uma porta específica:
 * nomes maliciosos, códigos de sala adivinháveis, conexões de outros
 * sites, excesso de mensagens e cabeçalhos HTTP inseguros.
 */
const crypto = require('crypto');

// Sem letras/números parecidos (0/O, 1/I/L) para facilitar ditar o código em voz alta
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const NAME_MAX = 16;

/**
 * Limpa o nome digitado: remove caracteres invisíveis e de controle,
 * junta espaços e corta no tamanho máximo. O navegador também só exibe
 * nomes como texto puro (textContent), então não há como injetar HTML.
 */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return name.length ? name : null;
}

function cleanCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code) ? code : null;
}

/** Código de sala sorteado com gerador criptográfico. */
function makeRoomCode(exists) {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!exists(code)) return code;
  }
}

/** Identidade secreta de cada jogador, usada para reconectar se a internet cair. */
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Compara tokens em tempo constante (não vaza nada pelo tempo de resposta). */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Limite de mensagens por conexão (balde de fichas). */
class RateLimiter {
  constructor(perSecond, burst) {
    this.rate = perSecond;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Só aceita WebSocket aberto pela própria página do jogo.
 * Impede que outro site use o navegador de alguém para se conectar aqui.
 * Para liberar outro domínio, defina ALLOWED_ORIGINS no Render
 * (ex.: https://meujogo.com,https://www.meujogo.com).
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (extra.length) return extra.includes(url.origin);
    return url.host === req.headers.host;
  } catch {
    return false;
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'desconhecido';
}

/** Cabeçalhos de segurança enviados com cada página. */
function securityHeaders(req) {
  const host = req.headers.host;
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const validHost = typeof host === 'string' && /^[a-z0-9.-]+(:\d+)?$/i.test(host);
  const wsSource = validHost ? (secure ? ` wss://${host}` : ` ws://${host} wss://${host}`) : '';
  const headers = {
    // Só carrega scripts e estilos do próprio servidor: bloqueia scripts injetados
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self'${wsSource}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

module.exports = {
  cleanName,
  cleanCode,
  makeRoomCode,
  newToken,
  sameToken,
  RateLimiter,
  originAllowed,
  clientIp,
  securityHeaders,
};
