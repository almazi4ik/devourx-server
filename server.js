const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const WORLD = 4000;
const TICK = 33;
const TICK_IDLE = 5000;
const MIN_LEN = 10;
const MAX_BODY = 1350;
const MAX_BODY_SLOW = 750;
const MAX_FOOD = 600;
const VIEW_X = 1600;
const VIEW_Y = 1000;
const MAX_SEGS_SEND = 750;

let lbTickCounter = 0;
let cachedLeaderboard = [];

// ═══ БОТЫ ═══
const BOTS = [
  { name: 'I crazy![NBAM]', skinId: 0, skinColor: '#ff6b6b' },
  { name: 'Player',          skinId: 2, skinColor: '#00e5cc' },
];
const BOT_RESPAWN_DELAY = 4000; // мс до респауна после смерти
const botMeta = {}; // botId -> { respawnAt }

function spawnBot(botCfg, botId) {
  const sx = 300 + Math.random() * (WORLD - 600);
  const sy = 300 + Math.random() * (WORLD - 600);
  const p = mkSnake(sx, sy, botCfg.name, botCfg.skinId);
  p.skinColor  = botCfg.skinColor;
  p.isBot      = true;
  p.botCfg     = botCfg;
  p.botId      = botId;
  p.ws         = null; // нет WebSocket
  p.deathSent  = true; // не слать 'dead' пакет
  p._botDir    = Math.random() * Math.PI * 2; // текущая цель-угол
  p._botDirTick = 0;
  players[botId] = p;
  botMeta[botId] = { respawnAt: 0 };
  adjustTick();
  console.log(`[BOT] Spawned ${botCfg.name} as ${botId}`);
}

function initBots() {
  BOTS.forEach((cfg, i) => {
    const botId = 'bot_' + i;
    spawnBot(cfg, botId);
  });
}

function botAngleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function tickBots() {
  BOTS.forEach((cfg, i) => {
    const botId = 'bot_' + i;
    const p = players[botId];
    const meta = botMeta[botId];

    // Респаун мёртвого бота
    if (!p || !p.alive) {
      if (meta && Date.now() >= meta.respawnAt) {
        spawnBot(cfg, botId);
      }
      return;
    }

    p._botDirTick = (p._botDirTick || 0) + 1;
    const head = p.segs[0];
    const myR = getR(p.score);
    const WALL = 180;

    // ── Собираем всех живых врагов (включая другого бота) ──
    const enemies = Object.values(players).filter(e =>
      e !== p && e.alive && e.segs.length > 0
    );

    // ── Ищем ближайшую цель для атаки ──
    let huntTarget = null, huntDist = 420;
    for (const e of enemies) {
      const dx = e.segs[0].x - head.x, dy = e.segs[0].y - head.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < huntDist) { huntDist = d; huntTarget = e; }
    }

    // ── Уклонение от чужих тел ──
    let dangerAngle = null, dangerDist = 9999;
    for (const e of enemies) {
      for (let si = 1; si < Math.min(e.segs.length, 60); si++) {
        const s = e.segs[si];
        const dx = s.x - head.x, dy = s.y - head.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const threshold = myR + getR(e.score) * 0.5 + 30;
        if (d < threshold && d < dangerDist) {
          dangerDist = d;
          dangerAngle = Math.atan2(dy, dx) + Math.PI;
        }
      }
    }

    // ── Ближайшая еда ──
    let bestFood = null, bestFoodDist = 250;
    for (const f of foods) {
      const dx = f.x - head.x, dy = f.y - head.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const bonus = f.drop ? 80 : 0;
      if (d - bonus < bestFoodDist) { bestFoodDist = d - bonus; bestFood = f; }
    }

    // ── Выбираем поведение ──
    let targetAngle = p._botDir || 0;
    let shouldBoost = false;

    const nearWall = head.x < WALL || head.x > WORLD - WALL ||
                     head.y < WALL || head.y > WORLD - WALL;

    if (nearWall) {
      targetAngle = Math.atan2(WORLD / 2 - head.y, WORLD / 2 - head.x);
      shouldBoost = true;

    } else if (dangerAngle !== null && dangerDist < myR * 2 + 25) {
      targetAngle = dangerAngle;
      shouldBoost = true;

    } else if (huntTarget && huntDist < 350) {
      // Упреждение — целимся чуть впереди головы врага
      const lead = 18;
      const ex = huntTarget.segs[0].x + Math.cos(huntTarget.angle) * lead;
      const ey = huntTarget.segs[0].y + Math.sin(huntTarget.angle) * lead;
      targetAngle = Math.atan2(ey - head.y, ex - head.x);

      if (huntDist < 200) {
        shouldBoost = p.score >= huntTarget.score * 0.7;
      }

      // Тактика окружения если бот крупнее
      if (p.score > huntTarget.score * 1.4 && huntDist < 300) {
        const offset = Math.PI * 0.35;
        targetAngle += offset * (Math.random() > 0.5 ? 1 : -1);
        shouldBoost = true;
      }

    } else if (bestFood) {
      targetAngle = Math.atan2(bestFood.y - head.y, bestFood.x - head.x);
      shouldBoost = bestFood.drop && bestFoodDist < 120;

    } else {
      if (p._botDirTick % 55 === 0) {
        p._botDir = (p._botDir || 0) + (Math.random() - 0.5) * 1.4;
      }
      targetAngle = p._botDir;
    }

    // Плавный поворот как у игрока
    const maxTurn = 0.22;
    const diff = botAngleDiff(p.tAngle, targetAngle);
    p.tAngle += Math.sign(diff) * Math.min(Math.abs(diff), maxTurn);

    p._botDir = targetAngle;
    p.boosting = shouldBoost && p.length > MIN_LEN + 5;
  });
}

