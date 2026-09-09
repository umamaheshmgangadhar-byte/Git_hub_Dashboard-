# GitHub Actions Dashboard

An account-wide, read-only dashboard for GitHub Actions activity. A scheduled GitHub Actions workflow runs the Python collector, writes the latest snapshot to `data/dashboard.json`, and commits that snapshot to the repository. The static frontend in `dashboard/` reads the snapshot and displays repositories, workflows, runs, failures, deployments, and seven-day analytics.

## Project Layout

```text
collector/collect.py          PAT-based GitHub collector
collector/requirements.txt    Python dependencies
dashboard/index.html          Dashboard page
dashboard/app.js              Dashboard behavior
dashboard/style.css            Dashboard styling
data/dashboard.json           Generated dashboard data
.github/workflows/collect.yml Scheduled collection workflow
```

## Prerequisites

- A GitHub repository containing this project.
- A personal access token with access to the target GitHub account and repositories.
- Python 3.12 or newer for local collection.
- GitHub Actions enabled for the repository.

## Create a Fine-Grained PAT

Create a fine-grained personal access token from **GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens**. Set the resource owner to your account, select the repositories to include, and give the token these repository permissions:

- `Actions: Read`
- `Contents: Read`
- `Deployments: Read`
- `Metadata: Read` (normally selected automatically)

For a public-only account, a classic PAT with `public_repo` may also work. A fine-grained PAT is preferred because it limits repository access. Never commit the token.

## Configure Repository Variables

In **Repository settings > Secrets and variables > Actions**, add:

| Name | Type | Value |
| --- | --- | --- |
| `ACTIONS_DASHBOARD_ORGANIZATION` | Repository variable | GitHub username, for example `umamaheshmgangadhar-byte` |
| `ACTIONS_DASHBOARD_TOKEN` | Repository secret | The complete PAT value |

These are the only two settings required. The collector uses `https://api.github.com` automatically.

The `GITHUB_*` names must not be used for these settings because that prefix is reserved by GitHub Actions. Remove any old variables or secrets using the previous `GITHUB_ORGANIZATION`, `GITHUB_APP_ID`, or `GITHUB_APP_PRIVATE_KEY` names.

## Run Collection Locally

From the repository root, create an environment and install the dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r collector\requirements.txt
```

Set the required values for the current PowerShell session. Keep the token out of shell history when possible:

```powershell
$env:ACTIONS_DASHBOARD_ORGANIZATION = "your-org"
$env:ACTIONS_DASHBOARD_TOKEN = "github_pat_..."
python collector\collect.py
```

The collector updates `data/dashboard.json`. It uses the PAT to read repository, workflow, workflow-run, and deployment data for the configured account.

## View the Dashboard Locally

Because the page fetches JSON, serve the repository over HTTP instead of opening the HTML file directly:

```powershell
python -m http.server 8000
```

Open <http://localhost:8000/dashboard/> in a browser. Run the collector again whenever you want to refresh the local data.

## Automated Collection

The workflow in `.github/workflows/collect.yml` runs:

- every 15 minutes;
- when manually started with **Run workflow**;
- on pushes to `main`, except when the only changed file is `data/dashboard.json`.

The workflow installs Python dependencies, runs `collector/collect.py`, and commits changed dashboard data back to `main`. Its workflow-level `contents: write` permission is required for that commit.

To run it manually, open the repository's **Actions** tab, select **Collect GitHub Actions Metrics**, and choose **Run workflow**.

## GitHub Pages

The `pages.yml` workflow enables Pages and deploys the dashboard whenever `main` changes. The workflow publishes `dashboard/index.html` at the Pages site root. If GitHub does not allow the workflow to enable Pages automatically, open **Repository settings > Pages**, set **Source** to **GitHub Actions**, and rerun the workflow. After one successful deployment, open:

```text
https://OWNER.github.io/REPOSITORY/
```

For this repository, the URL is `https://umamaheshmgangadhar-byte.github.io/Git_hub_Dashboard-/`. The `/dashboard/` path is only used for local development with `http://localhost:8000/dashboard/`.

The page contains no frontend authentication. Anyone who can access the published Pages site can see the generated metrics, so do not collect data that should remain private.

## Troubleshooting

- **Required variable error:** Confirm the two repository settings use the exact `ACTIONS_DASHBOARD_*` names.
- **Authentication or missing repositories:** Confirm the PAT is not expired, has access to the target account and repositories, and has the required `Actions`, `Contents`, `Deployments`, and `Metadata` permissions.
- **Token error:** Store the complete PAT value in the secret and do not include extra quotes or spaces.
- **Empty dashboard:** Run the collector first, confirm `data/dashboard.json` contains a non-null `generated_at`, and then refresh the browser.

## Security Notes

- Keep `ACTIONS_DASHBOARD_TOKEN` as a GitHub Actions secret, never a repository variable.
- Do not commit tokens or local environment files.
- The collector does not write credentials to `data/dashboard.json`.
