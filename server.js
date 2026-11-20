import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { careerSources, freeSources, score } from './extras.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const env = process.env;
fs.mkdirSync('data', { recursive: true });
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(`data/${f}`, 'utf8')); } catch { return d; } };
const save = (f, v) => fs.writeFileSync(`data/${f}`, JSON.stringify(v));
let jobs = load('jobs.json', []);
let tracker = load('tracker.json', []);
const secrets = load('secrets.json', {});
if (secrets.RAPIDAPI_KEY) env.RAPIDAPI_KEY = secrets.RAPIDAPI_KEY;

let rate = load('rate.json', {});
const srcStatus = load('status.json', {});
const clean = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (source, j) => ({
  id: crypto.createHash('md5').update(String(j.url)).digest('hex').slice(0, 12),
  source, found: Date.now(), ...j, desc: clean(j.desc).slice(0, 400),
});
const get = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: { 'User-Agent': 'job-radar/1.0', ...opt.headers } });
  if (url.includes('rapidapi.com')) {
    const h = {}; r.headers.forEach((v, k) => { if (/ratelimit/i.test(k)) h[k] = v; });
    if (Object.keys(h).length) { rate[new URL(url).host] = { ...h, at: Date.now() }; save('rate.json', rate); }
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// Each source returns [{title, company, location, remote, url, posted, desc}]
let jsLast = load('jsearch-last.json', { t: 0 }).t;
const sources = {
  ...careerSources(cfg),
  ...freeSources(cfg),
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
  async linkedin() { // LinkedIn Job Search API on RapidAPI; basic plan = 25 requests/month
    if (!env.RAPIDAPI_KEY) return [];
    const month = new Date().toISOString().slice(0, 7);
    let st = load('linkedin-quota.json', {});
    if (st.month !== month) st = { month, count: 0, last: 0 };
    if (st.count >= (cfg.linkedinMonthlyMax || 22)) return [];
    if (Date.now() - st.last < (cfg.linkedinHours || 36) * 36e5) return [];
    st.count++; st.last = Date.now(); save('linkedin-quota.json', st); // counted before the call, so failures still use up budget
    const kw = cfg.keywords.slice(0, 8).map(k => k.includes(' ') ? `'${k}'` : k).join(' | ');
    const loc = [].concat(cfg.localLocation).map(l => `"${l}"`).join(' OR ');
    const url = `https://linkedin-job-search-api.p.rapidapi.com/active-jb?time_frame=7d&limit=10&offset=0&description_format=text&title_advanced=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}`;
    const d = await get(url, { headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'linkedin-job-search-api.p.rapidapi.com' } });
    save('linkedin-last.json', d); // raw response, handy for debugging
    const arr = Array.isArray(d) ? d : d.data || d.jobs || [];
    console.log(`[linkedin] ${arr.length} results, ${st.count} requests used this month`);
    const strs = v => [].concat(v || []).filter(x => typeof x === 'string');
    return arr.map(j => ({
      title: j.title, company: j.organization,
      location: strs(j.locations_derived).join('; ') || [...strs(j.cities_derived), ...strs(j.countries_derived)].join(', ') || 'n/a',
      remote: !!j.remote_derived || /remote|telecommute/i.test(`${j.location_type || ''} ${j.ai_work_arrangement || ''}`),
      url: j.url, posted: j.date_posted, desc: j.description_text,
    }));
  },
  async companyjobs() { // Company Jobs API (RapidAPI); basic plan = 100 results/month
    const list = cfg.companyJobs || [];
    if (!env.RAPIDAPI_KEY || !list.length) return [];
    const month = new Date().toISOString().slice(0, 7), per = 10;
    let st = load('companyjobs-quota.json', {});
    if (st.month !== month) st = { month, count: 0, last: {} };
    if (st.count + per > (cfg.companyJobsMonthlyMax || 90)) return [];
    const c = list.find(x => Date.now() - (st.last[x.company + (x.location || '')] || 0) >= (cfg.companyJobsDays || 7) * 864e5);
    if (!c) return [];
    st.last[c.company + (c.location || '')] = Date.now(); save('companyjobs-quota.json', st); // marked before the call so failures can't loop
    const short = c.company.startsWith('http') ? new URL(c.company).hostname.split('.')[0] : c.company;
    const q = new URLSearchParams({ company: c.company, limit: String(per), postedWithinDays: String(cfg.maxAgeDays || 3), keywords: cfg.keywords.join(',') });
    if (c.provider) q.set('provider', c.provider);
    if (c.location) q.set('location', c.location);
    const d = await get(`https://company-jobs-api5.p.rapidapi.com/jobs?${q}`, { headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'company-jobs-api5.p.rapidapi.com' } });
    save('companyjobs-last.json', d);
    const arr = Array.isArray(d) ? d : d.items || d.jobs || d.data || [];
    st.count += Math.max(1, arr.length); save('companyjobs-quota.json', st);
    console.log(`[companyjobs] ${arr.length} results for ${short}, ${st.count} results used this month`);
    const txt = v => typeof v === 'string' ? v : v?.name || v?.city || '';
    return arr.map(j => {
      const urlLoc = decodeURIComponent((j.job_url || '').match(/\/job\/([^/]+)\//)?.[1] || '').replace(/-/g, ' ');
      const loc = [j.city, j.region, j.country].filter(Boolean).join(', ') || urlLoc || j.primary_location || txt(j.location) || [].concat(j.locations || []).map(txt).join('; ') || 'n/a';
      return { title: j.job_title || j.title || j.jobTitle, company: j.company_name || txt(j.company) || j.companyName || short, location: loc,
        remote: j.is_remote === true || j.remote === true || j.isRemote === true || /remote/i.test(`${loc} ${j.workplaceType || ''}`),
        url: j.job_url || j.apply_url || j.applyUrl || j.url || j.jobUrl, posted: j.posted_date || j.postedAt || j.datePosted || j.publishedAt, desc: j.description };
    });
  },
  async jsearch() { // local jobs; needs RAPIDAPI_KEY
    if (!env.RAPIDAPI_KEY) return [];
    if (Date.now() - jsLast < (cfg.jsearchHours || 6) * 36e5) return [];
    jsLast = Date.now(); save('jsearch-last.json', { t: jsLast });
    { const m = new Date().toISOString().slice(0, 7); let q = load('jsearch-quota.json', {}); if (q.month !== m) q = { month: m, count: 0 }; q.count += Math.min(2, cfg.keywords.length) * [].concat(cfg.localLocation).length; save('jsearch-quota.json', q); }
    const out = [];
    for (const [k, place] of cfg.keywords.slice(0, 2).flatMap(k => [].concat(cfg.localLocation).map(p => [k, p]))) {
      const q = encodeURIComponent(`${k} in ${place}`);
      const d = await get(`https://jsearch.p.rapidapi.com/search-v2?query=${q}&date_posted=3days&country=${({ india: 'in', 'saudi arabia': 'sa' })[String(place).toLowerCase()] || ''}`, { headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' } });
      out.push(...(Array.isArray(d.data) ? d.data : d.data?.jobs || d.data?.results || []).map(j => ({ title: j.job_title, company: j.employer_name, location: [j.job_city, j.job_state, ({ IN: 'India', SA: 'Saudi Arabia' })[j.job_country] || j.job_country].filter(Boolean).join(', '), remote: !!j.job_is_remote, url: j.job_apply_link, posted: j.job_posted_at_datetime_utc, desc: j.job_description })));
    }
    return out;
  },
};

const has = (s, list) => list.some(k => s.includes(k.toLowerCase()));
const match = j => {
  if (!j.url || !j.title) return false;
  const t0 = Date.parse(j.posted);
  if (Number.isFinite(t0) && Date.now() - t0 > (cfg.maxAgeDays || 3) * 864e5) return false;
  const title = j.title.toLowerCase(), text = `${title} ${j.desc}`.toLowerCase(), loc = (j.location || '').toLowerCase();
  if (!has(text, cfg.keywords) || has(title, cfg.exclude)) return false;
  if ((j.score ?? 0) < (cfg.minScore || 0)) return false;
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
      const rows = await fn();
      if (rows.length || !['linkedin', 'jsearch', 'companyjobs'].includes(name) || !srcStatus[name]) srcStatus[name] = { ok: true, fetched: rows.length, at: Date.now() };
      for (const raw of rows) {
        const j = norm(name, raw);
        j.score = score({ title: raw.title, desc: clean(raw.desc) }, cfg);
        if (!seen.has(j.id) && match(j)) { seen.add(j.id); fresh.push(j); }
      }
    } catch (e) { console.log(`[${name}] failed: ${e.message}`); srcStatus[name] = { ok: false, error: e.message, at: Date.now() }; }
  }
  console.log(`${new Date().toISOString()} +${fresh.length} jobs`);
  save('status.json', srcStatus);
  if (!fresh.length) return;
  const firstRun = jobs.length === 0; // don't spam alerts on the initial backfill
  jobs = [...fresh, ...jobs].filter(j => Date.now() - (Date.parse(j.posted) || j.found) <= (cfg.maxAgeDays || 3) * 864e5).slice(0, 2000);
  save('jobs.json', jobs);
  fresh.forEach(j => clients.forEach(c => c.write(`data: ${JSON.stringify(j)}\n\n`)));
  if (!firstRun) for (const j of fresh.slice(0, 10)) await alert(j);
}

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.get('/api/jobs', (_, r) => r.json(jobs));
app.get('/api/tracker', (_, r) => r.json(tracker));
const keyHint = () => env.RAPIDAPI_KEY ? '...' + env.RAPIDAPI_KEY.slice(-4) : '';
app.get('/api/settings', (_, r) => r.json({ set: !!env.RAPIDAPI_KEY, hint: keyHint() }));
app.post('/api/settings', (q, r) => {
  const k = String(q.body.rapidapiKey || '').trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(k)) return r.status(400).json({ error: 'That does not look like a RapidAPI key (20 to 100 letters and digits, no spaces).' });
  env.RAPIDAPI_KEY = k;
  fs.writeFileSync('data/secrets.json', JSON.stringify({ RAPIDAPI_KEY: k }), { mode: 0o600 });
  r.json({ set: true, hint: keyHint() });
});
app.post('/api/settings/test', async (_, r) => {
  try {
    const x = await fetch('https://company-jobs-api5.p.rapidapi.com/detect?url=stripe.com', { headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY || '', 'X-RapidAPI-Host': 'company-jobs-api5.p.rapidapi.com' }, signal: AbortSignal.timeout(45000) });
    r.json({ status: x.status });
  } catch (e) { r.json({ status: 0, error: e.message }); }
});
app.get('/api/usage', (_, r) => {
  const m = new Date().toISOString().slice(0, 7), lq = load('linkedin-quota.json', {}), jq = load('jsearch-quota.json', {});
  r.json({
    linkedin: { used: lq.month === m ? lq.count : 0, max: cfg.linkedinMonthlyMax || 22, next: (lq.last || 0) + (cfg.linkedinHours || 36) * 36e5 },
    jsearch: { used: jq.month === m ? jq.count : 0, next: jsLast + (cfg.jsearchHours || 6) * 36e5 },
    companyjobs: (q => ({ used: q.month === m ? q.count : 0, max: cfg.companyJobsMonthlyMax || 90 }))(load('companyjobs-quota.json', {})),
    sources: srcStatus, rate, total: jobs.length, stored: jobs.reduce((a, j) => (a[j.source] = (a[j.source] || 0) + 1, a), {}),
  });
});
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
