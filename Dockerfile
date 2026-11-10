# Orvantra — one container: Next.js web app + Telegram notifier (testnet demo).
FROM node:24-bookworm-slim

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# The app runs as this user; the entrypoint starts as root only to prepare the volume and write secrets.
RUN useradd --system --uid 10001 --user-group --create-home --home-dir /home/orvantra --shell /usr/sbin/nologin orvantra

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
# Code stays root-owned (read-only for the app user); only the build cache, the data volume and /secrets are writable.
RUN chmod +x /app/deploy/entrypoint.sh && mkdir -p /app/agent/data /secrets /app/web/.next/cache \
  && chown -R orvantra:orvantra /app/web/.next/cache /app/agent/data /secrets && chmod 700 /secrets

EXPOSE 3000
CMD ["/app/deploy/entrypoint.sh"]
