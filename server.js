const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const WORLD = 6000; // уменьшил карту вдвое
const TICK = 33;
const MIN_LEN = 10;
const MAX_BODY = 1000;
const MAX_FOOD = 1000;
const BOT_COUNT = 12; // постоянное количество ботов
const BOT_RESPAWN_DELAY = 10000; // 10 секунд до респауна

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DevourX Server OK');
});

const wss = new WebSocket.Server({ server });

// ══════ ИМЕНА БОТОВ ══════
const BOT_NAMES = [
  // Player-стиль (часто встречается)
  'Player','Player1','Player2','Player3','Player7','Player13','Player21',
  'Player42','Player69','Player99','Player123','Player$','Player$$',
  'Player_X','Player#1','Player001','NewPlayer','player','PLAYER',
  // Игровые ники
  'xXxSnake','Pro_Gamer','NoScope','EatMaster','SpeedBoi','SnekLord',
  'Muncher','GreenSnake','FastBoi','Killer$$','NooB','xXx_Pro',
  'TopSnake','BigBoi','SlitherKing','Destroyer','Shadow_X','DarkSnake',
  'QuickEat','BoostMaster','Snake_Pro','ZigZag','DeathCoil','VenomX',
  'SlashPro','NightCrawler','ChaosSnake','ViperX','StealthBoi','RushMaster'
];
const BOT_SKINS = [0,1,2,3,4,5,6,7]; // доступные скины для ботов

// ══════ ТИПЫ БОТОВ ══════
// 'eater'  — просто ест еду, не агрессивный
// 'hunter' — ест еду + пытается убить игроков и других ботов
// 'rusher' — ест еду + иногда ускоряется, иногда атакует

// ══════ ЕДА ══════
let foods = [];
let players = {}; // реальные игроки
let bots = {};    // боты
let nextId = 1;
let nextBotId = 1;
let deadBots = []; // { time, name, skinId, type } — очередь на респаун

function mkFood() {
  const rnd = Math.random();
  let size, r;
  if (rnd < 0.55)      { size = 'small';  r = 3 + Math.random() * 2; }
  else if (rnd < 0.85) { size = 'medium'; r = 6 + Math.random() * 2; }
  else                  { size = 'big';    r = 9 + Math.random() * 3; }
  return {
    x: Math.random() * WORLD,
    y: Math.random() * WORLD,
    r, color: `hsl(${Math.floor(Math.random()*360)},90%,65%)`, size
  };
}

function initFoods() {
  foods = [];
  for (let i = 0; i < MAX_FOOD; i++) foods.push(mkFood());
}

// ══════ СОЗДАНИЕ ЗМЕИ ══════
function mkSnake(x, y, name, skinId) {
  const angle = Math.random() * Math.PI * 2;
  const segs = [];
  for (let i = 0; i < MIN_LEN; i++)
    segs.push({ x: x - Math.cos(angle)*i*14, y: y - Math.sin(angle)*i*14 });
  return {
    x, y, name: name||'Player', skinId: skinId||0,
    angle, tAngle: angle,
    speed: 2.8, boosting: false, alive: true,
    length: MIN_LEN, score: MIN_LEN, segs, turnSpeed: 0.15
  };
}

function randomSpawn() {
  const margin = 400;
  return {
    x: margin + Math.random() * (WORLD - margin*2),
    y: margin + Math.random() * (WORLD - margin*2)
  };
}

function getR(score) { return 6 + (Math.min(score,1000)/1000)*22; }

// ══════ ДВИЖЕНИЕ ══════
function updateSnake(sn) {
  if (!sn.alive) return;
  let da = sn.tAngle - sn.angle;
  while (da > Math.PI) da -= Math.PI*2;
  while (da < -Math.PI) da += Math.PI*2;
  sn.angle += da * sn.turnSpeed;
  const spd = sn.boosting ? sn.speed*1.85 : sn.speed;
  const hx = sn.segs[0].x + Math.cos(sn.angle)*spd;
  const hy = sn.segs[0].y + Math.sin(sn.angle)*spd;
  if (hx <= 0 || hx >= WORLD || hy <= 0 || hy >= WORLD) {
    killSnake(sn, true); return;
  }
  sn.segs.unshift({ x: hx, y: hy });
  while (sn.segs.length > sn.length) sn.segs.pop();
}

