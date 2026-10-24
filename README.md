# gulf-leads

Finds companies, checks their websites, scores them, confirms emails, sends a safe sequence, reads replies,
and hands you qualified leads with a tailored proposal. Nothing leaves without the checks in `src/outreach.ts`;
first messages, AI replies and proposals wait for your approval while `outreach.mode` is `review`.

## First time setup

```
npm install
cp .env.example .env                                  # keys: mailbox, Claude, Google Places, ZeroBounce/Hunter, webhook
cp profiles/webdev.example.json profiles/webdev.json   # your name, email, address, offer, search targets
```

`.env` and `profiles/*.json` are git-ignored on purpose: they hold your real email, address and keys, and this repository is public.
Only `profiles/*.example.json` is tracked. Edit your own copy, never the example.
Without `profiles/<name>.json` every command stops and tells you to create it (tests and the demo use the example).

## Run

```
npm test                                            # 50+ tests, no network and no keys needed
node src/demo.ts                                    # fills a separate "demo" profile with made-up companies
npm run leads -- dashboard --profile demo           # web dashboard on localhost:4300 (prints a sign-in link)
npm run leads -- run --country AE --city Dubai --industry clinic   # one real search by hand
npm run leads -- loop                               # send, read replies, daily search, alerts: every 10 minutes
```

## Automation

`loop` runs `cycle()` in `src/cli.ts` every N minutes. All state is in SQLite (`data/<profile>.db`), so you can stop and restart it.

1. retry events that failed to reach the webhook
2. daily search (`schedule.discover` in the profile): find, check sites, score, confirm emails, draft
3. confirm new emails
4. send what is due (window, daily cap, health pause, verification gate, approval)
5. read replies, stop sequences, answer or hand off; qualified leads trigger research and a proposal
6. daily summary event

## n8n

`integrations/n8n/gulf-leads.workflow.json` (also downloadable from the dashboard, "التكاملات") is a ready workflow:
Webhook, then a message, then Telegram. Import it, set the Header Auth credential (`x-gulf-secret` = `WEBHOOK_SECRET`),
set `WEBHOOK_URL` to the production URL, and run `npm run leads -- webhook-test`.

Events: `lead.qualified`, `lead.needs_human`, `proposal.ready`, `reply.pending`, `sending.paused`, `lead.unsubscribed`,
`lead.bounced`, `discovery.done`, `daily.summary`, `test`. Each POST carries `x-gulf-secret` and `x-gulf-signature`
(`sha256=` HMAC of the body). Events contain company and contact details, so point the webhook only at an endpoint you control.

n8n can call back (set `HOOK_TOKEN`, send it as `x-hook-token`):
`POST /api/hooks/discover {country, industry, city?, limit?, provider?}` and `POST /api/hooks/suppress {value}`.
It can never approve or send a message.