// Смерть бота обрабатывается внутри killSnake

const accounts = {};
const sessions = {};
const friendships = {};
const teams = {};
const pidToWsId = {};

// ═══ BATTLE ROYALE ═══
const BR_MIN_SIZE = 500;
const BR_SHRINK_INTERVAL = 60000;
const BR_SHRINK_AMOUNT = 400;
const BR_DAMAGE_TIME = 6000;
let brZoneSize = WORLD;
let brLastShrink = Date.now();
let brActive = false;

function brZoneLeft()   { return (WORLD - brZoneSize) / 2; }
function brZoneTop()    { return (WORLD - brZoneSize) / 2; }
function brZoneRight()  { return brZoneLeft() + brZoneSize; }
function brZoneBottom() { return brZoneTop()  + brZoneSize; }
function brIsOutside(x, y) {
  return x < brZoneLeft() || x > brZoneRight() || y < brZoneTop() || y > brZoneBottom();
}
function brTickZone() {
  if (!brActive) return;
  const now = Date.now();
  if (now - brLastShrink >= BR_SHRINK_INTERVAL) {
    brLastShrink = now;
    if (brZoneSize - BR_SHRINK_AMOUNT >= BR_MIN_SIZE) {
      brZoneSize -= BR_SHRINK_AMOUNT;
      console.log(`[BR] Зона: ${brZoneSize}`);
    } else {
      brZoneSize = WORLD;
      console.log(`[BR] Зона сброшена`);
    }
  }
}
function updateBrActive() {
  brActive = Object.values(players).some(p => p.alive && p.brMode);
  if (!brActive) brZoneSize = WORLD;
}

