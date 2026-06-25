import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT_NAME = 'KingTroll';
const COMMIT_EMAIL = 'xkingtrollprox@gmail.com';
const CONFIG_FILE = path.resolve('config', 'mode-scripts.json');

class GitCommandError extends Error {
  constructor(message, result = {}) {
    super(message);
    this.name = 'GitCommandError';
    this.stdout = result.stdout || '';
    this.stderr = result.stderr || '';
    this.status = result.status;
  }
}

export async function syncConfigToGit(options = {}) {
  const configFile = options.configFile || CONFIG_FILE;
  const remote = options.remote || 'origin';

  await access(configFile);

  const repoRoot = runGit(['rev-parse', '--show-toplevel']).stdout.trim();
  const branch = runGit(['branch', '--show-current'], { cwd: repoRoot }).stdout.trim();
  const configPath = toGitPath(path.relative(repoRoot, configFile));
  const commitMessage = options.commitMessage || `Sync Mode-Scripts config ${formatCommitDate(new Date())}`;

  runGit(['add', '-f', '--', configPath], { cwd: repoRoot });
  const stagedDiff = runGit(['diff', '--cached', '--quiet', '--', configPath], {
    cwd: repoRoot,
    allowExitCodes: [0, 1]
  });

  let committed = false;
  let commitHash = null;
  if (stagedDiff.status === 1) {
    runGit([
      '-c',
      `user.name=${COMMIT_NAME}`,
      '-c',
      `user.email=${COMMIT_EMAIL}`,
      'commit',
      '--only',
      '-m',
      commitMessage,
      '--',
      configPath
    ], { cwd: repoRoot });
    committed = true;
    commitHash = runGit(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  }

  const pushArgs = branch ? ['push', remote, branch] : ['push'];
  const push = runGit(pushArgs, { cwd: repoRoot });

  return {
    branch: branch || '(detached)',
    committed,
    commitHash,
    configPath,
    pushOutput: cleanOutput(push.stdout || push.stderr)
  };
}

export function formatSyncResult(result) {
  const lines = [
    `Config: ${result.configPath}`,
    `Branch: ${result.branch}`,
    result.committed
      ? `Commit: ${result.commitHash}`
      : 'Commit: sin cambios nuevos en configuracion',
    'Push: completado'
  ];

  if (result.pushOutput) {
    lines.push(`Git: ${result.pushOutput}`);
  }

  return lines.join('\n');
}

function runGit(args, options = {}) {
  const command = `git ${args.join(' ')}`;
  const result = spawnSync('git', args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never'
    },
    timeout: options.timeout || 45000,
    windowsHide: true
  });
  const allowExitCodes = options.allowExitCodes || [0];

  if (result.error) {
    const detail = result.error.code === 'ETIMEDOUT'
      ? 'Git tardo demasiado y se detuvo. Revisa que no este esperando credenciales.'
      : `No se pudo ejecutar git: ${result.error.message}`;
    throw new GitCommandError(detail, result);
  }

  if (!allowExitCodes.includes(result.status)) {
    const output = cleanOutput(`${result.stdout || ''}\n${result.stderr || ''}`);
    throw new GitCommandError(formatGitFailure(command, output), result);
  }

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function formatCommitDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toGitPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function cleanOutput(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ');
}

function formatGitFailure(command, output) {
  const lowerOutput = output.toLowerCase();
  const authFailed = lowerOutput.includes('terminal prompts disabled')
    || lowerOutput.includes('could not read username')
    || lowerOutput.includes('authentication failed')
    || lowerOutput.includes('permission denied')
    || lowerOutput.includes('repository not found');

  if (!authFailed) {
    return `${command} fallo.${output ? `\n${output}` : ''}`;
  }

  return `${command} fallo por autenticacion de GitHub.
${output}

El push automatico no puede pedir usuario/contrasena dentro del menu.
Configura credenciales en este equipo y vuelve a intentarlo:
  gh auth login
  gh auth setup-git

Alternativa: usa SSH en el remoto:
  git remote set-url origin git@github.com:JoseMiguel-DG/mode-scripts.git`;
}

function printHelp() {
  console.log(`Uso:
  npm run config:push

Hace automaticamente:
  git add -f config/mode-scripts.json
  git commit --only -m "Sync Mode-Scripts config ..."
  git push origin <branch>
`);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const command = process.argv[2] || 'push';
  if (command === '--help' || command === '-h') {
    printHelp();
  } else if (command === 'push') {
    try {
      const result = await syncConfigToGit();
      console.log(formatSyncResult(result));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else {
    console.error(`Comando no valido: ${command}`);
    printHelp();
    process.exit(1);
  }
}
