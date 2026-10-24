const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;
const SIZE = 70, TICK = 100, SPEED = 0.48;
const colors = ['#00c2ff','#ffbe3b','#b074ff','#51df8b','#ff638a','#ff8b45'];
const grid = new Int16Array(SIZE * SIZE).fill(-1);
const players = new Map();
let nextId = 1;
const idx = (x,y) => y * SIZE + x;
const inside = (x,y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;
function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const data = JSON.stringify(obj); for (const p of players.values()) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data); }
function spawn(p) {
  p.alive = true; p.trail = []; p.trailSet = new Set(); p.dir = {x:1,y:0}; p.nextDir = {x:1,y:0};
  let x,y,tries=0;
  do { x = 4 + Math.floor(Math.random()*(SIZE-8)); y = 4 + Math.floor(Math.random()*(SIZE-8)); tries++; }
  while (grid[idx(x,y)] !== -1 && tries < 200);
  p.x = x + .5; p.y = y + .5;
  for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) if(inside(x+dx,y+dy)) grid[idx(x+dx,y+dy)] = p.id;
}
function kill(p) {
  p.alive=false;
  for(let i=0;i<grid.length;i++) if(grid[i]===p.id) grid[i]=-1;
  p.trail=[]; p.trailSet.clear();
  send(p.ws,{type:'dead'});
  setTimeout(()=>{if(players.has(p.id)){spawn(p);send(p.ws,{type:'respawn'});}},1800);
}
function capture(p) {
  for(const k of p.trail) grid[k]=p.id;
  const seen = new Uint8Array(grid.length);
  const queue = new Int32Array(grid.length);
  let head=0,tail=0;
  function enqueue(k){if(!seen[k] && grid[k]!==p.id){seen[k]=1;queue[tail++]=k;}}
  for(let x=0;x<SIZE;x++){enqueue(idx(x,0));enqueue(idx(x,SIZE-1));}
  for(let y=0;y<SIZE;y++){enqueue(idx(0,y));enqueue(idx(SIZE-1,y));}
  while(head<tail){const k=queue[head++],x=k%SIZE,y=Math.floor(k/SIZE);if(x>0)enqueue(k-1);if(x<SIZE-1)enqueue(k+1);if(y>0)enqueue(k-SIZE);if(y<SIZE-1)enqueue(k+SIZE);}
  for(let k=0;k<grid.length;k++)if(grid[k]!==p.id && !seen[k])grid[k]=p.id;
  p.trail=[];p.trailSet.clear();
}
const server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent((req.url||'/').split('?')[0]);
  if(pathname==='/' || pathname==='/index.html'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    fs.createReadStream(path.join(__dirname,'index.html')).pipe(res);
  }else if(pathname==='/health'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');}
  else{res.writeHead(404);res.end('Not found');}
});
const wss=new WebSocket.Server({server});
wss.on('connection',ws=>{
  if(players.size>=24){send(ws,{type:'error',message:'Camera este plină'});ws.close();return;}
  const id=nextId++;
  const p={id,ws,name:'Player '+id,color:colors[(id-1)%colors.length]};
  players.set(id,p);spawn(p);
  send(ws,{type:'welcome',id,size:SIZE});
  ws.on('message',raw=>{
    if(raw.length>1024)return;
    let m;try{m=JSON.parse(raw.toString());}catch{return;}
    if(m.type==='name' && typeof m.name==='string')p.name=m.name.trim().slice(0,16)||p.name;
    if(m.type==='direction' && ['up','down','left','right'].includes(m.value)){
      const d={up:{x:0,y:-1},down:{x:0,y:1},left:{x:-1,y:0},right:{x:1,y:0}}[m.value];
      if(d.x!==-p.dir.x || d.y!==-p.dir.y)p.nextDir=d;
    }
  });
  ws.on('close',()=>{players.delete(id);for(let i=0;i<grid.length;i++)if(grid[i]===id)grid[i]=-1;});
});
setInterval(()=>{
  for(const p of players.values()){
    if(!p.alive)continue;
    if(p.nextDir.x!==-p.dir.x || p.nextDir.y!==-p.dir.y)p.dir=p.nextDir;
    p.x+=p.dir.x*SPEED;p.y+=p.dir.y*SPEED;
    const x=Math.floor(p.x),y=Math.floor(p.y);
    if(!inside(x,y)){kill(p);continue;}
    const k=idx(x,y);
    let hit=false;
    for(const q of players.values())if(q.alive && q.trailSet.has(k)){kill(q);if(q.id===p.id)hit=true;}
    if(hit || !p.alive)continue;
    if(grid[k]===p.id){if(p.trail.length)capture(p);}
    else if(!p.trailSet.has(k)){p.trail.push(k);p.trailSet.add(k);}
  }
  const scores=new Map();for(const owner of grid)if(owner!==-1)scores.set(owner,(scores.get(owner)||0)+1);
  broadcast({type:'state',grid:Array.from(grid),players:[...players.values()].map(p=>({id:p.id,name:p.name,color:p.color,x:p.x,y:p.y,alive:p.alive,trail:p.trail,score:scores.get(p.id)||0}))});
},TICK);
server.listen(PORT,'0.0.0.0',()=>console.log('Paper Arena on '+PORT));