function hashPass(pass) { return crypto.createHash('sha256').update(pass + 'dvx_salt_2025').digest('hex'); }
function mkToken() { return crypto.randomBytes(32).toString('hex'); }
function fmtScore(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

let globalTop = [];
const TOP_SIZE = 100;
function submitScore(name, score, skinId, isBot) {
  if (score < 50) return;
  if (isBot) {
    // Бот — обновляем его запись (не дублируем)
    const idx = globalTop.findIndex(r => r.name === name && r.isBot);
    if (idx >= 0) {
      if (score <= globalTop[idx].score) return; // не обновляем если меньше
      globalTop[idx].score = score;
      globalTop[idx].date = Date.now();
    } else {
      globalTop.push({ name, score, skinId, date: Date.now(), isBot: true });
    }
  } else {
    globalTop.push({ name, score, skinId, date: Date.now() });
  }
  globalTop.sort((a, b) => b.score - a.score);
  if (globalTop.length > TOP_SIZE) globalTop = globalTop.slice(0, TOP_SIZE);
}
function getTop(n = 10) {
  return globalTop.slice(0, n).map((r, i) => ({ rank: i+1, name: r.name, score: r.score, scoreStr: fmtScore(r.score), skinId: r.skinId }));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/auth/register' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        if (!email || !password) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Введи email и пароль'})); }
        const key = email.toLowerCase().trim();
        if (accounts[key]) { res.writeHead(409,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Этот email уже зарегистрирован'})); }
        const pid = 'p_' + crypto.randomBytes(8).toString('hex');
        accounts[key] = { email: key, passHash: hashPass(password), pid, createdAt: Date.now() };
        const token = mkToken(); sessions[token] = key;
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,token,email:key,pid,newAccount:true}));
      } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Ошибка сервера'})); }
    }); return;
  }
  if (req.url === '/auth/login' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        const key = email.toLowerCase().trim(); const acc = accounts[key];
        if (!acc || acc.passHash !== hashPass(password)) { res.writeHead(401,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Неверный email или пароль'})); }
        const token = mkToken(); sessions[token] = key;
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,token,email:key,pid:acc.pid}));
      } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Ошибка сервера'})); }
    }); return;
  }
  if (req.url === '/auth/check' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body); const email = sessions[token];
        if (!email || !accounts[email]) { res.writeHead(401,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Сессия истекла'})); }
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,email,pid:accounts[email].pid}));
      } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Ошибка сервера'})); }
    }); return;
  }
  if (req.url === '/top') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(getTop(50))); return; }
  res.writeHead(200,{'Content-Type':'text/plain'}); res.end('DevourX Server OK');
});

const wss = new WebSocket.Server({ server });
let foods = [], players = {}, nextId = 1, tickInterval = null, currentTickRate = null;

function getAlivePlayers() { return Object.values(players).filter(p => p.alive).length; }
function startTick(rate) {
  if (currentTickRate === rate) return;
  if (tickInterval) clearInterval(tickInterval);
  currentTickRate = rate;
  tickInterval = setInterval(gameTick, rate);
  if (rate === TICK_IDLE) console.log('😴 idle'); else console.log('⚡ active');
}
function adjustTick() { getAlivePlayers() === 0 ? startTick(TICK_IDLE) : startTick(TICK); }

function mkFood() {
  const rnd = Math.random(); let size, r;
  if (rnd < 0.75) { size='small'; r=3+Math.random()*2; } else if (rnd < 0.95) { size='medium'; r=5+Math.random()*2; } else { size='big'; r=8+Math.random()*2; }
  return { x:Math.round(200+Math.random()*(WORLD-400)), y:Math.round(200+Math.random()*(WORLD-400)), r:Math.round(r*10)/10, color:`hsl(${Math.floor(Math.random()*360)},90%,65%)`, size };
}

function initFoods() { 
  foods = []; 
  for(let i = 0; i < MAX_FOOD; i++) foods.push(mkFood()); 
}
// Вызови при старте сервера
initFoods();

function mkSnake(x, y, name, skinId) {
  const angle = Math.random()*Math.PI*2, segs=[];
  for(let i=0;i<MIN_LEN;i++) segs.push({x:Math.round(x-Math.cos(angle)*i*14),y:Math.round(y-Math.sin(angle)*i*14)});
  return { x,y, name:name||'Player', skinId:skinId||0, angle, tAngle:angle, speed:2.8, boosting:false, alive:true, length:MIN_LEN, score:MIN_LEN, segs, turnSpeed:0.18, skinColor:'#f9ca24', pid:null, teamId:null, brMode:false, brHP:100, brInZone:false, brZoneSince:0 };
}

