# Imagen única: compila React y lo sirve desde la API .NET.
FROM node:20-alpine AS web
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS api
WORKDIR /src
COPY backend/ backend/
COPY --from=web /src/backend/PlanVirtualizacion.Api/wwwroot backend/PlanVirtualizacion.Api/wwwroot
RUN dotnet publish backend/PlanVirtualizacion.Api/PlanVirtualizacion.Api.csproj -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=api /app ./
ENV ASPNETCORE_URLS=http://+:8080
# Los datos se guardan en /app/App_Data: monta un volumen para no perderlos.
VOLUME ["/app/App_Data"]
EXPOSE 8080
ENTRYPOINT ["dotnet", "PlanVirtualizacion.Api.dll"]
