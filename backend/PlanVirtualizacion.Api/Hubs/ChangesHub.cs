using Microsoft.AspNetCore.SignalR;

namespace PlanVirtualizacion.Api.Hubs;

/// <summary>Canal en tiempo real: avisa a todos los navegadores abiertos cuando cambia un documento.</summary>
public class ChangesHub : Hub
{
}
