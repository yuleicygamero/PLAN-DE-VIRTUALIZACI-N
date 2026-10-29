using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PlanVirtualizacion.Api.Auth;

public static class Roles
{
    public const string Admin = "admin";     // edita y administra usuarios
    public const string Editor = "editor";   // edita el plan
    public const string Lector = "lector";   // solo consulta
    public static readonly string[] All = [Admin, Editor, Lector];
}

public class UserRecord
{
    public string Id { get; set; } = "";
    public string Username { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Role { get; set; } = Roles.Lector;
    public string PasswordHash { get; set; } = "";
    /// <summary>Cambia con cada cambio de contraseña, rol o estado: invalida las sesiones abiertas.</summary>
    public string SecurityStamp { get; set; } = "";
    public bool Disabled { get; set; }
    public bool MustChangePassword { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? PasswordChangedAt { get; set; }
    public DateTime? LastLoginAt { get; set; }
}

public class UserException(string message) : Exception(message);

/// <summary>
/// Usuarios de la plataforma, guardados en users.json dentro de la carpeta de datos (nunca
/// accesible por la API de documentos). Si no hay ningún usuario se crea "admin" con una
/// contraseña aleatoria que se escribe en ADMIN-INICIAL.txt y debe cambiarse al entrar.
/// </summary>
public partial class UserStore
{
    public const int MaxFailures = 5;
    public static readonly TimeSpan LockoutTime = TimeSpan.FromMinutes(15);

    private readonly string _path;
    private readonly string _initialFile;
    private readonly ILogger<UserStore> _log;
    private readonly object _gate = new();
    private List<UserRecord> _users = [];
    private readonly ConcurrentDictionary<string, (int Fails, DateTime? LockedUntil)> _attempts = new();
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    [GeneratedRegex("^[a-z0-9._@-]{3,64}$")]
    private static partial Regex UsernameRegex();

    [GeneratedRegex(@"[\u0000-\u001F\u007F<>]")]
    private static partial Regex BadDisplayChars();

    public UserStore(string dataDir, ILogger<UserStore> log)
    {
        _log = log;
        _path = Path.Combine(dataDir, "users.json");
        _initialFile = Path.Combine(dataDir, "ADMIN-INICIAL.txt");
        if (File.Exists(_path)) _users = JsonSerializer.Deserialize<List<UserRecord>>(File.ReadAllText(_path)) ?? [];
        if (_users.Count == 0) CreateInitialAdmin();
    }

    public static string Normalize(string? username) => (username ?? "").Trim().ToLowerInvariant();

    public UserRecord? FindById(string id) { lock (_gate) return _users.FirstOrDefault(u => u.Id == id); }
    public UserRecord? FindByUsername(string username) { var n = Normalize(username); lock (_gate) return _users.FirstOrDefault(u => u.Username == n); }
    public List<UserRecord> All() { lock (_gate) return _users.OrderBy(u => u.Username).ToList(); }

    /* ---------- intentos fallidos y bloqueo ---------- */

    /// <summary>Bloqueo por nombre de usuario (exista o no, para no revelar cuáles existen).</summary>
    public TimeSpan? LockedFor(string username)
    {
        if (_attempts.TryGetValue(Normalize(username), out var a) && a.LockedUntil is { } until && until > DateTime.UtcNow)
            return until - DateTime.UtcNow;
        return null;
    }

    public void RegisterFailure(string username)
    {
        var n = Normalize(username);
        if (n.Length > 64) n = n[..64];
        if (_attempts.Count > 10_000) _attempts.Clear(); // evita llenar la memoria con nombres inventados
        _attempts.AddOrUpdate(n, _ => (1, null), (_, a) =>
        {
            var fails = a.LockedUntil is { } u && u <= DateTime.UtcNow ? 1 : a.Fails + 1;
            return fails >= MaxFailures ? (0, DateTime.UtcNow + LockoutTime) : (fails, null);
        });
    }

    public void RegisterSuccess(UserRecord user)
    {
        _attempts.TryRemove(user.Username, out _);
        Update(user.Id, u => u.LastLoginAt = DateTime.UtcNow, rotateStamp: false);
    }

    /* ---------- administración ---------- */

    public UserRecord Create(string username, string displayName, string role, string password)
    {
        var n = Normalize(username);
        if (!UsernameRegex().IsMatch(n)) throw new UserException("El usuario debe tener de 3 a 64 caracteres: letras minúsculas, números, punto, guion, guion bajo o @.");
        if (!Roles.All.Contains(role)) throw new UserException("Rol no válido.");
        if (PasswordHasher.Weakness(password, n) is { } weak) throw new UserException(weak);
        var user = new UserRecord
        {
            Id = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant(),
            Username = n,
            DisplayName = CleanDisplay(displayName, n),
            Role = role,
            PasswordHash = PasswordHasher.Hash(password),
            SecurityStamp = NewStamp(),
            MustChangePassword = true,
            CreatedAt = DateTime.UtcNow,
        };
        lock (_gate)
        {
            if (_users.Any(u => u.Username == n)) throw new UserException("Ya existe un usuario con ese nombre.");
            if (_users.Count >= 500) throw new UserException("Se alcanzó el número máximo de usuarios.");
            _users.Add(user);
            Save();
        }
        return user;
    }

    /// <summary>Aplica cambios a un usuario. Por defecto renueva el sello de seguridad (cierra sus sesiones).</summary>
    public UserRecord Update(string id, Action<UserRecord> change, bool rotateStamp = true)
    {
        lock (_gate)
        {
            var user = _users.FirstOrDefault(u => u.Id == id) ?? throw new UserException("El usuario no existe.");
            var copy = JsonSerializer.Deserialize<UserRecord>(JsonSerializer.Serialize(user))!;
            change(copy);
            if (rotateStamp) copy.SecurityStamp = NewStamp();
            var admins = _users.Count(u => u.Id != id && u.Role == Roles.Admin && !u.Disabled) + (copy.Role == Roles.Admin && !copy.Disabled ? 1 : 0);
            if (admins == 0) throw new UserException("Debe quedar al menos un administrador activo.");
            _users[_users.IndexOf(user)] = copy;
            Save();
            return copy;
        }
    }

    public void SetPassword(string id, string password, bool mustChange)
    {
        var user = FindById(id) ?? throw new UserException("El usuario no existe.");
        if (PasswordHasher.Weakness(password, user.Username) is { } weak) throw new UserException(weak);
        if (PasswordHasher.Verify(password, user.PasswordHash)) throw new UserException("La nueva contraseña debe ser distinta de la actual.");
        Update(id, u =>
        {
            u.PasswordHash = PasswordHasher.Hash(password);
            u.MustChangePassword = mustChange;
            u.PasswordChangedAt = DateTime.UtcNow;
        });
        // En cuanto cambia la contraseña del administrador inicial, el archivo queda obsoleto.
        if (user.Username == "admin" && File.Exists(_initialFile)) File.Delete(_initialFile);
    }

    public void Delete(string id)
    {
        lock (_gate)
        {
            var user = _users.FirstOrDefault(u => u.Id == id) ?? throw new UserException("El usuario no existe.");
            if (user.Role == Roles.Admin && _users.Count(u => u.Role == Roles.Admin && !u.Disabled && u.Id != id) == 0)
                throw new UserException("Debe quedar al menos un administrador activo.");
            _users.Remove(user);
            Save();
        }
    }

    public static string CleanDisplay(string? displayName, string fallback)
    {
        var d = BadDisplayChars().Replace((displayName ?? "").Trim(), "");
        if (d.Length > 100) d = d[..100];
        return d.Length == 0 ? fallback : d;
    }

    private static string NewStamp() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16));

