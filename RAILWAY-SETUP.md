# Deploy Knovera on Railway

Prepared for the current Node 24 + SQLite app. No Railway deployment has been created yet.

## 1. Sign in and select your app

Open https://railway.com/new and sign in with GitHub. Choose **Deploy from GitHub repo**, then **lakshya260310-LB26/Knovera**, branch **main**. Grant repository access if requested.

The repository root must contain `Dockerfile`, `package.json`, `server/`, `src/`, `public/`, and `scripts/`. Use the latest source: the local `skillswap` folder includes manual UPI checkout, which may be newer than the version uploaded to GitHub. Do not upload `.env`, `data/`, database files, or `node_modules/`.

Railway can build the existing Dockerfile. Keep the root directory blank if these files are at the repository root. There is no need to rewrite the app or add another build configuration file.

## 2. Preserve accounts and balances

Create a **Volume**, attach it to the Knovera service, and set its mount path to `/var/data`. Use a single application instance. The database must live on this volume, not on the container's temporary filesystem.

## 3. Configure the service

In the service Variables tab, set:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DEMO_MODE` | `false` |
| `PORT` | `3000` |
| `DB_PATH` | `/var/data/skillswap.sqlite` |
| `GOOGLE_CLIENT_ID` | `418119824194-trhvcrfhvu20btcbjjqhumn31qjsklnj.apps.googleusercontent.com` |
| `ADMIN_EMAIL` | Your verified Google email used to administer Knovera |
| `DATA_ENCRYPTION_KEY` | A new, private random value of at least 32 characters; keep a secure backup and do not change it after storing profiles |
| `PAYMENTS_ENABLED` | `false` until Razorpay live checkout is configured |
| `PAYOUTS_ENABLED` | `false` until teacher payouts are configured |
| `MANUAL_UPI_ENABLED` | `true` for the existing manually verified UPI checkout |
| `UPI_ID` | `9680877599@ybl` |
| `WELCOME_SLOT_LIMIT` | `100` |

Under service Settings, set the health-check path to `/healthz`. Leave the start command on the Dockerfile default (`node server/index.mjs`).

In Settings → Networking, choose **Generate Domain** and use target port `3000` if asked. Copy the actual HTTPS address and add it as `APP_ORIGIN` in Variables, with no trailing slash or path. Apply the changes and deploy. The app intentionally refuses to start until its origin, Google client ID and encryption key are set.

## 4. Enable Google login on the public address

In your existing Google Cloud OAuth web client, add the exact new HTTPS origin under **Authorized JavaScript origins**. Keep the localhost entries for local testing. This app's popup sign-in does not require a redirect URI.

Open the deployed address and sign in. Create a test profile, restart the service, and confirm the profile and balance remain. This checks that the volume is correctly attached. Do not copy the local demonstration database into production.

## 5. Payments and classroom services

Hosting does not activate payment-provider accounts. With manual UPI enabled, a student pays the QR and submits a reference. The administrator must confirm the received amount and reference in their bank records before approving credits in Review center. This does not provide instant automatic verification or teacher transfers.

For automatic checkout and teacher payouts, complete the separate Razorpay/payment-provider activation in `START-HERE.md`, configure private credentials on Railway, and verify the live integrations before enabling their switches. LiveKit and AI monitoring likewise require their provider setup. No real transfer or classroom integration has been tested by preparing this guide.

## Trial and cost limits

Railway offers a no-card trial with $5 of usage credit for up to 30 days, followed by a Free plan with $1 monthly usage credit. Full trial access depends on account verification; check the plan shown in your account. This is not a promise of free continuous hosting. Trial volume data can be deleted 30 days after credit expiry; plan ongoing hosting and backups before relying on it for paid customer balances. The existing $50 Render balance does not apply to Railway.

Official references: [Trial](https://docs.railway.com/pricing/free-trial), [No-card trial](https://docs.railway.com/pricing/faqs), [Volumes](https://docs.railway.com/volumes), [Quick start](https://docs.railway.com/quick-start).

## Hackathon form

- **Live URL:** the actual public HTTPS address, once it loads and login works.
- **Repo URL:** `https://github.com/lakshya260310-LB26/Knovera` (currently private according to the earlier screenshot; judges need repository access if review is required).

`localhost` is not a public project link. No live URL is available until deployment succeeds.
