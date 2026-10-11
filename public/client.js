'use strict';
/**
 * Navegador do jogador.
 *
 * Este arquivo NÃO decide nada do jogo. Ele só:
 *  1. mostra o que o servidor mandou (a sua mão, a mesa, de quem é a vez);
 *  2. envia pedidos de ação ("quero jogar a carta 42").
 * Se alguém alterar este código pelo F12, o servidor continua recusando
 * jogadas inválidas.
 *
 * Segurança na tela: todo texto vindo de outros jogadores (nomes, registro
 * de jogadas) é colocado com textContent, nunca com innerHTML.
 */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const COLOR_NAMES = { r: 'Vermelho', y: 'Amarelo', g: 'Verde', b: 'Azul' };
  const SYMBOL = { skip: '⊘', rev: '⇄', '+2': '+2', wild: '✦', '+4': '+4' };
  const LABEL = { skip: 'Bloqueio', rev: 'Inverte', '+2': 'Mais dois', wild: 'Coringa', '+4': 'Coringa mais quatro' };
  const COLOR_ORDER = { r: 0, y: 1, g: 2, b: 3, w: 4 };
  const VALUE_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'rev', '+2', 'wild', '+4'];

  let ws = null;
  let state = null;
  let retry = 0;
  let armed = false;        // "Última!" apertado antes de jogar a penúltima carta
  let pendingWild = null;   // coringa esperando a escolha de cor
  let stopped = false;      // aberto em outra aba
  let toastTimer = null;

  // ---------- armazenamento local (protegido contra navegação privada) ----------
  const session = {
    get() { try { return JSON.parse(sessionStorage.getItem('uc-session')); } catch { return null; } },
    set(v) { try { sessionStorage.setItem('uc-session', JSON.stringify(v)); } catch { /* sem armazenamento */ } },
    clear() { try { sessionStorage.removeItem('uc-session'); } catch { /* sem armazenamento */ } },
  };
  const savedName = {
    get() { try { return localStorage.getItem('uc-name') || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem('uc-name', v); } catch { /* sem armazenamento */ } },
  };

  // ---------- criação de elementos sem innerHTML ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  // ---------- conexão ----------
  function connect() {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    setConn('Conectando…');

    ws.onopen = () => {
      retry = 0;
      setConn(null);
      const s = session.get();
      if (s && s.code && s.token) send({ t: 'resume', code: s.code, token: s.token });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (ev.code === 4000) {
        stopped = true;
        setConn('Você abriu o jogo em outra aba. Continue por lá.');
        return;
      }
      setConn('Sem conexão. Reconectando…');
      const delay = Math.min(10000, 500 * 2 ** retry++);
      setTimeout(connect, delay);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else toast('Sem conexão. Tentando reconectar…');
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'joined':
        session.set({ code: msg.code, token: msg.token });
        break;
      case 'state':
        state = msg.state;
        render();
        break;
      case 'resume-failed':
      case 'left':
        session.clear();
        state = null;
        show('home');
        if (msg.reason) toast(msg.reason);
        break;
      case 'error':
        toast(msg.msg);
        break;
    }
  }

  // ---------- telas ----------
  function show(name) {
    for (const id of ['home', 'lobby', 'game']) $(`#screen-${id}`).hidden = id !== name;
    if (name !== 'game') { $('#ended').hidden = true; $('#color-picker').hidden = true; }
  }

  function render() {
    if (!state) return show('home');
    if (state.phase === 'lobby') return renderLobby();
    renderGame();
  }

  const nameOf = (id) => (state.players.find((p) => p.id === id) || {}).name || '';

  function renderLobby() {
    show('lobby');
    $('#lobby-code').textContent = state.code;
    $('#lobby-link').textContent = `${location.origin}/?sala=${state.code}`;
    $('#lobby-players').replaceChildren(...state.players.map((p) => playerRow(p)));
    const isHost = state.hostId === state.you;
    $('#btn-start').hidden = !isHost;
    $('#btn-start').disabled = state.players.length < 2;
    $('#lobby-wait').textContent = isHost
      ? (state.players.length < 2 ? 'Esperando mais alguém entrar…' : `${state.players.length} jogadores prontos.`)
      : `Esperando ${nameOf(state.hostId)} começar a partida…`;
  }

  function playerRow(p) {
    return h('li', { class: p.connected ? '' : 'offline' },
      h('span', { text: p.name }),
      p.id === state.hostId && h('span', { class: 'tag', text: 'anfitrião' }),
      p.id === state.you && h('span', { class: 'tag', text: 'você' }),
      !p.connected && h('span', { class: 'tag', text: 'sem conexão' }));
  }

  function renderGame() {
    show('game');
    const me = state.you;
    const playing = state.phase === 'playing';
    const myTurn = playing && state.turnId === me;

    $('#game-code').textContent = state.code;
    $('#game-round').textContent = state.round ? `Rodada ${state.round}` : '';

    // Adversários na ordem da mesa, começando depois de você
    const idx = state.players.findIndex((p) => p.id === me);
    const others = state.players.slice(idx + 1).concat(state.players.slice(0, idx));
    $('#opponents').replaceChildren(...others.map((p) => {
      const cls = ['opp', p.id === state.turnId && 'turn', p.id === state.vulnerableId && 'vuln', !p.connected && 'offline']
        .filter(Boolean).join(' ');
      const backs = h('span', { class: 'backs', 'aria-hidden': 'true' },
        Array.from({ length: Math.min(p.count, 8) }, () => h('i')));
      return h('li', { class: cls },
        h('span', { class: 'oname', text: p.name }),
        h('span', { class: 'ocount' }, backs, `${p.count}`));
    }));

    // Mesa
    $('#discard').replaceChildren(state.top ? cardEl(state.top, 'div') : '');
    $('#color-dot').className = `dot c-${state.color || 'w'}`;
    $('#color-name').textContent = state.color ? COLOR_NAMES[state.color] : '';
    $('#dir').textContent = state.dir === 1 ? '↻' : '↺';
    $('#deck-count').textContent = `${state.deckCount} no monte`;
    $('#btn-draw').disabled = !state.canDraw;

    // Situação
    const status = $('#status');
    status.classList.toggle('mine', myTurn);
    status.textContent = !playing ? ''
      : myTurn ? (state.canPass ? 'Jogue a carta comprada ou passe' : 'Sua vez!')
      : `Vez de ${nameOf(state.turnId)}`;

    // Botões de ação
    const handSize = state.hand.length;
    if (!(myTurn && handSize === 2)) armed = false;
    const announce = $('#btn-announce');
    const vulnerableMe = state.vulnerableId === me;
    announce.hidden = !(playing && ((myTurn && handSize === 2) || vulnerableMe));
    announce.setAttribute('aria-pressed', String(armed));
    announce.textContent = armed ? 'Última! ✓' : 'Última!';
    $('#btn-pass').hidden = !state.canPass;
    const catchBtn = $('#btn-catch');
    const target = playing && state.vulnerableId && state.vulnerableId !== me ? state.vulnerableId : null;
    catchBtn.hidden = !target;
    if (target) catchBtn.textContent = `Pegar ${nameOf(target)}!`;

    // Sua mão
    const playable = new Set(state.playable);
    const sorted = state.hand.slice().sort((a, b) =>
      COLOR_ORDER[a.c] - COLOR_ORDER[b.c] || VALUE_ORDER.indexOf(a.v) - VALUE_ORDER.indexOf(b.v));
    const hand = $('#hand');
    hand.classList.toggle('myturn', myTurn);
    hand.replaceChildren(...sorted.map((c) => {
      const el = cardEl(c, 'button');
      el.type = 'button';
      if (playable.has(c.id)) {
        el.classList.add('playable');
        el.addEventListener('click', () => playCard(c));
      } else {
        el.disabled = true;
      }
      return el;
    }));

    // Registro (mais recente primeiro)
    $('#log').replaceChildren(...state.log.slice().reverse().slice(0, 5).map((line) => h('li', { text: line })));

    // Fim de rodada
    const ended = $('#ended');
    ended.hidden = state.phase !== 'ended';
    if (!ended.hidden) {
      $('#winner').textContent = state.winnerId
        ? (state.winnerId === me ? 'Você venceu! 🎉' : `${nameOf(state.winnerId)} venceu!`)
        : 'Rodada encerrada';
      const isHost = state.hostId === me;
      $('#btn-again').hidden = !isHost;
      $('#btn-again').disabled = state.players.length < 2;
      $('#ended-wait').textContent = isHost
        ? (state.players.length < 2 ? 'Precisa de pelo menos 2 jogadores.' : '')
        : `Esperando ${nameOf(state.hostId)} começar a próxima…`;
    }
    if (!myTurn) $('#color-picker').hidden = true;
  }

  function cardEl(card, tag) {
    const isNum = /^\d$/.test(card.v);
    const face = isNum ? card.v : SYMBOL[card.v];
    const aria = card.c === 'w' ? LABEL[card.v] : `${isNum ? card.v : LABEL[card.v]} ${COLOR_NAMES[card.c].toLowerCase()}`;
    return h(tag, { class: `card c-${card.c}`, 'data-corner': face, 'aria-label': aria },
      h('span', { class: 'face', 'aria-hidden': 'true', text: face }));
  }

  // ---------- ações ----------
  function playCard(card) {
    if (card.c === 'w') {
      pendingWild = card.id;
      $('#color-picker').hidden = false;
      $('#color-picker .swatch').focus();
      return;
    }
    send({ t: 'play', cardId: card.id, announce: armed });
    armed = false;
  }

  function chooseColor(color) {
    $('#color-picker').hidden = true;
    if (pendingWild === null) return;
    send({ t: 'play', cardId: pendingWild, color, announce: armed });
    pendingWild = null;
    armed = false;
  }

  function readName() {
    const name = $('#name').value.replace(/\s+/g, ' ').trim();
    if (!name) {
      toast('Digite seu nome primeiro.');
      $('#name').focus();
      return null;
    }
    savedName.set(name);
    return name;
  }

  /** Sair pede confirmação com um segundo toque (o jogo não usa janelas do navegador). */
  function confirmLeave(btn) {
    if (btn.dataset.confirm === '1') {
      send({ t: 'leave' });
      return;
    }
    const original = btn.textContent;
    btn.dataset.confirm = '1';
    btn.textContent = 'Toque de novo para sair';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = original; }, 3000);
  }

  function setConn(text) {
    const el = $('#conn');
    el.hidden = !text;
    if (text) el.textContent = text;
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---------- ligações dos botões ----------
  function init() {
    $('#name').value = savedName.get();
    const fromLink = new URLSearchParams(location.search).get('sala');
    if (fromLink) $('#code').value = fromLink.toUpperCase().slice(0, 4);

    $('#btn-create').addEventListener('click', () => {
      const name = readName();
      if (name) send({ t: 'create', name });
    });
    const join = () => {
      const name = readName();
      const code = $('#code').value.trim().toUpperCase();
      if (!name) return;
      if (code.length !== 4) return toast('O código da sala tem 4 letras.');
      send({ t: 'join', name, code });
    };
    $('#btn-join').addEventListener('click', join);
    $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    $('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#code').value ? join() : $('#btn-create').click(); });

    $('#btn-copy').addEventListener('click', async () => {
      const link = $('#lobby-link').textContent;
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copiado!');
      } catch {
        const range = document.createRange();
        range.selectNodeContents($('#lobby-link'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('Link selecionado. Copie com Ctrl+C ou segurando o dedo.');
      }
    });

    $('#btn-start').addEventListener('click', () => send({ t: 'start' }));
    $('#btn-again').addEventListener('click', () => send({ t: 'start' }));
    $('#btn-draw').addEventListener('click', () => send({ t: 'draw' }));
    $('#btn-pass').addEventListener('click', () => send({ t: 'pass' }));
    $('#btn-catch').addEventListener('click', () => {
      if (state && state.vulnerableId) send({ t: 'catch', targetId: state.vulnerableId });
    });
    $('#btn-announce').addEventListener('click', () => {
      if (!state) return;
      if (state.vulnerableId === state.you) { send({ t: 'announce' }); return; }
      armed = !armed;
      renderGame();
    });

    for (const btn of document.querySelectorAll('.swatch')) {
      btn.addEventListener('click', () => chooseColor(btn.dataset.color));
    }
    $('#btn-cancel-color').addEventListener('click', () => { pendingWild = null; $('#color-picker').hidden = true; });

    for (const id of ['#btn-leave-lobby', '#btn-leave-game', '#btn-leave-ended']) {
      $(id).addEventListener('click', (e) => confirmLeave(e.currentTarget));
    }

    connect();
  }

  init();
})();
