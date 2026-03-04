const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const WORLD = 12000;
const TICK = 50;
const MAX_BOTS = 30;
const MIN_LEN = 10;
const MAX_BODY = 1000;
const MAX_FOOD = 800;
const BOT_NAMES = ['Toxix','BloodWorm','Kira','ZeroX','Ghost','Titan','Nova','Crux','Venom','Abyss','Rush','Nyx','Omen','Void','Fang','Drift','Blaze','Pulse','Echo','Raven','Cobra','Sphinx','Drex','Hornet','Vex'];

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DevourX Server OK');
});

const wss = new WebSocket.Server({ server });

let foods = [];
let bots = [];
let players = {};
let nextId = 1;

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

function mkSnake(x, y, name, skinId, isBot = false, botIdx = 0) {
  const angle = Math.random() * Math.PI * 2;
  const segs = [];
  for (let i = 0; i < MIN_LEN; i++) {
    segs.push({ x: x - Math.cos(angle) * i * 14, y: y - Math.sin(angle) * i * 14 });
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
    isBot,
    botIdx,
    turnSpeed: isBot ? 0.06 : 0.18,
  };
}

function getR(score) {
  const s = Math.min(score, 1000);
  return 6 + (s / 1000) * 22;
}

function updateSnake(sn) {
  if (!sn.alive) return;
  let da = sn.tAngle - sn.angle;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  sn.angle += da * sn.turnSpeed;
  const spd = sn.boosting ? sn.speed * 1.85 : sn.speed;
  const hx = ((sn.segs[0].x + Math.cos(sn.angle) * spd) % WORLD + WORLD) % WORLD;
  const hy = ((sn.segs[0].y + Math.sin(sn.angle) * spd) % WORLD + WORLD) % WORLD;
  sn.segs.unshift({ x: hx, y: hy });
  while (sn.segs.length > sn.length) sn.segs.pop();
}

function eatFood(sn) {
  const h = sn.segs[0];
  const r = getR(sn.score);
  let gained = 0;
  for (let i = foods.length - 1; i >= 0; i--) {
    const f = foods[i];
    const dx = h.x - f.x, dy = h.y - f.y;
    const er = (f.big ? f.r + 8 : f.r + 4) + r;
    if (dx * dx + dy * dy < er * er) {
      const g = f.big ? 4 : 1;
      sn.score += g;
      if (sn.length < MAX_BODY) sn.length = Math.min(MAX_BODY, sn.length + g);
      foods.splice(i, 1);
      foods.push(mkFood());
      gained += g;
    }
  }
  return gained;
}

function killSnake(sn) {
  if (!sn.alive) return;
  sn.alive = false;
  const drop = Math.min(sn.segs.length, 80);
  for (let i = 0; i < drop; i += 3) {
    const s = sn.segs[i];
    foods.push({
      x: s.x + (Math.random() - 0.5) * 20,
      y: s.y + (Math.random() - 0.5) * 20,
      r: 5 + Math.random() * 5,
      color: `hsl(${Math.floor(Math.random() * 360)},90%,65%)`,
      big: true
    });
  }
}

function updateBotAI(bot) {
  if (!bot.alive) return;
  const h = bot.segs[0];

  let best = Infinity, tgt = null;
  for (let i = 0; i < foods.length; i += 4) {
    const f = foods[i];
    const dx = f.x - h.x, dy = f.y - h.y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; tgt = f; }
  }
  if (tgt) bot.tAngle = Math.atan2(tgt.y - h.y, tgt.x - h.x);

  for (const pid in players) {
    const p = players[pid];
    if (!p.alive) continue;
    const ph = p.segs[0];
    const dx = ph.x - h.x, dy = ph.y - h.y;
    if (dx * dx + dy * dy < 120 * 120) {
      bot.tAngle = Math.atan2(h.y - ph.y, h.x - ph.x);
    }
  }

  for (const ob of bots) {
    if (ob === bot || !ob.alive) continue;
    const oh = ob.segs[0];
    const dx = oh.x - h.x, dy = oh.y - h.y;
    if (dx * dx + dy * dy < 55 * 55) {
      bot.tAngle = Math.atan2(h.y - oh.y, h.x - oh.x);
    }
  }

  if (h.x < 200) bot.tAngle = 0;
  if (h.x > WORLD - 200) bot.tAngle = Math.PI;
  if (h.y < 200) bot.tAngle = Math.PI / 2;
  if (h.y > WORLD - 200) bot.tAngle = -Math.PI / 2;

  bot.boosting = false;
}

function initBots() {
  bots = [];
  for (let i = 0; i < MAX_BOTS; i++) {
    const b = mkSnake(
      800 + Math.random() * (WORLD - 1600),
      800 + Math.random() * (WORLD - 1600),
      BOT_NAMES[i % BOT_NAMES.length],
      Math.floor(Math.random() * 8),
      true, i
    );
    b.score = MIN_LEN + Math.floor(Math.random() * 200);
    b.length = b.score;
    for (let j = 0; j < b.length - MIN_LEN; j++) b.segs.push({ ...b.segs[b.segs.length - 1] });
    bots.push(b);
  }
}

