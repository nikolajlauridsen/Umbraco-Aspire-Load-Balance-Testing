using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Umbraco.Cms.Core;
using Umbraco.Cms.Core.Configuration;
using Umbraco.Cms.Core.Configuration.Models;
using Umbraco.Cms.Core.Models;
using Umbraco.Cms.Core.Services;
using Umbraco.Cms.Core.Services.OperationStatus;
using Umbraco.Cms.Core.Strings;
using Umbraco.Cms.Core.Sync;

namespace Umbraco.LbSite.Rig;

/// <summary>
/// Anonymous rig endpoints so k6 and the Aspire health check do not need backoffice OAuth.
/// They call <see cref="IContentService"/> directly, which takes the same locks as the Management API.
/// </summary>
[ApiController]
[AllowAnonymous]
[IgnoreAntiforgeryToken]
[RigExceptionFilter]
[Route("umbraco/lb")]
public sealed class LbController : ControllerBase
{
    private const string PageAlias = "lbPage";
    private const string RootName = "LB Root";

    private readonly IRuntimeState _runtimeState;
    private readonly IServerRoleAccessor _serverRoleAccessor;
    private readonly IOptions<HostingSettings> _hostingSettings;
    private readonly IContentService _contentService;
    private readonly IContentTypeService _contentTypeService;
    private readonly IDataTypeService _dataTypeService;
    private readonly IShortStringHelper _shortStringHelper;
    private readonly IUmbracoVersion _umbracoVersion;
    private readonly IConfiguration _configuration;

    public LbController(
        IRuntimeState runtimeState,
        IServerRoleAccessor serverRoleAccessor,
        IOptions<HostingSettings> hostingSettings,
        IContentService contentService,
        IContentTypeService contentTypeService,
        IDataTypeService dataTypeService,
        IShortStringHelper shortStringHelper,
        IUmbracoVersion umbracoVersion,
        IConfiguration configuration)
    {
        _runtimeState = runtimeState;
        _serverRoleAccessor = serverRoleAccessor;
        _hostingSettings = hostingSettings;
        _contentService = contentService;
        _contentTypeService = contentTypeService;
        _dataTypeService = dataTypeService;
        _shortStringHelper = shortStringHelper;
        _umbracoVersion = umbracoVersion;
        _configuration = configuration;
    }

    [HttpGet("status")]
    public IActionResult Status()
    {
        var body = new
        {
            node = _configuration["Rig:NodeName"] ?? Environment.MachineName,
            role = _serverRoleAccessor.CurrentServerRole.ToString(),
            runtimeLevel = _runtimeState.Level.ToString(),
            pid = Environment.ProcessId,
            machineIdentifier = _hostingSettings.Value.MachineIdentifier,
            version = _umbracoVersion.SemanticVersion.ToString(),
        };

        return _runtimeState.Level == RuntimeLevel.Run
            ? Ok(body)
            : StatusCode(StatusCodes.Status503ServiceUnavailable, body);
    }

    [HttpPost("seed")]
    public async Task<IActionResult> Seed(int branches = 20, int perBranch = 100)
    {
        IContentType contentType = await EnsureContentTypeAsync();

        IContent? root = FindRoot();
        if (root is not null)
        {
            return Ok(new { rootId = root.Id, created = 0, existing = true });
        }

        root = _contentService.Create(RootName, Constants.System.Root, contentType.Alias);
        root.SetValue("title", RootName);
        _contentService.Save(root);
        int created = 1;

        for (int b = 1; b <= branches; b++)
        {
            IContent branch = _contentService.Create($"Branch {b}", root.Id, contentType.Alias);
            branch.SetValue("title", $"Branch {b}");
            _contentService.Save(branch);
            created++;

            for (int p = 1; p <= perBranch; p++)
            {
                IContent page = _contentService.Create($"Page {b}-{p}", branch.Id, contentType.Alias);
                page.SetValue("title", $"Page {b}-{p}");
                _contentService.Save(page);
                created++;
            }
        }

        _contentService.PublishBranch(root, PublishBranchFilter.All, ["*"]);

        return Ok(new { rootId = root.Id, created, existing = false });
    }

    [HttpGet("ids")]
    public IActionResult Ids(int count = 500)
    {
        IContentType? contentType = _contentTypeService.Get(PageAlias);
        if (contentType is null)
        {
            return NotFound(new { error = $"Document type '{PageAlias}' does not exist; POST /umbraco/lb/seed first." });
        }

        int[] ids = _contentService
            .GetPagedOfTypes([contentType.Id], 0, int.MaxValue, out _, null)
            .Where(c => c.Published && c.Trashed == false)
            .Select(c => c.Id)
            .OrderBy(_ => Random.Shared.Next())
            .Take(count)
            .ToArray();

        return Ok(new { rootId = FindRoot()?.Id, ids });
    }

