# Orvantra — one container: Next.js web app + Telegram notifier (testnet demo).
FROM node:24-bookworm-slim

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Agent (tsx is needed at runtime: the web app spawns the agent pipeline, and the notifier runs with it)
COPY agent/package.json agent/package-lock.json agent/
RUN cd agent && npm ci --include=dev --no-audit --no-fund
COPY agent/ agent/

# Web
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --include=dev --no-audit --no-fund
COPY web/ web/
COPY contracts/vendor-registry/src/lib.rs contracts/vendor-registry/src/lib.rs
RUN cd web && npm run build

COPY deploy/entrypoint.sh /app/deploy/entrypoint.sh
# Runs as root: Railway volumes are mounted root-owned. Secrets are written to /secrets with mode 600.
RUN chmod +x /app/deploy/entrypoint.sh && mkdir -p /app/agent/data /secrets && chmod 700 /secrets

EXPOSE 3000
CMD ["/app/deploy/entrypoint.sh"]
