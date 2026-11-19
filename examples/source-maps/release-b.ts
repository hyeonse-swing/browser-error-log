const details = { release: 'B' };
document.getElementById('fire')?.addEventListener('click', function crash() {
  const ready = details.release === 'B';
  if (!ready) return;
  const label = details.release.toLowerCase();
  void label;
  SOURCE_MAP_FIXTURE_MISSING();
});

(window as any).__sourceMapFixtureReady = true;
