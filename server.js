const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const WORLD = 4000;
const TICK = 33;
const MIN_LEN = 10;
const MAX_BODY = 750;
const MAX_FOOD = 2500;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DevourX Server OK');
});

const wss = new WebSocket.Server({ server });

let foods = [];
let players = {};
let nextId = 1;

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

function updateSnake(sn) {
  if (!sn.alive) return;
  let da = sn.tAngle - sn.angle;
  while (da > Math.PI) da -= Math.PI*2;
  while (da < -Math.PI) da += Math.PI*2;
  sn.angle += da * sn.turnSpeed;
  const spd = sn.boosting ? sn.speed*1.85 : sn.speed;
  const hx = sn.segs[0].x + Math.cos(sn.angle)*spd;
  const hy = sn.segs[0].y + Math.sin(sn.angle)*spd;
  if (hx <= 10 || hx >= WORLD-10 || hy <= 10 || hy >= WORLD-10) { killSnake(sn); return; }
  sn.segs.unshift({ x: hx, y: hy });
  while (sn.segs.length > sn.length) sn.segs.pop();
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
      if (sn.length < MAX_BODY) sn.length = Math.min(MAX_BODY, sn.length + g);
      // 1 монета за каждые 3 еды (считаем штуки, не очки)
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
  const drop = Math.min(sn.segs.length, 80);
  for (let i = 0; i < drop; i += 3) {
    const s = sn.segs[i];
    foods.push({
      x: Math.max(50, Math.min(WORLD-50, s.x+(Math.random()-0.5)*20)),
      y: Math.max(50, Math.min(WORLD-50, s.y+(Math.random()-0.5)*20)),
      r: 9+Math.random()*3, color: `hsl(${Math.floor(Math.random()*360)},90%,65%)`, size: 'big'
    });
  }
  if (foods.length > MAX_FOOD) foods.splice(0, foods.length - MAX_FOOD);
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
  const nearPlayers = Object.entries(players).filter(([,p])=>p.alive).map(([id,p])=>({
    id, name: p.name, skinId: p.skinId, score: p.score,
    segs: p.segs.slice(0,750), boosting: p.boosting, isMe: id===forId
  }));
  const leaderboard = Object.values(players).filter(s=>s.alive)
    .sort((a,b)=>b.score-a.score).slice(0,10)
    .map(s=>({ name:s.name, score:s.score, isMe:s===me }));
  return { type:'world', players:nearPlayers, foods, leaderboard, myScore:me.score };
}

function gameTick() {
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
  const playerCount = Object.values(players).filter(p=>p.alive).length;
  for (const id in players) {
    const p = players[id], ws = p.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (!p.alive) {
      if (!p.deathSent) { p.deathSent=true; ws.send(JSON.stringify({type:'dead',score:p.score})); }
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
      ws.send(JSON.stringify({type:'joined',id,spawnX:sx,spawnY:sy,worldSize:WORLD,playerCount:cnt}));
      console.log(`[join] ${msg.name} id=${id}`);
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
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${id} отключился`);
    if (players[id]) { killSnake(players[id]); delete players[id]; }
  });

  ws.on('error', () => {
    if (players[id]) { killSnake(players[id]); delete players[id]; }
  });
});

initFoods();
setInterval(gameTick, TICK);
server.listen(PORT, () => console.log(`DevourX запущен на порту ${PORT}`));
