import { REPOSITORY } from './release-common.mjs';

// These immutable tags were published before the GitHub Release job existed.
// Only their exact source commits may use the original single-job proof.
const legacyPublishedTags = new Map([
  ['v0.1.3', '99da5f23a8d468d1af78e0f2d48426ba3c3854e1'],
  ['v0.1.4', 'e711a54ea73294daf771921c95b3d5a61d08b0dd'],
]);

const isLegacyPublish = (tag, headSha) => legacyPublishedTags.get(tag) === headSha;

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
  if (response.total_count > 100 || !Array.isArray(response.jobs)) return false;
  const successfulJob = name => response.jobs.some(job =>
    job.name === name && job.status === 'completed' && job.conclusion === 'success'
    && job.run_id === id && job.run_attempt === runAttempt
    && job.head_branch === tag && job.head_sha === headSha);
  return successfulJob('publish') && (isLegacyPublish(tag, headSha) || successfulJob('github_release'));
}
