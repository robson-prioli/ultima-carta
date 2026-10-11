'use strict';
/**
 * Servidor do "Última Carta".
 *
 * - Entrega a página do jogo (só os arquivos da lista FILES, nada mais).
 * - Mantém as salas e conversa com os jogadores por WebSocket em /ws.
 * - É a única autoridade do jogo: o navegador só pede ações
 *   ("jogar a carta 42") e o servidor confere se a jogada é válida.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room, GameError } = require('./src/game');
const sec = require('./src/security');

const PORT = Number(process.env.PORT) || 3000;

const LIMITS = {
  maxPayload: 1024,                 // bytes por mensagem
  maxRooms: 200,
  maxConnections: 500,
  maxConnPerIp: 12,
  msgPerSecond: 12,
  msgBurst: 25,
  maxJoinFails: 8,                  // tentativas erradas de código antes de desconectar
  reconnectGraceMs: 60 * 1000,      // tempo para voltar se a internet cair
  roomIdleMs: 2 * 60 * 60 * 1000,   // sala parada há 2 h é apagada
};

// ---------- arquivos públicos (lista fechada: não dá para pedir outro arquivo) ----------

const PUBLIC_DIR = path.join(__dirname, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
for (const entry of Object.values(FILES)) {
  entry.push(fs.readFileSync(path.join(PUBLIC_DIR, entry[0])));
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://local').pathname;
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  const file = FILES[pathname];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...sec.securityHeaders(req) });
    return res.end('Página não encontrada');
  }
  res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache', ...sec.securityHeaders(req) });
  res.end(req.method === 'HEAD' ? undefined : file[2]);
});

// ---------- WebSocket ----------

const rooms = new Map();
const ipCount = new Map();
let connCount = 0;

const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload });

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://local').pathname; } catch { /* inválido */ }
  if (pathname !== '/ws') return reject(socket, 404, 'Not Found');
  if (!sec.originAllowed(req)) return reject(socket, 403, 'Forbidden');
  const ip = sec.clientIp(req);
  if (connCount >= LIMITS.maxConnections || (ipCount.get(ip) || 0) >= LIMITS.maxConnPerIp) {
    return reject(socket, 429, 'Too Many Requests');
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, ip));
});

wss.on('connection', (ws, ip) => {
  connCount++;
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  ws.ctx = {
    ip,
    alive: true,
    limiter: new sec.RateLimiter(LIMITS.msgPerSecond, LIMITS.msgBurst),
    joinFails: 0,
    roomCode: null,
    playerId: null,
  };

  ws.on('pong', () => { ws.ctx.alive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return ws.close(1003, 'Somente texto');
    if (!ws.ctx.limiter.take()) return ws.close(1008, 'Mensagens demais');
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return send(ws, { t: 'error', msg: 'Mensagem inválida.' });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (err) {
      if (err instanceof GameError) send(ws, { t: 'error', msg: err.message });
      else {
        console.error(err);
        send(ws, { t: 'error', msg: 'Algo deu errado no servidor. Tente de novo.' });
      }
    }
  });

  ws.on('close', () => {
    connCount--;
    const left = (ipCount.get(ip) || 1) - 1;
    if (left <= 0) ipCount.delete(ip); else ipCount.set(ip, left);
    detach(ws);
  });

  ws.on('error', () => {});
});

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.ws) send(p.ws, { t: 'state', state: room.viewFor(p.id) });
  }
}

