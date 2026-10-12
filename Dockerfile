# Devon on your own server.
#
#   docker build -t devon .
#   docker run -d --name devon -p 3000:3000 --restart unless-stopped devon
#
# Then open http://localhost:3000. For the GitHub Pages address (or any other
# https page) to show it, it needs an https:// address: see "Running Devon on
# your own server" in README.md. YouTube settings (DEVON_* variables) can be
# passed with -e. Devon AI only runs on EdgeOne.

FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.28.0
# The install script (scripts/copy-vendor.mjs) copies browser files into public/vendor
COPY package.json pnpm-lock.yaml ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY . .
RUN DEVON_STANDALONE=1 pnpm build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
