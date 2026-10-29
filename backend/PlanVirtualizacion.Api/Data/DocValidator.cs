using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace PlanVirtualizacion.Api.Data;

public class DocValidationException(string message) : Exception(message);

/// <summary>
/// Esquema de las colecciones. Solo se aceptan los campos que usa la plataforma, con su
/// tipo, longitud y valores permitidos. Así ningún dato guardado puede romper la interfaz
/// ni llevar código (HTML/JS) que luego se pinte en el navegador de otro usuario.
/// </summary>
public static partial class DocValidator
{
    public static readonly HashSet<string> Collections = ["programs", "pc"];

    [GeneratedRegex("^[A-Za-z0-9_.~:@+-]{1,200}$")]
    public static partial Regex IdRegex();

    [GeneratedRegex("^[A-Za-z0-9_-]{1,40}$")]
    private static partial Regex CourseIdRegex();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}$")]
    private static partial Regex DateRegex();

    [GeneratedRegex(@"[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]")]
    private static partial Regex ControlChars();

    private static readonly HashSet<string> Levels = ["pregrado", "especializacion", "maestria", "doctorado", "distancia"];
    private static readonly HashSet<string> Vias = ["por_definir", "reestructuracion", "cero", "virtual"];
    private static readonly HashSet<string> Statuses = ["no_iniciado", "en_proceso", "virtualizado"];
    private static readonly HashSet<string> TcSources = ["", "si", "duplicado"];

    private const int MaxCoursesPerProgram = 3000;
    private const int MaxDocBytes = 1_000_000;

    public static bool IsValidId(string? id) => id is not null && IdRegex().IsMatch(id);

    public static void Validate(string col, JsonObject doc)
    {
        switch (col)
        {
            case "programs": ValidateProgram(doc); break;
            case "pc": ValidateProgramCourses(doc); break;
            default: throw new DocValidationException("Colección no permitida");
        }
        if (doc.ToJsonString().Length > MaxDocBytes) throw new DocValidationException("El documento es demasiado grande");
    }

    private static void ValidateProgram(JsonObject p)
    {
        foreach (var (key, v) in p)
        {
            switch (key)
            {
                case "name": Str(key, v, 1, 200); break;
                case "level": Enum(key, v, Levels); break;
                case "modalidad": Str(key, v, 0, 60, allowNull: true); break;
                case "expected": case "expectedDisc": case "expectedTC": Int(key, v, 0, 5000, allowNull: true); break;
                case "semesters": Int(key, v, 0, 20); break;
                case "semsToProduce": Int(key, v, 0, 20, allowNull: true); break;
                case "order": Int(key, v, 0, 1_000_000); break;
                case "defaultVia": Enum(key, v, Vias); break;
                case "hidden": case "escala": case "escalaOnly": Bool(key, v); break;
                case "prodStart": case "classStart": Date(key, v); break;
                case "plan": ValidatePlan(v); break;
                default: throw new DocValidationException($"Campo no permitido en programa: {Trunc(key)}");
            }
        }
        if (p["name"] is null) throw new DocValidationException("El programa necesita un nombre");
        if (p["level"] is null) throw new DocValidationException("El programa necesita un nivel");
    }

    private static void ValidatePlan(JsonNode? v)
    {
        if (v is null) return;
        if (v is not JsonObject plan) throw new DocValidationException("plan debe ser un objeto");
        if (plan.Count > 20) throw new DocValidationException("plan tiene demasiados semestres");
        foreach (var (sem, entry) in plan)
        {
            if (!int.TryParse(sem, out var n) || n < 1 || n > 20) throw new DocValidationException("plan: semestre inválido");
            if (entry is not JsonObject e) throw new DocValidationException("plan: entrada inválida");
            foreach (var (k, d) in e)
            {
                if (k is not ("start" or "end")) throw new DocValidationException("plan: campo no permitido");
                Date($"plan.{k}", d);
            }
        }
    }

    private static void ValidateProgramCourses(JsonObject doc)
    {
        foreach (var (key, v) in doc)
        {
            switch (key)
            {
                case "programId":
                    if (!IsValidId(StrValue(key, v))) throw new DocValidationException("programId inválido");
                    break;
                case "courses":
                    if (v is not JsonObject courses) throw new DocValidationException("courses debe ser un objeto");
                    if (courses.Count > MaxCoursesPerProgram) throw new DocValidationException("Demasiadas asignaturas en el programa");
                    foreach (var (cid, c) in courses)
                    {
                        if (!CourseIdRegex().IsMatch(cid)) throw new DocValidationException("Id de asignatura inválido");
                        if (c is not JsonObject course) throw new DocValidationException("Asignatura inválida");
                        ValidateCourse(course);
                    }
                    break;
                default: throw new DocValidationException($"Campo no permitido: {Trunc(key)}");
            }
        }
    }

    private static void ValidateCourse(JsonObject c)
    {
        foreach (var (key, v) in c)
        {
            switch (key)
            {
                case "name": case "key": case "slot": Str(key, v, 0, 300); break;
                case "modalidad": Str(key, v, 0, 60); break;
                case "createdAt": case "updatedAt": Str(key, v, 0, 40); break;
                case "semester": Int(key, v, 1, 20); break;
                case "via": Enum(key, v, Vias); break;
                case "status": case "ownStatus": Enum(key, v, Statuses); break;
                case "tcSrc": Enum(key, v, TcSources); break;
                case "tc": case "deleted": case "linked": Bool(key, v); break;
                case "srcCid":
                    if (StrValue(key, v) is { Length: > 0 } s && !CourseIdRegex().IsMatch(s)) throw new DocValidationException("srcCid inválido");
                    break;
                case "srcPid":
                    if (StrValue(key, v) is { Length: > 0 } p && !IsValidId(p)) throw new DocValidationException("srcPid inválido");
                    break;
                default: throw new DocValidationException($"Campo no permitido en asignatura: {Trunc(key)}");
            }
        }
    }

    /* ---------- tipos ---------- */

    private static string StrValue(string key, JsonNode? v)
    {
        if (v is JsonValue jv && jv.GetValueKind() == JsonValueKind.String) return jv.GetValue<string>();
        throw new DocValidationException($"{key} debe ser texto");
    }

    private static void Str(string key, JsonNode? v, int min, int max, bool allowNull = false)
    {
        if (v is null && allowNull) return;
        var s = StrValue(key, v);
        if (s.Length < min || s.Length > max) throw new DocValidationException($"{key}: longitud fuera de rango");
        if (ControlChars().IsMatch(s)) throw new DocValidationException($"{key}: caracteres no permitidos");
    }

    private static void Int(string key, JsonNode? v, int min, int max, bool allowNull = false)
    {
        if (v is null && allowNull) return;
        if (v is JsonValue jv && jv.GetValueKind() == JsonValueKind.Number && jv.TryGetValue<int>(out var n) && n >= min && n <= max) return;
        if (v is JsonValue dv && dv.GetValueKind() == JsonValueKind.Number && dv.TryGetValue<double>(out var d) && d == Math.Floor(d) && d >= min && d <= max) return;
        throw new DocValidationException($"{key} debe ser un número entero entre {min} y {max}");
    }

    private static void Bool(string key, JsonNode? v)
    {
        if (v is JsonValue jv && jv.GetValueKind() is JsonValueKind.True or JsonValueKind.False) return;
        throw new DocValidationException($"{key} debe ser verdadero o falso");
    }

    private static void Enum(string key, JsonNode? v, HashSet<string> allowed)
    {
        if (!allowed.Contains(StrValue(key, v))) throw new DocValidationException($"{key}: valor no permitido");
    }

    private static void Date(string key, JsonNode? v)
    {
        if (v is null) return;
        var s = StrValue(key, v);
        if (s.Length == 0) return;
        if (!DateRegex().IsMatch(s) || !DateOnly.TryParseExact(s, "yyyy-MM-dd", out _)) throw new DocValidationException($"{key}: fecha inválida");
    }

    private static string Trunc(string s) => s.Length > 40 ? s[..40] : s;
}
