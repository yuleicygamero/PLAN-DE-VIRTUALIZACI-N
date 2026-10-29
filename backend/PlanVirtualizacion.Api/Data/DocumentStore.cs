using System.Text.Json;
using System.Text.Json.Nodes;

namespace PlanVirtualizacion.Api.Data;

/// <summary>
/// Almacén de documentos JSON guardado en un archivo en disco (sin dependencias externas).
/// Estructura: colección → id → { data, version, updatedAt }.
/// La plataforma tiene pocos cientos de documentos, así que todo se mantiene en memoria
/// y cada cambio se escribe de forma atómica (archivo temporal + reemplazo).
/// </summary>
public class DocumentStore
{
    public record Doc(string Id, JsonObject Data, int Version, DateTime UpdatedAt);

    private readonly string _path;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly Dictionary<string, Dictionary<string, Doc>> _cols = new();
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = false };

    public DocumentStore(string path, string? seedPath, ILogger<DocumentStore> log)
    {
        _path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
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
    }

    public IReadOnlyList<Doc> List(string col)
    {
        _lock.Wait();
        try { return _cols.TryGetValue(col, out var m) ? m.Values.OrderBy(d => d.Id).Select(Clone).ToList() : []; }
        finally { _lock.Release(); }
    }

    public Doc? Get(string col, string id)
    {
        _lock.Wait();
        try { return _cols.TryGetValue(col, out var m) && m.TryGetValue(id, out var d) ? Clone(d) : null; }
        finally { _lock.Release(); }
    }

    public async Task<Doc> SetAsync(string col, string id, JsonObject data)
    {
        await _lock.WaitAsync();
        try
        {
            var m = Col(col);
            var version = m.TryGetValue(id, out var old) ? old.Version + 1 : 1;
            var d = new Doc(id, data.DeepClone().AsObject(), version, DateTime.UtcNow);
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
            var d = new Doc(id, data, old.Version + 1, DateTime.UtcNow);
            m[id] = d;
            Save();
            return Clone(d);
        }
        finally { _lock.Release(); }
    }

    public async Task DeleteAsync(string col, string id)
    {
        await _lock.WaitAsync();
        try { if (Col(col).Remove(id)) Save(); }
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
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, root.ToJsonString(Indented));
        File.Move(tmp, _path, overwrite: true);
    }
}
