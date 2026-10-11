'use strict';
/**
 * Teste automático: liga o servidor, coloca 3 robôs para jogar uma
 * partida inteira e tenta alguns "ataques" para conferir as proteções.
 *
 * Rode com:  npm test
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3999;
const URL = `ws://localhost:${PORT}/ws`;
const ORIGIN = `http://localhost:${PORT}`;
let failures = 0;

function check(ok, label) {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}`);
  if (!ok) failures++;
}

function open(origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { origin });
    ws.inbox = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'state') ws.state = m.state;
      ws.inbox.push(m);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

function waitFor(ws, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const i = ws.inbox.findIndex(pred);
      if (i >= 0) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - started > ms) return reject(new Error('tempo esgotado'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastState = (ws) => ws.state || null;

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);
    server.once('exit', () => reject(new Error(`O servidor não subiu. A porta ${PORT} está livre?`)));
  });

  try {
    console.log('\nSegurança');
    // 1. Conexão vinda de outro site é recusada
    let blocked = false;
    try { await open('https://site-malicioso.com'); } catch { blocked = true; }
    check(blocked, 'WebSocket de outro site é recusado');

    // 2. Arquivos fora da lista não são servidos
    const res = await fetch(`http://localhost:${PORT}/../server.js`);
    const res2 = await fetch(`http://localhost:${PORT}/src/security.js`);
    check(res.status === 404 && res2.status === 404, 'Código do servidor não pode ser baixado');
    const home = await fetch(`http://localhost:${PORT}/`);
    check((home.headers.get('content-security-policy') || '').includes("script-src 'self'"), 'Página sai com política de segurança (CSP)');

    // 3. Nome com HTML é aceito só como texto e com tamanho limitado
    const a = await open();
    a.send(JSON.stringify({ t: 'create', name: '<img src=x onerror=alert(1)>Ana' }));
    const joinedA = await waitFor(a, (m) => m.t === 'joined');
    const st = (await waitFor(a, (m) => m.t === 'state')).state;
    check(st.players[0].name.length <= 16, 'Nome cortado em 16 caracteres');
    check(!JSON.stringify(st).includes(joinedA.token), 'Token secreto não aparece no estado do jogo');

    const b = await open();
    const c = await open();
    b.send(JSON.stringify({ t: 'join', code: joinedA.code, name: 'Bruno' }));
    c.send(JSON.stringify({ t: 'join', code: joinedA.code, name: 'Carla' }));
    await waitFor(b, (m) => m.t === 'joined');
    await waitFor(c, (m) => m.t === 'joined');

    // 4. Quem não é anfitrião não pode começar
    b.send(JSON.stringify({ t: 'start' }));
    const err = await waitFor(b, (m) => m.t === 'error');
    check(/Só quem criou/.test(err.msg), 'Só o anfitrião começa a partida');

    // 5. Código errado várias vezes derruba a conexão
    const guesser = await open();
    const closed = new Promise((r) => guesser.on('close', r));
    for (let i = 0; i < 10; i++) guesser.send(JSON.stringify({ t: 'join', code: 'ZZZZ', name: 'X' }));
    await Promise.race([closed, sleep(2000)]);
    check(guesser.readyState !== WebSocket.OPEN, 'Quem chuta códigos de sala é desconectado');

    // 6. Enxurrada de mensagens derruba a conexão
    const spammer = await open();
    const spamClosed = new Promise((r) => spammer.on('close', r));
    for (let i = 0; i < 60; i++) spammer.send(JSON.stringify({ t: 'noop' }));
    await Promise.race([spamClosed, sleep(2000)]);
    check(spammer.readyState !== WebSocket.OPEN, 'Excesso de mensagens desconecta');

    // 7. Mensagem gigante é recusada
    const big = await open();
    const bigClosed = new Promise((r) => big.on('close', r));
    big.send(JSON.stringify({ t: 'create', name: 'x'.repeat(5000) }));
    await Promise.race([bigClosed, sleep(2000)]);
    check(big.readyState !== WebSocket.OPEN, 'Mensagem acima de 1 KB é recusada');

    console.log('\nPartida com 3 robôs');
    a.send(JSON.stringify({ t: 'start' }));
    await sleep(150);
    const bots = [a, b, c];
    const views = () => bots.map(lastState);

    // 8. Ninguém vê a mão dos outros
    const v0 = views();
    const leaked = v0.some((v) => v.players.some((p) => 'hand' in p) || 'deck' in v);
    check(!leaked && v0.every((v) => v.hand.length === 7), 'Cada um recebe só as próprias 7 cartas');

    // 9. Jogar fora da vez é recusado
    const waiting = bots.find((w) => lastState(w).turnId !== lastState(w).you);
    const wv = lastState(waiting);
    waiting.inbox.length = 0;
    waiting.send(JSON.stringify({ t: 'play', cardId: wv.hand[0].id }));
    const outOfTurn = await waitFor(waiting, (m) => m.t === 'error');
    check(/não é a sua vez/.test(outOfTurn.msg), 'Jogada fora da vez é recusada');

    // 10. Jogar carta que não está na mão é recusado
    const turnBot = bots.find((w) => lastState(w).turnId === lastState(w).you);
    const other = bots.find((w) => w !== turnBot);
    const stolen = lastState(other).hand[0].id;
    turnBot.inbox.length = 0;
    turnBot.send(JSON.stringify({ t: 'play', cardId: stolen }));
    const notMine = await waitFor(turnBot, (m) => m.t === 'error');
    check(/não está na sua mão/.test(notMine.msg), 'Carta de outro jogador é recusada');

    // Joga até alguém vencer
    let moves = 0;
    let lastLog = [];
    while (moves < 1500) {
      await sleep(5);
      const vs = views();
      const v = vs[0];
      if (v.phase === 'ended') { lastLog = v.log; break; }
      const idx = vs.findIndex((x) => x.turnId === x.you);
      if (idx < 0) continue;
      const me = vs[idx];
      const bot = bots[idx];
      const before = JSON.stringify(me);
      if (me.playable.length) {
        const card = me.hand.find((h) => h.id === me.playable[0]);
        bot.send(JSON.stringify({ t: 'play', cardId: card.id, color: 'g', announce: me.hand.length === 2 }));
      } else if (me.canPass) {
        bot.send(JSON.stringify({ t: 'pass' }));
      } else {
        bot.send(JSON.stringify({ t: 'draw' }));
      }
      moves++;
      // espera o estado mudar
      for (let i = 0; i < 100 && JSON.stringify(lastState(bot)) === before; i++) await sleep(5);
      for (const w of bots) w.inbox.length = 0;
    }
    const final = lastState(a);
    check(final.phase === 'ended' && final.winnerId, `Partida terminou com vencedor em ${moves} jogadas`);
    const total = views().reduce((s, v) => s + v.hand.length, 0) + final.deckCount;
    check(total < 108, 'Contagem de cartas consistente');
    console.log('    Últimas jogadas:');
    for (const line of lastLog.slice(-4)) console.log(`      · ${line}`);

    for (const w of bots) w.close();
  } finally {
    server.kill('SIGTERM');
  }

  console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nTudo certo!');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