    /// <summary>
    /// The seeded tree: the root plus each branch with its published page ids, so k6 can hand
    /// editors disjoint pages and keep bulk publishes away from them.
    /// </summary>
    [HttpGet("tree")]
    public IActionResult Tree()
    {
        IContent? root = FindRoot();
        if (root is null)
        {
            return NotFound(new { error = "No tree; POST /umbraco/lb/seed first." });
        }

        var branches = Children(root.Id)
            .Select(branch => new
            {
                id = branch.Id,
                pages = Children(branch.Id).Where(c => c.Published).Select(c => c.Id).ToArray(),
            })
            .ToArray();

        return Ok(new { rootId = root.Id, branches });
    }

    /// <summary>
    /// Reads a document through the repository cache on this node, as a save or publish would.
    /// </summary>
    [HttpGet("get/{id:int}")]
    public IActionResult Get(int id)
    {
        IContent? content = _contentService.GetById(id);
        if (content is null)
        {
            return NotFound();
        }

        return Ok(new
        {
            id,
            node = NodeName,
            versionId = content.VersionId,
            publishedVersionId = content.PublishedVersionId,
            title = content.GetValue<string>("title"),
            updateDate = content.UpdateDate,
        });
    }

    /// <param name="id">The document id.</param>
    /// <param name="delayMs">
    /// Delays the end of the request after the save has committed. Cache instructions are written at request end,
    /// so this widens the window between the cache version bump and the instruction becoming visible to other nodes.
    /// </param>
    [HttpPost("save/{id:int}")]
    public async Task<IActionResult> Save(int id, int delayMs = 0)
    {
        IContent? content = _contentService.GetById(id);
        if (content is null)
        {
            return NotFound();
        }

        content.SetValue("title", DateTime.UtcNow.ToString("O"));
        OperationResult result = _contentService.Save(content);
        if (delayMs > 0)
        {
            await Task.Delay(delayMs);
        }

        return Result(id, result.Success, result.Result.ToString());
    }

    [HttpPost("publish/{id:int}")]
    public IActionResult Publish(int id)
    {
        IContent? content = _contentService.GetById(id);
        if (content is null)
        {
            return NotFound();
        }

        PublishResult result = _contentService.Publish(content, ["*"]);
        return Result(id, result.Success, result.Result.ToString());
    }

    [HttpPost("publish-branch/{id:int}")]
    public IActionResult PublishBranch(int id)
    {
        IContent? content = _contentService.GetById(id);
        if (content is null)
        {
            return NotFound();
        }

        PublishResult[] results = _contentService.PublishBranch(content, PublishBranchFilter.All, ["*"]).ToArray();
        return Ok(new { id, node = NodeName, count = results.Length, failed = results.Count(r => r.Success == false) });
    }

    [HttpPost("delete/{id:int}")]
    public IActionResult Delete(int id)
    {
        IContent? content = _contentService.GetById(id);
        if (content is null)
        {
            return NotFound();
        }

        OperationResult result = _contentService.MoveToRecycleBin(content);
        return Result(id, result.Success, result.Result.ToString());
    }

    private IEnumerable<IContent> Children(int parentId)
        => _contentService.GetPagedChildren(parentId, 0, int.MaxValue, out _, null, null, null, false).Where(c => c.Trashed == false);

    private string NodeName => _configuration["Rig:NodeName"] ?? Environment.MachineName;

    private IActionResult Result(int id, bool success, string status)
    {
        var body = new { id, node = NodeName, success, status };
        // 409 is reserved for stale versions (RigExceptionFilter), so other failures use 422.
        return success ? Ok(body) : UnprocessableEntity(body);
    }

    private IContent? FindRoot()
        => _contentService.GetRootContent()
            .FirstOrDefault(c => c.Name == RootName && c.ContentType.Alias == PageAlias && c.Trashed == false);

    private async Task<IContentType> EnsureContentTypeAsync()
    {
        IContentType? existing = _contentTypeService.Get(PageAlias);
        if (existing is not null)
        {
            return existing;
        }

        IDataType textstring = await _dataTypeService.GetAsync(Constants.DataTypes.Guids.TextstringGuid)
            ?? throw new InvalidOperationException("The default Textstring data type is missing.");

        var contentType = new ContentType(_shortStringHelper, Constants.System.Root)
        {
            Alias = PageAlias,
            Name = "LB Page",
            Icon = "icon-document",
            AllowedAsRoot = true,
        };
        contentType.AddPropertyType(new PropertyType(_shortStringHelper, textstring, "title") { Name = "Title" }, "content", "Content");

        Attempt<ContentTypeOperationStatus> created = await _contentTypeService.CreateAsync(contentType, Constants.Security.SuperUserKey);
        if (created.Success == false)
        {
            throw new InvalidOperationException($"Creating '{PageAlias}' failed: {created.Result}");
        }

        contentType.AllowedContentTypes = [new ContentTypeSort(contentType.Key, 0, PageAlias)];
        Attempt<ContentTypeOperationStatus> updated = await _contentTypeService.UpdateAsync(contentType, Constants.Security.SuperUserKey);
        if (updated.Success == false)
        {
            throw new InvalidOperationException($"Allowing '{PageAlias}' under itself failed: {updated.Result}");
        }

        return contentType;
    }
}