// ══════ ЕДА ══════
function eatFood(sn) {
  const h = sn.segs[0], r = getR(sn.score);
  for (let i = foods.length-1; i >= 0; i--) {
    const f = foods[i];
    const dx = h.x-f.x, dy = h.y-f.y;
    const er = (f.size==='big' ? f.r+8 : f.size==='medium' ? f.r+6 : f.r+4) + r;
    if (dx*dx + dy*dy < er*er) {
      const g = f.size==='big' ? 3 : f.size==='medium' ? 2 : 1;
      if (sn.score < MAX_BODY) {
        sn.score = Math.min(MAX_BODY, sn.score+g);
        sn.length = Math.min(MAX_BODY, sn.length+g);
      }
      foods[i] = mkFood();
    }
  }
}

// ══════ СМЕРТЬ ══════
function killSnake(sn, isBot) {
  if (!sn.alive) return;
  sn.alive = false;
  // Дропаем еду
  const drop = Math.min(sn.segs.length, 60);
  for (let i = 0; i < drop; i += 3) {
    const s = sn.segs[i];
    const idx = Math.floor(Math.random()*foods.length);
    foods[idx] = {
      x: s.x+(Math.random()-0.5)*20,
      y: s.y+(Math.random()-0.5)*20,
      r: 8+Math.random()*4,
      color: `hsl(${Math.floor(Math.random()*360)},90%,65%)`,
      size: 'big'
    };
  }
  // Если бот — добавляем в очередь на респаун
  if (isBot && sn.botType) {
    deadBots.push({
      time: Date.now() + BOT_RESPAWN_DELAY,
      name: BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)],
      skinId: BOT_SKINS[Math.floor(Math.random()*BOT_SKINS.length)],
      type: sn.botType
    });
  }
}

// ══════ ИИ БОТОВ ══════
function updateBotAI(bot) {
  if (!bot.alive) return;
  const h = bot.segs[0];
  const margin = 500;

  // Держимся от краёв
  if (h.x < margin || h.x > WORLD-margin || h.y < margin || h.y > WORLD-margin) {
    bot.tAngle = Math.atan2(WORLD/2 - h.y, WORLD/2 - h.x);
    bot.boosting = false;
    return;
  }

  // Случайные ошибки — бот иногда отвлекается (делает его не слишком умным)
  if (Math.random() < 0.015) {
    bot.tAngle += (Math.random()-0.5) * 1.5;
    bot.boosting = false;
    return;
  }

  const allSnakes = [
    ...Object.values(players).filter(p=>p.alive),
    ...Object.values(bots).filter(b=>b.alive && b!==bot)
  ];

  // ── EATER: просто ест еду, убегает от опасности ──
  if (bot.botType === 'eater') {
    bot.boosting = false;

    // Убегаем от больших змей
    for (const other of allSnakes) {
      if (other.score <= bot.score * 0.7) continue;
      const dx = h.x - other.segs[0].x, dy = h.y - other.segs[0].y;
      if (dx*dx+dy*dy < 180*180) {
        bot.tAngle = Math.atan2(dy, dx);
        return;
      }
    }

    // Ищем еду
    let best = Infinity, tgt = null;
    for (let i = 0; i < foods.length; i += 2) {
      const f = foods[i];
      const dx = f.x-h.x, dy = f.y-h.y, d = dx*dx+dy*dy;
      if (d < best) { best=d; tgt=f; }
    }
    if (tgt) bot.tAngle = Math.atan2(tgt.y-h.y, tgt.x-h.x);
  }

  // ── HUNTER: охотится на змей, пытается подрезать ──
  else if (bot.botType === 'hunter') {
    let hunted = false;

    // Ищем цель — маленькую змею рядом
    let bestTarget = null, bestDist = Infinity;
    for (const other of allSnakes) {
      if (other.score > bot.score * 1.4) continue; // не атакуем тех кто сильно больше
      const dx = other.segs[0].x-h.x, dy = other.segs[0].y-h.y;
      const d = dx*dx+dy*dy;
      if (d < 350*350 && d < bestDist) { bestDist=d; bestTarget=other; }
    }

    if (bestTarget) {
      // Едем наперерез — немного впереди головы цели
      const tx = bestTarget.segs[0].x + Math.cos(bestTarget.angle)*60;
      const ty = bestTarget.segs[0].y + Math.sin(bestTarget.angle)*60;
      bot.tAngle = Math.atan2(ty-h.y, tx-h.x);
      // Ускоряемся если близко и мы больше
      bot.boosting = bestDist < 200*200 && bot.score > bestTarget.score;
      hunted = true;
    }

    if (!hunted) {
      bot.boosting = false;
      // Ищем еду
      let best = Infinity, tgt = null;
      for (let i = 0; i < foods.length; i += 2) {
        const f = foods[i];
        const dx = f.x-h.x, dy = f.y-h.y, d = dx*dx+dy*dy;
        if (d < best) { best=d; tgt=f; }
      }
      if (tgt) bot.tAngle = Math.atan2(tgt.y-h.y, tgt.x-h.x);
    }
  }

  // ── RUSHER: ест еду + иногда ускоряется и режет ──
  else if (bot.botType === 'rusher') {
    // Иногда случайно ускоряется
    if (!bot._rushTimer) bot._rushTimer = 0;
    bot._rushTimer--;
    if (bot._rushTimer <= 0) {
      bot.boosting = Math.random() < 0.4 && bot.score > 20;
      bot._rushTimer = 30 + Math.floor(Math.random()*60);
    }

    // Ищем ближайшую цель или еду
    let bestTarget = null, bestDist = Infinity;
    for (const other of allSnakes) {
      if (other.score > bot.score * 1.8) continue;
      const dx = other.segs[0].x-h.x, dy = other.segs[0].y-h.y;
      const d = dx*dx+dy*dy;
      if (d < 280*280 && d < bestDist) { bestDist=d; bestTarget=other; }
    }

    if (bestTarget && Math.random() < 0.6) {
      bot.tAngle = Math.atan2(bestTarget.segs[0].y-h.y, bestTarget.segs[0].x-h.x);
    } else {
      let best = Infinity, tgt = null;
      for (let i = 0; i < foods.length; i += 2) {
        const f = foods[i];
        const dx = f.x-h.x, dy = f.y-h.y, d = dx*dx+dy*dy;
        if (d < best) { best=d; tgt=f; }
      }
      if (tgt) bot.tAngle = Math.atan2(tgt.y-h.y, tgt.x-h.x);
    }
  }
}

