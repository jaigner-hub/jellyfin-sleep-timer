using System;
using Jellyfin.Plugin.SleepTimer.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SleepTimer;

public class Plugin : BasePlugin<PluginConfiguration>
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Sleep Timer";

    public override Guid Id => Guid.Parse("25eb5d6f-c155-4c2c-8f71-5baeb18f7bde");

    public override string Description =>
        "Pauses your active playback sessions after a chosen duration. Triggered by a browser bookmarklet.";
}
