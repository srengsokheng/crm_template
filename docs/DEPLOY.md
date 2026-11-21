# Deploying Acme CRM

From an empty server to the CRM on `https://your-domain`, then backups and upgrades. Every step here was run on a
test install (Docker 29, `DOMAIN=localhost`): build, start, HTTPS, sign-up rules, PDFs, backup, restore, restart.
For what the app does and how to
develop it, see `HANDOFF.md`.

## What you need

- A Linux server (Ubuntu 24.04 or similar) with **2 GB RAM** or more and **Docker** with the compose plugin
  (`curl -fsSL https://get.docker.com | sh`).
- A **domain** (e.g. `crm.example.com`) whose DNS `A` record points at the server. Ports **80 and 443** open.
- An **SMTP** account for email (invitations, reminders, quotes and invoices). Without it, emails are only logged.

## First install

```bash
git clone -b main https://github.com/srengsokheng/crm_template.git && cd crm_template
cp .env.production.example .env
nano .env            # DOMAIN, POSTGRES_PASSWORD, SECRETS_KEY, SMTP_* (instructions inside)
docker compose -f docker-compose.prod.yml up -d --build
```

- `app` runs the database migrations on start, then serves the API and the web app and runs background jobs
  (reminders, emails, automation) — one process.
- `caddy` gets the HTTPS certificate for `DOMAIN` by itself (give it a minute on first start).
- Check: `curl https://your-domain/api/v1/health` → `{"ok":true}` (it also checks the database).

**Create your workspace:** open `https://your-domain/signup` and sign up — you become the admin. With the default
`SIGNUP=first`, sign-up then closes: everyone else joins by **Settings → Users & teams → Invite**. (`SIGNUP=open`
lets anyone create a workspace on your server; `closed` turns sign-up off entirely.)

Then, in the app: **Settings → Workspace** (name, currency, time zone) → **Send a test email to me** to check SMTP.

## Backups (do this on day one)

Three things together make a full backup:

| What | Where | How |
|---|---|---|
| Database | `pgdata` volume | `docker compose -f docker-compose.prod.yml exec -T db pg_dump -U crm -Fc crm > crm-$(date +%F).dump` |
| Attachments | `files` volume (unless `FILES_STORAGE=s3`) | `docker run --rm -v crm_template_files:/f -v "$PWD":/b alpine tar czf /b/files-$(date +%F).tgz -C /f .` |
| `SECRETS_KEY` | your `.env` | keep a copy in your password manager — without it, channel tokens can't be read |

Volume names start with the folder name (`crm_template_files` if you cloned into `crm_template`; `docker volume ls`
shows them). Run the first two daily (cron) and copy them off the server. **Restore:**

```bash
docker compose -f docker-compose.prod.yml exec -T db pg_restore -U crm -d crm --clean --if-exists < crm-YYYY-MM-DD.dump
docker run --rm -v crm_template_files:/f -v "$PWD":/b alpine tar xzf /b/files-YYYY-MM-DD.tgz -C /f
```

## Upgrading

```bash
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run on start (they only add; none are edited after release). Back up first. If something goes wrong:
`git checkout <previous tag or commit>` and the same command, then restore the backup if a migration had run.

## Day to day

- Logs: `docker compose -f docker-compose.prod.yml logs -f app`
- Restart: `docker compose -f docker-compose.prod.yml restart app`
- Disk: the database and attachments volumes grow; the recycle bin is purged after 30 days.

## Optional

- **Attachments in S3** (AWS, R2, B2, MinIO): set `FILES_STORAGE=s3` and the `S3_*` variables (see `.env.example`).
- **Virus scanning** of uploads: run ClamAV and set `CLAMAV_HOST`/`CLAMAV_PORT`.
- **Video calls** behind strict firewalls: add a TURN server to `CALL_ICE_SERVERS`.
- **Telegram, Messenger, Instagram, WhatsApp**: connect them in **Settings → Channels** (needs `SECRETS_KEY` and an
  `https` `APP_URL`, which the compose file sets from `DOMAIN`). Meta needs a Meta app with the webhook URL the
  settings page shows.

## Without Docker

Node.js 26 and PostgreSQL 16 on the server:

```bash
npm ci && npm run build
NODE_ENV=production DATABASE_URL=postgres://… APP_URL=https://… SECRETS_KEY=… npm start
```

Run it under systemd (restart on failure) behind nginx or Caddy for HTTPS, and set `TRUST_PROXY=127.0.0.1` so
rate limits see real client addresses. Everything else above applies.

## Security checklist

- [ ] `.env` is only on the server (`chmod 600 .env`), never in git.
- [ ] `SIGNUP` is `first` or `closed` (default `first`).
- [ ] The app's port 3000 is not published; only Caddy (80/443) is.
- [ ] Backups run daily and a restore has been tried once.
- [ ] `SECRETS_KEY` is saved somewhere other than the server.
