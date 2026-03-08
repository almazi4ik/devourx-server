const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const WORLD = 4000;
const TICK = 33;
const TICK_IDLE = 5000; // тик когда нет игроков (1 раз в 5 сек вместо 30/сек)
const MIN_LEN = 10;
const MAX_BODY = 1350;
const MAX_BODY_SLOW = 750;
const MAX_FOOD = 600;

// ═══ ГЛОБАЛЬНАЯ ТАБЛИЦА РЕКОРДОВ ═══
let globalTop = [];
const TOP_SIZE = 100;

function submitScore(name, score, skinId) {
  if (score < 50) return;
  globalTop.push({ name, score, skinId, date: Date.now() });
  globalTop.sort((a,b) => b.score - a.score);
  if (globalTop.length > TOP_SIZE) globalTop = globalTop.slice(0, TOP_SIZE);
}

function getTop(n=10) {
  return globalTop.slice(0, n).map((r,i) => ({rank:i+1, name:r.name, score:r.score, skinId:r.skinId}));
}

const server = http.createServer((req, res) => {
  if (req.url === '/top') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin':'*' });
    res.end(JSON.stringify(getTop(50)));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DevourX Server OK');
});

const wss = new WebSocket.Server({ server });

let foods = [];
let players = {};
let nextId = 1;

// ═══ ДИНАМИЧЕСКИЙ ТИК ═══
let tickInterval = null;
let currentTickRate = null;

function getAlivePlayers() {
  return Object.values(players).filter(p => p.alive).length;
}

function startTick(rate) {
  if (currentTickRate === rate) return; // уже на нужной скорости
  if (tickInterval) clearInterval(tickInterval);
  currentTickRate = rate;
  tickInterval = setInterval(gameTick, rate);
  if (rate === TICK_IDLE) {
    console.log('😴 Нет игроков — замедляю тик до 5с (экономия CPU)');
  } else {
    console.log('⚡ Игрок зашёл — полная скорость (33мс тик)');
  }
}

function adjustTick() {
  const alive = getAlivePlayers();
  if (alive === 0) {
    startTick(TICK_IDLE);
  } else {
    startTick(TICK);
  }
}

function mkFood() {
  const rnd = Math.random();
  let size, r;
  if (rnd < 0.75)      { size = 'small';  r = 3 + Math.random() * 2; }
  else if (rnd < 0.95) { size = 'medium'; r = 5 + Math.random() * 2; }
  else                  { size = 'big';    r = 8 + Math.random() * 2; }
  return {
    x: 200 + Math.random() * (WORLD - 400),
    y: 200 + Math.random() * (WORLD - 400),
    r, color: `hsl(${Math.floor(Math.random()*360)},90%,65%)`, size
  };
}

function initFoods() {
  foods = [];
  for (let i = 0; i < MAX_FOOD; i++) foods.push(mkFood());
}

function mkSnake(x, y, name, skinId) {
  const angle = Math.random() * Math.PI * 2;
  const segs = [];
  for (let i = 0; i < MIN_LEN; i++)
    segs.push({ x: x - Math.cos(angle)*i*14, y: y - Math.sin(angle)*i*14 });
  return {
    x, y, name: name||'Player', skinId: skinId||0, angle, tAngle: angle,
    speed: 2.8, boosting: false, alive: true, length: MIN_LEN, score: MIN_LEN,
    segs, turnSpeed: 0.18
  };
}

function getR(score) { return 6 + (Math.min(score,1000)/1000)*22; }

function getTurnSpeed(score) {
  const t = Math.min(score, 1000) / 1000;
  return 0.18 - t * 0.125;
}