function handle(ws, msg) {
  const room = ws.ctx.roomCode ? rooms.get(ws.ctx.roomCode) : null;
  const pid = ws.ctx.playerId;

  switch (msg.t) {
    case 'create': {
      if (room) throw new GameError('Você já está em uma sala.');
      const name = sec.cleanName(msg.name);
      if (!name) throw new GameError('Digite seu nome (até 16 letras).');
      if (rooms.size >= LIMITS.maxRooms) throw new GameError('O servidor está cheio agora. Tente daqui a pouco.');
      const code = sec.makeRoomCode((c) => rooms.has(c));
      const newRoom = new Room(code);
      rooms.set(code, newRoom);
      seat(ws, newRoom, name);
      return;
    }

    case 'join': {
      if (room) throw new GameError('Você já está em uma sala.');
      if (ws.ctx.joinFails >= LIMITS.maxJoinFails) return ws.close(1008, 'Tentativas demais');
      const name = sec.cleanName(msg.name);
      if (!name) throw new GameError('Digite seu nome (até 16 letras).');
      const code = sec.cleanCode(msg.code);
      const target = code && rooms.get(code);
      if (!target) {
        ws.ctx.joinFails++;
        throw new GameError('Sala não encontrada. Confira o código.');
      }
      seat(ws, target, name);
      return;
    }

    case 'resume': {
      if (room) throw new GameError('Você já está em uma sala.');
      if (ws.ctx.joinFails >= LIMITS.maxJoinFails) return ws.close(1008, 'Tentativas demais');
      const code = sec.cleanCode(msg.code);
      const target = code && rooms.get(code);
      const p = target && target.players.find((pl) => sec.sameToken(pl.token, msg.token));
      if (!p) {
        ws.ctx.joinFails++;
        return send(ws, { t: 'resume-failed' });
      }
      if (p.ws && p.ws !== ws) {
        // A mesma pessoa abriu o jogo em outra aba: a antiga é desconectada
        const old = p.ws;
        old.ctx.roomCode = null;
        old.ctx.playerId = null;
        old.close(4000, 'Aberto em outra aba');
      }
      attach(ws, target, p);
      return;
    }
  }

  // Daqui para baixo, só quem está em uma sala
  if (!room || !pid) throw new GameError('Entre em uma sala primeiro.');
  room.lastActive = Date.now();

  switch (msg.t) {
    case 'start': room.start(pid); break;
    case 'play': room.play(pid, msg.cardId, msg.color, msg.announce === true); break;
    case 'draw': room.draw(pid); break;
    case 'pass': room.pass(pid); break;
    case 'announce': room.announce(pid); break;
    case 'catch': room.catchPlayer(pid, typeof msg.targetId === 'string' ? msg.targetId : ''); break;
    case 'leave': return leave(ws, room);
    default: throw new GameError('Ação desconhecida.');
  }
  broadcast(room);
}

function seat(ws, room, name) {
  const id = crypto.randomBytes(8).toString('hex');
  const token = sec.newToken();
  try {
    room.addPlayer({ id, name, token });
  } catch (err) {
    if (room.players.length === 0) rooms.delete(room.code);
    throw err;
  }
  attach(ws, room, room.player(id));
}

function attach(ws, room, p) {
  clearTimeout(p.dcTimer);
  p.dcTimer = null;
  p.ws = ws;
  p.connected = true;
  ws.ctx.roomCode = room.code;
  ws.ctx.playerId = p.id;
  room.lastActive = Date.now();
  // O token só é enviado para o próprio dono, nunca para os outros
  send(ws, { t: 'joined', code: room.code, token: p.token, playerId: p.id });
  broadcast(room);
}

function detach(ws) {
  const room = ws.ctx.roomCode && rooms.get(ws.ctx.roomCode);
  if (!room) return;
  const p = room.player(ws.ctx.playerId);
  if (!p || p.ws !== ws) return;
  p.ws = null;
  p.connected = false;
  p.dcTimer = setTimeout(() => {
    if (!p.connected && room.player(p.id)) {
      room.removePlayer(p.id);
      afterRemoval(room);
    }
  }, LIMITS.reconnectGraceMs);
  broadcast(room);
}

function leave(ws, room) {
  const pid = ws.ctx.playerId;
  ws.ctx.roomCode = null;
  ws.ctx.playerId = null;
  room.removePlayer(pid);
  send(ws, { t: 'left' });
  afterRemoval(room);
}

function afterRemoval(room) {
  if (room.players.length === 0) rooms.delete(room.code);
  else broadcast(room);
}

// Derruba conexões mortas (celular que perdeu sinal, aba fechada à força)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.ctx.alive) { ws.terminate(); continue; }
    ws.ctx.alive = false;
    ws.ping();
  }
}, 25 * 1000);

// Apaga salas esquecidas
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive < LIMITS.roomIdleMs) continue;
    for (const p of room.players) {
      clearTimeout(p.dcTimer);
      if (p.ws) {
        p.ws.ctx.roomCode = null;
        p.ws.ctx.playerId = null;
        send(p.ws, { t: 'left', reason: 'A sala foi fechada por inatividade.' });
      }
    }
    rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Última Carta rodando em http://localhost:${PORT}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const ws of wss.clients) ws.close(1001, 'Servidor reiniciando');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
