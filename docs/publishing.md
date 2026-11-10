# Marketplace publishing checklist

The confirmed Marketplace Publisher ID is `ArionLee`; the formal extension identifier is `ArionLee.agent-session-restore`. Publisher IDs are permanent, and the extension identifier is formed from the publisher ID and package name; do not replace it casually.

## Manual upload

1. Sign in to [Visual Studio Marketplace Publisher Management](https://marketplace.visualstudio.com/manage/publishers/) and select `ArionLee`.
2. Run `npm ci` and `npm run package` to create `rekindle.vsix`.
3. Upload the VSIX from the Publisher Management page.

Packaging and manual upload do not require a PAT or an Azure DevOps organization. Automated publishing can be configured separately using the current VS Code publishing guidance.

## Release checks

- `LICENSE` is present and `package.json` declares `MIT`.
- `media/icon.png` is the Marketplace extension icon. The README avoids repository-relative images because this source repository is private; Marketplace readers would not be able to fetch those assets.
- Repository, homepage, and issue links in `package.json` currently point to the private GitHub repository. Decide whether to make source/support links publicly accessible before listing the extension.
- The VSIX is universal by default, but automatic terminal tracking is currently implemented for macOS only. Do not describe Windows or Linux as having automatic process tracking until that support exists.
- The first `ArionLee` release uses a one-time migration from `local-tools.agent-session-restore`. Package the passive compatibility bridge with `npm run package:legacy-bridge`, install it over the old extension first, then install the `ArionLee` VSIX. Keep the bridge installed until each workspace has opened under the new identity; it does not restore or observe sessions.

See the official [extension publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) for publisher setup and publishing options.
