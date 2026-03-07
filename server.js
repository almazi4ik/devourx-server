const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const WORLD = 4000;
const TICK = 33;
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
let players = {};   // реальные игроки
let bots = {};      // серверные боты
let nextId = 1;
let nextBotId = 1;

// ═══════════════════════════════════════
// НИКНЕЙМЫ БОТОВ — как у реальных игроков
// ═══════════════════════════════════════
const BOT_NAME_BASES = ['Player'];

function mkBotName() {
  // Генерим ник типа Player, Player1, Player123, Player111223 и т.д.
  const styles = [
    () => 'Player',
    () => 'Player' + (Math.floor(Math.random()*9)+1),
    () => 'Player' + (Math.floor(Math.random()*90)+10),
    () => 'Player' + (Math.floor(Math.random()*900)+100),
    () => 'Player' + (Math.floor(Math.random()*9000)+1000),
    () => 'Player' + (Math.floor(Math.random()*90000)+10000),
    () => 'Player' + (Math.floor(Math.random()*900000)+100000),
  ];
  const weights = [0.05, 0.1, 0.15, 0.25, 0.25, 0.15, 0.05];
  let r = Math.random(), acc = 0;
  for (let i = 0; i < styles.length; i++) {
    acc += weights[i];
    if (r < acc) return styles[i]();
  }
  return 'Player' + Math.floor(Math.random()*9999);
}

// Сколько ботов держать на сервере (подстраивается под число игроков)
const BOT_BASE_COUNT = 2; // минимум всегда 2

function targetBotCount() {
  return BOT_BASE_COUNT; // всегда 2 бота, они сами добавляются в счётчик онлайна
}

// ═══════════════════════════════════════
// ЕДА
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// ЗМЕЙКА
// ═══════════════════════════════════════
function mkSnake(x, y, name, skinId) {
  const angle = Math.random() * Math.PI * 2;
  const segs = [];
  for (let i = 0; i < MIN_LEN; i++)
    segs.push({ x: x - Math.cos(angle)*i*14, y: y - Math.sin(angle)*i*14 });
  return {
    x, y, name: name||'Player', skinId: skinId||0, angle, tAngle: angle,
    speed: 2.8, boosting: false, alive: true, length: MIN_LEN, score: MIN_LEN,
    segs, turnSpeed: 0.18, _growBuf: 0, foodEaten: 0
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
      if (sn.length < MAX_BODY) {
        if (sn.length < MAX_BODY_SLOW) {
          sn.length = Math.min(MAX_BODY_SLOW, sn.length + g);
        } else {
          sn._growBuf = (sn._growBuf||0) + g;
          if (sn._growBuf >= 2) {
            const add = Math.floor(sn._growBuf / 2);
            sn._growBuf -= add * 2;
            sn.length = Math.min(MAX_BODY, sn.length + add);
          }
        }
      }
      sn.foodEaten = (sn.foodEaten||0) + 1;
      if (sn.foodEaten >= 3 && sn.ws && sn.ws.readyState === 1) {
        sn.foodEaten -= 3;
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
      size: 'big', drop: true
    });
  }
  if (foods.length > MAX_FOOD + 200) foods.splice(0, foods.length - (MAX_FOOD + 200));
}

function checkCollisions() {
  // Все живые змейки: игроки + боты
  const allSnakes = [
    ...Object.entries(players).map(([id,p]) => ({...p, _isBot:false, _id:id})),
    ...Object.entries(bots).map(([id,b]) => ({...b, _isBot:true, _id:id})),
  ].filter(s => s.alive);

  for (const sn of allSnakes) {
    if (!sn.alive) continue;
    const h = sn.segs[0], r = getR(sn.score);
    for (const other of allSnakes) {
      if (!other.alive || other === sn) continue;
      for (let i = 2; i < other.segs.length; i++) {
        const s = other.segs[i], dx = h.x-s.x, dy = h.y-s.y;
        if (dx*dx + dy*dy < (r + getR(other.score)*0.55)**2) {
          // убиваем оригинальный объект (не копию)
          const snOrig = sn._isBot ? bots[sn._id] : players[sn._id];
          const otherOrig = other._isBot ? bots[other._id] : players[other._id];
          if (snOrig) killSnake(snOrig);
          // награда убийце-игроку
          if (!sn._isBot && otherOrig && !other._isBot) {
            // игрок убил игрока — серверная логика
            if (otherOrig.ws && otherOrig.ws.readyState === 1)
              otherOrig.ws.send(JSON.stringify({type:'kill_reward', coins:3}));
          }
          if (sn._isBot && !other._isBot) {
            // бот убит игроком — награда игроку
            const otherPlayer = players[other._id];
            if (otherPlayer && otherPlayer.ws && otherPlayer.ws.readyState === 1)
              otherPlayer.ws.send(JSON.stringify({type:'kill_reward', coins:3}));
          }
          break;
        }
      }
      if (sn._isBot ? !bots[sn._id]?.alive : !players[sn._id]?.alive) break;
    }
  }
}

