document.getElementById('fire')?.addEventListener('click', function crash() {
  SOURCE_MAP_FIXTURE_MISSING();
});

(window as any).__sourceMapFixtureReady = true;
