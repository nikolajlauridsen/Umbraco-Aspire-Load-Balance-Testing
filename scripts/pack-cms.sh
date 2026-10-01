#!/usr/bin/env bash
# Packs the Umbraco CMS from a git checkout into ./packages and prints the version.
# Usage: scripts/pack-cms.sh /home/mole/github/V17/Umbraco-CMS
set -euo pipefail
CHECKOUT="${1:?usage: pack-cms.sh <umbraco-cms-checkout>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/packages"
mkdir -p "$OUT"

# PackageVersion, not NuGetPackageVersion: the build adds a prerelease suffix on top of the
# Nerdbank.GitVersioning version, so ask with the same properties the build below uses.
VERSION=$(dotnet msbuild "$CHECKOUT/src/Umbraco.Core/Umbraco.Core.csproj" \
  -p:Configuration=Release -p:ContinuousIntegrationBuild=true \
  -getProperty:PackageVersion -getTargetResult:GetBuildVersion \
  | grep -oP '"PackageVersion": "\K[^"]+')
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
