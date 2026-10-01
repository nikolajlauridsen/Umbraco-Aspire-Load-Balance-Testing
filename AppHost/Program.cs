using Aspire.Hosting.Yarp;

var builder = DistributedApplication.CreateBuilder(args);

int nodeCount = ConfigInt("Rig:NodeCount", 3);
int gatewayPort = ConfigInt("Rig:GatewayPort", 8080);
int firstNodePort = ConfigInt("Rig:FirstNodePort", 5001);
string k6Script = builder.Configuration["Rig:K6Script"] ?? "/scripts/smoke.js";

string root = Path.GetFullPath(Path.Combine(builder.AppHostDirectory, ".."));
string shared = Path.Combine(root, "shared");
string logs = Path.Combine(root, "logs");
Directory.CreateDirectory(Path.Combine(shared, "media"));
Directory.CreateDirectory(Path.Combine(shared, "uploads"));
Directory.CreateDirectory(logs);

string gatewayUrl = $"http://localhost:{gatewayPort}";

var sql = builder.AddSqlServer("sql", port: 14333)
    .WithDataVolume("umbraco-lb-sql")
    .WithLifetime(ContainerLifetime.Persistent);
var db = sql.AddDatabase("umbracoDbDSN", "UmbracoLb");

var redis = builder.AddRedis("redis", port: 63790)
    .WithLifetime(ContainerLifetime.Persistent)
    .WithRedisInsight();

var imagingHmac = builder.AddParameter(
    "imaging-hmac",
    new GenerateParameterDefault { MinLength = 64, Special = false },
    secret: true,
    persist: true);

var nodes = new List<IResourceBuilder<ProjectResource>>();
for (int i = 1; i <= nodeCount; i++)
{
    string name = $"umb-{i}";
    int port = firstNodePort + i - 1;

    var node = builder.AddProject<Projects.Umbraco_LbSite>(name, launchProfileName: null)
        .WithHttpEndpoint(port: port, name: "http")
        .WithReference(db).WaitFor(db)
        .WithReference(redis).WaitFor(redis)
        .WithEnvironment("ConnectionStrings__umbracoDbDSN_ProviderName", "Microsoft.Data.SqlClient")
        .WithEnvironment("ASPNETCORE_FORWARDEDHEADERS_ENABLED", "true")
        .WithEnvironment("Rig__NodeName", name)
        .WithEnvironment("Rig__ServerRole", "SchedulingPublisher")
        .WithEnvironment("Rig__UseRedisDistributedCache", builder.Configuration["Rig:UseRedisDistributedCache"] ?? "true")
        .WithEnvironment("Umbraco__CMS__Hosting__SiteName", name)
        .WithEnvironment("Umbraco__CMS__Hosting__MachineIdentifier", name)
        .WithEnvironment("Umbraco__CMS__Hosting__LocalTempStorageLocation", "EnvironmentTemp")
        .WithEnvironment("Umbraco__CMS__Hosting__TemporaryFileUploadLocation", Path.Combine(shared, "uploads"))
        .WithEnvironment("Umbraco__CMS__Global__UmbracoMediaPhysicalRootPath", Path.Combine(shared, "media"))
        .WithEnvironment("Umbraco__CMS__Global__MainDomLock", "SqlMainDomLock")
        .WithEnvironment("Umbraco__CMS__Global__MainDomKeyDiscriminator", name)
        .WithEnvironment("Umbraco__CMS__Global__DistributedLockingReadLockDefaultTimeout", "00:00:05")
        .WithEnvironment("Umbraco__CMS__Examine__LuceneDirectoryFactory", "TempFileSystemDirectoryFactory")
        .WithEnvironment("Umbraco__CMS__SignalR__ClientShouldSkipNegotiation", "true")
        .WithEnvironment("Umbraco__CMS__WebRouting__UmbracoApplicationUrl", gatewayUrl)
        .WithEnvironment("Umbraco__CMS__Logging__Directory", Path.Combine(logs, name))
        .WithEnvironment("Umbraco__CMS__Imaging__HMACSecretKey", imagingHmac)
        .WithEnvironment("Umbraco__CMS__Unattended__InstallUnattended", "true")
        .WithEnvironment("Umbraco__CMS__Unattended__UnattendedUserName", "LB Admin")
        .WithEnvironment("Umbraco__CMS__Unattended__UnattendedUserEmail", "admin@lb.local")
        .WithEnvironment("Umbraco__CMS__Unattended__UnattendedUserPassword", "LoadBalance-Admin-1234!")
        .WithHttpHealthCheck("/umbraco/lb/status")
        .WithUrl(string.Concat("http://localhost:", port.ToString(), "/umbraco"), $"{name} backoffice (direct)");

    if (nodes.Count > 0)
    {
        node.WaitFor(nodes[0]);
    }

    nodes.Add(node);
}

var gateway = builder.AddYarp("gateway")
    .WithHostPort(gatewayPort)
    .WithConfiguration(yarp =>
    {
        YarpCluster cluster = yarp
            .AddCluster("umbraco", nodes.Select(n => (object)n.GetEndpoint("http")).ToArray())
            .WithLoadBalancingPolicy("RoundRobin");
        yarp.AddRoute("/{**catch-all}", cluster);
    })
    .WithUrl(gatewayUrl + "/umbraco", "Backoffice via gateway");

// AddCluster(name, object[]) emits service-discovery names (http://umb-1) but does not
// add the references that resolve them, so add them here.
foreach (var node in nodes)
{
    gateway.WithReference(node).WaitFor(node);
}

var k6 = builder.AddK6("k6")
    .WithBindMount(Path.Combine(root, "k6"), "/scripts", isReadOnly: true)
    .WithScript(k6Script)
    .WithReference(gateway)
    .WithK6OtlpEnvironment()
    .WithExplicitStart();

foreach (var node in nodes)
{
    k6.WithReference(node);
}

// Script knobs, e.g. Rig__K6Env__EDITORS=200 (k6 reads system environment variables into __ENV).
foreach (var setting in builder.Configuration.GetSection("Rig:K6Env").GetChildren())
{
    k6.WithEnvironment(setting.Key, setting.Value ?? string.Empty);
}

builder.Build().Run();

int ConfigInt(string key, int fallback)
    => int.TryParse(builder.Configuration[key], out int value) ? value : fallback;
