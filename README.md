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
3. **Adgang (Cloudflare Access):** Zero Trust → Access → Applications → Add an application → Self-hosted.
   - Domæne: projektets adresse (fx `campaign-tracker-3nl.pages.dev`) og evt. eget domæne.
   - Policy: *Allow* for de mails, der må se siden (fx Christian og Anne-Katrine).
   - Login foregår med en engangskode på mail.
   - Kopiér **Application Audience (AUD) Tag** fra applikationens oversigt og jeres **team domain** (fx `alzheimer.cloudflareaccess.com`).
4. **Variabler** (Pages-projektet → Settings → Variables and Secrets):
   - `EDITORS` – mails, der må tilføje og fjerne kampagner (fx kun Christians). Alle andre kan kun se listen.
   - `ACCESS_TEAM_DOMAIN` – team domain fra trin 3
   - `ACCESS_AUD` – AUD-tag fra trin 3
   - `NOTIFY_WEBHOOK_URL` – webhooken i Make, der sender mailen (gem som *Secret*)
   - `NOTIFY_EMAIL` – Anne-Katrines mailadresse
   - `DASHBOARD_URL` – fx `https://kampagner.alzheimer.dk`
5. **Eget domæne** (valgfrit): Pages-projektet → Custom domains. Husk at tilføje domænet i Access-applikationen også.
6. Deploy igen (Deployments → Retry deployment) efter trin 2 og 4, så binding og variabler slår igennem.

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
