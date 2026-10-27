#!/usr/bin/env bash
# Instalación del CRM de José Altamirano en un VPS con Ubuntu 24.04.
# Uso: curl -fsSL https://raw.githubusercontent.com/ivanjr11/vocero-crm/instalar-jose/deploy/instalar-jose.sh | bash
set -e
DOMINIO=crm.altamiranoinmobiliaria.tech
# Memoria extra (swap) para que la construcción no se quede sin RAM
if ! swapon --show | grep -q /swapfile; then fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
# Docker
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh || (apt-get update && apt-get install -y docker.io docker-compose-v2); fi
# El CRM desde la copia de Ivan
mkdir -p /opt && cd /opt
[ -d vocero ] || git clone https://github.com/ivanjr11/vocero-crm.git vocero
cd vocero && git pull
# Secretos generados aquí mismo (nunca salen del servidor)
if [ ! -f .env ]; then
cat > .env <<EOF
DOMAIN=$DOMINIO
APP_BASE_URL=https://$DOMINIO
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)
META_WEBHOOK_VERIFY_TOKEN=$(openssl rand -hex 32)
META_GRAPH_API_VERSION=v25.0
BOT_API_KEY=$(openssl rand -hex 32)
AGENDA=on
EOF
chmod 600 .env
fi
# CRM y agente construidos desde las copias de Ivan (traen el video y el recordatorio)
cat > docker-compose.override.yml <<'EOF'
services:
  app:
    image: vocero-crm-jose:local
    pull_policy: build
    build: .
  nea:
    image: nea-agent-jose:local
    pull_policy: build
    build: https://github.com/ivanjr11/nea-agent.git#main
EOF
docker compose up -d --build
docker compose ps
