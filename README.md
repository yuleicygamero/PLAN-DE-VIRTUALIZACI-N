# Plan de Virtualización 2026

Plataforma de seguimiento de la virtualización de asignaturas de la Dirección de Innovación Educativa (Corporación Universitaria Americana): programas por nivel y modalidad, vías de producción, estados, tronco común, Escala Latam, programas a distancia, inicio de clases y cronograma (Gantt y calendario).

- **Frontend:** React 18 + Vite (`frontend/`)
- **Backend:** ASP.NET Core 8, API REST + SignalR para cambios en tiempo real (`backend/PlanVirtualizacion.Api/`)
- **Datos:** archivo JSON en el servidor (`App_Data/plan-data.json`). La primera vez se crea con los datos iniciales de `Seed/seed.json` (los 87 programas y sus asignaturas exportados de la versión en Claude).

## Requisitos

- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Node.js 20 o superior](https://nodejs.org/)

## Ejecutar en tu computador

En dos terminales:

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

Abre http://localhost:5173. Vite reenvía `/api` y `/hubs` a la API.

## Publicar en un servidor

La forma más simple es un solo servicio .NET que sirve la app y los datos:

```bash
cd frontend
npm install
npm run build          # deja la app compilada en backend/PlanVirtualizacion.Api/wwwroot

cd ../backend/PlanVirtualizacion.Api
dotnet publish -c Release -o ../../publish
```

Copia la carpeta `publish` al servidor y ejecuta `dotnet PlanVirtualizacion.Api.dll`
(en IIS: crea un sitio que apunte a esa carpeta con el Hosting Bundle de .NET 8 instalado).

Con Docker:

```bash
docker build -t plan-virtualizacion .
docker run -d -p 8080:8080 -v plan-datos:/app/App_Data plan-virtualizacion
```

### Configuración (`appsettings.json`)

| Clave | Para qué sirve |
|---|---|
| `Storage:DataFile` | Ruta del archivo de datos. Por defecto `App_Data/plan-data.json`. |
| `Cors:Origins` | Dominios desde donde se puede llamar la API si el frontend se publica aparte. |

Si publicas el frontend en otro dominio, compílalo con `VITE_API_URL=https://tu-api.dominio npm run build`.

## Respaldos

Todo el plan está en `App_Data/plan-data.json`. Copia ese archivo para hacer un respaldo; para restaurar, detén la API, reemplázalo y vuelve a iniciarla.

## Seguridad

La plataforma no tiene inicio de sesión: cualquiera que abra la dirección puede ver y editar. Si se publica en internet, protégela (por ejemplo con autenticación del servidor/IIS, una VPN o restringiendo IPs).

## API

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/docs/{colección}` | Lista documentos (`programs`, `pc`) |
| GET | `/api/docs/{colección}/{id}` | Lee un documento |
| PUT | `/api/docs/{colección}/{id}` | Crea o reemplaza |
| PATCH | `/api/docs/{colección}/{id}` | Actualiza con fusión profunda |
| DELETE | `/api/docs/{colección}/{id}` | Borra |
| — | `/hubs/changes` | SignalR: evento `changed` en cada modificación |
