import { spawn } from 'node:child_process';

const url = process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-zA-Z0-9_%.-]+$/.test(url ?? '')) process.exit(2);
const wsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
const argv = wsl || process.platform === 'win32'
  ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Start-Process', url]
  : [process.platform === 'darwin' ? 'open' : 'xdg-open', url];
const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' });
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