// ══════ КОЛЛИЗИИ ══════
function checkCollisions() {
  const allSnakes = [
    ...Object.values(players).filter(p=>p.alive),
    ...Object.values(bots).filter(b=>b.alive)
  ];
  for (const sn of allSnakes) {
    if (!sn.alive) continue;
    const h = sn.segs[0], r = getR(sn.score);
    for (const other of allSnakes) {
      if (!other.alive || other === sn) continue;
      for (let i = 2; i < Math.min(other.segs.length, 80); i++) {
        const s = other.segs[i], dx = h.x-s.x, dy = h.y-s.y;
        if (dx*dx+dy*dy < (r+getR(other.score)*0.7)**2) {
          killSnake(sn, !!sn.botType);
          break;
        }
      }
      if (!sn.alive) break;
    }
  }
}

// ══════ СОЗДАНИЕ БОТА ══════
function spawnBot(name, skinId, type) {
  const { x, y } = randomSpawn();
  const bid = 'bot_' + (nextBotId++);
  const bot = mkSnake(x, y, name, skinId);
  bot.botType = type;
  bot.isBot = true;
  bots[bid] = bot;
  return bid;
}

function initBots() {
  const types = ['eater','eater','eater','hunter','hunter','rusher','rusher',
                 'eater','hunter','rusher','eater','rusher'];
  for (let i = 0; i < BOT_COUNT; i++) {
    const name = BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)];
    const skinId = BOT_SKINS[Math.floor(Math.random()*BOT_SKINS.length)];
    spawnBot(name, skinId, types[i % types.length]);
  }
}

// ══════ РЕСПАУН БОТОВ ══════
function checkBotRespawns() {
  const now = Date.now();
  const ready = deadBots.filter(b => b.time <= now);
  deadBots = deadBots.filter(b => b.time > now);
  for (const b of ready) {
    spawnBot(b.name, b.skinId, b.type);
  }
}

