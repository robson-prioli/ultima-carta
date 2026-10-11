'use strict';
/**
 * Regras do jogo "Última Carta".
 *
 * Todo o estado da partida mora aqui, no servidor: baralho, mãos, vez,
 * cor da mesa. O navegador de cada pessoa só recebe a própria visão
 * (viewFor), então ninguém consegue espiar a mão dos outros nem o
 * baralho, mesmo abrindo o F12.
 */
const crypto = require('crypto');

const COLORS = ['r', 'y', 'g', 'b'];
const COLOR_NAMES = { r: 'vermelho', y: 'amarelo', g: 'verde', b: 'azul' };
const VALUE_NAMES = { skip: 'Bloqueio', rev: 'Inverte', '+2': '+2', wild: 'Coringa', '+4': 'Coringa +4' };
const HAND_SIZE = 7;
const MAX_PLAYERS = 8;
const LOG_SIZE = 8;

/** Erro "esperado" (jogada inválida). A mensagem é mostrada ao jogador. */
class GameError extends Error {}

/** Embaralha com gerador criptográfico (não dá para prever as cartas). */
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** 108 cartas: por cor um 0, dois de 1 a 9, dois Bloqueio, dois Inverte, dois +2; mais 4 Coringas e 4 Coringas +4. */
function buildDeck() {
  const deck = [];
  let id = 0;
  for (const c of COLORS) {
    deck.push({ id: id++, c, v: '0' });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: id++, c, v: String(n) }, { id: id++, c, v: String(n) });
    }
    for (const v of ['skip', 'rev', '+2']) {
      deck.push({ id: id++, c, v }, { id: id++, c, v });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: id++, c: 'w', v: 'wild' }, { id: id++, c: 'w', v: '+4' });
  }
  return shuffle(deck);
}

