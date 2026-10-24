const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const WORLD = { w: 2200, h: 1500 };
const TICK_MS = 1000 / 60;
const SNAPSHOT_MS = 50;
const PLAYER_SPEED = 260;
const PLAYER_RADIUS = 17;
const BULLET_SPEED = 620;
const BULLET_RADIUS = 5;
const BULLET_DAMAGE = 25;
const FIRE_COOLDOWN = 220;
const RESPAWN_MS = 1800;
const MAX_PLAYERS = 24;
const CHAT_COOLDOWN_MS = 650;
const EMOTES = ['😀','😂','😎','😡','😭','🔥','👍','💀'];
const COLORS = ['#42d9ff','#ffbd4a','#b78bff','#62ed9a','#ff638b','#ff8a4c','#f4f76a','#65a6ff'];

const players = new Map();
const bullets = new Map();
let nextPlayerId = 1;
let nextBulletId = 1;
let lastSnapshot = 0;

// Static cover. Coordinates are world-space rectangles.
const obstacles = [
  {x:300,y:220,w:230,h:70,type:'crate'}, {x:660,y:170,w:80,h:260,type:'wall'},
  {x:960,y:260,w:270,h:75,type:'crate'}, {x:1510,y:180,w:100,h:280,type:'wall'},
  {x:1820,y:280,w:170,h:80,type:'crate'}, {x:230,y:650,w:100,h:280,type:'wall'},
  {x:510,y:790,w:220,h:75,type:'crate'}, {x:900,y:600,w:90,h:290,type:'wall'},
  {x:1120,y:760,w:260,h:75,type:'crate'}, {x:1590,y:650,w:100,h:300,type:'wall'},
  {x:1840,y:990,w:180,h:80,type:'crate'}, {x:330,y:1190,w:250,h:75,type:'crate'},
  {x:740,y:1110,w:90,h:250,type:'wall'}, {x:1050,y:1230,w:250,h:75,type:'crate'},
  {x:1410,y:1120,w:90,h:240,type:'wall'}, {x:1710,y:1210,w:240,h:70,type:'crate'},
  {x:1000,y:440,w:70,h:90,type:'barrel'}, {x:1300,y:450,w:70,h:90,type:'barrel'},
  {x:430,y:480,w:70,h:90,type:'barrel'}, {x:1760,y:510,w:70,h:90,type:'barrel'},
  {x:780,y:930,w:70,h:90,type:'barrel'}, {x:1370,y:950,w:70,h:90,type:'barrel'}
];

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function rand(min, max) { return min + Math.random() * (max - min); }
function circleRect(cx, cy, r, rect) {
  const x = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const y = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - x, dy = cy - y;
  return dx * dx + dy * dy < r * r;
}
function blocked(x, y, r = PLAYER_RADIUS) {
  if (x < r || y < r || x > WORLD.w-r || y > WORLD.h-r) return true;
  return obstacles.some(o => circleRect(x, y, r, o));
}
function spawn(p) {
  let x, y, tries = 0;
  do {
    x = rand(80, WORLD.w - 80);
    y = rand(80, WORLD.h - 80);
    tries++;
  } while ((blocked(x,y) || [...players.values()].some(q => q.id !== p.id && q.alive && Math.hypot(q.x-x,q.y-y) < 100)) && tries < 300);
  p.x = x; p.y = y; p.vx = 0; p.vy = 0;
  p.hp = 100; p.alive = true; p.respawnAt = 0;
  p.aim = 0; p.lastShot = 0; p.invulnerableUntil = Date.now() + 1200;
}
function eliminate(p, killerId = null) {
  if (!p.alive) return;
  p.alive = false; p.hp = 0; p.respawnAt = Date.now() + RESPAWN_MS;
  if (killerId && players.has(killerId) && killerId !== p.id) players.get(killerId).kills++;
  p.deaths++;
}
function circleHitsSegment(px, py, r, x1, y1, x2, y2) {
  const dx = x2-x1, dy = y2-y1;
  const len2 = dx*dx + dy*dy || 1;
  const t = Math.max(0, Math.min(1, ((px-x1)*dx+(py-y1)*dy)/len2));
  return Math.hypot(px-(x1+t*dx), py-(y1+t*dy)) <= r;
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } else if (pathname === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, players:players.size}));
  } else { res.writeHead(404); res.end('Not found'); }
});
const wss = new WebSocket.Server({server, perMessageDeflate:false});
wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { send(ws,{type:'error',message:'Serverul este plin. Încearcă mai târziu.'}); ws.close(); return; }
  const id = nextPlayerId++;
  const p = {id,ws,name:`Player ${id}`,color:COLORS[(id-1)%COLORS.length],x:100,y:100,vx:0,vy:0,hp:100,alive:true,kills:0,deaths:0,aim:0,keys:{},lastShot:0,respawnAt:0,invulnerableUntil:0,lastInput:Date.now(),lastChat:0,lastEmote:0,emote:'',emoteUntil:0};
  players.set(id,p); spawn(p);
  send(ws,{type:'welcome',id,world:WORLD,obstacles});
  ws.on('message', raw => {
    if (raw.length > 2048) return;
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'name' && typeof m.name === 'string') p.name = m.name.trim().slice(0,16) || p.name;
    if (m.type === 'input') {
      const k = m.keys || {};
      p.keys = {up:!!k.up,down:!!k.down,left:!!k.left,right:!!k.right,fire:!!k.fire};
      if (Number.isFinite(m.aim)) p.aim = m.aim;
      p.lastInput = Date.now();
    }
    if (m.type === 'shoot' && Number.isFinite(m.aim)) { p.aim = m.aim; p.keys.fire = true; }
    if (m.type === 'chat' && typeof m.text === 'string') {
      const now = Date.now();
      const text = m.text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
      if (text && now - p.lastChat >= CHAT_COOLDOWN_MS) {
        p.lastChat = now;
        const packet = JSON.stringify({type:'chat',id:p.id,name:p.name,color:p.color,text,at:now});
        for (const q of players.values()) if (q.ws.readyState === WebSocket.OPEN && q.ws.bufferedAmount < 100_000) q.ws.send(packet);
      }
    }
    if (m.type === 'emote' && EMOTES.includes(m.value) && Date.now() - p.lastEmote > 450) {
      p.lastEmote = Date.now(); p.emote = m.value; p.emoteUntil = Date.now() + 1800;
      const packet = JSON.stringify({type:'emote',id:p.id,value:p.emote,until:p.emoteUntil});
      for (const q of players.values()) if (q.ws.readyState === WebSocket.OPEN && q.ws.bufferedAmount < 100_000) q.ws.send(packet);
    }
  });
  ws.on('close', () => { players.delete(id); for (const [bid,b] of bullets) if (b.ownerId === id) bullets.delete(bid); });
  ws.on('error', () => {});
});

