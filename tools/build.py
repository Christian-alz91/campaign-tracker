#!/usr/bin/env python3
"""Campaign Tracker – opdatering.

Læser den publicerede side (HTML), fletter nye dagstal fra Supermetrics ind i sidens
indlejrede data og skriver en ny HTML-fil, der kan publiceres på samme link.

Brug:
  python3 build.py --html nuv.html --rows rows.txt --from 2026-09-24 --to 2026-10-07 \
                   --asof 2026-10-07 --rules rules.json --out ny.html

rows.txt = rækkerne fra Supermetrics data_query (FA) med felterne, i denne rækkefølge:
  Date,profile,adcampaign_id,adcampaign_name,campaignobjective,campaign_start_date,campaign_end_date,cost,onsite_conversion.lead_grouped
Både det komprimerede format ('  - [9,]: 2026-10-01,ALZ - ...') og ren CSV accepteres.
--from/--to er forespørgslens datointerval: alle dage i intervallet erstattes af de nye tal.
Uden --rows genbygges siden blot ud fra de data, den allerede har (fx ny --asof).
"""
import argparse, csv, datetime as dt, io, json, re, sys

DATA_RE = re.compile(r'(<script type="application/json" id="data">)(.*?)(</script>)', re.S)
ROW_PREFIX = re.compile(r'^\s*-\s*\[\d+,?\]:\s*')

def d(s): return dt.date.fromisoformat(s)

def parse_rows(text):
    rows = []
    t = text.strip()
    if t.startswith('[['):  # ukomprimeret JSON-svar fra Supermetrics: [[header...], [række], ...]
        buf = io.StringIO()
        w = csv.writer(buf)
        for r in json.loads(t):
            w.writerow(['' if v is None else v for v in r])
        text = buf.getvalue()
    for line in text.splitlines():
        line = ROW_PREFIX.sub('', line.strip()) if ROW_PREFIX.match(line) else line.strip()
        if not line or line.startswith('Date,') or line.startswith('[') or line.startswith('data:'):
            continue
        rec = next(csv.reader(io.StringIO(line)))
        if len(rec) < 9 or not re.match(r'\d{4}-\d{2}-\d{2}$', rec[0]):
            continue
        date, account, cid, name, obj, start, end, cost, leads = [x.strip() for x in rec[:9]]
        cost = float(cost or 0)
        leads = int(float(leads)) if leads not in ('', 'null', 'None') else 0
        rows.append(dict(date=date, account=account, id=cid.strip('"'), name=name, objective=obj,
                         start=start or None, end=end.strip('"') or None, cost=cost, leads=leads))
    return rows

def assign(camp, rules, inits):
    cid, name, acc = camp['id'], camp['name'].lower(), camp['account']
    if cid in rules['byCampaignId']:
        return rules['byCampaignId'][cid], False
    for r in rules['rules']:
        if 'account' in r and r['account'] != acc: continue
        if 'nameAny' in r and not any(k in name for k in r['nameAny']): continue
        if 'nameAll' in r and not all(k in name for k in r['nameAll']): continue
        if 'nameAlso' in r and not any(k in name for k in r['nameAlso']): continue
        if 'yearInitiative' in r:
            y = r['yearInitiative']; year = (camp.get('start') or camp['first'])[:4]
            iid = y['idPrefix'] + year[2:]
            if iid not in inits: inits[iid] = dict(id=iid, name=y['namePrefix'] + year, cat=y['cat'])
            return iid, False
        return r['initiative'], False
    # Ikke placeret: eget initiativ under "Øvrige"
    iid = 'ny-' + cid
    clean = re.sub(r'\s*[-–]\s*\d{8}.*$', '', camp['name']).strip() or camp['name']
    inits[iid] = dict(id=iid, name=clean, cat='ovrige')
    return iid, True