function getR(score) { return 6+(Math.min(score,1000)/1000)*22; }
function getTurnSpeed(score) { const t=Math.min(score,1000)/1000; return 0.18-t*0.125; }

function updateSnake(sn) {
  if (!sn.alive) return;
  let da=sn.tAngle-sn.angle;
  while(da>Math.PI) da-=Math.PI*2; while(da<-Math.PI) da+=Math.PI*2;
  sn.angle+=da*getTurnSpeed(sn.score);
  const spd=sn.boosting?sn.speed*1.85:sn.speed;
  const hx=sn.segs[0].x+Math.cos(sn.angle)*spd, hy=sn.segs[0].y+Math.sin(sn.angle)*spd;
  if(hx<=10||hx>=WORLD-10||hy<=10||hy>=WORLD-10){killSnake(sn,'wall');return;}
  sn.segs.unshift({x:Math.round(hx),y:Math.round(hy)});
  while(sn.segs.length>sn.length) sn.segs.pop();
  const segDist=8;
  for(let i=1;i<sn.segs.length;i++){
    const prev=sn.segs[i-1],curr=sn.segs[i],dx=prev.x-curr.x,dy=prev.y-curr.y,dist=Math.sqrt(dx*dx+dy*dy);
    if(dist>segDist){const ratio=(dist-segDist)/dist; curr.x=Math.round(curr.x+dx*ratio); curr.y=Math.round(curr.y+dy*ratio);}
  }
  // ═══ BR урон от зоны ═══
  if (sn.brMode && sn.segs.length > 0 && brIsOutside(sn.segs[0].x, sn.segs[0].y)) {
    if (!sn.brInZone) { sn.brInZone = true; sn.brZoneSince = Date.now(); }
    sn.brHP = Math.max(0, 100 - (Date.now() - sn.brZoneSince) / BR_DAMAGE_TIME * 100);
    if (sn.brHP <= 0) { killSnake(sn); return; }
  } else if (sn.brMode) {
    if (sn.brInZone) { sn.brInZone = false; sn.brZoneSince = 0; }
    sn.brHP = Math.min(100, sn.brHP + 0.4);
  }
}

function eatFood(sn) {
  const h=sn.segs[0],r=getR(sn.score);
  for(let i=foods.length-1;i>=0;i--){
    const f=foods[i],dx=h.x-f.x,dy=h.y-f.y;
    const er=(f.size==='big'?f.r+10:f.size==='medium'?f.r+7:f.r+5)+r;
    if(dx*dx+dy*dy<er*er){
      const g=f.size==='big'?10:f.size==='medium'?5:2;
      sn.score+=g;
      if(sn.length<MAX_BODY){if(sn.length<MAX_BODY_SLOW){sn.length=Math.min(MAX_BODY_SLOW,sn.length+g);}else{sn._growBuf=(sn._growBuf||0)+g;if(sn._growBuf>=2){const add=Math.floor(sn._growBuf/2);sn._growBuf-=add*2;sn.length=Math.min(MAX_BODY,sn.length+add);}}}
      sn.foodEaten=(sn.foodEaten||0)+1;
      if(sn.foodEaten>=3){sn.foodEaten-=3;if(sn.ws&&sn.ws.readyState===1)sn.ws.send(JSON.stringify({type:'coin_reward',coins:1}));}
      foods[i]=mkFood();
    }
  }
}

