# antigravity-worker

Cloudflare Worker adapter for an authorized Google Code Assist / Antigravity-compatible upstream.

## Architecture

Client -> Worker -> SQLite Durable Object account pool -> Google OAuth access token -> Code Assist upstream.

The Worker does not create quota or bypass Google entitlement. Each account uses its own authorized Google credentials and service quota.

## Endpoints

- GET /health
- GET /oauth/google/start (admin)
- GET /oauth/google/callback
- GET /admin/accounts (admin)
- GET /admin/accounts/:id/quota (admin)
- POST /v1/chat/completions (admin, OpenAI-compatible subset)

## Local setup

1. npm install
2. Copy .dev.vars.example to .dev.vars and fill secrets.
3. Configure the exact OAuth callback URL in the Google OAuth client:
   https://YOUR_WORKER_HOST/oauth/google/callback
   The Worker derives this URI from the incoming request host.
4. npm run dev

Production secrets should be configured with Wrangler secrets, not committed to git.

## Deploy

npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npm run deploy

## Example

curl https://YOUR_WORKER/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_ADMIN_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hello"}],"stream":true}'

## Current scope

Phase 1 implements account persistence, OAuth PKCE, encrypted tokens, token refresh, quota lookup, account health/cooldown and OpenAI text chat streaming.

Multimodal input, tool/function calling, provider-specific reasoning parts, usage accounting and full Antigravity Tools feature parity are intentionally left for the next phase and should be implemented only after validating the actual upstream wire format.

## Important

Google's Antigravity/Code Assist endpoints and client behavior are service-controlled and can change. Keep the upstream URL and client metadata configurable and verify usage against the current Google terms before production deployment.