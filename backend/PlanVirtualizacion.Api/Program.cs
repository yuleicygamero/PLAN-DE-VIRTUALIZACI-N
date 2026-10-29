using System.Security.Claims;
using System.Text.Json.Nodes;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using PlanVirtualizacion.Api.Auth;
using PlanVirtualizacion.Api.Data;
using PlanVirtualizacion.Api.Hubs;
using PlanVirtualizacion.Api.Security;

var builder = WebApplication.CreateBuilder(args);
var isDev = builder.Environment.IsDevelopment();

builder.WebHost.ConfigureKestrel(k =>
{
    k.AddServerHeader = false;
    k.Limits.MaxRequestBodySize = 2 * 1024 * 1024;
});

// Carpeta de datos (configurable en appsettings.json → Storage:DataDir). En el servidor va fuera de la carpeta web.
var dataDir = builder.Configuration["Storage:DataDir"] ?? "App_Data";
if (!Path.IsPathRooted(dataDir)) dataDir = Path.Combine(builder.Environment.ContentRootPath, dataDir);
Directory.CreateDirectory(dataDir);
var seedFile = Path.Combine(AppContext.BaseDirectory, "Seed", "seed.json");
// Subruta donde se publica la plataforma (por ejemplo /plan-virtualizacion). Vacío = raíz del dominio.
var pathBase = (builder.Configuration["PathBase"] ?? "").TrimEnd('/');

builder.Services.AddSingleton(sp => new DocumentStore(Path.Combine(dataDir, "plan-data.json"), seedFile, sp.GetRequiredService<ILogger<DocumentStore>>()));
builder.Services.AddSingleton(sp => new UserStore(dataDir, sp.GetRequiredService<ILogger<UserStore>>()));
builder.Services.AddSingleton(new AuditLog(dataDir));
builder.Services.AddSingleton<ConnectionRegistry>();
builder.Services.AddSignalR();

// Claves que cifran la cookie de sesión: se guardan en la carpeta de datos para sobrevivir a reinicios.
builder.Services.AddDataProtection()
    .SetApplicationName("PlanVirtualizacion")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataDir, "keys")));

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(o =>
{
    o.Cookie.Name = "pv.sesion";
    o.Cookie.HttpOnly = true;
    o.Cookie.SameSite = SameSiteMode.Strict;
    o.Cookie.SecurePolicy = isDev ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;
    o.ExpireTimeSpan = TimeSpan.FromHours(8);
    o.SlidingExpiration = true;
    o.Events.OnValidatePrincipal = AuthEndpoints.ValidatePrincipal;
    o.Events.OnRedirectToLogin = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return ctx.Response.WriteAsJsonAsync(new { code = "unauthenticated", message = "Inicia sesión." });
    };
    o.Events.OnRedirectToAccessDenied = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        return ctx.Response.WriteAsJsonAsync(new { code = "permission_denied", message = "Tu usuario no tiene permiso para esta acción." });
    };
});

builder.Services.AddAuthorization(o =>
{
    // Todo exige sesión salvo lo marcado con AllowAnonymous (login, estado de sesión, archivos de la app).
    o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build();
    o.AddPolicy("editar", p => p.RequireRole(Roles.Admin, Roles.Editor));
    o.AddPolicy("admin", p => p.RequireRole(Roles.Admin));
});

builder.Services.AddAntiforgery(o =>
{
    o.HeaderName = "X-XSRF-TOKEN";
    o.Cookie.Name = "pv.xsrf";
    o.Cookie.HttpOnly = true;
    o.Cookie.SameSite = SameSiteMode.Strict;
    o.Cookie.SecurePolicy = isDev ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;
    o.SuppressXFrameOptionsHeader = true; // ya se envía X-Frame-Options: DENY
});

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.OnRejected = (ctx, ct) => new ValueTask(ctx.HttpContext.Response.WriteAsJsonAsync(
        new { code = "rate_limited", message = "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo." }, ct));
    // Login y cambio de contraseña: 10 intentos cada 5 minutos por dirección IP.
    o.AddPolicy("login", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "?",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(5), QueueLimit = 0 }));
    // Resto de la API: 600 peticiones por minuto por usuario (o por IP sin sesión).
    o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
        !ctx.Request.Path.StartsWithSegments("/api")
            ? RateLimitPartition.GetNoLimiter("static")
            : RateLimitPartition.GetTokenBucketLimiter(
                ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "?",
                _ => new TokenBucketRateLimiterOptions
                {
                    TokenLimit = 600, TokensPerPeriod = 600, ReplenishmentPeriod = TimeSpan.FromMinutes(1),
                    QueueLimit = 0, AutoReplenishment = true,
                }));
});

// Detrás de Nginx: la IP y el esquema (https) reales llegan en X-Forwarded-*; solo se aceptan desde localhost.
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.ForwardLimit = 1;
});
builder.Services.AddHsts(o => o.MaxAge = TimeSpan.FromDays(365));
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.MaxDepth = 32);