function killSnake(sn, cause) {
  if(!sn.alive) return; sn.alive=false;
  sn._deathCause = cause || null; // 'wall' | { killerName } | null
  // Бот — запланировать респаун
  if (sn.isBot && sn.botId !== undefined && botMeta[sn.botId]) {
    botMeta[sn.botId].respawnAt = Date.now() + BOT_RESPAWN_DELAY;
    submitScore(sn.name, sn.score, sn.skinId, true); // бот попадает в топ
  }
  if(sn.teamId&&teams[sn.teamId]){teams[sn.teamId]=teams[sn.teamId].filter(pid=>pid!==sn.pid);if(teams[sn.teamId].length===0)delete teams[sn.teamId];}
  sn.teamId=null;
  const dropCount=Math.max(1,Math.min(200,Math.floor(sn.score/2))),totalSegs=sn.segs.length,step=Math.max(1,Math.floor(totalSegs/dropCount));
  for(let i=0;i<dropCount;i++){const idx=Math.min(i*step,totalSegs-1),s=sn.segs[idx];foods.push({x:Math.round(Math.max(50,Math.min(WORLD-50,s.x+(Math.random()-.5)*20))),y:Math.round(Math.max(50,Math.min(WORLD-50,s.y+(Math.random()-.5)*20))),r:9+Math.random()*3,color:`hsl(${Math.floor(Math.random()*360)},90%,65%)`,size:'big',drop:true});}
  if(foods.length>MAX_FOOD+200) foods.splice(0,foods.length-(MAX_FOOD+200));
}

function checkCollisions() {
  const alive = Object.values(players).filter(s => s.alive);
  for (const sn of alive) {
    if (!sn.alive) continue;
    const h = sn.segs[0], r = getR(sn.score);
    for (const other of alive) {
      if (!other.alive || other === sn) continue;
      if (sn.teamId && sn.teamId === other.teamId) continue;
      
      // Проверка расстояния до другой змейки (чтобы не считать далёких)
      const distToOther = Math.hypot(other.segs[0].x - h.x, other.segs[0].y - h.y);
      if (distToOther > VIEW_X) continue; // слишком далеко — не проверяем
      
      for (let i = 2; i < other.segs.length; i++) {
        const s = other.segs[i];
        const dx = h.x - s.x, dy = h.y - s.y;
        // Уменьшенный радиус коллизии
        if (dx * dx + dy * dy < (r + getR(other.score) * 0.3) ** 2) {
          killSnake(sn, { killerName: other.name });
          if (other.ws && other.ws.readyState === 1) {
            other.ws.send(JSON.stringify({ type: 'kill_reward', coins: 3 }));
          }
          break;
        }
      }
      if (!sn.alive) break;
    }
  }
}

const TEAM_COLORS=['#f9ca24','#ff6b9d','#00e5cc','#a29bfe','#ff9f43','#39ff14']; let teamColorIdx=0;
function nextTeamColor(){const c=TEAM_COLORS[teamColorIdx%TEAM_COLORS.length];teamColorIdx++;return c;}

function buildSnapshot(forId) {
  const me=players[forId]; if(!me||!me.segs.length) return null;
  const cx=me.segs[0].x,cy=me.segs[0].y;
  const nearPlayers=Object.entries(players).filter(([,p])=>p.alive).filter(([id,p])=>{if(id===forId)return true;const ph=p.segs[0];return Math.abs(ph.x-cx)<VIEW_X&&Math.abs(ph.y-cy)<VIEW_Y;}).map(([id,p])=>({id,name:p.name,skinId:p.skinId,score:p.score,scoreStr:fmtScore(p.score),segs:p.segs.slice(0,MAX_SEGS_SEND),boosting:p.boosting,isMe:id===forId,teamId:p.teamId||null,teamColor:p.teamColor||null,brMode:p.brMode||false,brHP:p.brMode?Math.round(p.brHP):null}));
  const nearFoods=foods.filter(f=>{if(f.drop)return true;const dx=Math.abs(f.x-cx),dy=Math.abs(f.y-cy);return dx<VIEW_X&&dy<VIEW_Y;});
  lbTickCounter++;
  if(lbTickCounter>=10){lbTickCounter=0;cachedLeaderboard=Object.entries(players).filter(([,s])=>s.alive).sort(([,a],[,b])=>b.score-a.score).slice(0,10).map(([id,s])=>({name:s.name,score:s.score,scoreStr:fmtScore(s.score),isMe:id===forId}));}
  const brSecsLeft = Math.max(0, Math.ceil((BR_SHRINK_INTERVAL-(Date.now()-brLastShrink))/1000));
  const allHeads=Object.entries(players).filter(([,p])=>p.alive&&p.segs.length).map(([id,p])=>({x:p.segs[0].x,y:p.segs[0].y,isMe:id===forId}));
  return {type:'world',players:nearPlayers,foods:nearFoods,leaderboard:cachedLeaderboard,allHeads,myScore:me.score,myScoreStr:fmtScore(me.score),brZoneSize:brActive?brZoneSize:null,brSecsLeft:brActive?brSecsLeft:null};
}

