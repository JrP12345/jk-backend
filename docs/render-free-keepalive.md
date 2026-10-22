# Render Free keepalive for development

Use the existing public `GET /api/health` endpoint, not readiness, synthetic
health, an appointment route, or the frontend. The handler returns only status
and timestamp and performs no patient/database operation. This is an idle-sleep
convenience for synthetic demonstrations, not proof of clinic readiness.

## Prepared configuration

`deploy/render-keepalive.json` is a cron-job.org REST API request body. The URL is
the existing Render origin supplied for this project. Confirm that hostname is
still the intended development service before activation.

| Setting | Value |
| --- | --- |
| Title | Ekavyu Render development keepalive |
| URL | `https://anant-backend-80y3.onrender.com/api/health` |
| Method | GET (API value `0`) |
| Schedule | Every 10 minutes, at minutes 03/13/23/33/43/53, every hour/day, UTC |
| Request timeout | 30 seconds |
| Headers | Accept: application/json; Cache-Control: no-cache |
| Request body / authentication / cookies | None |
| Save response bodies | Off |
| Treat redirects as success | Off |
| Notifications | Account email: after 2 failures, recovery, automatic disablement |

No application dependency, Node timer, frontend change, Render environment change,
GitHub schedule, paid service, or application redeployment is needed. Keeping one
service running can consume 744 of the workspace's shared 750 free hours in a
31-day month. Other free web services also consume that allowance.

## Activate once from the backend directory

1. Create a free account at https://console.cron-job.org/ and verify your email.
   Under **Settings**, generate an API key. Keep it in your local terminal;
   never paste it into chat, commit it, or put it in backend/frontend env files.
2. Inspect the prepared request without any network access:

   ```powershell
   node scripts/configure-render-keepalive.mjs --plan
   ```

3. Enter the key using a hidden prompt and apply the configuration:

   ```powershell
   $env:CRON_JOB_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'cron-job.org API key' -AsSecureString)).Password
   try {
     node scripts/configure-render-keepalive.mjs --apply
   } finally {
     Remove-Item Env:CRON_JOB_API_KEY -ErrorAction SilentlyContinue
   }
   ```

The script checks existing jobs, verifies the actual backend JSON (allowing up to
90 seconds for its first wake-up), then creates or updates this one job. Repeated
sequential runs reuse the same job. Do not run setup concurrently. If an API write
times out, inspect the console before retrying. Conflicting jobs are left alone.
The scheduler key goes only to `api.cron-job.org`; the Render request has no tokens.

4. In the cron-job.org console, confirm the job is enabled, the next execution is
   correct, and the next two scheduled executions succeed. Confirm notification
   email delivery. No scheduled requests occur until setup has actually succeeded.

If you prefer the console UI, create **one** job with the table's settings instead
of using an API key. Check the backend URL in a browser first and require JSON
`{"status":"ok","timestamp":"..."}`, not Render's HTML wake-up page.

## Limitations and rollback

- A first cold request can exceed the scheduler's default 30-second timeout.
  Warm the endpoint manually, then inspect the next run. Repeated failures can
  automatically disable a job; check alerts/history and re-enable after fixing it.
- The scheduler checks HTTP transport status, not your database or booking flow.
  HTTP 200 alone can be a Render loading page. Setup verifies JSON once; this is
  not a continuous JSON-content or clinical-readiness monitor.
- If health returns 403 because origin protection is enabled, stop. Do not share
  the global origin token with this scheduler or exempt application routes. An
  approved monitoring path would need a separate security review.
- Free scheduling may be delayed; Render can restart or suspend services. This
  does not fix frontend timeouts, email delivery, booking retries or backups.
- The frontend's Vercel and Cloudflare DNS settings are unaffected. No patient
  records, session cookies, production keys or database credentials are involved.

To stop, disable/delete this job in the console. Alternatively, supply the API key
as above and run `node scripts/configure-render-keepalive.mjs --disable`, then clear
the environment variable. This does not contact Render or alter other jobs.

## Official references

- [Render Free limits and idle behavior](https://render.com/docs/free)
- [cron-job.org free scheduling](https://cron-job.org/en/)
- [cron-job.org REST API](https://docs.cron-job.org/rest-api.html)
- [Timeouts, delays and automatic disabling](https://cron-job.org/en/faq/)
- [GitHub Actions private-repository runner billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
