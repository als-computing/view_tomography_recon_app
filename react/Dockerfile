# syntax=docker/dockerfile:1

# ---------- base: shared dependency-install layer (today's exact steps) ----------
FROM node:20-alpine AS base
RUN apk add --no-cache git python3 make g++
WORKDIR /app
COPY package*.json ./
COPY patches ./patches
RUN npm ci
COPY . .
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# ---------- dev: exact current behavior, used by docker-compose local dev ----------
FROM base AS dev
EXPOSE 5174
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5174"]

# ---------- docs: static mkdocs build, embedded into prod under ${BASE_PATH}docs/ ----------
# Built here (not as a separate published artifact) so the Docs button (src/config.ts's DOCS_URL)
# can stay a same-origin relative path — no docs FQDN/host is ever baked into the app bundle,
# regardless of which domain actually fronts a given deployment (:local, :als-prod, :als-staging).
FROM python:3.12-slim AS docs
WORKDIR /docs
COPY requirements-docs.txt ./
RUN pip install --no-cache-dir -r requirements-docs.txt
COPY mkdocs.yml ./
COPY docs ./docs
RUN mkdocs build --strict -d /docs-site

# ---------- build: production vite build, base path + optional Tiled-server lock baked in ----------
FROM base AS build
ARG BASE_PATH=/tomo_viewer/
ENV BASE_PATH=${BASE_PATH}
# Empty (default) = the local/staging/production dropdown is shown, exactly like today (:local).
# Set to 'production' or 'staging' to hide the dropdown and lock the app to that one server (:als-prod/
# :als-staging) — see src/tiledServers.ts's FIXED_SERVER_ID. Vite auto-inlines any VITE_-prefixed
# process.env var into import.meta.env at build time, no vite.config.js change needed for this one
# (unlike BASE_PATH, which vite.config.js itself consumes).
ARG FIXED_TILED_SERVER=""
ENV VITE_FIXED_TILED_SERVER=${FIXED_TILED_SERVER}
RUN npm run build

# ---------- prod: minimal static server for the built assets ----------
FROM nginx:alpine AS prod
ARG BASE_PATH=/tomo_viewer/
COPY --from=build /app/dist /usr/share/nginx/html${BASE_PATH}
# Same-origin docs, served alongside the app at ${BASE_PATH}docs/ — matches src/config.ts's DOCS_URL
# default exactly, so the Docs button works out of the box with no per-deployment override needed.
COPY --from=docs /docs-site /usr/share/nginx/html${BASE_PATH}docs/
# Generate the nginx server config at BUILD time (not container start) so the served location can
# never drift from the BASE_PATH the assets were actually built with (no envsubst/runtime templating).
# nginx always listens on 80 internally in all three published images - external port choice is
# handled by normal `docker run -p <port>:80` mapping, not by any container-internal mechanism.
RUN set -eu; \
    printf 'server {\n\
    listen 80;\n\
    add_header X-Content-Type-Options nosniff always;\n\
    gzip on;\n\
    gzip_types text/plain text/css application/javascript application/json application/wasm image/svg+xml;\n\
    gzip_min_length 1024;\n\
    gzip_vary on;\n\
    location %sassets/ {\n\
        alias /usr/share/nginx/html%sassets/;\n\
        add_header Cache-Control "public, max-age=31536000, immutable";\n\
    }\n\
    location %s {\n\
        alias /usr/share/nginx/html%s;\n\
        try_files $uri $uri/ %sindex.html;\n\
    }\n\
}\n' "$BASE_PATH" "$BASE_PATH" "$BASE_PATH" "$BASE_PATH" "$BASE_PATH" > /etc/nginx/conf.d/default.conf
EXPOSE 80