function gameTick() {
  tickBots();
  const alive=Object.values(players).filter(p=>p.alive); if(alive.length===0) return;
  brTickZone();
  for(const id in players){
    const p=players[id]; if(!p.alive) continue;
    updateSnake(p); eatFood(p);
    p._boostTick=(p._boostTick||0)+1;
    if(p.boosting&&p.length>MIN_LEN&&p._boostTick>=20){p._boostTick=0;p.length=Math.max(MIN_LEN,p.length-1);p.score=Math.max(MIN_LEN,p.score-1);const tail=p.segs[p.segs.length-1];foods.push({x:Math.round(tail.x+(Math.random()-.5)*10),y:Math.round(tail.y+(Math.random()-.5)*10),r:5,color:p.skinColor||'#f9ca24',size:'small',drop:true});}
    else if(!p.boosting) p._boostTick=0;
  }
  checkCollisions();
  if(Date.now()-lastFriendPing>1000){lastFriendPing=Date.now();broadcastFriendStatuses();}
  const playerCount=alive.length;
  for(const id in players){
    const p=players[id],ws=p.ws;
    if(p.isBot) continue; // боты — без ws
    if(!ws||ws.readyState!==WebSocket.OPEN) continue;
    if(!p.alive){if(!p.deathSent){p.deathSent=true;submitScore(p.name,p.score,p.skinId);const cause=p._deathCause;ws.send(JSON.stringify({type:'dead',score:p.score,globalTop:getTop(10),deathCause:cause}));}continue;}
    const snap=buildSnapshot(id); if(snap){snap.playerCount=playerCount;try{ws.send(JSON.stringify(snap));}catch(e){}}
  }
}

let lastFriendPing=0;
function broadcastFriendStatuses(){
  for(const id in players){
    const p=players[id]; if(!p.ws||p.ws.readyState!==WebSocket.OPEN||!p.pid) continue;
    const myFriends=friendships[p.pid]; if(!myFriends||myFriends.size===0) continue;
    const statuses=[];
    for(const friendPid of myFriends){const fwid=pidToWsId[friendPid],fp=fwid?players[fwid]:null;statuses.push({pid:friendPid,online:!!(fp&&fp.alive),name:fp?fp.name:null,teamId:fp?fp.teamId:null});}
    try{p.ws.send(JSON.stringify({type:'friend_statuses',statuses}));}catch(e){}
  }
}

