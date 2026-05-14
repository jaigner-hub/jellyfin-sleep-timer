using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SleepTimer.Services;

public record TimerStatus(bool Active, DateTime? EndsAt, long? RemainingMs);

public class SleepTimerService
{
    private readonly ISessionManager _sessionManager;
    private readonly ILogger<SleepTimerService> _logger;
    private readonly ConcurrentDictionary<Guid, TimerEntry> _timers = new();

    public SleepTimerService(ISessionManager sessionManager, ILogger<SleepTimerService> logger)
    {
        _sessionManager = sessionManager;
        _logger = logger;
    }

    public TimerStatus SetTimer(Guid userId, int minutes)
    {
        if (_timers.TryRemove(userId, out var existing))
        {
            existing.Cts.Cancel();
            existing.Cts.Dispose();
        }

        var cts = new CancellationTokenSource();
        var endsAt = DateTime.UtcNow.AddMinutes(minutes);
        _timers[userId] = new TimerEntry(cts, endsAt);

        _logger.LogInformation(
            "SleepTimer: SetTimer userId={UserId} minutes={Minutes} endsAt={EndsAt:o}",
            userId, minutes, endsAt);

        _ = RunTimerAsync(userId, minutes, cts.Token);

        return new TimerStatus(true, endsAt, (long)Math.Max(0, (endsAt - DateTime.UtcNow).TotalMilliseconds));
    }

    public void CancelTimer(Guid userId)
    {
        if (_timers.TryRemove(userId, out var entry))
        {
            entry.Cts.Cancel();
            entry.Cts.Dispose();
            _logger.LogInformation("SleepTimer: CancelTimer userId={UserId}", userId);
        }
    }

    public TimerStatus GetStatus(Guid userId)
    {
        if (!_timers.TryGetValue(userId, out var entry))
        {
            return new TimerStatus(false, null, null);
        }
        var remainingMs = (long)Math.Max(0, (entry.EndsAt - DateTime.UtcNow).TotalMilliseconds);
        return new TimerStatus(true, entry.EndsAt, remainingMs);
    }

    private async Task RunTimerAsync(Guid userId, int minutes, CancellationToken ct)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(minutes), ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        await OnExpiredAsync(userId).ConfigureAwait(false);
    }

    private async Task OnExpiredAsync(Guid userId)
    {
        _timers.TryRemove(userId, out _);

        var playingSessions = _sessionManager.Sessions
            .Where(s => s.UserId.Equals(userId) && s.NowPlayingItem != null)
            .ToList();

        _logger.LogInformation(
            "SleepTimer: OnExpired userId={UserId} sessionsToPause={Count}",
            userId, playingSessions.Count);

        foreach (var session in playingSessions)
        {
            try
            {
                await _sessionManager.SendPlaystateCommand(
                    controllingSessionId: null,
                    sessionId: session.Id,
                    command: new PlaystateRequest { Command = PlaystateCommand.Pause },
                    cancellationToken: CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex,
                    "SleepTimer: failed to pause session {SessionId}", session.Id);
            }
        }
    }

    private sealed record TimerEntry(CancellationTokenSource Cts, DateTime EndsAt);
}
