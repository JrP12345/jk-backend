import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cron-job.org';
const { job } = JSON.parse(await readFile(new URL('../deploy/render-keepalive.json', import.meta.url), 'utf8'));

// This operator utility never loads application env files or backend credentials.
// The scheduler account key is sent only to the scheduler API, never to Render.
export async function configureKeepalive({ mode = 'plan', apiKey, request = fetch } = {}) {
  if (!['plan', 'apply', 'disable'].includes(mode)) throw new Error('Use --plan, --apply or --disable.');
  if (mode === 'plan') return { mode, ...structuredClone({ job }) };
  if (!apiKey?.trim()) throw new Error('Set CRON_JOB_API_KEY in this terminal only. See docs/render-free-keepalive.md.');

  async function api(path, method = 'GET', body) {
    let response;
    try {
      response = await request(`${API}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error('Scheduler request failed. Inspect its console before rerunning; a write may have completed.');
    }
    // Do not echo provider responses, which might contain account data.
    if (!response.ok) throw new Error(`Scheduler API returned HTTP ${response.status}. Check its console and API key permissions.`);
    try { return await response.json(); }
    catch { throw new Error('Scheduler returned an invalid response. Inspect its console before rerunning.'); }
  }

  const listing = await api('/jobs');
  if (!Array.isArray(listing.jobs) || listing.someFailed) throw new Error('Cannot safely identify existing jobs from an incomplete scheduler listing.');
  const matches = listing.jobs.filter(item => item.title === job.title || item.url === job.url);
  if (matches.length > 1 || (matches.length === 1 && (matches[0].title !== job.title || matches[0].url !== job.url))) {
    throw new Error('An existing job conflicts with this name or URL. Review it in the console; no jobs were changed.');
  }
  const existingId = matches[0]?.jobId;
  if (matches.length && (!Number.isSafeInteger(existingId) || existingId <= 0)) throw new Error('Scheduler returned an invalid job identifier.');

  if (mode === 'disable') {
    if (!existingId) return { mode, status: 'No matching job exists; nothing changed.' };
    await api(`/jobs/${existingId}`, 'PATCH', { job: { enabled: false } });
    return { mode, jobId: existingId, status: 'Disabled.' };
  }

  // A Render wake-up page can be HTTP 200. Require the actual minimal application
  // JSON before enabling a recurring job. Never bypass origin protection.
  let health;
  try {
    const response = await request(job.url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: job.extendedData.headers,
    });
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
    health = await response.json();
  } catch {
    throw new Error('Backend health check failed, was redirected, or returned a wake-up page. No job was changed. Wait for startup and retry; do not disable origin protection.');
  }
  if (health?.status !== 'ok' || typeof health.timestamp !== 'string' || !Number.isFinite(Date.parse(health.timestamp))) {
    throw new Error('Backend did not return the expected health JSON. No job was changed.');
  }

  let jobId = existingId;
  if (jobId) await api(`/jobs/${jobId}`, 'PATCH', { job });
  else ({ jobId } = await api('/jobs', 'PUT', { job }));
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('Scheduler write returned no valid job identifier. Inspect its console before rerunning.');

  const { jobDetails } = await api(`/jobs/${jobId}`);
  const expected = { url: job.url, enabled: true, requestMethod: 0, saveResponses: false, requestTimeout: 30, redirectSuccess: false };
  if (!jobDetails || Object.entries(expected).some(([key, value]) => jobDetails[key] !== value) ||
      Object.entries(job.schedule).some(([key, value]) => JSON.stringify(jobDetails.schedule?.[key]) !== JSON.stringify(value)) ||
      jobDetails.auth?.enable !== false || Object.keys(jobDetails.extendedData?.headers || {}).some(key => /^(authorization|cookie|x-origin-verify-token)$/i.test(key))) {
    throw new Error('Job write was accepted but verification failed. Inspect or disable the job in the scheduler console.');
  }
  return { mode, jobId, status: 'Enabled and configuration verified; check execution history after the next scheduled run.', url: job.url };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !['--plan', '--apply', '--disable'].includes(args[0]))) throw new Error('Use --plan, --apply or --disable. Default: --plan (no network).');
    console.log(JSON.stringify(await configureKeepalive({ mode: args[0]?.slice(2) || 'plan', apiKey: process.env.CRON_JOB_API_KEY }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
