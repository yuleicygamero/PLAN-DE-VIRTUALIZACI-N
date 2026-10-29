using System.Collections.Concurrent;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace PlanVirtualizacion.Api.Hubs;

/// <summary>Canal en tiempo real: avisa a los navegadores con sesión iniciada cuando cambia un documento.</summary>
[Authorize]
public class ChangesHub(ConnectionRegistry registry) : Hub
{
    public override Task OnConnectedAsync()
    {
        registry.Add(Context);
        return base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        registry.Remove(Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }
}

/// <summary>
/// Conexiones abiertas por usuario, para cortarlas al desactivar un usuario, cambiar su rol o
/// su contraseña (la sesión ya no es válida y no debe seguir recibiendo datos).
/// </summary>
public class ConnectionRegistry
{
    private readonly ConcurrentDictionary<string, HubCallerContext> _conns = new();

    public void Add(HubCallerContext ctx) => _conns[ctx.ConnectionId] = ctx;
    public void Remove(string connectionId) => _conns.TryRemove(connectionId, out _);

    public void AbortUser(string userId)
    {
        foreach (var ctx in _conns.Values.Where(c => c.UserIdentifier == userId)) ctx.Abort();
    }
}