var app = builder.Build();
app.Services.GetRequiredService<DocumentStore>(); // carga los datos al arrancar
app.Services.GetRequiredService<UserStore>();     // crea el administrador inicial si no hay usuarios

app.UseForwardedHeaders();
if (!isDev)
{
    app.UseExceptionHandler(e => e.Run(ctx => ctx.Response.WriteAsJsonAsync(new { code = "internal", message = "Error interno del servidor." })));
    app.UseHsts();
}
if (pathBase.Length > 0) app.UsePathBase(pathBase);
app.UseSecurityHeaders();
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    // Los archivos de assets/ llevan un hash en el nombre: se pueden guardar en caché; index.html no.
    OnPrepareResponse = f => f.Context.Response.Headers.CacheControl =
        f.Context.Request.Path.StartsWithSegments("/assets") ? "public, max-age=31536000, immutable" : "no-cache",
});
app.UseRouting();
app.UseAuthentication();
app.UseRateLimiter();
app.UseMustChangePassword();
app.UseAuthorization();
app.UseCsrfProtection();

IResult Bad(string m) => Results.BadRequest(new { code = "invalid_argument", message = m });
bool ValidPath(string collection, string? id = null) => DocValidator.Collections.Contains(collection) && (id is null || DocValidator.IsValidId(id));
object Payload(DocumentStore.Doc d) => new { id = d.Id, data = d.Data, version = d.Version, updatedAt = d.UpdatedAt };
Task Broadcast(IHubContext<ChangesHub> hub, string collection, string id, JsonObject? data, bool deleted) =>
    hub.Clients.All.SendAsync("changed", new { collection, id, data, deleted });
// Resumen para la bitácora: qué campos (y en pc, qué asignaturas) cambió cada petición.
object Summary(JsonObject body) => body["courses"] is JsonObject cs
    ? new { courses = cs.Take(50).ToDictionary(c => c.Key, c => (c.Value as JsonObject)?.Select(f => f.Key).ToArray()), total = cs.Count }
    : body.Select(f => f.Key).ToArray();

var api = app.MapGroup("/api/docs");

// Listar los documentos de una colección.
api.MapGet("/{collection}", (string collection, DocumentStore store) =>
    ValidPath(collection) ? Results.Ok(store.List(collection).Select(Payload)) : Bad("Colección inválida"));

// Leer un documento.
api.MapGet("/{collection}/{id}", (string collection, string id, DocumentStore store) =>
    !ValidPath(collection, id) ? Bad("Ruta inválida") : store.Get(collection, id) is { } d ? Results.Ok(Payload(d)) : Results.NotFound(new { code = "not_found", message = "El documento no existe" }));

// Crear o reemplazar un documento completo.
api.MapPut("/{collection}/{id}", async (string collection, string id, JsonObject body, HttpContext ctx, DocumentStore store, IHubContext<ChangesHub> hub, AuditLog audit) =>
{
    if (!ValidPath(collection, id)) return Bad("Ruta inválida");
    try
    {
        var d = await store.SetAsync(collection, id, body);
        audit.Write(ctx, "doc.crear", new { collection, id, cambios = Summary(body) });
        await Broadcast(hub, collection, id, d.Data, false);
        return Results.Ok(Payload(d));
    }
    catch (DocValidationException e) { return Bad(e.Message); }
}).RequireAuthorization("editar");

// Actualizar campos con fusión profunda.
api.MapPatch("/{collection}/{id}", async (string collection, string id, JsonObject body, HttpContext ctx, DocumentStore store, IHubContext<ChangesHub> hub, AuditLog audit) =>
{
    if (!ValidPath(collection, id)) return Bad("Ruta inválida");
    try
    {
        var d = await store.MergeAsync(collection, id, body);
        if (d is null) return Results.NotFound(new { code = "not_found", message = "El documento no existe" });
        audit.Write(ctx, "doc.modificar", new { collection, id, cambios = Summary(body) });
        await Broadcast(hub, collection, id, d.Data, false);
        return Results.Ok(Payload(d));
    }
    catch (DocValidationException e) { return Bad(e.Message); }
}).RequireAuthorization("editar");

// Borrar un documento (la interfaz no lo usa; queda solo para administradores).
api.MapDelete("/{collection}/{id}", async (string collection, string id, HttpContext ctx, DocumentStore store, IHubContext<ChangesHub> hub, AuditLog audit) =>
{
    if (!ValidPath(collection, id)) return Bad("Ruta inválida");
    if (await store.DeleteAsync(collection, id))
    {
        audit.Write(ctx, "doc.borrar", new { collection, id });
        await Broadcast(hub, collection, id, null, true);
    }
    return Results.NoContent();
}).RequireAuthorization("admin");

app.MapAuthEndpoints();
app.MapGet("/api/health", () => Results.Ok(new { ok = true })).AllowAnonymous();
app.Map("/api/{**rest}", () => Results.NotFound(new { code = "not_found", message = "Ruta no encontrada" })).AllowAnonymous();
app.MapHub<ChangesHub>("/hubs/changes");
app.MapFallbackToFile("index.html").AllowAnonymous();

app.Run();
