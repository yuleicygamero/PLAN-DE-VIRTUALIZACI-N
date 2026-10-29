using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;
using PlanVirtualizacion.Api.Data;
using PlanVirtualizacion.Api.Hubs;

var builder = WebApplication.CreateBuilder(args);

// Archivo donde se guardan los datos (configurable en appsettings.json → Storage:DataFile).
var dataFile = builder.Configuration["Storage:DataFile"] ?? "App_Data/plan-data.json";
if (!Path.IsPathRooted(dataFile)) dataFile = Path.Combine(builder.Environment.ContentRootPath, dataFile);
var seedFile = Path.Combine(AppContext.BaseDirectory, "Seed", "seed.json");

builder.Services.AddSingleton(sp => new DocumentStore(dataFile, seedFile, sp.GetRequiredService<ILogger<DocumentStore>>()));
builder.Services.AddSignalR();

var origins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:5173"];
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

var app = builder.Build();
app.Services.GetRequiredService<DocumentStore>(); // carga los datos al arrancar

app.UseCors();
app.UseDefaultFiles();
app.UseStaticFiles();

var validName = new Regex("^[A-Za-z0-9_.~:@+-]{1,200}$");
IResult Bad(string m) => Results.BadRequest(new { code = "invalid_argument", message = m });
object Payload(DocumentStore.Doc d) => new { id = d.Id, data = d.Data, version = d.Version, updatedAt = d.UpdatedAt };
Task Broadcast(IHubContext<ChangesHub> hub, string collection, string id, JsonObject? data, bool deleted) =>
    hub.Clients.All.SendAsync("changed", new { collection, id, data, deleted });

var api = app.MapGroup("/api/docs");

// Listar los documentos de una colección.
api.MapGet("/{collection}", (string collection, DocumentStore store) =>
    validName.IsMatch(collection) ? Results.Ok(store.List(collection).Select(Payload)) : Bad("Colección inválida"));

// Leer un documento.
api.MapGet("/{collection}/{id}", (string collection, string id, DocumentStore store) =>
    store.Get(collection, id) is { } d ? Results.Ok(Payload(d)) : Results.NotFound());

// Crear o reemplazar un documento completo.
api.MapPut("/{collection}/{id}", async (string collection, string id, JsonObject body, DocumentStore store, IHubContext<ChangesHub> hub) =>
{
    if (!validName.IsMatch(collection) || !validName.IsMatch(id)) return Bad("Ruta inválida");
    var d = await store.SetAsync(collection, id, body);
    await Broadcast(hub, collection, id, d.Data, false);
    return Results.Ok(Payload(d));
});

// Actualizar campos con fusión profunda.
api.MapPatch("/{collection}/{id}", async (string collection, string id, JsonObject body, DocumentStore store, IHubContext<ChangesHub> hub) =>
{
    var d = await store.MergeAsync(collection, id, body);
    if (d is null) return Results.NotFound(new { code = "invalid_argument", message = "El documento no existe" });
    await Broadcast(hub, collection, id, d.Data, false);
    return Results.Ok(Payload(d));
});

// Borrar un documento.
api.MapDelete("/{collection}/{id}", async (string collection, string id, DocumentStore store, IHubContext<ChangesHub> hub) =>
{
    await store.DeleteAsync(collection, id);
    await Broadcast(hub, collection, id, null, true);
    return Results.NoContent();
});

app.MapGet("/api/health", () => Results.Ok(new { ok = true }));
app.MapHub<ChangesHub>("/hubs/changes");
app.MapFallbackToFile("index.html");

app.Run();
