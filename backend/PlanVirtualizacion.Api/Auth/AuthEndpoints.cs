using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using PlanVirtualizacion.Api.Hubs;
using PlanVirtualizacion.Api.Security;

namespace PlanVirtualizacion.Api.Auth;

public record LoginRequest(string? Username, string? Password);
public record ChangePasswordRequest(string? Current, string? Password);
public record CreateUserRequest(string? Username, string? DisplayName, string? Role, string? Password);
public record UpdateUserRequest(string? DisplayName, string? Role, bool? Disabled, bool? ResetPassword);

public static class AuthEndpoints
{
    public const string StampClaim = "pv:stamp";
    public const string MustChangeClaim = "pv:mcp";
    public const string IssuedClaim = "pv:iat";
    /// <summary>Duración máxima de una sesión aunque se mantenga activa.</summary>
    public static readonly TimeSpan MaxSession = TimeSpan.FromHours(12);

    private const string Scheme = CookieAuthenticationDefaults.AuthenticationScheme;

    public static object Dto(UserRecord u) => new
    {
        id = u.Id, username = u.Username, displayName = u.DisplayName, role = u.Role,
        disabled = u.Disabled, mustChangePassword = u.MustChangePassword, createdAt = u.CreatedAt, lastLoginAt = u.LastLoginAt,
    };