// ═══════════════════════════════════════
// БОТ AI
// ═══════════════════════════════════════
function mkBot() {
  const id = 'bot_' + (nextBotId++);
  const x = 300 + Math.random() * (WORLD - 600);
  const y = 300 + Math.random() * (WORLD - 600);
  const sn = mkSnake(x, y, mkBotName(), Math.floor(Math.random()*8));
  sn._isBot = true;
  sn._id = id;
  sn._thinkTimer = 0;
  sn._spinTimer = 0;
  sn._deadAt = 0;
  sn.speed = 2.2 + Math.random() * 0.8;
  sn.turnSpeed = 0.14;
  return { id, snake: sn };
}

function botAI(bot) {
  const sn = bot;
  sn._thinkTimer = (sn._thinkTimer||0) - 1;
  if (sn._thinkTimer > 0) return;
  sn._thinkTimer = 6 + Math.floor(Math.random() * 12);

  const h = sn.segs[0];
  const margin = 200;

  // Держаться в пределах карты
  if (h.x < margin || h.x > WORLD-margin || h.y < margin || h.y > WORLD-margin) {
    sn.tAngle = Math.atan2(WORLD/2-h.y, WORLD/2-h.x) + (Math.random()-.5)*0.4;
    sn.boosting = false;
    return;
  }

  // Спин-ловушка
  if (sn._spinTimer > 0) {
    sn._spinTimer--;
    sn.tAngle += 0.22;
    sn.boosting = true;
    return;
  }

  // Найти ближайшего реального игрока (радар — вся карта)
  let closestPlayer = null;
  let closestDist = Infinity;
  for (const pid in players) {
    const p = players[pid];
    if (!p.alive || !p.segs || !p.segs.length) continue;
    const ph = p.segs[0];
    const dx = ph.x - h.x, dy = ph.y - h.y;
    const d = dx*dx + dy*dy;
    if (d < closestDist) { closestDist = d; closestPlayer = p; }
  }

  if (closestPlayer) {
    const ph = closestPlayer.segs[0];
    const dx = ph.x - h.x, dy = ph.y - h.y;
    const dist = Math.sqrt(closestDist);

    // Вычислить направление движения игрока из его сегментов
    let playerDirX = 0, playerDirY = 0;
    if (closestPlayer.segs.length >= 2) {
      const s1 = closestPlayer.segs[0], s2 = closestPlayer.segs[1];
      const pdx = s1.x - s2.x, pdy = s1.y - s2.y;
      const plen = Math.sqrt(pdx*pdx + pdy*pdy) || 1;
      playerDirX = pdx / plen;
      playerDirY = pdy / plen;
    }

    if (dist > 800) {
      // Далеко — мчим напрямую к голове
      sn.tAngle = Math.atan2(dy, dx) + (Math.random()-.5)*0.1;
      sn.boosting = dist > 1400 && sn.score > MIN_LEN*2;
    } else if (dist > 180) {
      // Среднее расстояние — перехват: целимся ПЕРЕД головой игрока
      // Упреждение пропорционально дистанции и скорости игрока
      const leadDist = Math.min(dist * 0.55, 280);
      const aimX = ph.x + playerDirX * leadDist;
      const aimY = ph.y + playerDirY * leadDist;
      sn.tAngle = Math.atan2(aimY - h.y, aimX - h.x);
      sn.boosting = dist > 280 && sn.score > MIN_LEN*1.5;
      // Спин-ловушка если близко
      if (dist < 320 && Math.random() < 0.06) sn._spinTimer = 14;
    } else {
      // Вплотную — буст прямо в голову
      sn.tAngle = Math.atan2(dy, dx);
      sn.boosting = sn.score > MIN_LEN;
    }
  } else {
    // Нет игроков — едим еду
    let best = Infinity, tgt = null;
    for (let i = 0; i < foods.length; i += 2) {
      const f = foods[i], dx = f.x-h.x, dy = f.y-h.y, d = dx*dx+dy*dy;
      if (d < best) { best = d; tgt = f; }
    }
    if (tgt) sn.tAngle = Math.atan2(tgt.y-h.y, tgt.x-h.x) + (Math.random()-.5)*0.2;
    else sn.tAngle += (Math.random()-.5)*0.5;
    sn.boosting = false;
  }

  // Избегать других ботов
  for (const bid in bots) {
    const other = bots[bid];
    if (other === sn || !other.alive) continue;
    for (let i = 2; i < Math.min(other.segs.length, 12); i++) {
      const s = other.segs[i], dx = h.x-s.x, dy = h.y-s.y;
      if (dx*dx+dy*dy < 85*85) {
        sn.tAngle = Math.atan2(h.y-s.y, h.x-s.x) + (Math.random()-.5)*0.8;
        sn.boosting = false;
        return;
      }
    }
  }
}

