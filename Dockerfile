# syntax=docker/dockerfile:1

# ---------- base: shared dependency-install layer (today's exact steps) ----------
# node:22-alpine over node:20-alpine: verified via `trivy image` - roughly half the HIGH-severity
# vulnerability count (12 vs 23; both carry 1 CRITICAL, from npm's own bundled deps, unaffected by
# this bump). Node 22 is Active LTS, same support tier as 20 - no known compatibility risk for this
# Vite/React app.
FROM node:22-alpine AS base
RUN apk add --no-cache git python3 make g++
WORKDIR /app
COPY package*.json ./
COPY patches ./patches
RUN npm ci
COPY . .
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# ---------- dev: shared dependency layer, used by docker-compose local dev ----------
# No EXPOSE/CMD here on purpose - running the Vite dev server is only appropriate on a development
# machine, not baked into an image that could otherwise be mistaken for something deployable.
# docker-compose.yml's `react` service supplies both (command: + expose:) itself at the compose layer.
FROM base AS dev

# ---------- docs: static mkdocs build, embedded into prod under ${BASE_PATH}docs/ ----------
# Built here (not as a separate published artifact) so the Docs button (src/config.ts's DOCS_URL)
# can stay a same-origin relative path — no docs FQDN/host is ever baked into the app bundle,
# regardless of which domain actually fronts a given deployment (:local, :als-prod, :als-staging).
# python:3.12-alpine over python:3.12-slim (Debian-based): verified via `trivy image` - a large drop
# (7 HIGH/0 CRITICAL vs 53 HIGH/3 CRITICAL). Confirmed requirements-docs.txt installs cleanly here
# (all deps resolve as pure-Python or musllinux wheels, no missing build toolchain needed).
FROM python:3.12-alpine AS docs
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
# Set to a configured Tiled server's hostname (e.g. tiled.als.lbl.gov, tiled-staging.als.lbl.gov —
# matched against config.yml's own tiledServers.*.apiUrl hosts) to hide the dropdown and lock the app
# to that one server (:als-prod/:als-staging) — see src/tiledServers.ts's FIXED_SERVER_ID. A hostname
# that doesn't match any configured server is a build-time error, not a silent fallback. Vite
# auto-inlines any VITE_-prefixed process.env var into import.meta.env at build time, no
# vite.config.js change needed for this one (unlike BASE_PATH, which vite.config.js itself consumes).
ARG FIXED_TILED_SERVER=""
ENV VITE_FIXED_TILED_SERVER=${FIXED_TILED_SERVER}
# Real build-time gate: `vite build` only bundles JS, it never executes the app's module graph, so a
# bad hostname couldn't otherwise fail the build itself (only crash later, in a real browser, once the
# image is deployed and opened) — see the script's own header comment.
RUN node scripts/validate-fixed-tiled-server.mjs
RUN npm run build

# ---------- prod: minimal static server for the built assets ----------
# Tried nginx:1.29-alpine-slim here - one scanner (Trivy) showed fewer vulnerabilities, but two
# others (Grype, Docker's own IDE scanner) showed it as meaningfully WORSE (0 critical -> several
# critical). Reverted to plain nginx:alpine, which scored best or tied-best across all three tools -
# not worth a regression on 2/3 scanners for an improvement only 1/3 agreed with.
FROM nginx:alpine AS prod
ARG BASE_PATH=/tomo_viewer/
COPY --from=build /app/dist /usr/share/nginx/html${BASE_PATH}
# Same-origin docs, served alongside the app at ${BASE_PATH}docs/ — matches src/config.ts's DOCS_URL
# default exactly, so the Docs button works out of the box with no per-deployment override needed.
COPY --from=docs /docs-site /usr/share/nginx/html${BASE_PATH}docs/
# Generate the nginx server config at BUILD time (not container start, and NOT via nginx:alpine's own
# /etc/nginx/templates/ auto-substitution feature, which runs at container start) so the served
# location can never drift from the BASE_PATH the assets were actually built with. Substituting only
# the explicit '${BASE_PATH}' name (not envsubst's default "replace every $VAR") leaves nginx's own
# $uri variable in the template untouched. nginx always listens on 80 internally in all three
# published images - external port choice is handled by normal `docker run -p <port>:80` mapping, not
# by any container-internal mechanism.
COPY nginx.prod.conf.template /tmp/default.conf.template
RUN envsubst '${BASE_PATH}' < /tmp/default.conf.template > /etc/nginx/conf.d/default.conf \
    && rm /tmp/default.conf.template
EXPOSE 80
