const RETRY_DELAYS = [5000, 10000, 20000, 30000, ...Array(4).fill(60000)];

function isPendingPackage(stderr, expectedPackages, version) {
  if (typeof stderr !== 'string') return false;
  const lines = stderr.split(/\r?\n/);
  const codes = lines.flatMap(line => {
    const match = /^npm error code (\S+)\s*$/.exec(line);
    return match ? [match[1]] : [];
  });
  if (codes.length !== 1 || !['ETARGET', 'E404'].includes(codes[0])) return false;

  const errorLines = lines.filter(line => /^npm error(?:\s|$)/.test(line));
  const targetPattern = /^npm error notarget No matching version found for (\S+)\.\s*$/;
  const legacy404Pattern = /^npm error 404\s+'([^']+)' is not in this registry\.\s*$/;
  const tarball404Pattern = /^npm error 404  The requested resource '([^']+)' could not be found or you do not have permission to access it\.\s*$/;
  const get404Pattern = /^npm error 404 Not Found - GET (\S+) - Not found\s*$/;
  const diagnosticPattern = codes[0] === 'ETARGET' ? targetPattern : legacy404Pattern;
  const allowedExplanations = codes[0] === 'ETARGET'
    ? [
      /^npm error notarget In most cases you or one of your dependencies are requesting\s*$/,
      /^npm error notarget a package version that doesn't exist\.\s*$/,
      /^npm error notarget In most cases you or one of your dependencies are requesting a package version that doesn't exist\.\s*$/,
    ]
    : [
      /^npm error 404\s*$/,
      get404Pattern,
      /^npm error 404 Note that you can also install from a\s*$/,
      /^npm error 404 tarball, folder, http url, or git url\.\s*$/,
    ];
  if (!errorLines.every(line => /^npm error code (?:ETARGET|E404)\s*$/.test(line)
    || diagnosticPattern.test(line)
    || (codes[0] === 'E404' && tarball404Pattern.test(line))
    || allowedExplanations.some(pattern => pattern.test(line))
    || /^npm error A complete log of this run can be found in: .+/.test(line))) return false;

  const diagnostics = errorLines.flatMap(line => {
    const match = diagnosticPattern.exec(line);
    return match ? [match[1]] : [];
  });
  const requested = errorLines.flatMap(line => tarball404Pattern.exec(line)?.slice(1) ?? []);
  const urls = errorLines.flatMap(line => get404Pattern.exec(line)?.slice(1) ?? []);
  if (diagnostics.length === 1 && requested.length === 0) {
    return expectedPackages.some(name => diagnostics[0] === `${name}@${version}`);
  }
  if (codes[0] !== 'E404' || diagnostics.length) return false;
  if (requested.length !== 1 || urls.length !== 1) return false;
  return expectedPackages.some(name => {
    const tarball = `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
    return urls[0] === tarball && requested[0] === `${name}@${tarball}`;
  });
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
