const RETRY_DELAYS = [5000, 10000, 20000, 30000, 60000];

function isPendingPackage(stderr, expectedPackages, version) {
  if (typeof stderr !== 'string') return false;
  const lines = stderr.split(/\r?\n/);
  const codes = lines.flatMap(line => {
    const match = /^npm error code (\S+)\s*$/.exec(line);
    return match ? [match[1]] : [];
  });
  if (codes.length !== 1 || !['ETARGET', 'E404'].includes(codes[0])) return false;

  const diagnosticPattern = codes[0] === 'ETARGET'
    ? /^npm error notarget No matching version found for (\S+)\.\s*$/
    : /^npm error 404\s+'([^']+)' is not in this registry\.\s*$/;
  const errorLines = lines.filter(line => /^npm error(?:\s|$)/.test(line));
  const allowedExplanations = codes[0] === 'ETARGET'
    ? [
      /^npm error notarget In most cases you or one of your dependencies are requesting\s*$/,
      /^npm error notarget a package version that doesn't exist\.\s*$/,
    ]
    : [
      /^npm error 404\s*$/,
      /^npm error 404 Not Found - GET \S+ - Not found\s*$/,
      /^npm error 404 Note that you can also install from a\s*$/,
      /^npm error 404 tarball, folder, http url, or git url\.\s*$/,
    ];
  if (!errorLines.every(line => /^npm error code (?:ETARGET|E404)\s*$/.test(line)
    || diagnosticPattern.test(line)
    || allowedExplanations.some(pattern => pattern.test(line))
    || /^npm error A complete log of this run can be found in: .+/.test(line))) return false;

  const diagnostics = errorLines.flatMap(line => {
    const match = diagnosticPattern.exec(line);
    return match ? [match[1]] : [];
  });
  return diagnostics.length === 1 && expectedPackages.some(name => diagnostics[0] === `${name}@${version}`);
}

export async function retryRegistryInstall({ install, sleep, expectedPackages, version }) {
  for (const delay of [...RETRY_DELAYS, null]) {
    try {
      return install();
    } catch (error) {
      if (delay === null || !isPendingPackage(error.stderr?.toString('utf8'), expectedPackages, version)) throw error;
      await sleep(delay);
    }
  }
}
