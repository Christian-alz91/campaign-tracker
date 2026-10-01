// Cloudflare Pages Function: /api/campaigns
// Gemmer nye kampagner i Cloudflare KV og sender en mail (via webhook),
// hver gang en kampagne tilføjes.
//
// Kræver i Cloudflare Pages → Settings:
//   KV-binding:   CAMPAIGNS            (KV-namespace til kampagnerne)
//   Variabler:    EDITORS              (kommaseparerede mails, der må tilføje og fjerne kampagner – fx kun Christians)
//                 ACCESS_TEAM_DOMAIN   (Zero Trust-teamdomæne, fx alzheimer.cloudflareaccess.com)
//                 ACCESS_AUD           (Application Audience (AUD) Tag fra Access-applikationen)
//                 NOTIFY_WEBHOOK_URL   (Make/Zapier-webhook, der sender mailen)
//                 NOTIFY_EMAIL         (modtager, fx Anne-Katrines mail – sendes med til webhooken)
//                 DASHBOARD_URL        (fx https://kampagner.alzheimer.dk)
//
// Hvem der er logget ind, afgøres ved at verificere Cloudflare Access' signerede token
// (Cf-Access-Jwt-Assertion). Kan brugeren ikke verificeres, eller står mailen ikke i EDITORS,
// kan vedkommende kun se listen – ikke tilføje eller fjerne kampagner.

const CATS = {
  frivillige: 'Frivillige og koordinatorer',
  deltagere: 'Deltagere og rådgivning',
  leads: 'Leads til fundraising',
  indsamling: 'Landsindsamling',
  arv: 'Arv og testamente',
};
const PLATFORMS = ['Meta', 'Google Ads', 'Google Grants', 'LinkedIn', 'Nyhedsbrev', 'Andet'];
const KEY = 'entries';
const MONTHS = ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.'];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// ---------- Login (Cloudflare Access) ----------
const b64url = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const dec = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
let certCache = { at: 0, team: '', keys: [] };

async function accessKeys(team) {
  if (certCache.team === team && Date.now() - certCache.at < 3600e3) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('certs');
  const j = await r.json();
  certCache = { at: Date.now(), team, keys: j.keys || [] };
  return certCache.keys;
}

// Returnerer den indloggede mail, hvis tokenet er gyldigt og udstedt til netop denne app; ellers null.
async function verifiedEmail(req, env) {
  const team = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = (env.ACCESS_AUD || '').trim();
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!team || !aud || !token) return null;
  try {
    const [h, p, sig] = token.split('.');
    const header = dec(b64url(h)), payload = dec(b64url(p));
    if (header.alg !== 'RS256') return null;
    let jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!jwk) { certCache.at = 0; jwk = (await accessKeys(team)).find((k) => k.kid === header.kid); }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    if (payload.exp && payload.exp < now) return null;
    if (payload.iss && payload.iss !== `https://${team}`) return null;
    return (payload.email || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

async function editor(req, env) {
  const email = await verifiedEmail(req, env);
  const allow = (env.EDITORS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { email, canEdit: !!email && allow.includes(email) };
}

function sameOrigin(req) {
  const o = req.headers.get('origin');
  if (!o) return true;
  try { return new URL(o).host === new URL(req.url).host; } catch { return false; }
}

async function load(env) {
  const raw = await env.CAMPAIGNS.get(KEY);
  return raw ? JSON.parse(raw) : [];
}
const save = (env, list) => env.CAMPAIGNS.put(KEY, JSON.stringify(list));

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

function clean(b) {
  const e = {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) return { error: 'Navnet skal udfyldes (højst 80 tegn).' };
  e.name = name;
  if (!CATS[b.cat]) return { error: 'Vælg et gyldigt formål.' };
  e.cat = b.cat;
  e.platform = PLATFORMS.includes(b.platform) ? b.platform : 'Andet';
  if (!isDate(b.start)) return { error: 'Startdatoen mangler eller er ugyldig.' };
  e.start = b.start;
  e.ongoing = !!b.ongoing;
  if (e.ongoing) e.end = null;
  else {
    if (!isDate(b.end)) return { error: 'Slutdatoen mangler, eller vælg at kampagnen kører løbende.' };
    if (b.end < b.start) return { error: 'Slutdatoen ligger før startdatoen.' };
    e.end = b.end;
  }
  if (b.budget === null || b.budget === undefined || b.budget === '') e.budget = null;
  else {
    const n = Number(b.budget);
    if (!isFinite(n) || n < 0 || n > 10000000) return { error: 'Budgettet er ugyldigt.' };
    e.budget = Math.round(n);
  }
  e.budgetMonthly = e.ongoing || !!b.budgetMonthly; // løbende kampagner har månedsbudget – også efter de er afsluttet
  e.note = typeof b.note === 'string' ? b.note.trim().slice(0, 400) : '';
  const link = typeof b.link === 'string' ? b.link.trim() : '';
  if (link && (!/^https?:\/\//i.test(link) || link.length > 300)) return { error: 'Linket skal starte med https://' };
  e.link = link;
  e.status = 'live'; // alle tilføjede kampagner er sat i gang og udløser en mail
  return { entry: e };
}

function fmtD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${d}. ${MONTHS[m - 1]} ${y}`;
}
const kr = (n) => Math.round(n).toLocaleString('da-DK') + ' kr.';
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function mailContent(e, env, by) {
  const period = e.ongoing ? `Fra ${fmtD(e.start)}, løbende` : `${fmtD(e.start)} – ${fmtD(e.end)}`;
  const budget = e.budget ? (e.budgetMonthly ? `${kr(e.budget)} pr. måned` : kr(e.budget)) : 'Ikke angivet';
  const rows = [
    ['Platform', e.platform],
    ['Formål', CATS[e.cat]],
    ['Periode', period],
    ['Budget', budget],
  ];
  if (e.note) rows.push(['Beskrivelse', e.note]);
  if (e.link) rows.push(['Landingsside', e.link]);
  if (by) rows.push(['Meldt af', by]);
  const url = env.DASHBOARD_URL || '';
  const subject = `Ny kampagne sat i gang: ${e.name}`;
  const text =
    `Kampagnen "${e.name}" er sat i gang.\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    (url ? `\n\nDen vises nu i Campaign Tracker: ${url}` : '');
  const html =
    `<p>Kampagnen <strong>${escHtml(e.name)}</strong> er sat i gang.</p>` +
    `<table cellpadding="4" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="color:#6E3149;padding-right:12px">${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`).join('') +
    `</table>` +
    (url ? `<p><a href="${escHtml(url)}">Se den i Campaign Tracker</a></p>` : '');
  return { subject, text, html };
}

async function notify(e, env, by) {
  if (!env.NOTIFY_WEBHOOK_URL) return { sent: false, error: 'Mailen er ikke sat op endnu (webhook mangler).' };
  const { subject, text, html } = mailContent(e, env, by);
  try {
    const r = await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'campaign_live', to: env.NOTIFY_EMAIL || '', subject, text, html, campaign: e, addedBy: by, dashboardUrl: env.DASHBOARD_URL || '' }),
    });
    if (!r.ok) return { sent: false, error: `Mailtjenesten svarede med fejl ${r.status}.` };
    return { sent: true };
  } catch {
    return { sent: false, error: 'Mailtjenesten kunne ikke nås.' };
  }
}

