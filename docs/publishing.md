# Marketplace publishing checklist

This extension is not ready to upload until its Marketplace Publisher ID is chosen. `local-tools` in `package.json` is a placeholder. Publisher IDs are permanent, and the extension identifier is formed from the publisher ID and package name; do not replace it casually.

## Manual upload

1. Register or sign in to the intended publisher at [Visual Studio Marketplace Publisher Management](https://marketplace.visualstudio.com/manage/publishers/).
2. After the publisher ID is confirmed, update only the `publisher` field in `package.json` and review the resulting extension ID and package contents.
3. Run `npm ci` and `npm run package` to create `rekindle.vsix`.
4. Upload the VSIX from the Publisher Management page.

Packaging and manual upload do not require a PAT or an Azure DevOps organization. Automated publishing can be configured separately using the current VS Code publishing guidance.

## Release checks

- `LICENSE` is present and `package.json` declares `MIT`.
- `media/icon.png` is the Marketplace extension icon. The README avoids repository-relative images because this source repository is private; Marketplace readers would not be able to fetch those assets.
- Repository, homepage, and issue links in `package.json` currently point to the private GitHub repository. Decide whether to make source/support links publicly accessible before listing the extension.
- The VSIX is universal by default, but automatic terminal tracking is currently implemented for macOS only. Do not describe Windows or Linux as having automatic process tracking until that support exists.
- If the Publisher ID changes, VS Code treats it as a different extension ID and does not carry over the old extension's `workspaceState`. Keep the old identity available long enough to export session records and provide a one-time import in the new identity, or retain the current publisher ID. No storage migration should be assumed before that transition is designed and tested.

See the official [extension publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) for publisher setup and publishing options.