function cardLabel(card) {
  const v = VALUE_NAMES[card.v] || card.v;
  return card.c === 'w' ? v : `${v} ${COLOR_NAMES[card.c]}`;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = [];        // { id, name, token, hand, connected, ws, dcTimer }
    this.hostId = null;
    this.phase = 'lobby';     // lobby | playing | ended
    this.round = 0;
    this.deck = [];
    this.discard = [];
    this.color = null;
    this.turn = 0;
    this.dir = 1;
    this.drawnCardId = null;  // carta comprada nesta vez (só ela pode ser jogada)
    this.vulnerableId = null; // quem ficou com 1 carta sem gritar "Última!"
    this.winnerId = null;
    this.log = [];
    this.lastActive = Date.now();
  }

  // ---------- jogadores ----------

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  addPlayer({ id, name, token }) {
    if (this.phase === 'playing') throw new GameError('A rodada já começou. Espere ela acabar para entrar.');
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`A sala está cheia (máximo ${MAX_PLAYERS}).`);
    const lower = name.toLocaleLowerCase('pt-BR');
    if (this.players.some((p) => p.name.toLocaleLowerCase('pt-BR') === lower)) {
      throw new GameError('Já tem alguém com esse nome na sala. Escolha outro.');
    }
    this.players.push({ id, name, token, hand: [], connected: true, ws: null, dcTimer: null });
    if (!this.hostId) this.hostId = id;
    this.addLog(`${name} entrou na sala`);
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const [p] = this.players.splice(idx, 1);
    clearTimeout(p.dcTimer);
    this.addLog(`${p.name} saiu`);

    if (this.phase === 'playing') {
      this.deck.unshift(...p.hand); // cartas voltam para o fundo do baralho
      if (idx < this.turn) {
        this.turn--;
      } else if (idx === this.turn) {
        this.drawnCardId = null;
        if (this.dir === -1) this.turn--;
      }
      const n = this.players.length;
      if (n) this.turn = ((this.turn % n) + n) % n;
      if (this.vulnerableId === id) this.vulnerableId = null;
      if (n < 2) {
        this.phase = 'ended';
        this.winnerId = n ? this.players[0].id : null;
        this.addLog('Rodada encerrada: faltaram jogadores');
      }
    }
    if (this.hostId === id) this.hostId = this.players[0] ? this.players[0].id : null;
  }

  // ---------- partida ----------

  start(byId) {
    if (byId !== this.hostId) throw new GameError('Só quem criou a sala pode começar.');
    if (this.phase === 'playing') throw new GameError('A rodada já está em andamento.');
    if (this.players.length < 2) throw new GameError('Precisa de pelo menos 2 jogadores.');

    this.deck = buildDeck();
    this.discard = [];
    for (const p of this.players) p.hand = this.deck.splice(-HAND_SIZE);

    // A primeira carta da mesa precisa ser um número
    let first = this.deck.pop();
    while (!/^\d$/.test(first.v)) {
      this.deck.unshift(first);
      first = this.deck.pop();
    }
    this.discard.push(first);
    this.color = first.c;
    this.turn = crypto.randomInt(this.players.length);
    this.dir = 1;
    this.drawnCardId = null;
    this.vulnerableId = null;
    this.winnerId = null;
    this.phase = 'playing';
    this.round++;
    this.log = [];
    this.addLog(`Rodada ${this.round} começou. ${this.current.name} começa!`);
  }

  get current() {
    return this.players[this.turn];
  }

  top() {
    return this.discard[this.discard.length - 1] || null;
  }

  isPlayable(card) {
    return card.c === 'w' || card.c === this.color || card.v === this.top().v;
  }

  play(id, cardId, color, announce) {
    this.assertTurn(id);
    const p = this.current;
    if (!Number.isInteger(cardId)) throw new GameError('Carta inválida.');
    const idx = p.hand.findIndex((c) => c.id === cardId);
    if (idx < 0) throw new GameError('Essa carta não está na sua mão.');
    if (this.drawnCardId !== null && cardId !== this.drawnCardId) {
      throw new GameError('Depois de comprar, você só pode jogar a carta comprada ou passar.');
    }
    const card = p.hand[idx];
    if (!this.isPlayable(card)) throw new GameError('Essa carta não combina com a da mesa.');
    if (card.c === 'w' && !COLORS.includes(color)) throw new GameError('Escolha uma cor para o coringa.');

    this.closeVulnerable(id);
    p.hand.splice(idx, 1);
    this.discard.push(card);
    this.color = card.c === 'w' ? color : card.c;
    this.addLog(`${p.name} jogou ${cardLabel(card)}${card.c === 'w' ? ` e escolheu ${COLOR_NAMES[color]}` : ''}`);

    if (p.hand.length === 0) {
      this.phase = 'ended';
      this.winnerId = p.id;
      this.vulnerableId = null;
      this.addLog(`${p.name} venceu a rodada!`);
      return;
    }
    if (p.hand.length === 1) {
      if (announce === true) this.addLog(`${p.name} gritou "Última!"`);
      else this.vulnerableId = p.id;
    }

    const n = this.players.length;
    switch (card.v) {
      case 'skip':
        this.next(2);
        break;
      case 'rev':
        if (n === 2) this.next(2);
        else { this.dir *= -1; this.next(1); }
        break;
      case '+2':
      case '+4': {
        this.next(1);
        const victim = this.current;
        const amount = card.v === '+2' ? 2 : 4;
        this.drawCards(victim, amount);
        this.addLog(`${victim.name} comprou ${amount} e perdeu a vez`);
        this.next(1);
        break;
      }
      default:
        this.next(1);
    }
  }

  draw(id) {
    this.assertTurn(id);
    if (this.drawnCardId !== null) throw new GameError('Você já comprou nesta vez. Jogue a carta ou passe.');
    this.closeVulnerable(id);
    const p = this.current;
    const [card] = this.drawCards(p, 1);
    if (!card) {
      this.addLog(`${p.name} passou (sem cartas para comprar)`);
      this.next(1);
    } else if (this.isPlayable(card)) {
      this.drawnCardId = card.id;
      this.addLog(`${p.name} comprou uma carta`);
    } else {
      this.addLog(`${p.name} comprou e passou`);
      this.next(1);
    }
  }

  pass(id) {
    this.assertTurn(id);
    if (this.drawnCardId === null) throw new GameError('Compre uma carta antes de passar.');
    this.addLog(`${this.current.name} passou`);
    this.next(1);
  }

  /** Quem ficou com 1 carta e esqueceu de gritar ainda pode gritar antes de ser pego. */
  announce(id) {
    if (this.phase !== 'playing' || this.vulnerableId !== id) throw new GameError('Agora não precisa gritar.');
    this.vulnerableId = null;
    this.addLog(`${this.player(id).name} gritou "Última!" a tempo`);
  }

  /** Pegar quem esqueceu de gritar: ele compra 2. */
  catchPlayer(id, targetId) {
    if (this.phase !== 'playing') throw new GameError('Não há rodada em andamento.');
    if (!this.vulnerableId || this.vulnerableId !== targetId || targetId === id) {
      throw new GameError('Não há ninguém para pegar agora.');
    }
    const me = this.player(id);
    const target = this.player(targetId);
    this.drawCards(target, 2);
    this.vulnerableId = null;
    this.addLog(`${me.name} pegou ${target.name} sem gritar "Última!" (+2)`);
  }

  // ---------- auxiliares ----------

  assertTurn(id) {
    if (this.phase !== 'playing') throw new GameError('Não há rodada em andamento.');
    if (this.current.id !== id) throw new GameError('Calma, ainda não é a sua vez.');
  }

  /** A chance de pegar alguém termina quando outra pessoa faz a próxima jogada. */
  closeVulnerable(actorId) {
    if (this.vulnerableId && this.vulnerableId !== actorId) this.vulnerableId = null;
  }

  next(steps) {
    const n = this.players.length;
    this.turn = (((this.turn + this.dir * steps) % n) + n) % n;
    this.drawnCardId = null;
  }

  drawCards(p, amount) {
    const got = [];
    for (let i = 0; i < amount; i++) {
      if (this.deck.length === 0) {
        // Reaproveita a pilha da mesa, menos a carta de cima
        const top = this.discard.pop();
        this.deck = shuffle(this.discard);
        this.discard = top ? [top] : [];
        if (this.deck.length === 0) break;
      }
      const card = this.deck.pop();
      p.hand.push(card);
      got.push(card);
    }
    return got;
  }

  addLog(text) {
    this.log.push(text);
    if (this.log.length > LOG_SIZE) this.log.shift();
  }

  /** O que UM jogador pode ver. Nunca inclui tokens, baralho ou mãos alheias. */
  viewFor(id) {
    const me = this.player(id);
    const playing = this.phase === 'playing';
    const myTurn = playing && this.current.id === id;
    const top = this.top();
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      you: id,
      hostId: this.hostId,
      hand: me.hand.map(({ id: cid, c, v }) => ({ id: cid, c, v })),
      playable: myTurn
        ? me.hand.filter((c) => (this.drawnCardId === null || c.id === this.drawnCardId) && this.isPlayable(c)).map((c) => c.id)
        : [],
      canDraw: myTurn && this.drawnCardId === null,
      canPass: myTurn && this.drawnCardId !== null,
      players: this.players.map((p) => ({ id: p.id, name: p.name, count: p.hand.length, connected: p.connected })),
      turnId: playing ? this.current.id : null,
      dir: this.dir,
      color: this.color,
      top: top ? { c: top.c, v: top.v } : null,
      deckCount: this.deck.length,
      vulnerableId: this.vulnerableId,
      winnerId: this.winnerId,
      log: this.log.slice(),
    };
  }
}

module.exports = { Room, GameError, COLORS, MAX_PLAYERS };