let previous = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - previous) / 1000);
  previous = now;

  for (const p of players.values()) {
    if (!p.alive) {
      if (now >= p.respawnAt) spawn(p);
      continue;
    }
    let dx = (p.keys.right ? 1 : 0) - (p.keys.left ? 1 : 0);
    let dy = (p.keys.down ? 1 : 0) - (p.keys.up ? 1 : 0);
    const mag = Math.hypot(dx,dy) || 1;
    dx /= mag; dy /= mag;
    const speed = PLAYER_SPEED;
    const nx = p.x + dx * speed * dt;
    const ny = p.y + dy * speed * dt;
    // Axis-separated collision lets players slide along walls.
    if (!blocked(nx, p.y)) p.x = nx;
    if (!blocked(p.x, ny)) p.y = ny;

    if (p.keys.fire && now - p.lastShot >= FIRE_COOLDOWN) {
      p.lastShot = now;
      const a = p.aim;
      const sx = p.x + Math.cos(a) * (PLAYER_RADIUS + 9);
      const sy = p.y + Math.sin(a) * (PLAYER_RADIUS + 9);
      bullets.set(nextBulletId, {id:nextBulletId++,ownerId:p.id,x:sx,y:sy,vx:Math.cos(a)*BULLET_SPEED,vy:Math.sin(a)*BULLET_SPEED,life:1.25,damage:BULLET_DAMAGE,color:p.color});
    }
  }

  for (const [id,b] of bullets) {
    const ox = b.x, oy = b.y;
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD.w || b.y > WORLD.h || obstacles.some(o => circleRect(b.x,b.y,BULLET_RADIUS,o))) { bullets.delete(id); continue; }
    let hit = false;
    for (const p of players.values()) {
      if (!p.alive || p.id === b.ownerId || Date.now() < p.invulnerableUntil) continue;
      if (circleHitsSegment(p.x,p.y,PLAYER_RADIUS + BULLET_RADIUS,ox,oy,b.x,b.y)) {
        p.hp -= b.damage;
        if (p.hp <= 0) eliminate(p,b.ownerId);
        bullets.delete(id); hit = true; break;
      }
    }
    if (hit) continue;
  }

  if (now - lastSnapshot >= SNAPSHOT_MS) {
    lastSnapshot = now;
    const state = JSON.stringify({type:'state',time:now,players:[...players.values()].map(p=>({id:p.id,name:p.name,color:p.color,x:p.x,y:p.y,hp:p.hp,alive:p.alive,kills:p.kills,deaths:p.deaths,aim:p.aim,invulnerable:now<p.invulnerableUntil,emote:p.emoteUntil>now?p.emote:'',emoteUntil:p.emoteUntil})),bullets:[...bullets.values()].map(b=>({id:b.id,x:b.x,y:b.y,color:b.color})),count:players.size});
    for (const p of players.values()) if (p.ws.readyState === WebSocket.OPEN && p.ws.bufferedAmount < 1_000_000) p.ws.send(state);
  }
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => console.log(`Shooter server listening on ${PORT}`));
