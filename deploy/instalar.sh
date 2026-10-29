#!/usr/bin/env bash
# Instala o actualiza la plataforma en el servidor. Lo ejecuta GitHub Actions:
#   sudo bash deploy/instalar.sh /tmp/.../plan-virtualizacion.tgz
#
#   /var/www/html/plan-virtualizacion   aplicación (solo lectura para el servicio)
#   /var/lib/plan-virtualizacion        datos, usuarios, bitácora y respaldos (fuera de la web)
#   /opt/plan-virtualizacion            versión nueva en preparación y la anterior (para volver atrás)
#
# Es idempotente: se puede correr las veces que haga falta. No toca los otros sitios de
# /var/www/html; en Nginx solo agrega una línea include al server{} que sirve esa carpeta.
set -euo pipefail

APP=plan-virtualizacion
APP_DIR=/var/www/html/$APP
DATA_DIR=/var/lib/$APP
STAGE_DIR=/opt/$APP
SVC_USER=planvirt
PORT=5180
PATH_BASE=/$APP
SNIPPET=/etc/nginx/snippets/$APP.conf
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="${1:?Uso: instalar.sh paquete.tgz}"
TS="$(date -u +%Y%m%d-%H%M%S)"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "debe ejecutarse como root (sudo)"
[ "$(uname -m)" = x86_64 ] || die "arquitectura no soportada: $(uname -m) (el paquete es linux-x64)"
command -v nginx >/dev/null || die "Nginx no está instalado"
command -v curl >/dev/null || die "falta curl"
[ -f "$PKG" ] || die "no existe el paquete $PKG"

# El puerto interno debe estar libre o en uso por este mismo servicio.
if ! systemctl is-active --quiet "$APP" && ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  die "el puerto $PORT ya lo usa otro programa; cambia el puerto en deploy/ antes de desplegar"
fi

log "Usuario del servicio"
id "$SVC_USER" &>/dev/null || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"

log "Carpeta de datos ($DATA_DIR)"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR" "$DATA_DIR/backups"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod -R go-rwx "$DATA_DIR"
if [ -f "$DATA_DIR/plan-data.json" ]; then
  cp -p "$DATA_DIR/plan-data.json" "$DATA_DIR/backups/plan-data-predeploy-$TS.json"
  ls -1t "$DATA_DIR"/backups/plan-data-predeploy-*.json 2>/dev/null | tail -n +21 | xargs -r rm -f
fi

log "Preparando la nueva versión"
install -d -m 755 "$STAGE_DIR"
rm -rf "$STAGE_DIR/new"
mkdir -p "$STAGE_DIR/new"
tar -xzf "$PKG" -C "$STAGE_DIR/new" --no-same-owner
rm -rf "$STAGE_DIR/new/App_Data"
chown -R root:root "$STAGE_DIR/new"
chmod -R u=rwX,go=rX "$STAGE_DIR/new"
chmod 755 "$STAGE_DIR/new/PlanVirtualizacion.Api"

log "Servicio systemd"
install -m 644 "$HERE/plan-virtualizacion.service" "/etc/systemd/system/$APP.service"
systemctl daemon-reload
systemctl enable "$APP" >/dev/null 2>&1

log "Reemplazando la versión publicada"
systemctl stop "$APP" 2>/dev/null || true
rm -rf "$STAGE_DIR/prev"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$STAGE_DIR/prev"
mv "$STAGE_DIR/new" "$APP_DIR"
systemctl start "$APP"

healthy() {
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$PORT$PATH_BASE/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
if ! healthy; then
  echo "La nueva versión no respondió. Últimos registros del servicio:" >&2
  journalctl -u "$APP" -n 30 --no-pager >&2 || true
  if [ -d "$STAGE_DIR/prev" ]; then
    systemctl stop "$APP" || true
    rm -rf "$APP_DIR"
    mv "$STAGE_DIR/prev" "$APP_DIR"
    systemctl start "$APP"
    echo "Se restauró la versión anterior." >&2
  fi
  exit 1
fi
log "La aplicación responde en 127.0.0.1:$PORT$PATH_BASE"

log "Nginx"
install -d -m 755 /etc/nginx/snippets
install -m 644 "$HERE/nginx-plan-virtualizacion.conf" "$SNIPPET"
# Archivos de sitios activos cuyo server{} sirve /var/www/html (se siguen los enlaces de sites-enabled).
mapfile -t CONFS < <(grep -RlE '^[[:space:]]*root[[:space:]]+/var/www/html/?[[:space:]]*;' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | xargs -r -n1 readlink -f | sort -u)
BACKUP_DIR=/var/backups/$APP-nginx/$TS
CHANGED=()
for f in "${CONFS[@]}"; do
  grep -q "snippets/$APP.conf" "$f" && continue
  install -d -m 700 "$BACKUP_DIR"
  cp -p "$f" "$BACKUP_DIR/$(basename "$f")"
  sed -i -E "s#^([[:space:]]*)root[[:space:]]+/var/www/html/?[[:space:]]*;.*#&\n\1include snippets/$APP.conf;#" "$f"
  CHANGED+=("$f")
done
if ! nginx -t 2>/tmp/$APP-nginx-test.log; then
  cat /tmp/$APP-nginx-test.log >&2
  for f in "${CHANGED[@]}"; do cp -p "$BACKUP_DIR/$(basename "$f")" "$f"; done
  die "la configuración de Nginx no es válida; se restauraron los archivos originales"
fi
systemctl reload nginx
if [ ${#CONFS[@]} -eq 0 ]; then
  echo "AVISO: no encontré un server{} de Nginx con 'root /var/www/html;'." >&2
  echo "       Agrega dentro del server{} de tu dominio la línea:  include snippets/$APP.conf;" >&2
  echo "       y luego: sudo nginx -t && sudo systemctl reload nginx" >&2
else
  log "Nginx enlazado en: ${CONFS[*]}${CHANGED:+ (modificados; copia en $BACKUP_DIR)}"
fi

rm -rf "$STAGE_DIR/new"
if [ -f "$DATA_DIR/ADMIN-INICIAL.txt" ]; then
  log "Primer ingreso: usuario 'admin'. La contraseña inicial está en el servidor:"
  log "    sudo cat $DATA_DIR/ADMIN-INICIAL.txt"
fi
log "Despliegue terminado: https://<tu-dominio>$PATH_BASE/"
