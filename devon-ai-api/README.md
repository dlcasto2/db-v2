# devon-ai-api

Devon AI's standalone backend service. It mounts the existing `app/ai-*/route.ts`
handlers on a small Hono server, so there is one copy of the agent code and
nothing to keep in sync.

| Route | Purpose |
| --- | --- |
| `POST /ai-chat` | SSE chat stream (needs the `makers-conversation-id` header) |
| `POST /ai-stop` | Stop a running chat |
| `POST /ai-history`, `/ai-conversations`, `/ai-delete-conversation` | Chat history |
| `POST /ai-page-result` | Results of page actions run in the browser |
| `POST /ai-session`, `/ai-filesystem` | Session state and virtual document store |
| `POST /ai-feedback` | Thumbs up/down log and admin digest |
| `GET /health` | Which of model key, Redis and sandbox are configured |

`/auth-*` and `/account-sync` are not mounted: they use a same-site session
cookie and stay on the main Devon site.

## Run it

Install the repository's dependencies at the repository root first, then:

```sh
cd devon-ai-api
pnpm install
cp .env.example .env
# Fill in the required model key and any optional Redis or sandbox settings.
pnpm dev
```

`tsx` doesn't load `.env` on its own. Locally use
`node --env-file=.env ./node_modules/.bin/tsx src/server.ts`, or export the
variables.

## Deploy

This service keeps a Node process available for long-running streamed chats and
page-action approvals. Deploy it on a host that supports a persistent Node
service (for example Railway, Fly.io, Render, or a VPS), rather than a
serverless function with a shorter request timeout.

Build from the repository root:

```sh
docker build -f devon-ai-api/Dockerfile -t devon-ai-api .
docker run -p 8787:8787 --env-file devon-ai-api/.env devon-ai-api
```

## Point Devon at it

1. In the Devon site's environment, set `NEXT_PUBLIC_DEVON_AI_API_URL` to the
   service's origin, for example `https://<your-api-host>`, then rebuild the
   site. `NEXT_PUBLIC_` values are baked in at build time.
2. Set `DEVON_API_ALLOWED_ORIGINS` on the service to the Devon site's exact
   origin (comma-separated if you have multiple origins).

When `NEXT_PUBLIC_DEVON_AI_API_URL` is unset, Devon keeps using its same-origin
routes as before. All chat, stop, history, session, page-result, filesystem,
and feedback requests use the configured base URL when it is set.

## Configuration and security

The service uses the same server variables Devon AI already uses:
`ANTHROPIC_API_KEY` or `AI_GATEWAY_API_KEY` plus `AI_GATEWAY_BASE_URL`,
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `E2B_API_KEY`, and
`DEVON_AI_*` limits. Use the same Redis database as the Vercel deployment to
carry over existing chat history.

`DEVON_API_KEY` is optional and only gates callers whose Origin is not allowed.
Origin headers can be forged outside a browser, so the daily limits
(`DEVON_AI_DAILY_LIMIT` and `DEVON_AI_IP_DAILY_LIMIT`) remain the abuse
protection; set them appropriately. Behind a proxy, the per-IP limit reads
`x-forwarded-for`, so ensure the host sets it.

The health endpoint intentionally reveals whether model, Redis, and sandbox
configuration is present, but not secret values.
