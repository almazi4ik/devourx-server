const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const WORLD = 12000;
const TICK = 33; // ~30 тиков/сек вместо 20
const MIN_LEN = 10;
const MAX_BODY = 1000;
const MAX_FOOD = 800;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DevourX Server OK');
});

const wss = new WebSocket.Server({ server });

let foods = [];
let players = {};
let nextId = 1;

// ══════ ЕДА ══════
function mkFood() {
  return {
    x: Math.random() * WORLD,
    y: Math.random() * WORLD,
    r: 4 + Math.random() * 7,
    color: `hsl(${Math.floor(Math.random() * 360)},90%,65%)`,
    big: Math.random() > 0.82
  };
}

function initFoods() {
  foods = [];
  for (let i = 0; i < MAX_FOOD; i++) foods.push(mkFood());
}

// ══════ ЗМЕЯ ══════
function mkSnake(x, y, name, skinId) {
  const angle = Math.random() * Math.PI * 2;
  const segs = [];
  for (let i = 0; i < MIN_LEN; i++) {
    segs.push({
      x: x - Math.cos(angle) * i * 14,
      y: y - Math.sin(angle) * i * 14
    });
  }
  return {
    x, y,
    name: name || 'Player',
    skinId: skinId || 0,
    angle,
    tAngle: angle,
    speed: 2.8,
    boosting: false,
    alive: true,
    length: MIN_LEN,
    score: MIN_LEN,
    segs,
    turnSpeed: 0.18,
  };
}

function getR(score) {
  return 6 + (Math.min(score, 1000) / 1000) * 22;
}

function updateSnake(sn) {
  if (!sn.alive) return;
  let da = sn.tAngle - sn.angle;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  sn.angle += da * sn.turnSpeed;
  const spd = sn.boosting ? sn.speed * 1.85 : sn.speed;
  const hx = sn.segs[0].x + Math.cos(sn.angle) * spd;
  const hy = sn.segs[0].y + Math.sin(sn.angle) * spd;
  // Убиваем при касании границы
  if (hx <= 0 || hx >= WORLD || hy <= 0 || hy >= WORLD) {
    killSnake(sn);
    return;
  }
  sn.segs.unshift({ x: hx, y: hy });
  while (sn.segs.length > sn.length) sn.segs.pop();
}

function eatFood(sn) {
  const h = sn.segs[0];
  const r = getR(sn.score);
  for (let i = foods.length - 1; i >= 0; i--) {
    const f = foods[i];
    const dx = h.x - f.x, dy = h.y - f.y;
    const er = (f.big ? f.r + 8 : f.r + 4) + r;
    if (dx * dx + dy * dy < er * er) {
      const g = f.big ? 4 : 1;
      sn.score += g;
      if (sn.length < MAX_BODY) sn.length = Math.min(MAX_BODY, sn.length + g);
      // Заменяем съеденную еду новой в случайном месте
      foods[i] = mkFood();
    }
  }
}

function killSnake(sn) {
  if (!sn.alive) return;
  sn.alive = false;
  // Записываем в глобальный топ если это игрок
  if (!sn.isBot && sn.name && sn.score > 0) {
    updateGlobalTop(sn.name, sn.score, sn.skinId);
  }
  // Выбрасываем еду из тела
  const drop = Math.min(sn.segs.length, 80);
  for (let i = 0; i < drop; i += 3) {
    const s = sn.segs[i];
    // Заменяем существующую еду вместо добавления новой (чтобы не превышать MAX_FOOD)
    const replaceIdx = Math.floor(Math.random() * foods.length);
    foods[replaceIdx] = {
      x: s.x + (Math.random() - 0.5) * 20,
      y: s.y + (Math.random() - 0.5) * 20,
      r: 5 + Math.random() * 5,
      color: `hsl(${Math.floor(Math.random() * 360)},90%,65%)`,
      big: true
    };
  }
}

// ══════ КОЛЛИЗИИ (только игроки) ══════
function checkCollisions() {
  const alivePlayers = Object.values(players).filter(s => s.alive);

  for (const sn of alivePlayers) {
    if (!sn.alive) continue;
    const h = sn.segs[0];
    const r = getR(sn.score);

    for (const other of alivePlayers) {
      if (!other.alive || other === sn) continue;
      // Голова sn врезается в тело other
      for (let i = 2; i < other.segs.length; i++) {
        const s = other.segs[i];
        const dx = h.x - s.x, dy = h.y - s.y;
        const rr = r + getR(other.score) - 2;
        if (dx * dx + dy * dy < rr * rr) {
          killSnake(sn);
          break;
        }
      }
      if (!sn.alive) break;
    }
  }
}