wss.on('connection', (ws) => {
  const id=String(nextId++); console.log(`[+] ${id}`);
  ws.on('message', (raw) => {
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    if(msg.type==='join'){
      const sx=300+Math.random()*(WORLD-600),sy=300+Math.random()*(WORLD-600);
      const p=mkSnake(sx,sy,msg.name||'Player',msg.skinId||0);
      p.ws=ws; p.deathSent=false; players[id]=p; p.skinColor=msg.skinColor||'#f9ca24';
      if(msg.pid){p.pid=msg.pid;pidToWsId[msg.pid]=id;}
      // ═══ Battle Royale режим ═══
      if(msg.brMode){
        p.brMode=true; p.brHP=100; brActive=true;
        if(brZoneSize===WORLD) brLastShrink=Date.now();
        console.log(`[BR] ${msg.name} joined`);
      }
      const cnt=Object.values(players).filter(p=>p.alive).length;
      const brSecsLeft=Math.max(0,Math.ceil((BR_SHRINK_INTERVAL-(Date.now()-brLastShrink))/1000));
      ws.send(JSON.stringify({type:'joined',id,spawnX:sx,spawnY:sy,worldSize:WORLD,playerCount:cnt,globalTop:getTop(10),brZoneSize:p.brMode?brZoneSize:null,brSecsLeft:p.brMode?brSecsLeft:null}));
      adjustTick();
    }

    if(msg.type==='get_top') ws.send(JSON.stringify({type:'global_top',top:getTop(50)}));

    if(msg.type==='input'){const p=players[id];if(!p||!p.alive)return;p.tAngle=msg.angle;p.boosting=msg.boost&&p.length>MIN_LEN;}

    if(msg.type==='respawn'){
      const old=players[id];
      const sx=300+Math.random()*(WORLD-600),sy=300+Math.random()*(WORLD-600);
      const p=mkSnake(sx,sy,old?old.name:'Player',old?old.skinId:0);
      p.ws=ws; p.deathSent=false; players[id]=p; p.skinColor=old?(old.skinColor||'#f9ca24'):'#f9ca24';
      if(old&&old.pid){p.pid=old.pid;pidToWsId[old.pid]=id;}
      if(old&&old.brMode){p.brMode=true;p.brHP=100;}
      ws.send(JSON.stringify({type:'joined',id,spawnX:sx,spawnY:sy,worldSize:WORLD})); adjustTick();
    }

    if(msg.type==='add_friend'){
      const myPid=msg.myPid,friendPid=msg.friendPid;
      if(!myPid||!friendPid||myPid===friendPid) return;
      if(!friendships[myPid]) friendships[myPid]=new Set();
      friendships[myPid].add(friendPid);
      const fp=pidToWsId[friendPid]?players[pidToWsId[friendPid]]:null;
      ws.send(JSON.stringify({type:'friend_added',pid:friendPid,online:!!(fp&&fp.alive),name:fp?fp.name:'???'}));
    }

    if(msg.type==='remove_friend'){
      if(friendships[msg.myPid]) friendships[msg.myPid].delete(msg.friendPid);
      ws.send(JSON.stringify({type:'friend_removed',pid:msg.friendPid}));
    }

    if(msg.type==='join_team'){
      const myPid=msg.myPid,friendPid=msg.friendPid; if(!myPid||!friendPid) return;
      const me=players[id]; if(!me||!me.alive) return;
      const fp=pidToWsId[friendPid]?players[pidToWsId[friendPid]]:null;
      if(!fp||!fp.alive){ws.send(JSON.stringify({type:'team_error',msg:'Друг не в игре'}));return;}
      let teamId,teamColor;
      if(fp.teamId&&teams[fp.teamId]){teamId=fp.teamId;teamColor=fp.teamColor;teams[teamId].push(myPid);}
      else{teamId='team_'+Date.now();teamColor=nextTeamColor();teams[teamId]=[friendPid,myPid];fp.teamId=teamId;fp.teamColor=teamColor;if(fp.ws&&fp.ws.readyState===1)fp.ws.send(JSON.stringify({type:'team_joined',teamId,teamColor,partnerName:me.name}));}
      me.teamId=teamId;me.teamColor=teamColor;
      ws.send(JSON.stringify({type:'team_joined',teamId,teamColor,partnerName:fp.name}));
    }

    if(msg.type==='leave_team'){
      const me=players[id]; if(!me||!me.teamId) return;
      const tid=me.teamId;
      if(teams[tid]){teams[tid]=teams[tid].filter(p=>p!==me.pid);if(teams[tid].length===0)delete teams[tid];}
      me.teamId=null;me.teamColor=null;ws.send(JSON.stringify({type:'team_left'}));
    }
  });

  ws.on('close', () => {
    if(players[id]){const p=players[id];if(p.pid&&pidToWsId[p.pid]===id)delete pidToWsId[p.pid];killSnake(p);delete players[id];}
    updateBrActive(); adjustTick();
  });
  ws.on('error', () => {
    if(players[id]){const p=players[id];if(p.pid&&pidToWsId[p.pid]===id)delete pidToWsId[p.pid];killSnake(p);delete players[id];}
    updateBrActive(); adjustTick();
  });
});

initFoods();
initBots();
startTick(TICK_IDLE);
server.listen(PORT, () => console.log(`DevourX запущен на порту ${PORT}`));
