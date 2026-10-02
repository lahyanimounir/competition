// Thin wrapper around the Docker CLI (talking to the host engine through the mounted socket).
const { run } = require('./util');

const docker = (args, opts) => run('docker', args, opts);

async function isRunning(name) {
  const r = await docker(['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', name]);
  if (r.code !== 0) return { exists: false, running: false };
  const [running, exitCode] = r.stdout.trim().split(' ');
  return { exists: true, running: running === 'true', exitCode: Number(exitCode) };
}

async function logs(name, tail = 500) {
  const r = await docker(['logs', '--timestamps', '--tail', String(tail), name]);
  if (r.code !== 0) return null;
  // docker logs writes app stdout to stdout and app stderr to stderr; merge and order by timestamp
  return [...r.stdout.split('\n'), ...r.stderr.split('\n')].filter(Boolean).sort().join('\n');
}

const rmForce = (name) => docker(['rm', '-f', name]);
const rmImage = (image) => docker(['image', 'rm', '-f', image]);
const start = (name) => docker(['start', name]);
const stop = (name) => docker(['stop', '-t', '5', name]);

async function version() {
  const r = await docker(['version', '--format', '{{.Server.Version}}']);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function appContainers() {
  const r = await docker(['ps', '-a', '--filter', 'label=ws.repo', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}']);
  if (r.code !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [name, state, status, image] = l.split('\t');
    return { name, state, status, image };
  });
}

module.exports = { docker, isRunning, logs, rmForce, rmImage, start, stop, version, appContainers };
