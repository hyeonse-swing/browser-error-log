import { REPOSITORY } from './release-common.mjs';

function positiveInteger(value) {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function isPublishRunForTag(run, tag, headSha) {
  return run?.event === 'workflow_dispatch' && run.path === '.github/workflows/publish.yml'
    && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY
    && run.head_branch === tag && run.head_sha === headSha;
}

export function isSuccessfulTaggedPublishRun(run, tag, headSha) {
  return isPublishRunForTag(run, tag, headSha)
    && run.status === 'completed' && run.conclusion === 'success';
}

export async function verifiedPublishAttempt({ tag, headSha, runId, attempt, api }) {
  const id = positiveInteger(runId);
  const runAttempt = positiveInteger(attempt);
  if (!id || !runAttempt) return false;

  const run = await api(`repos/${REPOSITORY}/actions/runs/${id}`);
  if (run.id !== id || run.run_attempt !== runAttempt || !isPublishRunForTag(run, tag, headSha)) return false;

  const response = await api(`repos/${REPOSITORY}/actions/runs/${id}/attempts/${runAttempt}/jobs?per_page=100`);
  return response.total_count <= 100 && Array.isArray(response.jobs) && response.jobs.some(job =>
    job.name === 'publish' && job.status === 'completed' && job.conclusion === 'success'
    && job.run_id === id && job.run_attempt === runAttempt
    && job.head_branch === tag && job.head_sha === headSha);
}
