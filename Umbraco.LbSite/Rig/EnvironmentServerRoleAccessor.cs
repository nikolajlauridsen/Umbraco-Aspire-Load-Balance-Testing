using Umbraco.Cms.Core.Sync;

namespace Umbraco.LbSite.Rig;

public sealed class EnvironmentServerRoleAccessor : IServerRoleAccessor
{
    public EnvironmentServerRoleAccessor(IConfiguration configuration)
        => CurrentServerRole = Enum.TryParse<ServerRole>(configuration["Rig:ServerRole"], true, out var role)
            ? role
            : ServerRole.SchedulingPublisher;

    public ServerRole CurrentServerRole { get; }
}
