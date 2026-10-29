using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using PlanVirtualizacion.Api.Auth;

namespace PlanVirtualizacion.Api.Security;

public static class SecurityMiddleware
{
    // La interfaz pinta estilos en línea (style="…"), por eso style-src permite 'unsafe-inline';
    // los scripts solo pueden venir del propio sitio.
    private const string Csp =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

    /// <summary>Cabeceras de seguridad en todas las respuestas; las de la API nunca se guardan en caché.</summary>
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        var h = ctx.Response.Headers;
        h["Content-Security-Policy"] = Csp;
        h["X-Content-Type-Options"] = "nosniff";
        h["X-Frame-Options"] = "DENY";
        h["Referrer-Policy"] = "no-referrer";
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";
        h["Cross-Origin-Opener-Policy"] = "same-origin";
        h["Cross-Origin-Resource-Policy"] = "same-origin";
        if (ctx.Request.Path.StartsWithSegments("/api") || ctx.Request.Path.StartsWithSegments("/hubs"))
        {
            h.CacheControl = "no-store";
            h.Pragma = "no-cache";
        }
        await next();
    });

    /// <summary>Mientras el usuario tenga una contraseña temporal solo puede usar /api/auth (para cambiarla).</summary>
    public static IApplicationBuilder UseMustChangePassword(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        var path = ctx.Request.Path;
        if (ctx.User.FindFirstValue(AuthEndpoints.MustChangeClaim) == "1" && !path.StartsWithSegments("/api/auth")
            && (path.StartsWithSegments("/api") || path.StartsWithSegments("/hubs")))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            await ctx.Response.WriteAsJsonAsync(new { code = "must_change_password", message = "Debes cambiar tu contraseña antes de continuar." });
            return;
        }
        await next();
    });

    /// <summary>Toda petición de la API que modifica algo debe traer el token CSRF en la cabecera X-XSRF-TOKEN.</summary>
    public static IApplicationBuilder UseCsrfProtection(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        var m = ctx.Request.Method;
        if (ctx.Request.Path.StartsWithSegments("/api") && !(HttpMethods.IsGet(m) || HttpMethods.IsHead(m) || HttpMethods.IsOptions(m)))
        {
            var af = ctx.RequestServices.GetRequiredService<IAntiforgery>();
            try { await af.ValidateRequestAsync(ctx); }
            catch (AntiforgeryValidationException)
            {
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                await ctx.Response.WriteAsJsonAsync(new { code = "csrf", message = "La sesión de la página expiró. Recarga la página." });
                return;
            }
        }
        await next();
    });
}
