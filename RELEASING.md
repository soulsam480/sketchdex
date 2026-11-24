# Releasing

The Nim server builds on each platform. Build and sign on that platform; there
is no cross-compiler in the repository.

## macOS

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  scripts/build-release.sh
```

The script builds `dist/` with vendored fonts, builds and signs
`bin/sketchdex`, and writes the tarball and checksums under a temp directory.

Notarize before uploading:

```sh
xcrun notarytool submit /tmp/.../sketchdex-<version>-darwin-arm64.tar.gz \
  --keychain-profile <profile> --wait
xcrun stapler staple /tmp/.../sketchdex-<version>-darwin-arm64.tar.gz
```

Without `APPLE_SIGNING_IDENTITY` the script uses an ad-hoc signature. That
passes `codesign --verify`, but it is not notarized and Gatekeeper may still
warn.

Publish both Darwin architectures separately, `darwin-arm64` and `darwin-x64`.

## Linux

Run `scripts/build-release.sh` on the target machine. It produces
`sketchdex-<version>-linux-<arch>.tar.gz`. Build against glibc for the glibc
asset and in a musl image for the musl asset. The repository does not ship a
Docker build.

## Windows

On Windows, in PowerShell:

```powershell
npm install
npm run build
npm run build:server
# stage bin/sketchdex.exe, dist, README.md, BRIEF.md and install.sh
Compress-Archive -Path stage/* -DestinationPath sketchdex-<version>-windows-x64.zip
```

Sign the executable before zipping:

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f certificate.pfx /p <password> bin/sketchdex.exe
```

The Windows asset is a `.zip` because `Expand-Archive` is standard. The
installer script does not cover Windows yet; download, extract, and put
`sketchdex.exe` on `PATH`.

## Upload

```sh
gh release create v<version> --target main --title "Sketchdex <version>" \
  sketchdex-darwin-arm64-<version> sketchdex-darwin-arm64-<version>.sha256 \
  sketchdex-<version>-darwin-arm64.tar.gz sketchdex-<version>-darwin-arm64.tar.gz.sha256
```

`sketchdex update` reads the latest GitHub release and expects the tarball name
`sketchdex-<version>-<os>-<arch>.tar.gz` with a matching `.sha256`. Keep that
naming stable.
