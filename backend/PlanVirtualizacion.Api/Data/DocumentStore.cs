using System.Text.Json;
using System.Text.Json.Nodes;

namespace PlanVirtualizacion.Api.Data;

/// <summary>
/// Almacén de documentos JSON guardado en un archivo en disco (sin dependencias externas).
/// Estructura: colección → id → { data, version, updatedAt }.
/// La plataforma tiene pocos cientos de documentos, así que todo se mantiene en memoria
/// y cada cambio se escribe de forma atómica (archivo temporal + reemplazo).
/// Cada documento se valida contra el esquema de su colección antes de guardarse, y
/// cada hora se deja una copia del archivo en backups/ (se conservan las últimas 72).
/// </summary>
public class DocumentStore
{
    public record Doc(string Id, JsonObject Data, int Version, DateTime UpdatedAt);

    private const int MaxDocsPerCollection = 2000;
    private const int MaxBackups = 72;

    private readonly string _path;
    private readonly string _backupDir;
    private readonly ILogger<DocumentStore> _log;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly Dictionary<string, Dictionary<string, Doc>> _cols = new();
    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };
    private DateTime _lastBackup = DateTime.MinValue;

    public DocumentStore(string path, string? seedPath, ILogger<DocumentStore> log)
    {
        _path = path;
        _log = log;
        _backupDir = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(path))!, "backups");
        Directory.CreateDirectory(_backupDir);
        if (File.Exists(path))
        {
            var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            foreach (var (col, docs) in root)
            {
                var map = new Dictionary<string, Doc>();
                foreach (var (id, entry) in docs!.AsObject())
                {
                    var e = entry!.AsObject();
                    map[id] = new Doc(id, e["data"]!.AsObject().DeepClone().AsObject(), (int)e["version"]!, (DateTime)e["updatedAt"]!);
                }
                _cols[col] = map;
            }
            log.LogInformation("Datos cargados desde {Path}", path);
        }
        else if (seedPath is not null && File.Exists(seedPath))
        {
            var seed = JsonNode.Parse(File.ReadAllText(seedPath))!.AsObject();
            foreach (var (col, docs) in seed)
            {
                var map = new Dictionary<string, Doc>();
                foreach (var (id, data) in docs!.AsObject())
                    map[id] = new Doc(id, data!.AsObject().DeepClone().AsObject(), 1, DateTime.UtcNow);
                _cols[col] = map;
            }
            Save();
            log.LogInformation("Datos iniciales cargados desde {Seed}", seedPath);
        }
        // Los datos guardados antes de existir la validación se revisan al arrancar: si alguno no
        // cumple el esquema, sus ediciones serían rechazadas, así que se avisa en el registro.
        var invalid = 0;
        foreach (var (col, docs) in _cols)
            foreach (var d in docs.Values)
            {
                try { DocValidator.Validate(col, d.Data); }
                catch (DocValidationException e)
                {
                    if (++invalid <= 20) log.LogWarning("Documento {Col}/{Id} no cumple el esquema: {Msg}", col, d.Id, e.Message);
                }
            }
        log.LogInformation("Documentos revisados: {Total}, con problemas: {Invalid}", _cols.Sum(c => c.Value.Count), invalid);
    }

    public IReadOnlyList<Doc> List(string col)
    {
        _lock.Wait();
        try { return _cols.TryGetValue(col, out var m) ? m.Values.OrderBy(d => d.Id, StringComparer.Ordinal).Select(Clone).ToList() : []; }
        finally { _lock.Release(); }
    }

    public Doc? Get(string col, string id)
    {
        _lock.Wait();
        try { return _cols.TryGetValue(col, out var m) && m.TryGetValue(id, out var d) ? Clone(d) : null; }
        finally { _lock.Release(); }
    }

    /// <summary>Crea o reemplaza un documento. Lanza <see cref="DocValidationException"/> si no cumple el esquema.</summary>
    public async Task<Doc> SetAsync(string col, string id, JsonObject data)
    {
        await _lock.WaitAsync();
        try
        {
            var m = Col(col);
            if (!m.ContainsKey(id) && m.Count >= MaxDocsPerCollection)
                throw new DocValidationException("Se alcanzó el número máximo de documentos de la colección");
            var clean = data.DeepClone().AsObject();
            DocValidator.Validate(col, clean);
            var version = m.TryGetValue(id, out var old) ? old.Version + 1 : 1;
            var d = new Doc(id, clean, version, DateTime.UtcNow);
            m[id] = d;
            Save();
            return Clone(d);
        }
        finally { _lock.Release(); }
    }

    /// <summary>Fusión profunda: los objetos se mezclan, valores y listas se reemplazan. Null si no existe.</summary>
    public async Task<Doc?> MergeAsync(string col, string id, JsonObject patch)
    {
        await _lock.WaitAsync();
        try
        {
            var m = Col(col);
            if (!m.TryGetValue(id, out var old)) return null;
            var data = old.Data.DeepClone().AsObject();
            DeepMerge(data, patch);
            DocValidator.Validate(col, data);
            var d = new Doc(id, data, old.Version + 1, DateTime.UtcNow);
            m[id] = d;
            Save();
            return Clone(d);
        }
        finally { _lock.Release(); }
    }

    public async Task<bool> DeleteAsync(string col, string id)
    {
        await _lock.WaitAsync();
        try
        {
            if (!Col(col).Remove(id)) return false;
            Save();
            return true;
        }
        finally { _lock.Release(); }
    }

    private Dictionary<string, Doc> Col(string col)
    {
        if (!_cols.TryGetValue(col, out var m)) { m = new(); _cols[col] = m; }
        return m;
    }

    private static Doc Clone(Doc d) => d with { Data = d.Data.DeepClone().AsObject() };

    private static void DeepMerge(JsonObject target, JsonObject patch)
    {
        foreach (var (key, value) in patch.ToList())
        {
            if (value is JsonObject po && target[key] is JsonObject to) DeepMerge(to, po);
            else target[key] = value?.DeepClone();
        }
    }

    private void Save()
    {
        var root = new JsonObject();
        foreach (var (col, docs) in _cols)
        {
            var o = new JsonObject();
            foreach (var (id, d) in docs)
                o[id] = new JsonObject { ["data"] = d.Data.DeepClone(), ["version"] = d.Version, ["updatedAt"] = d.UpdatedAt };
            root[col] = o;
        }
        BackupIfDue();
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, root.ToJsonString(Compact));
        File.Move(tmp, _path, overwrite: true);
    }

    /// <summary>Copia el archivo actual a backups/ como máximo una vez por hora, antes de sobrescribirlo.</summary>
    private void BackupIfDue()
    {
        if (!File.Exists(_path) || DateTime.UtcNow - _lastBackup < TimeSpan.FromHours(1)) return;
        try
        {
            File.Copy(_path, Path.Combine(_backupDir, $"plan-data-{DateTime.UtcNow:yyyyMMdd-HHmmss}.json"), overwrite: true);
            _lastBackup = DateTime.UtcNow;
            foreach (var old in new DirectoryInfo(_backupDir).GetFiles("plan-data-*.json").OrderByDescending(f => f.Name).Skip(MaxBackups))
                old.Delete();
        }
        catch (Exception e)
        {
            _log.LogWarning(e, "No se pudo crear la copia de respaldo");
        }
    }
}