function updateSnake(sn) {
  if (!sn.alive) return;
  let da = sn.tAngle - sn.angle;
  while (da > Math.PI) da -= Math.PI*2;
  while (da < -Math.PI) da += Math.PI*2;
  sn.angle += da * getTurnSpeed(sn.score);
  const spd = sn.boosting ? sn.speed*1.85 : sn.speed;
  const hx = sn.segs[0].x + Math.cos(sn.angle)*spd;
  const hy = sn.segs[0].y + Math.sin(sn.angle)*spd;
  if (hx <= 10 || hx >= WORLD-10 || hy <= 10 || hy >= WORLD-10) { killSnake(sn); return; }
  sn.segs.unshift({ x: hx, y: hy });
  while (sn.segs.length > sn.length) sn.segs.pop();

  const segDist = 8;
  for (let i = 1; i < sn.segs.length; i++) {
    const prev = sn.segs[i-1];
    const curr = sn.segs[i];
    const dx = prev.x - curr.x;
    const dy = prev.y - curr.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > segDist) {
      const ratio = (dist - segDist) / dist;
      curr.x += dx * ratio;
      curr.y += dy * ratio;
    }
  }
}

function eatFood(sn) {
  const h = sn.segs[0], r = getR(sn.score);
  for (let i = foods.length-1; i >= 0; i--) {
    const f = foods[i];
    const dx = h.x-f.x, dy = h.y-f.y;
    const er = (f.size==='big' ? f.r+10 : f.size==='medium' ? f.r+7 : f.r+5) + r;
    if (dx*dx + dy*dy < er*er) {
      const g = f.size==='big' ? 10 : f.size==='medium' ? 5 : 2;
      sn.score += g;
      if (sn.length < MAX_BODY) {
        if (sn.length < MAX_BODY_SLOW) {
          sn.length = Math.min(MAX_BODY_SLOW, sn.length + g);
        } else {
          sn._growBuf = (sn._growBuf || 0) + g;
          if (sn._growBuf >= 2) {
            const add = Math.floor(sn._growBuf / 2);
            sn._growBuf -= add * 2;
            sn.length = Math.min(MAX_BODY, sn.length + add);
          }
        }
      }
      sn.foodEaten = (sn.foodEaten||0) + 1;
      if (sn.foodEaten >= 3) {
        sn.foodEaten -= 3;
        if (sn.ws && sn.ws.readyState === 1)
          sn.ws.send(JSON.stringify({type:'coin_reward', coins:1}));
      }
      foods[i] = mkFood();
    }
  }
}

function killSnake(sn) {
  if (!sn.alive) return;
  sn.alive = false;

  const dropCount = Math.max(1, Math.min(200, Math.floor(sn.score / 2)));
  const totalSegs = sn.segs.length;
  const step = Math.max(1, Math.floor(totalSegs / dropCount));

  for (let i = 0; i < dropCount; i++) {
    const idx = Math.min(i * step, totalSegs - 1);
    const s = sn.segs[idx];
    foods.push({
      x: Math.max(50, Math.min(WORLD-50, s.x+(Math.random()-0.5)*20)),
      y: Math.max(50, Math.min(WORLD-50, s.y+(Math.random()-0.5)*20)),
      r: 9+Math.random()*3,
      color: `hsl(${Math.floor(Math.random()*360)},90%,65%)`,
      size: 'big',
      drop: true
    });
  }
  if (foods.length > MAX_FOOD + 200) foods.splice(0, foods.length - (MAX_FOOD + 200));
}

function checkCollisions() {
  const alive = Object.values(players).filter(s => s.alive);
  for (const sn of alive) {
    if (!sn.alive) continue;
    const h = sn.segs[0], r = getR(sn.score);
    for (const other of alive) {
      if (!other.alive || other === sn) continue;
      for (let i = 2; i < other.segs.length; i++) {
        const s = other.segs[i], dx = h.x-s.x, dy = h.y-s.y;
        if (dx*dx + dy*dy < (r+getR(other.score)-2)**2) {
          killSnake(sn);
          if (other.ws && other.ws.readyState === 1)
            other.ws.send(JSON.stringify({type:'kill_reward', coins:3}));
          break;
        }
      }
      if (!sn.alive) break;
    }
  }
}

