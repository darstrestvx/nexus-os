#!/usr/bin/env bash
set -euo pipefail

NEXUS_VERSION="2.1.0"
NEXUS_USER="nexus"
NEXUS_HOME="/opt/nexus-os"
NEXUS_DATA="/var/lib/nexus"
NEXUS_CONFIG="/etc/nexus-os"
NEXUS_LOG="/var/log/nexus-os"
NEXUS_PORT_HTTP=8080
NEXUS_PORT_HTTPS=8443
NEXUS_PORT_AGENT=8090

RESET='\033[0m'; BOLD='\033[1m'; DIM='\033[2m'
CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'
OK="${GREEN}✓${RESET}"; FAIL="${RED}✗${RESET}"; INFO="${CYAN}→${RESET}"; WARN="${YELLOW}⚠${RESET}"; STEP="${BLUE}◆${RESET}"

INSTALL_LOG="/tmp/nexus-install-$(date +%s).log"
ERRORS=(); WARNINGS=(); STEP_NUM=0; TOTAL_STEPS=10

banner() {
  clear
  echo -e "${CYAN}${BOLD}"
  echo "  ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗     ██████╗ ███████╗"
  echo "  ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝    ██╔═══██╗██╔════╝"
  echo "  ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗    ██║   ██║███████╗"
  echo "  ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║    ██║   ██║╚════██║"
  echo "  ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║    ╚██████╔╝███████║"
  echo "  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝     ╚═════╝ ╚══════╝"
  echo -e "${RESET}"
  echo -e "  ${DIM}Home Server Panel v${NEXUS_VERSION}${RESET}"
  echo ""
}

step() {
  STEP_NUM=$((STEP_NUM+1))
  local filled=$((STEP_NUM*30/TOTAL_STEPS)) bar=""
  for ((i=0;i<filled;i++)); do bar+="█"; done
  for ((i=filled;i<30;i++)); do bar+="░"; done
  echo -e "\n  ${STEP} ${BOLD}${1}${RESET} ${DIM}[${STEP_NUM}/${TOTAL_STEPS}]${RESET}"
  echo -e "  ${CYAN}${bar}${RESET} ${DIM}$((STEP_NUM*100/TOTAL_STEPS))%${RESET}\n"
}

ok()   { echo -e "    ${OK} ${1}"; }
fail() { echo -e "    ${FAIL} ${RED}${1}${RESET}"; ERRORS+=("${1}"); }
warn() { echo -e "    ${WARN} ${YELLOW}${1}${RESET}"; WARNINGS+=("${1}"); }
info() { echo -e "    ${INFO} ${DIM}${1}${RESET}"; }
run()  { eval "$1" >> "${INSTALL_LOG}" 2>&1 || true; }

die() { echo -e "\n  ${RED}${BOLD}Error: ${1}${RESET}\n"; exit 1; }

