// Synthetic, fixed inputs only. This module is served by benchmark-sdk-presets.mjs.
let client;
let initSdk;
let mode;
const options = {
  project: 'preset-benchmark',
  environment: 'synthetic',
  release: '0.2.13',
  endpoint: '/collector',
  // Keep the timer outside each short measurement. All other limits are defaults.
  flushIntervalMs: 60_000,
};

function makeError(index, depth = 5) {
  if (depth > 0) return makeError(index, depth - 1);
  return new Error(`Synthetic operation ${index % 10} failed`, {
    cause: new Error('Synthetic upstream cause'),
  });
}

const extra = { componentStack: '\n    at FixtureButton\n    at FixturePanel', context: { screen: 'fixture', action: 'save' } };

async function unit(scenario, index) {
  if (scenario === 'manual') {
    const error = makeError(index);
    client?.captureException(error, extra);
    return;
  }
  history.replaceState(null, '', `/bench#step-${index % 10}`);
  await (await fetch('/ok')).text();
  if (scenario === 'healthy') return;
  const manual = makeError(index);
  client?.captureException(manual, extra);
  const automatic = makeError(index + 1);
  window.dispatchEvent(new ErrorEvent('error', { message: automatic.message, error: automatic }));
  console.error(`Synthetic console error ${index % 10}`);
  await (await fetch('/fail')).text();
}

window.benchmark = {
  async setup(selectedMode) {
    mode = selectedMode;
    if (mode !== 'none') ({ init: initSdk } = await import('/sdk.js'));
    this.recreate();
  },
  recreate() {
    client?.destroy();
    client = mode === 'none' ? undefined : initSdk({ ...options, preset: mode });
  },
  destroy() { client?.destroy(); client = undefined; },
  async workload({ scenario, batches, unitsPerBatch, flush = true }) {
    for (let batch = 0; batch < batches; batch++) {
      for (let index = 0; index < unitsPerBatch; index++) await unit(scenario, index);
      if (flush) await client?.flush();
    }
    return this.diagnostics();
  },
  async flush() { await client?.flush(); return this.diagnostics(); },
  diagnostics() {
    return client?.getDiagnostics() ?? {
      queued: 0, sent: 0, dropped: 0, inFlight: 0, filtered: 0, deduplicated: 0,
      droppedByReason: {},
    };
  },
};
