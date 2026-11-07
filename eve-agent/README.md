# Devon AI — Eve Agent service

This folder is a separate Eve deployment used by the **Eve Agent** choice in Devon AI's model/provider picker. Eve is an agent framework, not a hosted model or a shared API at `eve.dev`. Each deployment exposes its own `/eve/v1` API.

## Why this is a separate service

The Devon app already has two chat handlers (EdgeOne and Next.js). This integration calls Eve through its documented HTTP session API and converts Eve's NDJSON stream into Devon's existing SSE format. It deliberately does **not** add `withEve()` to Devon's `next.config.mjs`; this avoids coupling Devon's `next start` startup to Eve's managed Next.js handler.

## Deploy

Requirements: Node.js 24 or newer, npm, and an Eve-compatible deployment (the Eve CLI's Vercel deployment flow is supported).

1. Copy `.env.example` to `.env.local` and set `DEVON_EVE_JWT_SECRET` to a strong random secret of at least 32 characters. Use exactly the same value in Devon's `DEVON_EVE_JWT_SECRET` environment variable. Do not commit it.
2. Set `ANTHROPIC_API_KEY` and optionally choose a native Anthropic model ID with `DEVON_EVE_MODEL`. The default is `claude-sonnet-5`; the project uses Eve’s direct Anthropic provider, so this setting is a native Anthropic model ID (without the `anthropic/` gateway prefix).
3. Install and run locally:

   ```bash
   npm install
   npm run dev
   ```

4. Deploy this folder as its own Eve/Vercel project using the Eve CLI:

   ```bash
   npx eve@0.84.0 deploy
   ```

5. Copy the deployed service's origin (for example, `https://your-eve-project.vercel.app`) into Devon's `DEVON_EVE_BASE_URL`. Use the origin only—do not append `/eve/v1`.
6. Add `DEVON_EVE_BASE_URL` and the matching `DEVON_EVE_JWT_SECRET` to the Devon app's EdgeOne and/or Vercel environment, then redeploy Devon.

The Eve channel accepts the HS256 service token issued by Devon and local development requests. Production session routes are not public.

## Important differences from Claude in Devon

Eve has its own durable session and its own configured model. Devon persists the Eve session ID and stream cursor in its conversation store (Redis on the Next.js/Vercel backend, EdgeOne's conversation store on EdgeOne) so a later message resumes the same Eve session. On the Next.js backend, Redis is required for this mapping.

The first version is a text-chat provider. It can use tools authored inside this Eve deployment, but it does not inherit Devon's live-tab tools, Claude Agent SDK tools, or E2B sandbox. The picker calls it **Eve Agent** so it is not mistaken for a model named Eve.

The Eve API stream is NDJSON and Devon's chat stream is SSE. `agents/ai-chat/_eve.ts` is the server adapter; it tracks Eve's line cursor, handles renewable stream leases, retries `session_not_ready`, cancels remote turns when a request is stopped, and saves completed replies in Devon's chat history.
