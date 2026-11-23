# Releasing Glimpse

Releases are fully automated by [`.github/workflows/release.yml`](../.github/workflows/release.yml).
Pushing a version tag:

1. type-checks, tests and builds both targets, and validates the Firefox package with
   Mozilla's `addons-linter`;
2. creates a **GitHub Release** with notes from `CHANGELOG.md` and three assets:
   `glimpse-chrome-edge-X.Y.Z.zip`, `glimpse-firefox-X.Y.Z.zip`, `glimpse-source-X.Y.Z.zip`;
3. uploads the new version to each store whose secrets are configured:
   - **Chrome Web Store**: uploads and submits for review;
   - **Firefox Add-ons**: uploads **with the source code** and reviewer notes
     ([`.github/amo-reviewer-notes.txt`](../.github/amo-reviewer-notes.txt)) for signing and
     review;
   - **Edge Add-ons**: uploads and submits for certification.

A store whose secrets are missing is skipped; the GitHub Release still happens.

## Cutting a release

```bash
# 1. Write the notes: add a "## [1.2.1] - YYYY-MM-DD" section to CHANGELOG.md, then
git commit -am "Changelog for 1.2.1"

# 2. Bump the version: updates package.json + package-lock.json, commits, tags v1.2.1
npm version 1.2.1          # or: npm version patch | minor | major

# 3. Publish
git push --follow-tags
```

Watch it under **Actions → Release**. The workflow refuses to run if the tag doesn't match
`package.json` or if `CHANGELOG.md` has no section for the version (CI checks the latter on
every push too).

Store versions must always increase, and a version can only be uploaded once. To redo a
release, bump to a new version rather than re-tagging.

## One-time store setup

Add each value under **GitHub → Settings → Secrets and variables → Actions → New repository
secret**.

### Firefox Add-ons (AMO)

1. Sign in at <https://addons.mozilla.org/developers/addon/api/key/> and click
   **Generate new credentials**.
2. Add the secrets:

| Secret | Value |
| --- | --- |
| `FIREFOX_JWT_ISSUER` | "JWT issuer" (looks like `user:12345678:123`) |
| `FIREFOX_JWT_SECRET` | "JWT secret" |

The add-on ID (`glimpse@merfanian.github.io`) is already in the workflow.

### Chrome Web Store

The Chrome Web Store API uses an OAuth client and a long-lived refresh token.

1. **Google Cloud project:** at <https://console.cloud.google.com/>, create (or pick) a project
   and enable the **Chrome Web Store API** (*APIs & Services → Library*).
2. **OAuth consent screen:** *APIs & Services → OAuth consent screen*, user type
   **External**. Add your Google account as a **test user**, then **publish the app**
   ("In production"). Refresh tokens of apps left in "Testing" expire after 7 days.
3. **OAuth client:** *APIs & Services → Credentials → Create credentials → OAuth client ID*,
   application type **Web application**, authorised redirect URI
   `https://developers.google.com/oauthplayground`. Note the **client ID** and **client secret**.
4. **Refresh token:** open <https://developers.google.com/oauthplayground>, click ⚙, tick
   **Use your own OAuth credentials** and enter the client ID/secret. In *Step 1* enter the
   scope `https://www.googleapis.com/auth/chromewebstore`, authorise with the Google account
   that owns the extension, then in *Step 2* click **Exchange authorization code for tokens**
   and copy the **refresh token**.
5. **IDs:** in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), the
   **extension ID** is on the item's page, and the **publisher ID** is under *Account*.

| Secret | Value |
| --- | --- |
| `CHROME_EXTENSION_ID` | The item's ID (32 letters) |
| `CHROME_PUBLISHER_ID` | Your publisher ID |
| `CHROME_CLIENT_ID` | OAuth client ID |
| `CHROME_CLIENT_SECRET` | OAuth client secret |
| `CHROME_REFRESH_TOKEN` | Refresh token from step 4 |

### Microsoft Edge Add-ons (optional)

1. In [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/publishapi),
   open **Publish API** and click **Create API credentials**.
2. The **product ID** is on the extension's overview page in Partner Center.

| Secret | Value |
| --- | --- |
| `EDGE_PRODUCT_ID` | Product ID |
| `EDGE_CLIENT_ID` | Client ID |
| `EDGE_API_KEY` | API key |

## Building packages without releasing

**Actions → Release → Run workflow** builds and verifies everything and attaches the three
zips as a workflow artifact, without creating a release or touching any store. Useful for
checking a branch before tagging.
