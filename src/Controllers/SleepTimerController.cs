using System;
using Jellyfin.Plugin.SleepTimer.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.SleepTimer.Controllers;

[ApiController]
[Authorize]
[Route("SleepTimer")]
[Produces("application/json")]
public class SleepTimerController : ControllerBase
{
    private static readonly int[] AllowedMinutes = { 1, 15, 30, 60, 120 };
    private readonly SleepTimerService _service;

    public SleepTimerController(SleepTimerService service)
    {
        _service = service;
    }

    private static Guid GetUserId(System.Security.Claims.ClaimsPrincipal user)
    {
        var raw = user.FindFirst("Jellyfin-UserId")?.Value
                ?? user.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(raw, out var g) ? g : Guid.Empty;
    }

    [HttpPost("Set")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public IActionResult Set([FromQuery] int? minutes)
    {
        if (minutes is null || Array.IndexOf(AllowedMinutes, minutes.Value) < 0)
        {
            return BadRequest(new { error = "minutes must be one of: 1, 15, 30, 60, 120" });
        }
        var userId = GetUserId(User);
        var status = _service.SetTimer(userId, minutes.Value);
        return Ok(new { minutes = minutes.Value, endsAt = status.EndsAt });
    }

    [HttpPost("Cancel")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult Cancel()
    {
        var userId = GetUserId(User);
        _service.CancelTimer(userId);
        return Ok();
    }

    [HttpGet("Status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult Status()
    {
        var userId = GetUserId(User);
        var status = _service.GetStatus(userId);
        return Ok(new
        {
            active = status.Active,
            endsAt = status.EndsAt,
            remainingMs = status.RemainingMs
        });
    }
}
