using System.Security.Claims;
using System.Text.Json;

namespace PlanVirtualizacion.Api.Security;

/// <summary>
/// Bitácora de auditoría: una línea JSON por evento (entradas, salidas, intentos fallidos,
/// cambios de datos y de usuarios) en audit.log dentro de la carpeta de datos.
/// Al pasar de 20 MB se renombra a audit-AAAAMMDD-HHMMSS.log y se empieza uno nuevo.
/// </summary>
public class AuditLog(string dataDir)
{
    private const long MaxBytes = 20 * 1024 * 1024;
    private readonly string _path = Path.Combine(dataDir, "audit.log");
    private readonly object _gate = new();

    public void Write(HttpContext ctx, string action, object? detail = null, string? user = null)
    {
        var line = JsonSerializer.Serialize(new
        {
            t = DateTime.UtcNow,
            user = user ?? ctx.User.FindFirstValue(ClaimTypes.Name),
            ip = ctx.Connection.RemoteIpAddress?.ToString(),
            action,
            detail,
        });
        lock (_gate)
        {
            var fi = new FileInfo(_path);
            if (fi.Exists && fi.Length > MaxBytes)
                fi.MoveTo(Path.Combine(fi.DirectoryName!, $"audit-{DateTime.UtcNow:yyyyMMdd-HHmmss}.log"));
            File.AppendAllText(_path, line + "\n");
        }
    }
}