    private void CreateInitialAdmin()
    {
        var password = PasswordHasher.Generate();
        _users =
        [
            new UserRecord
            {
                Id = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant(),
                Username = "admin",
                DisplayName = "Administrador",
                Role = Roles.Admin,
                PasswordHash = PasswordHasher.Hash(password),
                SecurityStamp = NewStamp(),
                MustChangePassword = true,
                CreatedAt = DateTime.UtcNow,
            },
        ];
        Save();
        WritePrivate(_initialFile, $"Usuario: admin\nContraseña inicial: {password}\n\nAl entrar por primera vez la plataforma pedirá cambiarla. Este archivo se borra solo cuando la cambies.\n");
        _log.LogWarning("Se creó el usuario 'admin'. La contraseña inicial está en {File}", _initialFile);
    }

    private void Save()
    {
        var tmp = _path + ".tmp";
        WritePrivate(tmp, JsonSerializer.Serialize(_users, Json));
        File.Move(tmp, _path, overwrite: true);
    }

    /// <summary>Escribe un archivo legible solo por el usuario del servicio (600 en Linux).</summary>
    private static void WritePrivate(string path, string content)
    {
        if (!OperatingSystem.IsWindows())
        {
            using var fs = new FileStream(path, new FileStreamOptions
            {
                Mode = FileMode.Create, Access = FileAccess.Write,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            });
            using var w = new StreamWriter(fs);
            w.Write(content);
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        else File.WriteAllText(path, content);
    }
}
