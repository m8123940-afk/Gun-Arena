// Rival Arena server: matchmaking, rooms, server-side HP / damage validation, rounds (first to 5).
// Also serves ../client/index.html so one command runs everything.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, WIN = 5, COUNTDOWN = 3000, NEXT_ROUND = 2500;
// Order must match the client's weapon list.
const WD = [
  { dmg: 16, head: 1.8, rate: 95, pel: 1, range: 130 }, { dmg: 11, head: 1.6, rate: 60, pel: 1, range: 70 },
  { dmg: 85, head: 2, rate: 1100, pel: 1, range: 300 }, { dmg: 12, head: 1.5, rate: 850, pel: 8, range: 40 },
  { dmg: 20, head: 1.8, rate: 190, pel: 1, range: 90 }, { dmg: 55, head: 1.7, rate: 600, pel: 1, range: 150 },
  { dmg: 35, head: 1, rate: 450, pel: 1, range: 2.6 },
  { dmg: 9, head: 1.4, rate: 70, pel: 1, range: 90 }, { dmg: 22, head: 1.8, rate: 150, pel: 1, range: 110 }, { dmg: 75, head: 2, rate: 900, pel: 1, range: 200 },
  { dmg: 50, head: 1, rate: 500, pel: 1, range: 3 }, { dmg: 90, head: 1, rate: 1000, pel: 1, range: 999 }, { dmg: 14, head: 1.6, rate: 80, pel: 1, range: 120 }, { dmg: 10, head: 1.5, rate: 600, pel: 12, range: 35 }, { dmg: 40, head: 1.7, rate: 450, pel: 1, range: 110 }, { dmg: 25, head: 1, rate: 250, pel: 1, range: 2.6 }, { dmg: 12, head: 1, rate: 120, pel: 1, range: 2.8 }, // 12-16 new; 7 minigun, 8 burst, 9 bow, 10 katana, 11 grenade
];
// formats: q = players needed. ffa = every player is their own team.
const FM = [{ q: 2 }, { q: 4 }, { q: 10 }, { q: 6, ffa: 1 }], WAIT = 15000;
function spawnMap(pl, ffa) {
  const L = [], R = [], sp = {};
  pl.forEach((p, i) => ((ffa ? i % 2 === 0 : p.team === 0) ? L : R).push(p.id));
  [[L, -34, -Math.PI / 2], [R, 34, Math.PI / 2]].forEach(([a, x, yaw]) => a.forEach((id, i) => { sp[id] = { x, z: (i - (a.length - 1) / 2) * 8, yaw }; }));
  return sp;
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, '..', 'client', 'index.html'), (e, d) => {
      if (e) { res.writeHead(404); return res.end('client not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  } else if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server, maxPayload: 1024 });
const queues = [[], [], [], []];
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const num = (v) => typeof v === 'number' && isFinite(v);

class Room {
  constructor(list, f) {
    this.f = f; this.ffa = !!FM[f].ffa; this.round = 0; this.score = {}; this.over = false; this.ending = false; this.liveAt = 0;
    this.p = list; list.forEach((ws, i) => { ws.room = this; ws.id = i; ws.team = this.ffa ? i : i % 2; ws.gone = false; this.score[ws.team] = 0; });
    this.start();
  }
  start() {
    if (this.over) return;
    this.round++; this.ending = false; this.map = Math.floor(Math.random() * 4); this.liveAt = Date.now() + COUNTDOWN;
    const players = this.p.map((w) => ({ id: w.id, team: w.team, name: w.name })), sp = spawnMap(players, this.ffa);
    this.p.forEach((w) => { w.hp = 100; w.alive = !w.gone; w.last = {}; w.pos = [sp[w.id].x, 0, sp[w.id].z]; });
    this.p.forEach((w) => {
      const best = Math.max(0, ...players.filter((q) => q.team !== w.team).map((q) => this.score[q.team]));
      send(w, { t: 'round', n: this.round, map: this.map, me: w.id, myTeam: w.team, players, sp, score: [this.score[w.team], best], lbl: this.ffa ? 'Лучший' : 'Враги' });
    });
  }
  all(m, except) { this.p.forEach((w) => { if (w !== except && !w.gone) send(w, m); }); }
  hit(pl, m) {
    const now = Date.now(), tg = this.p[m.to | 0];
    if (this.over || this.ending || now < this.liveAt || !tg || tg === pl || !pl.alive || !tg.alive || tg.team === pl.team) return;
    const w = WD[m.w]; if (!w || !num(m.n) || !num(m.h)) return;
    const n = Math.max(1, Math.min(w.pel, m.n | 0)), h = Math.max(0, Math.min(n, m.h | 0));
    if (now - (pl.last[m.w] || 0) < w.rate * 0.6) return;            // fire-rate check
    pl.last[m.w] = now;
    if (Math.hypot(pl.pos[0] - tg.pos[0], pl.pos[2] - tg.pos[2]) > w.range + 6) return; // range sanity check
    const um = m.w === 11 ? 1 : 1 + 0.06 * Math.max(0, Math.min(5, m.u | 0));
    const dmg = um * (m.w === 11 ? Math.min(90, Math.max(0, m.d | 0)) : m.w === 6 && m.b ? 100 : w.dmg * (n - h) + w.dmg * w.head * h);
    tg.hp = Math.max(0, tg.hp - dmg); this.all({ t: 'hp', id: tg.id, hp: tg.hp });
    if (tg.hp <= 0) { tg.alive = false; this.all({ t: 'kill', by: pl.id, to: tg.id }); this.check(); }
  }
  check() {
    if (this.over || this.ending) return;
    const alive = new Set(this.p.filter((w) => w.alive).map((w) => w.team));
    if (alive.size > 1) return;
    this.ending = true;
    const win = [...alive][0];
    if (win !== undefined) { this.score[win]++; if (this.score[win] >= WIN) return this.finish(win, false); }
    setTimeout(() => this.start(), NEXT_ROUND);
  }
  leave(ws) {
    ws.gone = true; ws.alive = false; ws.room = null;
    const teams = new Set(this.p.filter((w) => !w.gone).map((w) => w.team));
    if (teams.size < 2) this.finish([...teams][0], true); else this.check();
  }
  finish(win, left) {
    if (this.over) return; this.over = true;
    this.p.forEach((w) => { if (!w.gone) { send(w, { t: 'end', win: w.team === win, left }); w.room = null; } });
  }
}
function launch(f, list) { list.forEach((w) => { w.qf = undefined; const i = queues[f].indexOf(w); if (i >= 0) queues[f].splice(i, 1); }); new Room(list, f); }
setInterval(() => {                                    // start partially filled lobbies after WAIT ms
  queues.forEach((q, f) => { if (q.length >= 2 && Date.now() - q[0].qt > WAIT) launch(f, q.splice(0, FM[f].q)); });
}, 1000);

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'queue') {
      if (ws.room || ws.qf !== undefined) return;
      const f = Math.abs(m.f | 0) % 4; ws.name = String(m.name || 'Игрок').slice(0, 16); ws.qf = f; ws.qt = Date.now(); queues[f].push(ws);
      if (queues[f].length >= FM[f].q) launch(f, queues[f].splice(0, FM[f].q));
    } else if (ws.room) {
      const r = ws.room;
      if (m.t === 'st' && Array.isArray(m.p) && m.p.length === 3 && m.p.every(num) && num(m.yaw) && num(m.pitch)) {
        ws.pos = m.p; r.all({ t: 'st', id: ws.id, p: m.p, yaw: m.yaw, pitch: m.pitch, w: m.w | 0, s: m.s ? 1 : 0 }, ws);
      } else if (m.t === 'fire') r.all({ t: 'fire', id: ws.id, w: m.w | 0 }, ws);
      else if (m.t === 'nade' && Array.isArray(m.p) && Array.isArray(m.v) && m.p.length === 3 && m.v.length === 3 && m.p.every(num) && m.v.every(num)) r.all({ t: 'nade', id: ws.id, p: m.p, v: m.v, k: Math.abs(m.k | 0) % 4 }, ws);
      else if (m.t === 'hit') r.hit(ws, m);
    }
  });
  ws.on('close', () => {
    if (ws.qf !== undefined) { const q = queues[ws.qf], i = q.indexOf(ws); if (i >= 0) q.splice(i, 1); }
    if (ws.room) ws.room.leave(ws);
  });
});
server.listen(PORT, () => console.log(`Rival Arena: http://localhost:${PORT}  (ws on same port)`));
