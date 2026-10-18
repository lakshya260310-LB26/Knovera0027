# Google sign-in update

Live login now uses Continue with Google. Set `GOOGLE_CLIENT_ID` and `ADMIN_EMAIL`; Twilio credentials are neither required nor used. Follow START-HERE.md for Google origins and deployment setup. The public client ID is safe to expose; no client secret is used. The server validates signed Google ID tokens and a short-lived, single-use browser-bound nonce before creating a session. Google subjects identify accounts, not email addresses. Only verified Gmail/Workspace administrator email matches receive administrator access. Legacy phone accounts are retained without automatic linking; migrate existing users with verified ownership before switching a live site.

# Knovera

A Render-targeted peer-learning app with dark/light themes, Google sign-in, teacher/student onboarding, scheduled video, monitored teaching, silver/gold learning credits, real payment integration and teacher UPI redemption. Read **START-HERE.md** for account activation and deployment.

## Run

Node.js 24 and pnpm 11.25.0 are required. Install with `pnpm install --frozen-lockfile --ignore-scripts`, build with `pnpm build`, start with `pnpm start`, and test with `pnpm test`. Copy `.env.example` to `.env` and fill credentials privately for local live-service testing. Secrets are never bundled into frontend assets; the Google client ID is public.

The default is `DEMO_MODE=false`. Production cannot enable demo endpoints and rejects test payment keys when payments/payouts are enabled. Demo databases are permanently marked and cannot be reused for real funds. A new database is required to migrate from the previous preview release.

## Money and attendance

All cash calculations use integer paise. Prices are owned by the server: silver packs are 30/₹45, 90/₹125, 120/₹165; gold packs are 30/₹150, 90/₹430, 120/₹570. Server-created Razorpay orders bind exact prices. Checkout HMAC verification plus provider retrieval, or a signed captured-payment webhook, fulfills an order once. An authorised payment or typed UTR cannot mint live credits.

Teacher earnings are 90 paise per group student-minute, 180 paise per one-to-one minute. Only booked students are included. Signed LiveKit join/leave intervals are intersected with teacher presence and the scheduled time window. Each student's completed minutes are floored after combining reconnects. Open intervals remain unverified. Earnings are unique per booking; uncertainty and refunds hold cash for review. Existing teaching-minute credits remain a separate historical measure, not spendable cash.

Redemption reserves the available amount in an immediate SQLite transaction. A unique partial index permits one active redemption per teacher. The destination is encrypted and frozen for that request. The exact payout request body and idempotency key persist before transmission. A timeout keeps the funds reserved; retries use the same key and payload. Processing is not presented as paid. Confirmed failures/reversals restore availability once. Signed payout webhooks fetch authoritative provider state before applying it. A background worker reconciles open redemptions every 30 seconds.

For ambiguous or persistently rejected provider requests, the reservation intentionally stays held until the original request can be reconciled. Check provider logs, account activation, funding, IP allowlists and the immutable destination. Do not delete payout records, change their keys or issue an outside transfer without reconciling the original; that can pay twice. Processed payouts require reversal webhooks to update a later reversal. Operator monitoring of failed webhook delivery is required.

## Deployment and operational limits

Use one Node instance and the attached persistent disk. This SQLite version is not a horizontally scaled service. Back up the database and stable encryption key together. The app stores session tokens hashed, private profiles encrypted, payout destinations encrypted, and transcript text encrypted. Transcripts expire after seven days; transaction and audit records persist.

AI examines consented teacher microphone audio for coverage and factual issues. It does not inspect every visual detail and cannot guarantee correct teaching. Evidence gaps go to review. High-confidence teaching issues return full student booking credits. Suspected fraud alone does not ban a teacher. Review-centre administrators can release verified held earnings with a recorded reason; unmatched attendance cannot be manufactured by that action.

Provider accounts, production credentials and Render deployment are not included. No live Google sign-in, bank settlement, payout, LiveKit room or OpenAI call was performed during this update. Automated tests use mocked services and temporary databases. Before public launch, the operator must provide actual support/contact information and final terms/privacy/refund policies, and complete the live checks in START-HERE.md. Cash refunds and payment disputes are operator-managed through the payment provider; automatic dispute accounting is not included.

## Source map

- `server/app.mjs`: authentication, access controls, checkout routes, signed webhooks, classrooms and review.
- `server/finance.mjs`: payment verification, attendance calculation, teacher earnings and idempotent payouts.
- `server/store.mjs`: durable profiles, bookings, credit ledger and audit records.
- `server/services.mjs`: Google sign-in, encryption, audio transcription and teaching review.
- `src/app.js`, `public/styles.css`: dashboard, earnings/history, UPI forms, checkout and themes.
- `tests/`: money, provider-route, OTP, booking, access-control and review tests.
- `render.yaml`, `Dockerfile`: deployment configuration.

## Provider references

[Google Identity Services](https://developers.google.com/identity/gsi/web/guides/overview), [Razorpay checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), [payment webhook validation](https://razorpay.com/docs/webhooks/validate-test/), [RazorpayX idempotency](https://razorpay.com/docs/api/x/payout-idempotency/make-request), [VPA fund accounts](https://razorpay.com/docs/api/x/fund-accounts/create/vpa), [Render persistent disks](https://render.com/docs/disks).
