import clipboard from 'clipboardy';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const WINDOWS_SOUND_PATH = 'C:\\Windows\\Media\\Alarm01.wav';
const MACOS_SOUND_PATH = '/System/Library/Sounds/Glass.aiff';

export const DEFAULT_SOUND_PATH = getDefaultSoundPath();

export async function copyTextToClipboard(text) {
  try {
    await clipboard.write(text);
    return { method: 'clipboardy' };
  } catch (clipboardyError) {
    try {
      const method = await copyWithPlatformFallback(text);
      return { method };
    } catch (fallbackError) {
      throw new Error(`clipboardy fallo (${clipboardyError.message}); fallback fallo (${fallbackError.message})`);
    }
  }
}

export function playSoundAsync(soundPath) {
  const player = getSoundPlayer(soundPath);

  try {
    const child = spawn(player.command, player.args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      console.error(`[sound] No se pudo reproducir sonido: ${error.message}`);
    });

    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        console.error(`[sound] El reproductor salio con codigo ${exitCode}: ${stderr.trim() || 'sin detalle'}`);
      } else if (stderr.trim()) {
        console.error(`[sound] Aviso: ${stderr.trim()}`);
      }
    });
  } catch (error) {
    console.error(`[sound] No se pudo iniciar sonido: ${error.message}`);
  }
}

function getDefaultSoundPath() {
  if (process.platform === 'win32') return WINDOWS_SOUND_PATH;
  if (process.platform === 'darwin') return MACOS_SOUND_PATH;
  return '';
}

function copyWithPlatformFallback(text) {
  if (process.platform === 'win32') {
    return runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '[Console]::In.ReadToEnd() | Set-Clipboard'
    ], {
      input: text,
      method: 'powershell fallback'
    });
  }

  if (process.platform === 'darwin') {
    return runCommand('pbcopy', [], {
      input: text,
      method: 'pbcopy fallback'
    });
  }

  return runCommand('sh', [
    '-c',
    'if command -v wl-copy >/dev/null 2>&1; then wl-copy; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then xsel --clipboard --input; else exit 127; fi'
  ], {
    input: text,
    method: 'linux clipboard fallback'
  });
}

function runCommand(command, args, { input = '', method }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(method);
      } else {
        reject(new Error(stderr.trim() || `${command} salio con codigo ${exitCode}`));
      }
    });

    child.stdin.on('error', () => {
      // El proceso puede cerrar stdin si falla antes de leer.
    });
    child.stdin.end(input);
  });
}

function getSoundPlayer(soundPath) {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildWindowsSoundCommand(soundPath || WINDOWS_SOUND_PATH)
      ]
    };
  }

  if (process.platform === 'darwin') {
    const candidate = soundPath || MACOS_SOUND_PATH;
    if (candidate && existsSync(candidate)) {
      return {
        command: 'afplay',
        args: [candidate]
      };
    }

    return {
      command: 'osascript',
      args: ['-e', 'beep 2']
    };
  }

  if (soundPath && existsSync(soundPath)) {
    return {
      command: 'sh',
      args: ['-c', 'if command -v paplay >/dev/null 2>&1; then paplay "$1"; elif command -v aplay >/dev/null 2>&1; then aplay "$1"; else printf "\\a"; fi', 'sh', soundPath]
    };
  }

  return {
    command: 'sh',
    args: ['-c', 'printf "\\a"']
  };
}

function buildWindowsSoundCommand(soundPath) {
  const escapedPath = String(soundPath).replace(/'/g, "''");

  return [
    "$ErrorActionPreference = 'Continue'",
    `$path = '${escapedPath}'`,
    '$played = $false',
    'try {',
    '  if (Test-Path -LiteralPath $path) {',
    '    $player = New-Object System.Media.SoundPlayer',
    '    $player.SoundLocation = $path',
    '    $player.Load()',
    '    $player.PlaySync()',
    '    $played = $true',
    '  } else {',
    '    [Console]::Error.WriteLine("No existe el archivo de sonido: " + $path)',
    '  }',
    '} catch {',
    '  [Console]::Error.WriteLine("SoundPlayer fallo: " + $_.Exception.Message)',
    '}',
    'if (-not $played) {',
    '  try {',
    '    [System.Media.SystemSounds]::Exclamation.Play()',
    '    Start-Sleep -Milliseconds 350',
    '    $played = $true',
    '  } catch {',
    '    [Console]::Error.WriteLine("SystemSounds fallo: " + $_.Exception.Message)',
    '  }',
    '}',
    'if (-not $played) {',
    '  try {',
    '    [Console]::Beep(1200, 180)',
    '    [Console]::Beep(1600, 180)',
    '    $played = $true',
    '  } catch {',
    '    [Console]::Error.WriteLine("Console.Beep fallo: " + $_.Exception.Message)',
    '  }',
    '}',
    'if (-not $played) { exit 1 }'
  ].join('; ');
}
