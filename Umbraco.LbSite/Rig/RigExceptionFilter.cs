using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Umbraco.Cms.Core.DistributedLocking.Exceptions;

namespace Umbraco.LbSite.Rig;

/// <summary>
/// Maps the two failure modes the cache-sync scenario measures to distinct status codes, so k6 can
/// count them separately: 409 for a stale cached version, 503 for a distributed lock timeout.
/// The exception is still logged by the node.
/// </summary>
public sealed class RigExceptionFilterAttribute : ExceptionFilterAttribute
{
    public override void OnException(ExceptionContext context)
    {
        // Notification handlers run at scope exit wrap failures in (nested) AggregateExceptions.
        Exception exception = context.Exception;
        while (exception is AggregateException { InnerException: { } inner })
        {
            exception = inner;
        }

        (int status, string error)? mapped = exception switch
        {
            InvalidOperationException e when e.Message.Contains("non-current version") => (StatusCodes.Status409Conflict, "stale-version"),
            DistributedReadLockTimeoutException => (StatusCodes.Status503ServiceUnavailable, "read-lock-timeout"),
            DistributedWriteLockTimeoutException => (StatusCodes.Status503ServiceUnavailable, "write-lock-timeout"),
            _ => null,
        };

        if (mapped is null)
        {
            return;
        }

        ILogger logger = context.HttpContext.RequestServices.GetRequiredService<ILogger<RigExceptionFilterAttribute>>();
        logger.LogWarning(context.Exception, "Rig request {Path} failed with {Error}", context.HttpContext.Request.Path, mapped.Value.error);

        context.Result = new ObjectResult(new
        {
            error = mapped.Value.error,
            node = context.HttpContext.RequestServices.GetRequiredService<IConfiguration>()["Rig:NodeName"],
            message = exception.Message,
        })
        {
            StatusCode = mapped.Value.status,
        };
        context.ExceptionHandled = true;
    }
}
