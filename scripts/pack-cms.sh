#!/usr/bin/env bash
# Packs the Umbraco CMS from a git checkout into ./packages and prints the version.
# Usage: scripts/pack-cms.sh <umbraco-cms-checkout> [--force]
#   Skips the build when ./packages already holds Umbraco.Cms for the checkout's version; --force rebuilds.
#   The version comes from the commit (Nerdbank.GitVersioning), so commit changes before packing: an
#   uncommitted change packs under the same version as HEAD and NuGet keeps serving its cached copy.
#   The last line of output is always "VERSION=<version>".
set -euo pipefail
CHECKOUT="${1:?usage: pack-cms.sh <umbraco-cms-checkout> [--force]}"
FORCE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/packages"
mkdir -p "$OUT"

# A fresh checkout has no GetBuildVersion target until Nerdbank.GitVersioning is restored.
dotnet restore "$CHECKOUT/src/Umbraco.Core/Umbraco.Core.csproj" >/dev/null

# PackageVersion, not NuGetPackageVersion: the build adds a prerelease suffix on top of the
# Nerdbank.GitVersioning version, so ask with the same properties the build below uses.
VERSION=$(dotnet msbuild "$CHECKOUT/src/Umbraco.Core/Umbraco.Core.csproj" \
  -p:Configuration=Release -p:ContinuousIntegrationBuild=true \
  -getProperty:PackageVersion -getTargetResult:GetBuildVersion \
  | grep -oP '"PackageVersion": "\K[^"]+')

if [ -n "$(git -C "$CHECKOUT" status --porcelain --untracked-files=no)" ]; then
  echo "warning: $CHECKOUT has uncommitted changes; they are packed under version $VERSION of HEAD" >&2
fi
# The SDK compiles every file in a project folder, tracked or not. src/Umbraco.Web.UI (the dev site) is not packed.
UNTRACKED=$(git -C "$CHECKOUT" ls-files --others --exclude-standard -- src | grep -v '^src/Umbraco.Web.UI/' || true)
if [ -n "$UNTRACKED" ]; then
  echo "warning: untracked files under src/ would be compiled into the packages:" >&2
  echo "$UNTRACKED" | sed 's/^/  /' >&2
fi

if [ "$FORCE" != "--force" ] && [ -f "$OUT/Umbraco.Cms.$VERSION.nupkg" ]; then
  echo "Umbraco.Cms $VERSION is already packed in $OUT; skipping the build (pass --force to rebuild)."
  echo "VERSION=$VERSION"
  exit 0
fi

echo "Packing Umbraco CMS $VERSION from $CHECKOUT"

dotnet build "$CHECKOUT/src/Umbraco.Cms/Umbraco.Cms.csproj" \
  -c Release \
  -p:GeneratePackageOnBuild=true \
  -p:PackageOutputPath="$OUT" \
  -p:ContinuousIntegrationBuild=true

echo
echo "Packed into $OUT:"
ls -1 "$OUT"/*."$VERSION".nupkg
echo
echo "Run the rig with:  UmbracoVersion=$VERSION aspire run"
echo "VERSION=$VERSION"
