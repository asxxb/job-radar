import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const env = process.env;
fs.mkdirSync('data', { recursive: true });
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(`data/${f}`, 'utf8')); } catch { return d; } };
const save = (f, v) => fs.writeFileSync(`data/${f}`, JSON.stringify(v));
let jobs = load('jobs.json', []);
let tracker = load('tracker.json', []);

const clean = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (source, j) => ({
  id: crypto.createHash('md5').update(String(j.url)).digest('hex').slice(0, 12),
  source, found: Date.now(), ...j, desc: clean(j.desc).slice(0, 400),
});
const get = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: { 'User-Agent': 'job-radar/1.0', ...opt.headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// Each source returns [{title, company, location, remote, url, posted, desc}]
const sources = {
  async remotive() {
    const d = await get('https://remotive.com/api/remote-jobs?limit=100');
    return d.jobs.map(j => ({ title: j.title, company: j.company_name, location: j.candidate_required_location, remote: true, url: j.url, posted: j.publication_date, desc: j.description }));
  },
  async remoteok() {
    const d = await get('https://remoteok.com/api');
    return d.slice(1).map(j => ({ title: j.position, company: j.company, location: j.location || 'Worldwide', remote: true, url: j.url, posted: j.date, desc: j.description }));
  },
  async arbeitnow() {
    const d = await get('https://www.arbeitnow.com/api/job-board-api');
    return d.data.map(j => ({ title: j.title, company: j.company_name, location: j.location, remote: j.remote, url: j.url, posted: new Date(j.created_at * 1000).toISOString(), desc: j.description }));
  },
  async jsearch() { // local jobs; needs RAPIDAPI_KEY
    if (!env.RAPIDAPI_KEY) return [];
    const out = [];
    for (const k of cfg.keywords.slice(0, 2)) {
      const q = encodeURIComponent(`${k} in ${cfg.localLocation}`);
      const d = await get(`https://jsearch.p.rapidapi.com/search?query=${q}&date_posted=3days`, { headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' } });
      out.push(...d.data.map(j => ({ title: j.job_title, company: j.employer_name, location: [j.job_city, j.job_country].filter(Boolean).join(', '), remote: !!j.job_is_remote, url: j.job_apply_link, posted: j.job_posted_at_datetime_utc, desc: j.job_description })));
    }
    return out;
  },
};

const has = (s, list) => list.some(k => s.includes(k.toLowerCase()));
const match = j => {
  if (!j.url || !j.title) return false;
  const title = j.title.toLowerCase(), text = `${title} ${j.desc}`.toLowerCase(), loc = (j.location || '').toLowerCase();
  if (!has(text, cfg.keywords) || has(title, cfg.exclude)) return false;
  return (cfg.remote && j.remote) || has(loc, cfg.localMatch);
};

async function alert(j) {
  const text = `New: ${j.title}\n${j.company} (${j.location || 'n/a'})\n${j.url}`;
  const tasks = [];
  if (env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT)
    tasks.push(fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT, text }) }));
  if (env.NTFY_TOPIC)
    tasks.push(fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: 'POST', body: text, headers: { Click: j.url } }));
  await Promise.allSettled(tasks);
}

const clients = new Set();
async function poll() {
  const seen = new Set(jobs.map(j => j.id)), fresh = [];
  for (const [name, fn] of Object.entries(sources)) {
    if (cfg.disabledSources.includes(name)) continue;
    try {
      for (const raw of await fn()) {
        const j = norm(name, raw);
        if (!seen.has(j.id) && match(j)) { seen.add(j.id); fresh.push(j); }
      }
    } catch (e) { console.log(`[${name}] failed: ${e.message}`); }
  }
  console.log(`${new Date().toISOString()} +${fresh.length} jobs`);
  if (!fresh.length) return;
  const firstRun = jobs.length === 0; // don't spam alerts on the initial backfill
  jobs = [...fresh, ...jobs].slice(0, 2000);
  save('jobs.json', jobs);
  fresh.forEach(j => clients.forEach(c => c.write(`data: ${JSON.stringify(j)}\n\n`)));
  if (!firstRun) for (const j of fresh.slice(0, 10)) await alert(j);
}

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.get('/api/jobs', (_, r) => r.json(jobs));
app.get('/api/tracker', (_, r) => r.json(tracker));
app.get('/api/stream', (q, r) => {
  r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  r.flushHeaders(); clients.add(r); q.on('close', () => clients.delete(r));
});
app.post('/api/tracker', (q, r) => {
  const { id, status, notes } = q.body;
  let t = tracker.find(x => x.id === id);
  if (!t) {
    const j = jobs.find(x => x.id === id);
    if (!j) return r.sendStatus(404);
    t = { ...j, status: 'saved' }; tracker.push(t);
  }
  if (status) t.status = status;
  if (notes !== undefined) t.notes = notes;
  t.updated = Date.now();
  save('tracker.json', tracker); r.json(t);
});
app.delete('/api/tracker/:id', (q, r) => {
  tracker = tracker.filter(x => x.id !== q.params.id);
  save('tracker.json', tracker); r.sendStatus(204);
});

poll();
setInterval(poll, cfg.pollMinutes * 60_000);
app.listen(cfg.port, () => console.log(`Job Radar on http://localhost:${cfg.port}`));
