const get = async url => {
  const r = await fetch(url, { headers: { 'User-Agent': 'job-radar/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const isRemote = s => /remote/i.test(s || '');
const unescapeHtml = s => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Company career pages that use Greenhouse or Lever (free public JSON)
export function careerSources(cfg) {
  const { greenhouse = [], lever = [] } = cfg.companies || {};
  const out = {};
  if (greenhouse.length) out.greenhouse = async () => {
    const all = [];
    for (const co of greenhouse) {
      try {
        const d = await get(`https://boards-api.greenhouse.io/v1/boards/${co}/jobs?content=true`);
        all.push(...d.jobs.map(j => ({ title: j.title, company: co, location: j.location?.name, remote: isRemote(j.location?.name), url: j.absolute_url, posted: j.updated_at, desc: unescapeHtml(j.content) })));
      } catch (e) { console.log(`[greenhouse:${co}] ${e.message}`); }
    }
    return all;
  };
  if (lever.length) out.lever = async () => {
    const all = [];
    for (const co of lever) {
      try {
        const d = await get(`https://api.lever.co/v0/postings/${co}?mode=json`);
        all.push(...d.map(j => ({ title: j.text, company: co, location: j.categories?.location, remote: j.workplaceType === 'remote' || isRemote(j.categories?.location), url: j.hostedUrl, posted: new Date(j.createdAt).toISOString(), desc: j.descriptionPlain })));
      } catch (e) { console.log(`[lever:${co}] ${e.message}`); }
    }
    return all;
  };
  return out;
}

// Skill-weighted score: a hit in the title counts double
export function score(j, cfg) {
  const title = (j.title || '').toLowerCase(), text = `${title} ${j.desc || ''}`.toLowerCase();
  let s = 0;
  for (const [k, w] of Object.entries(cfg.skills || {})) {
    const key = k.toLowerCase();
    if (title.includes(key)) s += w * 2; else if (text.includes(key)) s += w;
  }
  return s;
}

// ---- Free no-key APIs: Jobicy, RemoteJobs.org, Himalayas ----
const ent = s => (s || '').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const toIso = p => !p ? new Date().toISOString() : typeof p === 'number' ? new Date(p * (p < 1e12 ? 1000 : 1)).toISOString() : p;
const tryGet = async (url) => { try { return await get(url); } catch (e) { console.log(`[free] ${url.split('?')[0]} ${e.message}`); return {}; } };

export function freeSources(cfg) {
  const kws = (cfg.keywords || []).slice(0, 3);
  return {
    async jobicy() {
      const d = await get('https://jobicy.com/api/v2/remote-jobs?count=100');
      return (d.jobs || []).map(j => ({ title: ent(j.jobTitle), company: ent(j.companyName), location: [].concat(j.jobGeo || 'Anywhere').join(', '), remote: true, url: j.url, posted: j.pubDate, desc: ent(j.jobDescription || j.jobExcerpt) }));
    },
    async remotejobs() {
      const out = [];
      for (const q of kws) {
        const d = await tryGet(`https://remotejobs.org/api/v1/jobs?q=${encodeURIComponent(q)}&limit=50&sort=recent`);
        out.push(...(d.data || []).map(j => ({ title: j.title, company: j.company?.name, location: j.location || 'Remote', remote: true, url: j.url, posted: j.posted_at, desc: j.description })));
      }
      return out;
    },
    async himalayas() {
      const out = [];
      for (const q of kws) {
        const e = encodeURIComponent(q);
        const d = await tryGet(`https://himalayas.app/jobs/api/search?q=${e}&keyword=${e}&sort=recent`);
        out.push(...(d.jobs || []).map(j => ({ title: j.title, company: j.companyName, location: (j.locationRestrictions || []).join(', ') || 'Worldwide', remote: true, url: j.applicationLink || j.guid, posted: toIso(j.pubDate), desc: j.description || j.excerpt })));
      }
      return out;
    },
  };
}