check_root()    { [[ $EUID -eq 0 ]] && ok "Ejecutando como root" || die "Ejecuta con sudo"; }
check_disk()    { local d=$(df / --output=avail 2>/dev/null|tail -1|awk '{printf "%.0f",$1/1048576}'); [[ "$d" -ge 3 ]] && ok "Disco: ${d}GB libres" || fail "Espacio insuficiente: ${d}GB"; }
check_internet(){ curl -fsS --connect-timeout 5 https://github.com>/dev/null 2>&1 && ok "Internet disponible" || warn "Sin internet — instalación limitada"; }

install_deps() {
  info "Actualizando paquetes..."
  run "apt-get update -qq"
  for pkg in curl wget git jq openssl ca-certificates gnupg ufw fail2ban; do
    dpkg -l "$pkg" &>/dev/null && info "${pkg}: ya instalado" || { run "apt-get install -y -qq ${pkg}"; ok "${pkg} instalado"; }
  done
}

install_docker() {
  command -v docker &>/dev/null && { ok "Docker ya instalado: $(docker --version|grep -oP '\d+\.\d+')"; return; }
  info "Instalando Docker..."
  run "curl -fsSL https://get.docker.com | sh"
  run "systemctl enable --now docker"
  ok "Docker instalado"
}

install_node() {
  command -v node &>/dev/null && { ok "Node.js ya instalado: $(node --version)"; return; }
  info "Instalando Node.js 20..."
  run "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"
  run "apt-get install -y -qq nodejs"
  ok "Node.js instalado: $(node --version)"
}

setup_user() {
  id nexus &>/dev/null && ok "Usuario 'nexus' ya existe" || { run "useradd -r -s /bin/bash -d ${NEXUS_HOME} -m nexus"; ok "Usuario 'nexus' creado"; }
  run "usermod -aG docker nexus"
  ok "Usuario añadido al grupo docker"
}

setup_dirs() {
  for dir in "$NEXUS_HOME" "$NEXUS_HOME/frontend" "$NEXUS_HOME/backend" "$NEXUS_DATA" "$NEXUS_DATA/apps" "$NEXUS_DATA/certs" "$NEXUS_CONFIG" "$NEXUS_LOG"; do
    mkdir -p "$dir" && info "Directorio: $dir"
  done
  chown -R nexus:nexus "$NEXUS_HOME" "$NEXUS_DATA" "$NEXUS_LOG"
  ok "Directorios creados"
}

setup_security() {
  # Secretos
  cat > "${NEXUS_CONFIG}/secrets.env" << EOF
NEXUS_SECRET_KEY=$(openssl rand -hex 64)
NEXUS_JWT_SECRET=$(openssl rand -hex 32)
NEXUS_DB_PASSWORD=$(openssl rand -base64 24|tr -d '=+/')
NEXUS_ADMIN_TOKEN=$(openssl rand -hex 24)
EOF
  chmod 600 "${NEXUS_CONFIG}/secrets.env"
  ok "Secretos generados"

  # TLS
  local cert="${NEXUS_DATA}/certs"
  run "openssl req -x509 -newkey rsa:4096 -keyout ${cert}/nexus.key -out ${cert}/nexus.crt -days 365 -nodes -subj '/CN=nexus-os/O=NexusOS/C=CO' 2>/dev/null"
  chmod 600 "${cert}/nexus.key"
  ok "Certificado TLS generado"

  # Firewall
  run "ufw --force reset && ufw default deny incoming && ufw default allow outgoing"
  run "ufw allow ssh && ufw allow ${NEXUS_PORT_HTTP}/tcp && ufw allow ${NEXUS_PORT_HTTPS}/tcp"
  run "ufw --force enable"
  ok "Firewall UFW configurado"
}

install_backend() {
  # Copiar archivos del repo al servidor
  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [[ -f "${repo_dir}/backend/server.js" ]]; then
    cp -r "${repo_dir}/backend/"* "${NEXUS_HOME}/backend/"
    ok "Backend copiado desde repo local"
  fi

  if [[ -f "${repo_dir}/apps-catalog.json" ]]; then
    cp "${repo_dir}/apps-catalog.json" "${NEXUS_HOME}/"
    ok "Catálogo de apps copiado"
  fi

  # Instalar dependencias Node
  cd "${NEXUS_HOME}/backend"
  if [[ -f package.json ]]; then
    run "npm install --omit=dev"
    ok "Dependencias Node.js instaladas"
  fi
  cd - > /dev/null
}

install_frontend() {
  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for f in index.html store.html; do
    [[ -f "${repo_dir}/${f}" ]] && cp "${repo_dir}/${f}" "${NEXUS_HOME}/frontend/" && ok "Frontend: ${f} copiado"
  done
  chown -R nexus:nexus "${NEXUS_HOME}/frontend"
}

install_nginx() {
  command -v nginx &>/dev/null || run "apt-get install -y -qq nginx"
  cat > /etc/nginx/sites-available/nexus-os << EOF
server {
    listen 80; server_name _;
    return 301 https://\$host:${NEXUS_PORT_HTTPS}\$request_uri;
}
server {
    listen ${NEXUS_PORT_HTTPS} ssl http2; server_name _;
    ssl_certificate     ${NEXUS_DATA}/certs/nexus.crt;
    ssl_certificate_key ${NEXUS_DATA}/certs/nexus.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    root ${NEXUS_HOME}/frontend;
    index index.html;
    location / { try_files \$uri \$uri/ /index.html; }
    location /api/ {
        proxy_pass http://127.0.0.1:${NEXUS_PORT_AGENT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
    location ~ /\. { deny all; }
}
EOF
  run "ln -sf /etc/nginx/sites-available/nexus-os /etc/nginx/sites-enabled/nexus-os"
  run "rm -f /etc/nginx/sites-enabled/default"
  run "nginx -t && systemctl enable --now nginx"
  ok "Nginx configurado"
}

install_service() {
  cat > /etc/systemd/system/nexus-os.service << EOF
[Unit]
Description=NEXUS OS Backend
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=nexus
WorkingDirectory=${NEXUS_HOME}/backend
ExecStart=/usr/bin/node ${NEXUS_HOME}/backend/server.js
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
EnvironmentFile=-${NEXUS_CONFIG}/secrets.env

[Install]
WantedBy=multi-user.target
EOF
  run "systemctl daemon-reload && systemctl enable nexus-os"
  ok "Servicio systemd instalado"
}

install_cli() {
  cat > /usr/local/bin/nexus << 'CLI'
#!/usr/bin/env bash
case "${1:-help}" in
  start)    systemctl start nexus-os && echo "✓ NEXUS OS iniciado" ;;
  stop)     systemctl stop nexus-os && echo "✓ NEXUS OS detenido" ;;
  restart)  systemctl restart nexus-os && echo "✓ Reiniciado" ;;
  status)   systemctl status nexus-os ;;
  logs)     journalctl -u nexus-os -f --since "1 hour ago" ;;
  backup)
    TS=$(date +%Y%m%d_%H%M%S)
    tar -czf "/var/lib/nexus/backups/nexus-backup-${TS}.tar.gz" /etc/nexus-os /var/lib/nexus/nexus.db 2>/dev/null
    echo "✓ Backup: nexus-backup-${TS}.tar.gz" ;;
  update)   bash <(curl -fsSL https://raw.githubusercontent.com/darstrestvx/nexus-os/main/install.sh) ;;
  *)
    echo "NEXUS OS v2.1.0"
    echo "Uso: nexus [start|stop|restart|status|logs|backup|update]" ;;