async function guard(request, env) {
  if (!env.CAMPAIGNS) return { res: json({ error: 'Databasen (KV-bindingen CAMPAIGNS) er ikke sat op.' }, 503) };
  if (!sameOrigin(request)) return { res: json({ error: 'Forespørgslen kom fra et andet domæne.' }, 403) };
  const ed = await editor(request, env);
  if (!ed.canEdit) return { res: json({ error: 'Du har ikke adgang til at tilføje eller fjerne kampagner.' }, 403) };
  return { email: ed.email };
}

export async function onRequestGet({ request, env }) {
  if (!env.CAMPAIGNS) return json({ error: 'Databasen (KV-bindingen CAMPAIGNS) er ikke sat op.' }, 503);
  const ed = await editor(request, env);
  return json({ entries: await load(env), canEdit: ed.canEdit });
}

export async function onRequestPost({ request, env }) {
  const g = await guard(request, env); if (g.res) return g.res;
  let body; try { body = await request.json(); } catch { return json({ error: 'Ugyldige data.' }, 400); }
  const { entry, error } = clean(body);
  if (error) return json({ error }, 400);
  const by = g.email;
  entry.id = crypto.randomUUID();
  entry.createdAt = new Date().toISOString();
  entry.createdBy = by;
  let mail = null;
  if (entry.status === 'live') {
    mail = await notify(entry, env, by);
    if (mail.sent) entry.notifiedAt = new Date().toISOString();
  }
  const list = await load(env);
  list.push(entry);
  await save(env, list);
  return json({ entry, mail });
}

export async function onRequestPatch({ request, env }) {
  const g = await guard(request, env); if (g.res) return g.res;
  const id = new URL(request.url).searchParams.get('id');
  let body; try { body = await request.json(); } catch { return json({ error: 'Ugyldige data.' }, 400); }
  const list = await load(env);
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return json({ error: 'Kampagnen findes ikke længere.' }, 404);
  const { entry, error } = clean({ ...list[i], ...body });
  if (error) return json({ error }, 400);
  const prev = list[i];
  const next = { ...prev, ...entry, id: prev.id, createdAt: prev.createdAt, createdBy: prev.createdBy, updatedAt: new Date().toISOString() };
  let mail = null;
  if (prev.status !== 'live' && next.status === 'live') {
    mail = await notify(next, env, g.email);
    if (mail.sent) next.notifiedAt = new Date().toISOString();
  }
  list[i] = next;
  await save(env, list);
  return json({ entry: next, mail });
}

export async function onRequestDelete({ request, env }) {
  const g = await guard(request, env); if (g.res) return g.res;
  const id = new URL(request.url).searchParams.get('id');
  const list = await load(env);
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return json({ error: 'Kampagnen findes ikke længere.' }, 404);
  await save(env, next);
  return json({ ok: true });
}
