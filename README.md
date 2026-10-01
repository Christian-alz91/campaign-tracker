# Campaign Tracker

Alzheimerforeningens overblik over kampagner: tidslinje, forbrug pr. uge, nøgletal pr. initiativ
og en formular til nye kampagner. Når en kampagne tilføjes,
får Anne-Katrine en mail.

## Indhold

| Sti | Hvad |
|---|---|
| `site/index.html` | Selve dashboardet. Meta-tallene ligger indbygget i siden og opdateres dagligt. |
| `functions/api/campaigns.js` | Cloudflare Pages Function: gemmer nye kampagner og sender mail via webhook. |
| `tools/build.py` | Fletter nye Meta-tal (fra Supermetrics) ind i `site/index.html`. |
| `tools/rules.json` | Annoncekonti, formål og regler for, hvilket initiativ en kampagne hører til. |

## Opsætning på Cloudflare (én gang)

1. **Pages-projekt:** Cloudflare → Workers & Pages → Create → Pages → Connect to Git → vælg dette repository.
   - Framework preset: *None*
   - Build command: *(tom)*
   - Build output directory: `site`
2. **Database:** Workers & Pages → KV → opret et namespace, fx `campaign-tracker`.
   I Pages-projektet: Settings → Bindings → Add → KV namespace, navn **`CAMPAIGNS`**.
3. **Variabler** (Settings → Variables and Secrets):
   - `NOTIFY_WEBHOOK_URL` – webhooken i Make eller Zapier, der sender mailen (gem som *Secret*)
   - `NOTIFY_EMAIL` – Anne-Katrines mailadresse
   - `DASHBOARD_URL` – fx `https://kampagner.alzheimer.dk`
   - `EDITORS` *(valgfri)* – kommaseparerede mails, der må tilføje og ændre kampagner. Tom = alle med adgang.
4. **Eget domæne:** Pages-projektet → Custom domains → fx `kampagner.alzheimer.dk`. IT opretter den CNAME-post, Cloudflare viser.
5. **Adgang:** Zero Trust → Access → Applications → Self-hosted → domænet ovenfor.
   Policy: *Allow* for de mails, der skal have adgang (fx Anne-Katrine og Christian eller alle `@alzheimer.dk`).
   Login foregår med en engangskode på mail.
6. Deploy igen efter trin 2–3, så binding og variabler slår igennem.

## Mailen (Make eller Zapier)

Funktionen sender en JSON-besked til `NOTIFY_WEBHOOK_URL`, når en kampagne tilføjes:

```json
{ "event": "campaign_live", "to": "…", "subject": "Ny kampagne sat i gang: …",
  "text": "…", "html": "…", "campaign": { … }, "addedBy": "…", "dashboardUrl": "…" }
```

Scenariet skal kun: modtage webhooken → sende en mail fra Outlook/Microsoft 365 til `to`
med emnet `subject` og indholdet `html` (eller `text`).

## Daglig opdatering

En planlagt opgave i Claude kører hver hverdag morgen:
henter de seneste 14 dages Meta-tal via Supermetrics, kører
`python3 tools/build.py --html site/index.html --rows rows.txt --from FRA --to TIL --asof TIL --rules tools/rules.json --out site/index.html`
og skubber ændringen hertil. Cloudflare udgiver automatisk den nye version.

Nye kampagner placeres efter navnet (fx "Gruppekoordinator", "Demensfællesskaber … Deltagere", "Mørke dage", "LI26").
Kampagner, der ikke passer, vises under "Øvrige", indtil de får en plads i `tools/rules.json`.