// ══════ СНАПШОТ МИРА ══════
function buildWorldSnapshot(forPlayerId) {
  const me = players[forPlayerId];
  if (!me || !me.segs.length) return null;

  const cx = me.segs[0].x;
  const cy = me.segs[0].y;
  const VIEW = 2000;

  // Только живые игроки
  const nearPlayers = Object.entries(players)
    .filter(([, p]) => p.alive)
    .map(([id, p]) => ({
      id,
      name: p.name,
      skinId: p.skinId,
      score: p.score,
      segs: p.segs.slice(0, 60),
      boosting: p.boosting,
      isMe: id === forPlayerId
    }));

  // Еда в зоне видимости
  const nearFoods = foods.filter(f => {
    const dx = f.x - cx, dy = f.y - cy;
    return dx * dx + dy * dy < VIEW * VIEW;
  }).slice(0, 300);

  // Лидерборд — только игроки, без ботов
  const sorted = Object.values(players)
    .filter(s => s.alive)
    .sort((a, b) => b.score - a.score);

  const leaderboard = sorted.slice(0, 10).map(s => ({
    name: s.name,
    score: s.score,
    isMe: s === me
  }));

  return {
    type: 'world',
    players: nearPlayers,
    foods: nearFoods,
    leaderboard,
    globalTop: globalTop.slice(0, 20),
    myScore: me.score,
    myAlive: me.alive
  };
}

// ══════ ИГРОВОЙ ТИК ══════
function gameTick() {
  // Обновляем всех игроков
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    updateSnake(p);
    eatFood(p);
    // Ускорение тратит массу
    if (p.boosting && p.length > MIN_LEN && Math.random() < 0.18) {
      p.length = Math.max(MIN_LEN, p.length - 1);
      p.score = Math.max(MIN_LEN, p.score - 1);
    }
  }

  checkCollisions();

  // Считаем онлайн один раз для всех
  const playerCount = Object.values(players).filter(p => p.alive).length;

  // Рассылаем снапшоты
  for (const id in players) {
    const p = players[id];
    const ws = p.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;

    if (!p.alive) {
      if (!p.deathSent) {
        p.deathSent = true;
        ws.send(JSON.stringify({ type: 'dead', score: p.score }));
      }
      continue;
    }

    const snapshot = buildWorldSnapshot(id);
    if (snapshot) {
      snapshot.playerCount = playerCount;
      try { ws.send(JSON.stringify(snapshot)); } catch(e) {}
    }
  }
}

// ══════ СОЕДИНЕНИЯ ══════
wss.on('connection', (ws) => {
  const id = String(nextId++);
  console.log(`[+] Игрок ${id} подключился`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      // Спавн в центре мира
      const spawnX = WORLD / 2;
      const spawnY = WORLD / 2;
      const p = mkSnake(spawnX, spawnY, msg.name || 'Player', msg.skinId || 0);
      p.ws = ws;
      p.deathSent = false;
      players[id] = p;

      const joinCount = Object.values(players).filter(p => p.alive).length;
      ws.send(JSON.stringify({
        type: 'joined',
        id,
        spawnX,
        spawnY,
        worldSize: WORLD,
        playerCount: joinCount
      }));
      console.log(`[join] ${msg.name} спавн в центре (id=${id})`);
    }

    if (msg.type === 'input') {
      const p = players[id];
      if (!p || !p.alive) return;
      p.tAngle = msg.angle;
      p.boosting = msg.boost && p.length > MIN_LEN;
    }

    if (msg.type === 'getTop') {
      ws.send(JSON.stringify({ type: 'globalTop', data: globalTop.slice(0, 20) }));
    }

    if (msg.type === 'respawn') {
      const oldP = players[id];
      // Респавн тоже в центре
      const spawnX = WORLD / 2;
      const spawnY = WORLD / 2;
      const p = mkSnake(spawnX, spawnY, oldP ? oldP.name : 'Player', oldP ? oldP.skinId : 0);
      p.ws = ws;
      p.deathSent = false;
      players[id] = p;
      ws.send(JSON.stringify({ type: 'joined', id, spawnX, spawnY, worldSize: WORLD }));
      console.log(`[respawn] ${p.name} (id=${id})`);
    }
  });

  ws.on('close', () => {
    console.log(`[-] Игрок ${id} отключился`);
    if (players[id]) {
      // Записать рекорд перед удалением
      const p = players[id];
      if (p.score > 0) updateGlobalTop(p.name, p.score, p.skinId);
      killSnake(p);
      delete players[id];
    }
  });

  ws.on('error', () => {
    if (players[id]) {
      killSnake(players[id]);
      delete players[id];
    }
  });
});

initFoods();
// Глобальный топ рекордов (хранится пока сервер жив)
let globalTop = []; // [{name, score, skinId}]

function updateGlobalTop(name, score, skinId) {
  // Обновляем или добавляем запись
  const existing = globalTop.findIndex(r => r.name === name);
  if (existing >= 0) {
    if (score > globalTop[existing].score) globalTop[existing] = { name, score, skinId };
  } else {
    globalTop.push({ name, score, skinId });
  }
  globalTop.sort((a, b) => b.score - a.score);
  globalTop = globalTop.slice(0, 50); // храним топ-50
}

// Боты убраны — только реальные игроки
setInterval(gameTick, TICK);

server.listen(PORT, () => {
  console.log(`DevourX сервер запущен на порту ${PORT} (тик ${TICK}мс)`);
});
