# Activate your Knovera website

The app now includes real-service integrations for Google sign-in, student payments, automatic credit delivery, teacher earnings and UPI redemption. No provider accounts are connected yet, so Google sign-in, payments, video calls and payouts are not active. No money has been collected or transferred. The website has not been deployed to Render.

## 1. Create your provider accounts

| Service | What to set up | What it enables |
| --- | --- | --- |
| [Google Auth Platform](https://console.cloud.google.com/auth/clients) | A Web application OAuth client ID | Continue with Google; no SMS charges |
| [Razorpay Payment Gateway](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/) | Merchant activation, settlement bank account, API keys and automatic payment capture | Real student checkout and automatic credits |
| [RazorpayX](https://razorpay.com/docs/api/x/payout-idempotency/) | Separately activated and funded payout account, UPI API access and allowed server IPs | Teacher redemption to their UPI IDs |
| [LiveKit](https://docs.livekit.io/home/) | Cloud project and signed attendance webhook | Video classrooms and verified attendance |
| [OpenAI API](https://platform.openai.com/) | API account with billing | Consented teacher-audio transcription and review |

### Set up Continue with Google

This app uses Google Identity Services directly. Firebase, a client secret, Gmail access, and a paid SMS account are not required.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Open Google Auth Platform. Configure Branding with the app name Knovera and your support/developer email. Select an External audience if users are outside your organization.
3. Create an OAuth client under Clients, choosing **Web application**.
4. Under **Authorized JavaScript origins**, add your exact website origin, such as `https://your-service.onrender.com`, without a path or trailing slash. For local testing, also add `http://localhost:3000`. This popup flow does not need an authorized redirect URI.
5. Copy the client ID ending in `.apps.googleusercontent.com` to `GOOGLE_CLIENT_ID` in Render → Service → Environment. This ID is public; do not enter a client secret.
6. Set `ADMIN_EMAIL` to your own Gmail or Google Workspace email. Only that Google-verified account gets administrator access. `ADMIN_PHONE` is for local demos only.
7. While the Google project is in Testing, add the Google accounts you intend to test with under Audience → Test users. Before public launch, publish the audience configuration and complete any requirements Google displays. Basic sign-in uses only identity/profile/email, not Gmail inbox access.
8. Deploy, open the site, choose **Continue with Google**, and finish the existing teacher/student onboarding. Test sign-out and a second sign-in: the same profile and wallet must return.

Google verifies the account; it does not verify a mobile number. Real SMS endpoints return an unavailable message even if old Twilio credentials remain configured. Remove unused Twilio environment variables after deploying this version. Any Twilio account balance, automatic recharge, rented numbers, or unrelated recurring charges must be managed separately in Twilio.

**Existing accounts:** Google creates accounts using a stable Google account identifier. Old phone-login accounts and balances remain stored but are not automatically linked or transferred. If you already have real users or balances, arrange a verified account migration before switching the public site; never link accounts using a phone number merely typed by a user. Keep your existing disk and encryption key.

Your Render credit pays for eligible hosting. It does not fund teacher payouts or these providers. Your personal UPI ID `9680877599@ybl` alone cannot confirm purchases automatically. The new checkout settles through your activated merchant account; it does not use an unverified personal QR code.

## 2. Deploy on Render

Upload the contents of the `skillswap` folder to a private GitHub repository. Do not upload `.env`, `data`, or `node_modules`. In Render, create a Blueprint from the repository using `render.yaml`.

Use one web-service instance with the persistent disk. The Blueprint supplies a stable encryption secret. Keep that secret backed up; changing it makes stored private profiles unreadable. Enter `GOOGLE_CLIENT_ID` and `ADMIN_EMAIL` when prompted. Missing production Google client configuration stops startup.

Add the remaining values from `.env.example` in **Render → Service → Environment**. Secret values belong there, never in chat or the browser code. Start with `PAYMENTS_ENABLED=false` and `PAYOUTS_ENABLED=false`.

Configure these webhook destinations using your actual HTTPS website address:

- Razorpay: `/api/payments/webhook` — `payment.captured` and `order.paid`; secret must match `RAZORPAY_WEBHOOK_SECRET`.
- RazorpayX: `/api/payouts/webhook` — payout processing, queued, pending, processed, failed, rejected and reversed events supported by your account; secret must match `RAZORPAYX_WEBHOOK_SECRET`.
- LiveKit: `/api/livekit/webhook` — participant joined and left events, signed with the configured LiveKit key and secret.

For payouts, open Render → your service → Connect → Outbound. Render normally supplies IP ranges, while RazorpayX documents an allowlist of up to 20 individual IP addresses. Do not assume pasting a range will work. Confirm range support with RazorpayX; otherwise use Render dedicated outbound IPs and add those exact addresses under RazorpayX → My Account & Settings → Developer Controls → Share IP Addresses. Review the extra cost before enabling dedicated IPs. See https://render.com/docs/outbound-ip-addresses and https://razorpay.com/docs/x/dashboard/allowlist-ip. Fund the payout account; student collections are not automatically swept into it by this app. The platform also funds the free-credit promotion: a student using welcome credits can still generate real teacher earnings. The platform funds payout fees separately, so the teacher's requested principal is not reduced by an application fee.

Set `PAYMENTS_ENABLED=true` after payment activation and webhook configuration; set `PAYOUTS_ENABLED=true` after payout activation and funding. Production requires live Razorpay keys. A custom domain is configured separately; set `APP_ORIGIN` to its exact HTTPS origin.

## 3. Verify before inviting paying students

Use a separate non-production deployment and database with provider test keys first. Then, after live activation, personally test Google sign-in, a ₹45 student purchase resulting in exactly 30 silver credits, a real scheduled classroom with signed attendance, and a teacher redemption arriving at the chosen UPI ID. Do not assume test-key success proves live account activation.

The automated suite passes using controlled provider responses. Actual Google sign-in, payment settlement, live payouts, video service and AI quality still require your connected accounts and live checks.

## Earnings rules implemented

- Group: **₹0.90 × each student's complete attended minutes** while the teacher is also present.
- One-to-one: **₹1.80 × complete attended minutes** while both are present.
- Five students attending a complete 30-minute group lesson earn the teacher **₹135**. A complete 30-minute one-to-one earns **₹54**.
- Scheduled duration caps earnings. Reconnects are combined; unmatched attendance intervals are not paid automatically.
- Successful teaching review makes verified earnings available. Refunded sessions, uncertain reviews and incomplete attendance hold earnings for administrator review.
- Teachers save their own UPI ID and account-holder name, then confirm redemption from their home page. Minimum redemption is ₹1.
- Pending redemption amounts remain reserved. Confirmed failures and reversals release them; repeated notifications cannot create duplicate payouts.
- A later refund can put already-redeemed earnings on hold, reducing the remaining available balance. It does not silently withdraw money from a teacher's bank account.
- Student session refunds return learning credits, not cash to the original payment method. A student cash-refund/dispute process must be handled by the operator through the provider.

## Local use

With Node.js 24 and pnpm 11.25.0 installed:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm start
```

This opens live-service mode at `http://127.0.0.1:3000`, with unavailable services clearly indicated until configured. To inspect pages without accounts, explicitly run `DEMO_MODE=true DB_PATH=./data/preview.sqlite pnpm start`. Preview data can never be switched into the live money database.

## Direct UPI QR payments

The credit purchase screen can generate an amount-specific QR for `9680877599@ybl`. Set `MANUAL_UPI_ENABLED=true` and configure your verified Google administrator email in `ADMIN_EMAIL`. Students submit the 12-digit UTR after paying. Sign in as the administrator, open Review center, check the exact received amount and UTR in your own bank records, then approve or reject. A submitted reference never adds credits by itself. Razorpay checkout takes priority when enabled. Teacher payouts still require a separate payout setup. Demo mode uses a non-payable QR and simulated credits.
