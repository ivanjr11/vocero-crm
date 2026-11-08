# ============================================================
# Vocero CRM — imagen multi-etapa (Next.js standalone + Node 22)
# Los secretos NO se necesitan en build: llegan en runtime.
# ============================================================

FROM node:22.23.4-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22.23.4-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Commit del que sale la imagen, para que la app pueda decir qué está corriendo.
# Tiene que llegar como build arg en CADA despliegue; con docker compose,
# `--build-arg SOURCE_COMMIT=$(git rev-parse HEAD)`. Si falta nunca es un error
# de build: la app enseña solo la versión, o el SOURCE_COMMIT que encuentre en
# el entorno al arrancar, marcado como no verificado.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=$SOURCE_COMMIT
RUN pnpm build
# migrate.mjs autocontenido (drizzle-orm + postgres bundleados)
RUN pnpm exec esbuild scripts/migrate.mjs --bundle --platform=node \
    --format=esm --outfile=migrate.bundle.mjs \
    --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
RUN pnpm exec esbuild scripts/seed/demo.ts --bundle --platform=node \
    --format=esm --outfile=seed-demo.bundle.mjs --alias:@=./src \
    --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"

FROM node:22.23.4-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# 008: adjuntos, logo e icono viven en /data (el volumen de la instancia), no
# en /app, que es de root: el default de la app (./.dev-media) es solo para
# desarrollo local. No se define en la plataforma: basta montar /data.
ENV MEDIA_DIR=/data/media
# su-exec: el entrypoint arranca como root SOLO para dejar /data escribible y
# baja a `vocero` antes de correr la app (idea de #40).
RUN apk add --no-cache su-exec
RUN addgroup -S vocero && adduser -S vocero -G vocero
# El punto de montaje nace de `vocero`: un volumen nombrado nuevo hereda ese
# dueño al montarse vacío. Los que llegan como root (Coolify, Railway, un bind
# mount) los arregla vocero-entrypoint.sh en cada arranque.
RUN mkdir -p /data/media && chown -R vocero:vocero /data

COPY --from=builder --chown=vocero:vocero /app/.next/standalone ./
COPY --from=builder --chown=vocero:vocero /app/.next/static ./.next/static
COPY --from=builder --chown=vocero:vocero /app/public ./public
COPY --from=builder --chown=vocero:vocero /app/migrate.bundle.mjs ./migrate.mjs
COPY --from=builder --chown=vocero:vocero /app/seed-demo.bundle.mjs ./seed-demo.mjs
COPY --from=builder --chown=vocero:vocero /app/drizzle ./drizzle
# Nombre propio a propósito: la imagen de node ya trae su docker-entrypoint.sh
# (antepone `node` si el primer argumento no es un comando) y el nuestro le
# pasa la posta en vez de pisarlo.
COPY vocero-entrypoint.sh /usr/local/bin/vocero-entrypoint.sh
# sed: un checkout de Windows con autocrlf lo deja en CRLF y `sh` no lo corre.
RUN sed -i 's/\r$//' /usr/local/bin/vocero-entrypoint.sh \
    && chmod 755 /usr/local/bin/vocero-entrypoint.sh

# Sin `USER vocero`: el entrypoint baja a `vocero` con su-exec. Arrancado con
# `--user`, también funciona (y avisa si /data no es escribible).
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# start-period amplio: cubre las migraciones del arranque
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["vocero-entrypoint.sh"]
# Migrar al BOOT del contenedor nuevo y arrancar el server standalone
CMD ["sh", "-c", "node migrate.mjs && node server.js"]