function manageBots() {
  const target = targetBotCount();
  const liveBots = Object.values(bots).filter(b => b.alive).length;

  // Добавить ботов если мало
  if (liveBots < target) {
    for (let i = liveBots; i < target; i++) {
      const { id, snake } = mkBot();
      bots[id] = snake;
    }
  }

  // Проверить мёртвых — респавн через 5 секунд с новым ником
  const now = Date.now();
  for (const bid in bots) {
    const b = bots[bid];
    if (!b.alive) {
      if (!b._deadAt) b._deadAt = now;
      if (now - b._deadAt > 5000) {
        // Респавн: новый ник, новая позиция
        const x = 300 + Math.random() * (WORLD - 600);
        const y = 300 + Math.random() * (WORLD - 600);
        const fresh = mkSnake(x, y, mkBotName(), Math.floor(Math.random()*8));
        fresh._isBot = true;
        fresh._id = bid;
        fresh._thinkTimer = 0;
        fresh._spinTimer = 0;
        fresh._deadAt = 0;
        fresh.speed = 2.2 + Math.random() * 0.8;
        fresh.turnSpeed = 0.14;
        bots[bid] = fresh;
      }
    }
  }

  // Удалить лишних мёртвых ботов если стало слишком много
  const deadBots = Object.keys(bots).filter(bid => !bots[bid].alive);
  const targetDead = Math.max(0, target - liveBots);
  if (deadBots.length > targetDead + 5) {
    deadBots.slice(targetDead + 5).forEach(bid => delete bots[bid]);
  }
}

// ═══════════════════════════════════════
// СНАПШОТ — включает ботов
// ═══════════════════════════════════════
function buildSnapshot(forId) {
  const me = players[forId];
  if (!me || !me.segs.length) return null;
  const cx = me.segs[0].x, cy = me.segs[0].y;
  const VX = 1400, VY = 900;

  // Реальные игроки
  const nearPlayers = Object.entries(players)
    .filter(([,p]) => p.alive)
    .map(([id, p]) => ({
      id, name: p.name, skinId: p.skinId, score: p.score,
      segs: p.segs.slice(0, 750), boosting: p.boosting, isMe: id === forId
    }));

  // Боты — добавляем как обычных игроков (isMe: false)
  const botPlayers = Object.values(bots)
    .filter(b => b.alive)
    .map(b => ({
      id: b._id, name: b.name, skinId: b.skinId, score: b.score,
      segs: b.segs.slice(0, 750), boosting: b.boosting, isMe: false, _isBot: true
    }));

  const allPlayers = [...nearPlayers, ...botPlayers];

  const nearFoods = foods.filter(f => {
    if (f.drop) return true;
    const dx = Math.abs(f.x - cx), dy = Math.abs(f.y - cy);
    return dx < VX && dy < VY;
  });

  // Лидерборд: игроки + боты вместе
  const allAlive = [
    ...Object.values(players).filter(p => p.alive).map(p => ({name:p.name, score:p.score, isMe:p===me})),
    ...Object.values(bots).filter(b => b.alive).map(b => ({name:b.name, score:b.score, isMe:false})),
  ];
  const leaderboard = allAlive.sort((a,b) => b.score-a.score).slice(0,10);

  // Счётчик онлайна = реальные игроки + живые боты
  const realCount = Object.values(players).filter(p => p.alive).length;
  const botCount = Object.values(bots).filter(b => b.alive).length;
  const playerCount = realCount + botCount;

  return { type:'world', players:allPlayers, foods:nearFoods, leaderboard, myScore:me.score, playerCount };
}

// ═══════════════════════════════════════
// ИГРОВОЙ ТИК
// ═══════════════════════════════════════
function gameTick() {
  // Управление ботами (добавить/убрать/респавн)
  manageBots();

  // Обновить ботов
  for (const bid in bots) {
    const b = bots[bid];
    if (!b.alive) continue;
    botAI(b);
    if (b.boosting && b.length > MIN_LEN && Math.random() < 0.05) {
      b.length = Math.max(MIN_LEN, b.length-1);
      b.score  = Math.max(MIN_LEN, b.score-1);
    }
    updateSnake(b);
    eatFood(b);
  }

  // Обновить игроков
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

  // Отправить снапшоты игрокам
  for (const id in players) {
    const p = players[id];
    const ws = p.ws;
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
    if (snap) { try { ws.send(JSON.stringify(snap)); } catch(e){} }
  }
}

// ═══════════════════════════════════════
// WS ПОДКЛЮЧЕНИЯ
// ═══════════════════════════════════════
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
      const realCount = Object.values(players).filter(p=>p.alive).length;
      const botCount = Object.values(bots).filter(b=>b.alive).length;
      const cnt = realCount + botCount;
      ws.send(JSON.stringify({type:'joined',id,spawnX:sx,spawnY:sy,worldSize:WORLD,playerCount:cnt,globalTop:getTop(10)}));
      console.log(`[join] ${msg.name} id=${id}, total online: ${cnt}`);
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
      const realCount = Object.values(players).filter(p=>p.alive).length;
      const botCount = Object.values(bots).filter(b=>b.alive).length;
      ws.send(JSON.stringify({type:'joined',id,spawnX:sx,spawnY:sy,worldSize:WORLD,playerCount:realCount+botCount}));
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
