# Plan de Virtualización 2026

Plataforma de seguimiento de la virtualización de asignaturas de la Dirección de Innovación Educativa (Corporación Universitaria Americana): programas por nivel y modalidad, vías de producción, estados, tronco común, Escala Latam, programas a distancia, inicio de clases y cronograma (Gantt y calendario).

- **Frontend:** React 18 + Vite (`frontend/`)
- **Backend:** ASP.NET Core 8, API REST + SignalR para cambios en tiempo real (`backend/PlanVirtualizacion.Api/`)
- **Datos:** archivos JSON en la carpeta de datos (`Storage:DataDir`). La primera vez el plan se crea con `Seed/seed.json` (87 programas y sus asignaturas).

## Usuarios y roles

La plataforma exige iniciar sesión. Hay tres roles:

| Rol | Puede |
|---|---|
| `admin` | Todo lo del editor y administrar usuarios (botón **Usuarios**). |
| `editor` | Consultar y modificar el plan. |
| `lector` | Solo consultar. |

**Primer ingreso:** si no existe ningún usuario, la API crea `admin` con una contraseña aleatoria y la guarda en `ADMIN-INICIAL.txt` dentro de la carpeta de datos (en el servidor: `sudo cat /var/lib/plan-virtualizacion/ADMIN-INICIAL.txt`). Al entrar pide cambiarla y el archivo se borra.

Los usuarios nuevos y las contraseñas restablecidas reciben una contraseña temporal (se muestra una sola vez al administrador) que deben cambiar al entrar.

## Seguridad

- Contraseñas con hash PBKDF2-SHA512 (210.000 iteraciones); mínimo 12 caracteres.
- Sesión en cookie `HttpOnly`, `Secure`, `SameSite=Strict`; expira tras 8 h sin uso y como máximo a las 12 h.
- Al cambiar contraseña, rol o desactivar un usuario se cierran sus sesiones y su conexión en tiempo real al instante.
- Protección CSRF con token en todas las peticiones que modifican datos.
- Límite de 10 intentos de login cada 5 minutos por IP y bloqueo de 15 minutos tras 5 fallos por usuario. Límite general de 600 peticiones por minuto.
- Validación estricta en el servidor de cada documento (campos, tipos, longitudes y valores permitidos): no se puede guardar HTML o código.
- Cabeceras de seguridad: CSP, `X-Frame-Options: DENY`, `nosniff`, HSTS, `Referrer-Policy`, `Permissions-Policy`.
- Bitácora de auditoría (`audit.log`): entradas, intentos fallidos y cada cambio de datos o usuarios, con usuario e IP.
- Respaldo automático del plan cada hora (últimos 72) y antes de cada despliegue (últimos 20), en `backups/`.
- En el servidor: servicio aislado con systemd, usuario sin privilegios, solo escucha en `127.0.0.1` y no puede escribir fuera de su carpeta de datos.

## Ejecutar en tu computador

Requisitos: [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) y [Node.js 22](https://nodejs.org/) (o 20.19+).

```bash
# 1. API (http://localhost:5080)
cd backend/PlanVirtualizacion.Api
dotnet run
```

```bash
# 2. Frontend en modo desarrollo (http://localhost:5173)
cd frontend
npm install
npm run dev
```

Abre http://localhost:5173. Vite reenvía `/api` y `/hubs` a la API. La contraseña inicial de `admin` queda en `backend/PlanVirtualizacion.Api/App_Data/ADMIN-INICIAL.txt`.

## Despliegue en el servidor (GitHub Actions)

Cada push a `main` ejecuta [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): compila la interfaz y la API (.NET autocontenida, no hace falta instalar .NET en el servidor), copia el paquete por SSH y ejecuta [`deploy/instalar.sh`](deploy/instalar.sh). También se puede lanzar a mano desde la pestaña **Actions**.

Secretos del repositorio: `SSH_HOST`, `SSH_PORT`, `SSH_USER` (con `sudo` sin contraseña) y `SSH_PRIVATE_KEY`.

En el servidor queda así:

| Ruta | Contenido |
|---|---|
| `/var/www/html/plan-virtualizacion` | Aplicación (solo lectura para el servicio). |
| `/var/lib/plan-virtualizacion` | Datos, usuarios, bitácora, claves y respaldos (permisos 700, fuera de la web). |
| `/etc/systemd/system/plan-virtualizacion.service` | Servicio (`sudo systemctl status plan-virtualizacion`). |
| `/etc/nginx/snippets/plan-virtualizacion.conf` | Proxy de `/plan-virtualizacion/` hacia `127.0.0.1:5180`. |

El script agrega `include snippets/plan-virtualizacion.conf;` al `server{}` de Nginx que sirve `/var/www/html` (guarda copia en `/var/backups/plan-virtualizacion-nginx/` y la restaura si `nginx -t` falla). Si la nueva versión no responde, vuelve sola a la anterior.

La plataforma queda en `https://<dominio>/plan-virtualizacion/`.

Registros: `sudo journalctl -u plan-virtualizacion -f`. Bitácora: `sudo tail -f /var/lib/plan-virtualizacion/audit.log`.

## Respaldos

Para restaurar: `sudo systemctl stop plan-virtualizacion`, copia el respaldo elegido de `/var/lib/plan-virtualizacion/backups/` sobre `plan-data.json` (conservando el dueño `planvirt`) y `sudo systemctl start plan-virtualizacion`.

## Docker

```bash
docker build -t plan-virtualizacion .
docker run -d -p 8080:8080 -v plan-datos:/data plan-virtualizacion
```

Detrás de un proxy con HTTPS (la cookie de sesión exige HTTPS fuera del modo desarrollo).

## Configuración

| Clave | Para qué sirve |
|---|---|
| `Storage:DataDir` | Carpeta de datos. Por defecto `App_Data`. |
| `PathBase` | Subruta pública, p. ej. `/plan-virtualizacion`. Vacío = raíz del dominio. |

Al compilar la interfaz para una subruta: `VITE_BASE=/plan-virtualizacion/ npm run build`.

## API

Todas las rutas exigen sesión salvo `/api/auth/session`, `/api/auth/login` y `/api/health`. Las peticiones que modifican datos requieren la cabecera `X-XSRF-TOKEN`.

| Método | Ruta | Uso | Rol |
|---|---|---|---|
| GET | `/api/auth/session` | Usuario actual y token CSRF | — |
| POST | `/api/auth/login` · `/api/auth/logout` | Iniciar / cerrar sesión | — |
| POST | `/api/auth/password` | Cambiar la propia contraseña | cualquiera |
| GET | `/api/docs/{programs\|pc}` · `/api/docs/{colección}/{id}` | Leer | cualquiera |
| PUT · PATCH | `/api/docs/{colección}/{id}` | Crear/reemplazar · fusión profunda | editor, admin |
| DELETE | `/api/docs/{colección}/{id}` | Borrar | admin |
| GET · POST · PATCH · DELETE | `/api/users[/{id}]` | Administrar usuarios | admin |
| — | `/hubs/changes` | SignalR: evento `changed` en cada modificación | cualquiera |
