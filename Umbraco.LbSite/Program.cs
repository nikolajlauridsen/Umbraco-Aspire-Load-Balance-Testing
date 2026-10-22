using Umbraco.Cms.Core.DependencyInjection;
using Microsoft.AspNetCore.DataProtection;
using StackExchange.Redis;
using Umbraco.Cms.Core.Routing;
using Umbraco.Cms.Infrastructure.DependencyInjection;
using Umbraco.LbSite.Rig;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

string redisConnection = builder.Configuration.GetConnectionString("redis")
    ?? throw new InvalidOperationException("ConnectionStrings:redis is required; run through the AppHost.");
string nodeName = builder.Configuration["Rig:NodeName"] ?? Environment.MachineName;

// Rig:ThreadPoolMinThreads mirrors the <ThreadPoolMinThreads> runtimeconfig knob a site can set; it raises the
// floor below which the pool injects threads slowly (~1-2 per second), which is what hides thread starvation.
if (int.TryParse(builder.Configuration["Rig:ThreadPoolMinThreads"], out int minThreads) && minThreads > 0)
{
    ThreadPool.GetMinThreads(out int _, out int minIo);
    bool applied = ThreadPool.SetMinThreads(minThreads, Math.Max(minIo, minThreads));
    Console.WriteLine($"[rig] ThreadPool.SetMinThreads({minThreads}) applied={applied}");
}

IUmbracoBuilder umbracoBuilder = builder.CreateUmbracoBuilder()
    .AddBackOffice()
    .AddWebsite()
    .AddComposers();

// Rig:LoadBalanceIsolatedCaches=false runs the node as a single, non-load-balanced server would.
bool isolatedCaches = builder.Configuration.GetValue("Rig:LoadBalanceIsolatedCaches", true);
if (isolatedCaches)
{
    umbracoBuilder.LoadBalanceIsolatedCaches();
}

Console.WriteLine($"[rig] LoadBalanceIsolatedCaches={isolatedCaches}");
umbracoBuilder
    .SetServerRegistrar(new EnvironmentServerRoleAccessor(builder.Configuration))
    .Build();

// The rig endpoints stand in for backoffice (Management API) calls. Umbraco only runs the inline
// isolated-cache sync for backoffice requests, and /umbraco/lb/{action}/{id} would otherwise be treated
// as a front-end plugin controller route.
builder.Services.Configure<UmbracoRequestPathsOptions>(options =>
    options.IsBackOfficeRequest = path => path.StartsWith("/umbraco/lb/", StringComparison.OrdinalIgnoreCase));

IConnectionMultiplexer redis = ConnectionMultiplexer.Connect(redisConnection);
builder.Services.AddSingleton(redis);

builder.Services.AddDataProtection()
    .SetApplicationName("umbraco-lb-rig")
    .PersistKeysToStackExchangeRedis(redis, "umbraco-lb-rig:dataprotection-keys");

if (builder.Configuration.GetValue("Rig:UseRedisDistributedCache", true))
{
    builder.Services.AddStackExchangeRedisCache(options =>
    {
        options.Configuration = redisConnection;
        options.InstanceName = "umbraco-lb-rig:";
    });
}

builder.Services.AddSignalR().AddStackExchangeRedis(redisConnection, options =>
    options.Configuration.ChannelPrefix = RedisChannel.Literal("umbraco-lb-rig"));

WebApplication app = builder.Build();

await app.BootUmbracoAsync();

app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Umb-Node"] = nodeName;
        return Task.CompletedTask;
    });
    await next();
});

app.UseUmbraco()
    .WithMiddleware(u =>
    {
        u.UseBackOffice();
        u.UseWebsite();
    })
    .WithEndpoints(u =>
    {
        u.UseBackOfficeEndpoints();
        u.UseWebsiteEndpoints();
    });

await app.RunAsync();
