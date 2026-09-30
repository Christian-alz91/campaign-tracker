// Cloudflare Pages Function: /api/campaigns
// Gemmer planlagte og nye kampagner i Cloudflare KV og sender en mail (via webhook),
// når en kampagne markeres som "sat i gang".
//
// Kræver i Cloudflare Pages → Settings:
//   KV-binding:   CAMPAIGNS            (KV-namespace til kampagnerne)
//   Variabler:    NOTIFY_WEBHOOK_URL   (Make/Zapier-webhook, der sender mailen)
//                 NOTIFY_EMAIL         (modtager, fx Anne-Katrines mail – sendes med til webhooken)
//                 DASHBOARD_URL        (fx https://kampagner.alzheimer.dk)
//                 EDITORS              (valgfri: kommaseparerede mails, der må tilføje/ændre; tom = alle med adgang)
// Siden og /api beskyttes af Cloudflare Access, som sætter headeren cf-access-authenticated-user-email.

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

const who = (req) => (req.headers.get('cf-access-authenticated-user-email') || '').toLowerCase() || null;

function canEdit(req, env) {
  const allow = (env.EDITORS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.length) return true;
  return allow.includes(who(req) || '');
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
  e.note = typeof b.note === 'string' ? b.note.trim().slice(0, 400) : '';
  const link = typeof b.link === 'string' ? b.link.trim() : '';
  if (link && (!/^https?:\/\//i.test(link) || link.length > 300)) return { error: 'Linket skal starte med https://' };
  e.link = link;
  e.status = b.status === 'live' ? 'live' : 'planned';
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
  const budget = e.budget ? (e.ongoing ? `${kr(e.budget)} pr. måned` : kr(e.budget)) : 'Ikke angivet';
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

function guard(request, env) {
  if (!env.CAMPAIGNS) return json({ error: 'Databasen (KV-bindingen CAMPAIGNS) er ikke sat op.' }, 503);
  if (!sameOrigin(request)) return json({ error: 'Forespørgslen kom fra et andet domæne.' }, 403);
  if (!canEdit(request, env)) return json({ error: 'Du har ikke adgang til at ændre kampagner.' }, 403);
  return null;
}

export async function onRequestGet({ request, env }) {
  if (!env.CAMPAIGNS) return json({ error: 'Databasen (KV-bindingen CAMPAIGNS) er ikke sat op.' }, 503);
  return json({ entries: await load(env), canEdit: canEdit(request, env) });
}

export async function onRequestPost({ request, env }) {
  const g = guard(request, env); if (g) return g;
  let body; try { body = await request.json(); } catch { return json({ error: 'Ugyldige data.' }, 400); }
  const { entry, error } = clean(body);
  if (error) return json({ error }, 400);
  const by = who(request);
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
  const g = guard(request, env); if (g) return g;
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
    mail = await notify(next, env, who(request));
    if (mail.sent) next.notifiedAt = new Date().toISOString();
  }
  list[i] = next;
  await save(env, list);
  return json({ entry: next, mail });
}

export async function onRequestDelete({ request, env }) {
  const g = guard(request, env); if (g) return g;
  const id = new URL(request.url).searchParams.get('id');
  const list = await load(env);
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return json({ error: 'Kampagnen findes ikke længere.' }, 404);
  await save(env, next);
  return json({ ok: true });
}
