"""Omsæt svar fra Meta Ads-connectoren (ads_get_ad_entities, level=campaign, time_increment=1)
til de rækker, build.py læser.

Brug:
  python3 tools/meta_rows.py --out rows.json  KONTONAVN=svar1.json  KONTONAVN=svar2.json ...

Hver svarfil indeholder værdien af "ad_entities" (en JSON-liste – eller en streng med JSON-listen)
for én annoncekonto. Kontonavnet skal være præcis som i tools/rules.json → "accounts".
"""
import json, sys, argparse

HEADER = ['Date', 'profile', 'adcampaign_id', 'adcampaign_name', 'campaignobjective',
          'campaign_start_date', 'campaign_end_date', 'cost', 'onsite_conversion.lead_grouped']

def load(path):
    t = open(path, encoding='utf-8').read().strip()
    v = json.loads(t)
    if isinstance(v, dict):
        v = v.get('ad_entities', v)
    if isinstance(v, str):
        v = json.loads(v)
    return v

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('pairs', nargs='+', help='KONTONAVN=fil.json')
    a = ap.parse_args()
    rows, n = [HEADER], 0
    for pair in a.pairs:
        account, path = pair.split('=', 1)
        for e in load(path):
            spent = e.get('amount_spent') or {}
            cost = float(spent.get('value') if isinstance(spent, dict) else spent or 0)
            if cost <= 0:
                continue
            rows.append([e['date_start'], account, str(e['id']), e['name'], e.get('objective') or '',
                         (e.get('start_time') or '')[:10], (e.get('stop_time') or '')[:10],
                         round(cost, 2), int(float(e.get('lead') or 0))])
            n += 1
    json.dump(rows, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'{n} rækker skrevet til {a.out}')

if __name__ == '__main__':
    main()
