import { REGISTRY, manifestPackageNames } from './release-common.mjs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function lookupExactVersion(name, version, fetchImpl = fetch) {
  const url = `${REGISTRY}${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch (error) {
    throw new Error(`npm registry lookup failed for ${name}@${version}`, { cause: error });
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${name}@${version}`);
  const metadata = await response.json();
  if (metadata.name !== name || metadata.version !== version || typeof metadata.dist?.integrity !== 'string') {
    throw new Error(`npm registry returned invalid metadata for ${name}@${version}`);
  }
  return metadata;
}

export function assertRegistryIntegrity(metadata, name, manifest) {
  const expected = manifest.packages[name];
  if (metadata?.dist?.integrity !== expected) {
    throw new Error(`npm registry integrity mismatch for ${name}@${manifest.version}`);
  }
}

export async function releaseRegistryState(manifest, fetchImpl = fetch) {
  const missing = [];
  for (const name of manifestPackageNames(manifest)) {
    const metadata = await lookupExactVersion(name, manifest.version, fetchImpl);
    if (metadata) assertRegistryIntegrity(metadata, name, manifest);
    else missing.push(name);
  }
  return { missing, complete: missing.length === 0 };
}

export async function releaseAdvanceState({ tag, manifest, successfulRun, eventName, inputTag, verifiedAttempt, fetchImpl = fetch }) {
  if (tag !== `v${manifest.version}`) throw new Error('Release tag and integrity manifest differ');
  const proof = successfulRun || (eventName === 'workflow_dispatch' && inputTag === tag && verifiedAttempt === true);
  if (!proof) return { ready: false, missing: null };
  const registry = await releaseRegistryState(manifest, fetchImpl);
  return { ready: registry.complete, missing: registry.missing };
}

export async function waitForRegistryPackage(name, manifest, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
  // A successful npm publish may take a short time to become visible through
  // the registry API. Only a real 404 is retried; auth/server/network errors fail.
  for (const delay of [0, 5000, 10000, 20000, ...Array(9).fill(30000)]) {
    if (delay) await sleepImpl(delay);
    const metadata = await lookupExactVersion(name, manifest.version, fetchImpl);
    if (metadata) {
      assertRegistryIntegrity(metadata, name, manifest);
      return metadata;
    }
  }
  throw new Error(`npm accepted ${name}@${manifest.version}, but its exact version is still not visible after about five minutes`);
}