// ══════ СНАПШОТ ══════
function buildSnapshot(forId) {
  const me = players[forId];
  if (!me || !me.segs.length) return null;
  const cx = me.segs[0].x, cy = me.segs[0].y, VIEW = 2000;

  // Игроки
  const nearPlayers = Object.entries(players)
    .filter(([,p])=>p.alive)
    .map(([id,p])=>({
      id, name: p.name, skinId: p.skinId, score: p.score,
      segs: p.segs.slice(0,60), boosting: p.boosting, isMe: id===forId
    }));

  // Боты
  const nearBots = Object.values(bots)
    .filter(b=>b.alive)
    .filter(b=>{
      const dx=b.segs[0].x-cx, dy=b.segs[0].y-cy;
      return dx*dx+dy*dy < VIEW*VIEW*1.5;
    })
    .map(b=>({
      id: 'b'+b.name, name: b.name, skinId: b.skinId, score: b.score,
      segs: b.segs.slice(0,60), boosting: b.boosting, isMe: false
    }));

  const nearFoods = foods.filter(f=>{
    const dx=f.x-cx, dy=f.y-cy; return dx*dx+dy*dy < VIEW*VIEW;
  }).slice(0,400);

  // Лидерборд — игроки + боты
  const all = [
    ...Object.entries(players).filter(([,p])=>p.alive).map(([id,p])=>({name:p.name,score:p.score,isMe:id===forId})),
    ...Object.values(bots).filter(b=>b.alive).map(b=>({name:b.name,score:b.score,isMe:false}))
  ].sort((a,b)=>b.score-a.score).slice(0,10);

  return {
    type: 'world',
    players: [...nearPlayers, ...nearBots],
    foods: nearFoods,
    leaderboard: all,
    myScore: me.score,
    playerCount: Object.values(players).filter(p=>p.alive).length
  };
}

// ══════ ТИК ══════
function gameTick() {
  // Обновляем игроков
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    updateSnake(p); eatFood(p);
    if (p.boosting && p.length > MIN_LEN && Math.random() < 0.18) {
      p.length = Math.max(MIN_LEN, p.length-1);
      p.score  = Math.max(MIN_LEN, p.score-1);
    }
  }

  // Обновляем ботов
  for (const id in bots) {
    const b = bots[id];
    if (!b.alive) { delete bots[id]; continue; }
    updateBotAI(b);
    updateSnake(b);
    eatFood(b);
    if (b.boosting && b.length > MIN_LEN && Math.random() < 0.18) {
      b.length = Math.max(MIN_LEN, b.length-1);
      b.score  = Math.max(MIN_LEN, b.score-1);
    }
  }

  checkCollisions();
  checkBotRespawns();

  // Отправляем снапшоты игрокам
  const playerCount = Object.values(players).filter(p=>p.alive).length;
  for (const id in players) {
    const p = players[id];
    const ws = p.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (!p.alive) {
      if (!p.deathSent) {
        p.deathSent = true;
        ws.send(JSON.stringify({type:'dead', score:p.score}));
      }
      continue;
    }
    const snap = buildSnapshot(id);
    if (snap) {
      snap.playerCount = playerCount;
      try { ws.send(JSON.stringify(snap)); } catch(e) {}
    }
  }
}

// ══════ ПОДКЛЮЧЕНИЯ ══════
wss.on('connection', (ws) => {
  const id = String(nextId++);
  console.log(`[+] ${id} подключился`);

  ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const p = mkSnake(WORLD/2, WORLD/2, msg.name||'Player', msg.skinId||0);
      p.ws=ws; p.deathSent=false; players[id]=p;
      const cnt = Object.values(players).filter(p=>p.alive).length;
      ws.send(JSON.stringify({
        type:'joined', id, spawnX:WORLD/2, spawnY:WORLD/2,
        worldSize:WORLD, playerCount:cnt
      }));
      console.log(`[join] ${msg.name} id=${id}`);
    }

    if (msg.type === 'input') {
      const p = players[id]; if (!p||!p.alive) return;
      p.tAngle=msg.angle; p.boosting=msg.boost && p.length>MIN_LEN;
    }

    if (msg.type === 'respawn') {
      const old = players[id];
      const p = mkSnake(WORLD/2, WORLD/2, old?old.name:'Player', old?old.skinId:0);
      p.ws=ws; p.deathSent=false; players[id]=p;
      ws.send(JSON.stringify({
        type:'joined', id, spawnX:WORLD/2, spawnY:WORLD/2, worldSize:WORLD
      }));
    }

    if (msg.type === 'getTop') {
      // Топ среди всех
      const all = [
        ...Object.values(players).filter(p=>p.alive).map(p=>({name:p.name,score:p.score})),
        ...Object.values(bots).filter(b=>b.alive).map(b=>({name:b.name,score:b.score}))
      ].sort((a,b)=>b.score-a.score).slice(0,10);
      try { ws.send(JSON.stringify({type:'globalTop', data:all})); } catch(e){}
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${id} отключился`);
    if (players[id]) { killSnake(players[id], false); delete players[id]; }
  });

  ws.on('error', () => {
    if (players[id]) { killSnake(players[id], false); delete players[id]; }
  });
});

initFoods();
initBots();
setInterval(gameTick, TICK);
setInterval(() => console.log('keepalive', new Date().toISOString()), 25*60*1000);
server.listen(PORT, () => console.log(`DevourX запущен на порту ${PORT}`));
