# Build from the REPO ROOT (the service imports ../agents, ../lib and ../app/ai-*):
#   docker build -f devon-ai-api/Dockerfile -t devon-ai-api .
FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY . .
# Root dependencies (Claude Agent SDK, Upstash, E2B, ...). Scripts skipped: the
# postinstall only copies browser-side vendor files this service doesn't need.
RUN pnpm install --frozen-lockfile --ignore-scripts
WORKDIR /app/devon-ai-api
RUN pnpm install
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["pnpm", "start"]