    private static IResult Error(int status, string code, string message) => Results.Json(new { code, message }, statusCode: status);
    private static string? UserId(HttpContext ctx) => ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);

    public static Task SignInAsync(HttpContext ctx, UserRecord u)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, u.Id),
            new(ClaimTypes.Name, u.Username),
            new(ClaimTypes.Role, u.Role),
            new(StampClaim, u.SecurityStamp),
            new(MustChangeClaim, u.MustChangePassword ? "1" : "0"),
            new(IssuedClaim, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString()),
        };
        return ctx.SignInAsync(Scheme, new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme)), new AuthenticationProperties { IsPersistent = false });
    }

    /// <summary>Se ejecuta en cada petición con cookie: la sesión deja de valer si el usuario cambió o se desactivó.</summary>
    public static async Task ValidatePrincipal(CookieValidatePrincipalContext ctx)
    {
        var users = ctx.HttpContext.RequestServices.GetRequiredService<UserStore>();
        var p = ctx.Principal;
        var user = p?.FindFirstValue(ClaimTypes.NameIdentifier) is { } id ? users.FindById(id) : null;
        var issued = long.TryParse(p?.FindFirstValue(IssuedClaim), out var s) ? DateTimeOffset.FromUnixTimeSeconds(s) : DateTimeOffset.MinValue;
        if (user is null || user.Disabled || user.SecurityStamp != p!.FindFirstValue(StampClaim) || DateTimeOffset.UtcNow - issued > MaxSession)
        {
            ctx.RejectPrincipal();
            await ctx.HttpContext.SignOutAsync(Scheme);
        }
    }

    public static void MapAuthEndpoints(this WebApplication app)
    {
        var auth = app.MapGroup("/api/auth");

        // Estado de la sesión + token CSRF para las peticiones que modifican datos.
        auth.MapGet("/session", (HttpContext ctx, IAntiforgery af, UserStore users) =>
        {
            var tokens = af.GetAndStoreTokens(ctx);
            var user = UserId(ctx) is { } id ? users.FindById(id) : null;
            return Results.Ok(new { user = user is null ? null : Dto(user), csrf = tokens.RequestToken });
        }).AllowAnonymous();

        auth.MapPost("/login", async (LoginRequest req, HttpContext ctx, UserStore users, AuditLog audit) =>
        {
            var username = UserStore.Normalize(req.Username);
            var password = req.Password ?? "";
            if (username.Length is 0 or > 64 || password.Length is 0 or > 128)
                return Error(401, "bad_credentials", "Usuario o contraseña incorrectos.");
            if (users.LockedFor(username) is { } wait)
            {
                audit.Write(ctx, "login.bloqueado", user: username);
                return Error(429, "locked", $"Demasiados intentos fallidos. Espera {Math.Ceiling(wait.TotalMinutes)} minutos e inténtalo de nuevo.");
            }
            var user = users.FindByUsername(username);
            // Se verifica siempre (con un hash ficticio si el usuario no existe) para no revelar qué usuarios existen.
            var ok = PasswordHasher.Verify(password, user?.PasswordHash ?? PasswordHasher.Dummy);
            if (!ok || user is null || user.Disabled)
            {
                users.RegisterFailure(username);
                audit.Write(ctx, "login.fallido", user: username);
                return Error(401, "bad_credentials", "Usuario o contraseña incorrectos.");
            }
            users.RegisterSuccess(user);
            await SignInAsync(ctx, user);
            audit.Write(ctx, "login", user: user.Username);
            return Results.Ok(new { user = Dto(user) });
        }).AllowAnonymous().RequireRateLimiting("login");

        auth.MapPost("/logout", async (HttpContext ctx, AuditLog audit) =>
        {
            if (ctx.User.Identity?.IsAuthenticated == true) audit.Write(ctx, "logout");
            await ctx.SignOutAsync(Scheme);
            return Results.NoContent();
        }).AllowAnonymous();

        auth.MapPost("/password", async (ChangePasswordRequest req, HttpContext ctx, UserStore users, ConnectionRegistry conns, AuditLog audit) =>
        {
            var user = users.FindById(UserId(ctx)!);
            if (user is null) return Error(401, "unauthenticated", "Inicia sesión.");
            if (users.LockedFor(user.Username) is not null)
                return Error(429, "locked", "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.");
            if (!PasswordHasher.Verify(req.Current ?? "", user.PasswordHash))
            {
                users.RegisterFailure(user.Username);
                audit.Write(ctx, "password.fallido");
                return Error(400, "bad_credentials", "La contraseña actual no es correcta.");
            }
            try { users.SetPassword(user.Id, req.Password ?? "", mustChange: false); }
            catch (UserException e) { return Error(400, "weak_password", e.Message); }
            conns.AbortUser(user.Id);
            await SignInAsync(ctx, users.FindById(user.Id)!);
            audit.Write(ctx, "password.cambiada");
            return Results.NoContent();
        }).RequireRateLimiting("login");

        /* ---------- administración de usuarios ---------- */
        var adm = app.MapGroup("/api/users").RequireAuthorization("admin");

        adm.MapGet("/", (UserStore users) => Results.Ok(users.All().Select(Dto)));

        adm.MapPost("/", (CreateUserRequest req, HttpContext ctx, UserStore users, AuditLog audit) =>
        {
            var password = string.IsNullOrEmpty(req.Password) ? PasswordHasher.Generate() : req.Password;
            try
            {
                var u = users.Create(req.Username ?? "", req.DisplayName ?? "", req.Role ?? "", password);
                audit.Write(ctx, "usuario.creado", new { u.Username, u.Role });
                return Results.Ok(new { user = Dto(u), password });
            }
            catch (UserException e) { return Error(400, "invalid_argument", e.Message); }
        });

        adm.MapPatch("/{id}", (string id, UpdateUserRequest req, HttpContext ctx, UserStore users, ConnectionRegistry conns, AuditLog audit) =>
        {
            var self = id == UserId(ctx);
            if (self && (req.Role is not null || req.Disabled is not null || req.ResetPassword == true))
                return Error(400, "invalid_argument", "No puedes cambiar tu propio rol, estado o contraseña desde aquí.");
            if (req.Role is not null && !Roles.All.Contains(req.Role)) return Error(400, "invalid_argument", "Rol no válido.");
            try
            {
                var current = users.FindById(id) ?? throw new UserException("El usuario no existe.");
                var revoke = (req.Role is not null && req.Role != current.Role) || (req.Disabled is not null && req.Disabled != current.Disabled);
                var u = users.Update(id, x =>
                {
                    if (req.DisplayName is not null) x.DisplayName = UserStore.CleanDisplay(req.DisplayName, x.Username);
                    if (req.Role is not null) x.Role = req.Role;
                    if (req.Disabled is not null) x.Disabled = req.Disabled.Value;
                }, rotateStamp: revoke);
                string? password = null;
                if (req.ResetPassword == true)
                {
                    password = PasswordHasher.Generate();
                    users.SetPassword(id, password, mustChange: true);
                    u = users.FindById(id)!;
                    revoke = true;
                }
                if (revoke) conns.AbortUser(id);
                audit.Write(ctx, "usuario.modificado", new { u.Username, req.Role, req.Disabled, resetPassword = req.ResetPassword == true });
                return Results.Ok(new { user = Dto(u), password });
            }
            catch (UserException e) { return Error(400, "invalid_argument", e.Message); }
        });

        adm.MapDelete("/{id}", (string id, HttpContext ctx, UserStore users, ConnectionRegistry conns, AuditLog audit) =>
        {
            if (id == UserId(ctx)) return Error(400, "invalid_argument", "No puedes eliminar tu propio usuario.");
            try
            {
                var name = users.FindById(id)?.Username;
                users.Delete(id);
                conns.AbortUser(id);
                audit.Write(ctx, "usuario.eliminado", new { username = name });
                return Results.NoContent();
            }
            catch (UserException e) { return Error(400, "invalid_argument", e.Message); }
        });
    }
}