function checkCollisions() {
  const allSnakes = [...Object.values(players), ...bots].filter(s => s.alive);

  for (const sn of allSnakes) {
    if (!sn.alive) continue;
    const h = sn.segs[0];
    const r = getR(sn.score);

    for (const other of allSnakes) {
      if (!other.alive || other === sn) continue;
      const skipSegs = other === sn ? 10 : 2;
      for (let i = skipSegs; i < other.segs.length; i++) {
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

  for (let i = 0; i < bots.length; i++) {
    if (!bots[i].alive) {
      const b = mkSnake(
        800 + Math.random() * (WORLD - 1600),
        800 + Math.random() * (WORLD - 1600),
        BOT_NAMES[bots[i].botIdx % BOT_NAMES.length],
        Math.floor(Math.random() * 8),
        true, bots[i].botIdx
      );
      bots[i] = b;
    }
  }
}

function buildWorldSnapshot(forPlayerId) {
  const me = players[forPlayerId];
  if (!me || !me.segs.length) return null;

  const cx = me.segs[0].x;
  const cy = me.segs[0].y;
  const VIEW = 2000;

  const nearPlayers = Object.entries(players)
    .filter(([id, p]) => p.alive)
    .map(([id, p]) => {
      return {
        id,
        name: p.name,
        skinId: p.skinId,
        score: p.score,
        segs: p.segs.slice(0, 60),
        boosting: p.boosting,
        isMe: id === forPlayerId
      };
    });

  const nearBots = bots
    .filter(b => {
      if (!b.alive || !b.segs.length) return false;
      const h = b.segs[0];
      const dx = h.x - cx, dy = h.y - cy;
      return dx * dx + dy * dy < VIEW * VIEW * 4;
    })
    .map(b => ({
      name: b.name,
      skinId: b.skinId,
      score: b.score,
      segs: b.segs.slice(0, 40),
      boosting: b.boosting
    }));

  const nearFoods = foods.filter(f => {
    const dx = f.x - cx, dy = f.y - cy;
    return dx * dx + dy * dy < VIEW * VIEW;
  }).slice(0, 300);

  const allSnakes = [...Object.values(players), ...bots].filter(s => s.alive);
  allSnakes.sort((a, b) => b.score - a.score);
  const leaderboard = allSnakes.slice(0, 10).map(s => ({
    name: s.name,
    score: s.score,
    isMe: s === me
  }));

  return {
    type: 'world',
    players: nearPlayers,
    bots: nearBots,
    foods: nearFoods,
    leaderboard,
    myScore: me.score,
    myAlive: me.alive
  };
}

function gameTick() {
  for (const bot of bots) {
    updateBotAI(bot);
    updateSnake(bot);
    eatFood(bot);
    if (bot.boosting && bot.length > MIN_LEN && Math.random() < 0.18) {
      bot.length = Math.max(MIN_LEN, bot.length - 1);
      bot.score = Math.max(MIN_LEN, bot.score - 1);
    }
  }

  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    updateSnake(p);
    eatFood(p);
    if (p.boosting && p.length > MIN_LEN && Math.random() < 0.18) {
      p.length = Math.max(MIN_LEN, p.length - 1);
      p.score = Math.max(MIN_LEN, p.score - 1);
    }
  }

  checkCollisions();

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
      try { ws.send(JSON.stringify(snapshot)); } catch(e) {}
    }
  }
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  console.log(`[+] Игрок ${id} подключился`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const spawnX = 800 + Math.random() * (WORLD - 1600);
      const spawnY = 800 + Math.random() * (WORLD - 1600);
      const p = mkSnake(spawnX, spawnY, msg.name || 'Player', msg.skinId || 0, false);
      p.ws = ws;
      p.deathSent = false;
      players[id] = p;

      ws.send(JSON.stringify({
        type: 'joined',
        id,
        spawnX,
        spawnY,
        worldSize: WORLD
      }));
      console.log(`[join] ${msg.name} (id=${id})`);
    }

    if (msg.type === 'input') {
      const p = players[id];
      if (!p || !p.alive) return;
      p.tAngle = msg.angle;
      p.boosting = msg.boost && p.length > MIN_LEN;
    }

    if (msg.type === 'respawn') {
      const spawnX = 800 + Math.random() * (WORLD - 1600);
      const spawnY = 800 + Math.random() * (WORLD - 1600);
      const oldP = players[id];
      const p = mkSnake(spawnX, spawnY, oldP ? oldP.name : 'Player', oldP ? oldP.skinId : 0, false);
      p.ws = ws;
      p.deathSent = false;
      players[id] = p;
      ws.send(JSON.stringify({ type: 'respawned', spawnX, spawnY }));
    }
  });

  ws.on('close', () => {
    console.log(`[-] Игрок ${id} отключился`);
    if (players[id]) {
      killSnake(players[id]);
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
initBots();
setInterval(gameTick, TICK);

server.listen(PORT, () => {
  console.log(`DevourX сервер запущен на порту ${PORT}`);
  });