def segments(days):
    ds = sorted(d(x) for x in days)
    out, s, e = [], ds[0], ds[0]
    for x in ds[1:]:
        if (x - e).days <= 3: e = x
        else: out.append((s, e)); s = e = x
    out.append((s, e))
    return [[a.isoformat(), b.isoformat()] for a, b in out]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--html', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--rules', required=True); ap.add_argument('--asof', required=True)
    ap.add_argument('--rows'); ap.add_argument('--from', dest='frm'); ap.add_argument('--to')
    ap.add_argument('--only-accounts', help='Kommaseparerede kontonavne. Kun disse kontis dage ryddes i intervallet (bruges når datakilden ikke dækker alle konti).')
    a = ap.parse_args()
    html = open(a.html, encoding='utf-8').read()
    m = DATA_RE.search(html)
    if not m: sys.exit('Fandt ikke <script id="data"> i HTML-filen.')
    data = json.loads(m.group(2).replace('<\\/', '</'))
    rules = json.load(open(a.rules, encoding='utf-8'))
    raw = data.get('raw')
    if not raw: sys.exit('Siden mangler rådata (data.raw). Kør seed først.')
    camps, daily = raw['campaigns'], raw['daily']
    known_before = set(camps)

    if a.rows:
        if not (a.frm and a.to): sys.exit('--from og --to er påkrævet sammen med --rows.')
        rows = parse_rows(open(a.rows, encoding='utf-8').read())
        # ryd hele intervallet, så dage uden forbrug også opdateres
        only = {x.strip() for x in a.only_accounts.split(',')} if a.only_accounts else None
        for cid in daily:
            if only is not None and camps.get(cid, {}).get('account') not in only: continue
            for day in [k for k in daily[cid] if a.frm <= k <= a.to]:
                del daily[cid][day]
        for r in rows:
            if not (a.frm <= r['date'] <= a.to): continue
            c = camps.setdefault(r['id'], {})
            c.update(account=r['account'], name=r['name'], objective=r['objective'],
                     start=r['start'] or c.get('start'), end=r['end'])
            dd = daily.setdefault(r['id'], {})
            prev = dd.get(r['date'], [0, 0])
            dd[r['date']] = [round(prev[0] + r['cost'], 2), prev[1] + r['leads']]
        print(f'Indlæst {len(rows)} rækker for {a.frm} – {a.to}.')

    asof = a.asof
    inits = {i['id']: dict(i) for i in rules['initiatives']}
    groups, unplaced, new_camps = {}, [], []
    for cid, c in camps.items():
        dd = {k: v for k, v in daily.get(cid, {}).items() if v[0] > 0}
        if not dd: continue
        c['first'] = min(dd)
        iid, is_new = assign(dict(c, id=cid), rules, inits)
        if is_new: unplaced.append(c['name'])
        if cid not in known_before: new_camps.append((c['name'], inits[iid]['name']))
        groups.setdefault(iid, []).append((cid, c, dd))

    prev_day = (d(asof) - dt.timedelta(days=1)).isoformat()
    first_all = min(min(dd) for g in groups.values() for _, _, dd in g)
    # vindue: mandag ca. 13 uger før asof (dog ikke før første data), 27 uger frem
    w0 = max(d(first_all), d(asof) - dt.timedelta(weeks=13))
    w0 = w0 - dt.timedelta(days=w0.weekday())
    w1 = w0 + dt.timedelta(weeks=27)

    out = []
    for iid, members in groups.items():
        meta = inits[iid]; alld = {}; campaigns = []
        for cid, c, dd in members:
            for day, (cost, _) in dd.items(): alld[day] = alld.get(day, 0) + cost
            ended = bool(c.get('end')) and c['end'] < asof   # planlagt slutdato er passeret
            running = (asof in dd or prev_day in dd) and not ended
            leads = sum(v[1] for v in dd.values())
            campaigns.append(dict(name=c['name'].strip(), account=rules['accountShort'].get(c['account'], c['account']),
                objective=c.get('objective'), scheduledStart=c.get('start'), scheduledEnd=c.get('end'),
                first=min(dd), last=max(dd), cost=round(sum(v[0] for v in dd.values()), 2),
                leads=leads if c.get('objective') == 'OUTCOME_LEADS' else None, running=running))
        lead_obj = any(k['objective'] == 'OUTCOME_LEADS' for k in campaigns)
        run = [k for k in campaigns if k['running']]
        starts = [k['scheduledStart'] or k['first'] for k in campaigns]
        out.append(dict(id=iid, name=meta['name'], cat=meta['cat'], running=bool(run),
            endsToday=bool(run) and all(k['scheduledEnd'] == asof for k in run),
            segments=segments(alld), startedBeforeWindow=min(starts + list(alld)) < w0.isoformat(),
            cost=round(sum(k['cost'] for k in campaigns), 2),
            leads=sum(k['leads'] or 0 for k in campaigns) if lead_obj else None,
            accounts=sorted({k['account'] for k in campaigns}),
            daily={k: round(v, 2) for k, v in sorted(alld.items())},
            campaigns=sorted(campaigns, key=lambda k: k['first'])))
    order = [i['id'] for i in rules['initiatives']]
    out.sort(key=lambda i: (order.index(i['id']) if i['id'] in order else 999, i['segments'][0][0]))
    cats = [c for c in rules['categories'] if c['id'] != 'ovrige' or any(i['cat'] == 'ovrige' for i in out)]

    data.update(asOf=asof, categories=cats, initiatives=out,
                window=dict(start=w0.isoformat(), end=w1.isoformat()),
                raw=dict(campaigns=camps, daily=daily, dataFrom=raw.get('dataFrom')))
    s = json.dumps(data, ensure_ascii=False).replace('</', '<\\/')
    html = html[:m.start(2)] + s + html[m.end(2):]
    open(a.out, 'w', encoding='utf-8').write(html)

    tot = sum(i['cost'] for i in out)
    print(f'Tal pr. {asof}: {len(out)} initiativer, {sum(len(i["campaigns"]) for i in out)} kampagner, forbrug i alt {tot:,.0f} kr.')
    print('Kører nu:', ', '.join(i['name'] for i in out if i['running']) or 'ingen')
    if new_camps:
        print('Nye kampagner:'); [print(f'  - {n}  →  {g}') for n, g in new_camps]
    if unplaced:
        print('IKKE PLACERET (vises under "Øvrige"):'); [print(f'  - {n}') for n in unplaced]

if __name__ == '__main__':
    main()
