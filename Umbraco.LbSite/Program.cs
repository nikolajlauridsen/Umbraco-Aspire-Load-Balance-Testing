using Microsoft.AspNetCore.DataProtection;
using StackExchange.Redis;
using Umbraco.Cms.Core.Routing;
using Umbraco.Cms.Infrastructure.DependencyInjection;
using Umbraco.LbSite.Rig;

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

string redisConnection = builder.Configuration.GetConnectionString("redis")
    ?? throw new InvalidOperationException("ConnectionStrings:redis is required; run through the AppHost.");
string nodeName = builder.Configuration["Rig:NodeName"] ?? Environment.MachineName;

builder.CreateUmbracoBuilder()
    .AddBackOffice()
    .AddWebsite()
    .AddComposers()
    .LoadBalanceIsolatedCaches()
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