function buildSnapshot(forId) {
  const me = players[forId];
  if (!me || !me.segs.length) return null;
  const cx = me.segs[0].x, cy = me.segs[0].y;
  const VX = 1400, VY = 900;
  const nearPlayers = Object.entries(players).filter(([,p])=>p.alive).map(([id,p])=>({
    id, name: p.name, skinId: p.skinId, score: p.score,
    segs: p.segs.slice(0,750), boosting: p.boosting, isMe: id===forId
  }));
  const nearFoods = foods.filter(f => {
    if (f.drop) return true;
    const dx = Math.abs(f.x - cx), dy = Math.abs(f.y - cy);
    return dx < VX && dy < VY;
  });
  const leaderboard = Object.values(players).filter(s=>s.alive)
    .sort((a,b)=>b.score-a.score).slice(0,10)
    .map(s=>({ name:s.name, score:s.score, isMe:s===me }));
  return { type:'world', players:nearPlayers, foods:nearFoods, leaderboard, myScore:me.score };
}

function gameTick() {
  // Если нет живых игроков — ничего не делаем (тик идёт редко)
  const alive = Object.values(players).filter(p => p.alive);
  if (alive.length === 0) return;

  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    updateSnake(p);
    eatFood(p);
    if (p.boosting && p.length > MIN_LEN && Math.random() < 0.05) {
      p.length = Math.max(MIN_LEN, p.length-1);
      p.score  = Math.max(MIN_LEN, p.score-1);
    }
  }
  checkCollisions();

  const playerCount = alive.length;
  for (const id in players) {
    const p = players[id], ws = p.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (!p.alive) {
      if (!p.deathSent) {
        p.deathSent = true;
        submitScore(p.name, p.score, p.skinId);
        ws.send(JSON.stringify({type:'dead', score:p.score, globalTop: getTop(10)}));
      }
      continue;
    }
    const snap = buildSnapshot(id);
    if (snap) { snap.playerCount=playerCount; try { ws.send(JSON.stringify(snap)); } catch(e){} }
  }
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  console.log(`[+] ${id} подключился`);

  ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const sx = 300 + Math.random() * (WORLD - 600);
      const sy = 300 + Math.random() * (WORLD - 600);
      const p = mkSnake(sx, sy, msg.name||'Player', msg.skinId||0);
      p.ws=ws; p.deathSent=false; players[id]=p;
      const cnt = Object.values(players).filter(p=>p.alive).length;
      ws.send(JSON.stringify({type:'joined',id,spawnX:sx,spawnY:sy,worldSize:WORLD,playerCount:cnt,globalTop:getTop(10)}));
      console.log(`[join] ${msg.name} id=${id}`);
      adjustTick(); // ускоряем тик
    }

    if (msg.type === 'get_top') {
      ws.send(JSON.stringify({type:'global_top', top: getTop(50)}));
    }

    if (msg.type === 'input') {
      const p = players[id]; if (!p||!p.alive) return;
      p.tAngle=msg.angle;
      p.boosting=msg.boost && p.length>MIN_LEN;
    }

    if (msg.type === 'respawn') {
      const old = players[id];
      const sx = 300 + Math.random() * (WORLD - 600);
      const sy = 300 + Math.random() * (WORLD - 600);
      const p = mkSnake(sx, sy, old?old.name:'Player', old?old.skinId:0);
      p.ws=ws; p.deathSent=false; players[id]=p;
      ws.send(JSON.stringify({type:'joined',id,spawnX:sx,spawnY:sy,worldSize:WORLD}));
      adjustTick(); // ускоряем тик
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${id} отключился`);
    if (players[id]) { killSnake(players[id]); delete players[id]; }
    adjustTick(); // замедляем тик если никого нет
  });

  ws.on('error', () => {
    if (players[id]) { killSnake(players[id]); delete players[id]; }
    adjustTick(); // замедляем тик если никого нет
  });
});

initFoods();
startTick(TICK_IDLE); // стартуем в режиме ожидания
server.listen(PORT, () => console.log(`DevourX запущен на порту ${PORT}`));