esac
CLI
  chmod +x /usr/local/bin/nexus
  ok "CLI 'nexus' instalada"
}

main() {
  banner
  [[ "${1:-}" != "-y" ]] && read -rp "  ¿Instalar NEXUS OS? [Y/n] " ans && [[ "${ans:-y}" =~ ^[Nn]$ ]] && exit 0

  step "Verificaciones del sistema";  check_root; check_disk; check_internet
  step "Instalando dependencias";     install_deps
  step "Instalando Docker";           install_docker
  step "Instalando Node.js";          install_node
  step "Configurando usuario";        setup_user; setup_dirs
  step "Configurando seguridad";      setup_security
  step "Instalando backend";          install_backend
  step "Instalando frontend";         install_frontend
  step "Configurando Nginx";          install_nginx
  step "Servicio y CLI";              install_service; install_cli

  local ip; ip=$(ip route get 1.1.1.1 2>/dev/null|awk '{print $7;exit}'||echo "TU_IP")
  echo ""
  echo -e "  ${GREEN}${BOLD}╔══════════════════════════════════════╗${RESET}"
  echo -e "  ${GREEN}${BOLD}║   ✓  NEXUS OS INSTALADO              ║${RESET}"
  echo -e "  ${GREEN}${BOLD}╚══════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  Panel: ${CYAN}https://${ip}:${NEXUS_PORT_HTTPS}${RESET}"
  echo -e "  CLI:   ${DIM}nexus status / nexus logs / nexus restart${RESET}"
  echo ""
}

main "$@"
