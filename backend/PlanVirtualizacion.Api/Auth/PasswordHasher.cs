using System.Security.Cryptography;

namespace PlanVirtualizacion.Api.Auth;

/// <summary>
/// Hash de contraseñas con PBKDF2-HMAC-SHA512 (210.000 iteraciones, recomendación OWASP),
/// sal aleatoria de 16 bytes y comparación en tiempo constante.
/// Formato guardado: v1$iteraciones$sal(base64)$hash(base64).
/// </summary>
public static class PasswordHasher
{
    private const int Iterations = 210_000;
    private const int SaltSize = 16;
    private const int HashSize = 32;

    // Hash de una contraseña aleatoria: se verifica contra él cuando el usuario no existe,
    // para que la respuesta tarde lo mismo y no revele qué usuarios existen.
    public static readonly string Dummy = Hash(Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)));

    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA512, HashSize);
        return $"v1${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public static bool Verify(string password, string stored)
    {
        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != "v1" || !int.TryParse(parts[1], out var iterations) || iterations < 10_000) return false;
        try
        {
            var salt = Convert.FromBase64String(parts[2]);
            var expected = Convert.FromBase64String(parts[3]);
            var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA512, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    /// <summary>Contraseña aleatoria legible (sin caracteres que se confundan como 0/O o 1/l).</summary>
    public static string Generate(int length = 20)
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        return RandomNumberGenerator.GetString(alphabet, length);
    }

    private static readonly HashSet<string> Common = new(StringComparer.OrdinalIgnoreCase)
    {
        "123456789012", "1234567890123", "12345678901234", "contraseña123", "contrasena123", "password1234",
        "passwordpassword", "qwertyuiop12", "administrador", "administrador1", "americana2026", "americana2025",
        "virtualizacion", "virtualizacion1", "plan2026plan2026", "aaaaaaaaaaaa", "000000000000", "111111111111",
    };

    /// <summary>Devuelve el motivo por el que la contraseña no es aceptable, o null si es válida.</summary>
    public static string? Weakness(string password, string username)
    {
        if (password.Length < 12) return "La contraseña debe tener al menos 12 caracteres.";
        if (password.Length > 128) return "La contraseña no puede tener más de 128 caracteres.";
        if (Common.Contains(password)) return "Esa contraseña es demasiado común.";
        if (password.Distinct().Count() < 5) return "La contraseña tiene muy pocos caracteres distintos.";
        if (username.Length >= 3 && password.Contains(username, StringComparison.OrdinalIgnoreCase)) return "La contraseña no puede contener el nombre de usuario.";
        return null;
    }
}
