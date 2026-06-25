import clipboard from 'clipboardy';
import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import WebSocket, { WebSocketServer } from 'ws';

const DEFAULT_SOUND_PATH = 'C:\\Windows\\Media\\Alarm01.wav';
const DEFAULT_DEDUP_MINUTES = 10;
const DEFAULT_LOG_FILE = path.resolve('logs', 'codes.ndjson');
const DEFAULT_FAILURE_LOG_FILE = path.resolve('logs', 'keydrop-failures.ndjson');
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PORT = 17373;
const BRIDGE_ALERT_THROTTLE_MS = 30_000;
const TWITCH_IRC_WS = 'wss://irc-ws.chat.twitch.tv:443';
const CODE_REGEX = /(?<![A-Za-z0-9])([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})(?![A-Za-z0-9])/g;
const KEYDROP_ALLOWED_ORIGINS = new Set([
  'https://key-drop.com',
  'https://www.key-drop.com'
]);

const options = parseArgs(process.argv.slice(2));
const dedupMs = Math.max(0, options.dedupMinutes) * 60 * 1000;
const seenCodes = new Map();
const bridgeClients = new Set();
let reconnectAttempt = 0;
let reconnectTimer = null;
let currentSocket = null;
let currentNick = null;
let lastBridgeAlertAt = 0;

if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.soundTest) {
  await runSoundTest();
} else if (options.testMode) {
  if (options.keydropBridge) {
    startKeydropBridge();
  }
  await runTestMode();
} else {
  if (options.channels.length === 0) {
    console.error('Falta el canal. Usa: npm start -- --channel nombre_del_canal');
    console.error('Para varios canales: npm start -- --channels canal1,canal2');
    console.error('Tambien puedes definir TWITCH_CHANNEL o TWITCH_CHANNELS.');
    process.exit(1);
  }

  console.log('Twitch Code Clipboard');
  console.log(`Canales: ${formatChannels(options.channels)}`);
  console.log(`Deduplicacion: ${options.dedupMinutes} minuto(s)`);
  console.log(`Sonido: ${options.soundPath}`);
  console.log(`Log: ${options.logFile}`);
  console.log(`Log fallos KeyDrop: ${options.failureLogFile}`);
  if (options.keydropBridge) {
    startKeydropBridge();
  }
  connectToTwitch(options.channels);
}

function parseArgs(args) {
  const parsed = {
    channels: normalizeChannels(process.env.TWITCH_CHANNELS || process.env.TWITCH_CHANNEL || ''),
    dedupMinutes: numberFrom(process.env.DEDUP_MINUTES, DEFAULT_DEDUP_MINUTES),
    soundPath: process.env.SOUND_PATH || DEFAULT_SOUND_PATH,
    logFile: path.resolve(process.env.LOG_FILE || DEFAULT_LOG_FILE),
    failureLogFile: path.resolve(process.env.FAILURE_LOG_FILE || DEFAULT_FAILURE_LOG_FILE),
    keydropBridge: booleanFrom(process.env.KEYDROP_BRIDGE, false),
    bridgeHost: process.env.KEYDROP_BRIDGE_HOST || DEFAULT_BRIDGE_HOST,
    bridgePort: numberFrom(process.env.KEYDROP_BRIDGE_PORT, DEFAULT_BRIDGE_PORT),
    testMode: false,
    soundTest: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--test') {
      parsed.testMode = true;
    } else if (arg === '--sound-test') {
      parsed.soundTest = true;
    } else if (arg === '--keydrop-bridge') {
      parsed.keydropBridge = true;
    } else if (arg === '--channel' || arg === '-c' || arg === '--channels') {
      parsed.channels = normalizeChannels(args[++index] || '');
    } else if (arg.startsWith('--channel=')) {
      parsed.channels = normalizeChannels(arg.slice('--channel='.length));
    } else if (arg.startsWith('--channels=')) {
      parsed.channels = normalizeChannels(arg.slice('--channels='.length));
    } else if (arg === '--dedup-minutes') {
      parsed.dedupMinutes = numberFrom(args[++index], DEFAULT_DEDUP_MINUTES);
    } else if (arg.startsWith('--dedup-minutes=')) {
      parsed.dedupMinutes = numberFrom(arg.slice('--dedup-minutes='.length), DEFAULT_DEDUP_MINUTES);
    } else if (arg === '--sound') {
      parsed.soundPath = args[++index] || DEFAULT_SOUND_PATH;
    } else if (arg.startsWith('--sound=')) {
      parsed.soundPath = arg.slice('--sound='.length) || DEFAULT_SOUND_PATH;
    } else if (arg === '--log-file') {
      parsed.logFile = path.resolve(args[++index] || DEFAULT_LOG_FILE);
    } else if (arg.startsWith('--log-file=')) {
      parsed.logFile = path.resolve(arg.slice('--log-file='.length) || DEFAULT_LOG_FILE);
    } else if (arg === '--failure-log-file') {
      parsed.failureLogFile = path.resolve(args[++index] || DEFAULT_FAILURE_LOG_FILE);
    } else if (arg.startsWith('--failure-log-file=')) {
      parsed.failureLogFile = path.resolve(arg.slice('--failure-log-file='.length) || DEFAULT_FAILURE_LOG_FILE);
    } else if (arg === '--bridge-host') {
      parsed.bridgeHost = args[++index] || DEFAULT_BRIDGE_HOST;
    } else if (arg.startsWith('--bridge-host=')) {
      parsed.bridgeHost = arg.slice('--bridge-host='.length) || DEFAULT_BRIDGE_HOST;
    } else if (arg === '--bridge-port') {
      parsed.bridgePort = numberFrom(args[++index], DEFAULT_BRIDGE_PORT);
    } else if (arg.startsWith('--bridge-port=')) {
      parsed.bridgePort = numberFrom(arg.slice('--bridge-port='.length), DEFAULT_BRIDGE_PORT);
    } else if (!arg.startsWith('-')) {
      parsed.channels = mergeChannels(parsed.channels, normalizeChannels(arg));
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
Uso:
  npm install
  npm start -- --channel canal
  npm start -- --channels canal1,canal2

Opciones:
  --channel, -c          Canal de Twitch sin #.
  --channels             Varios canales separados por coma o espacios.
  --dedup-minutes       Minutos para ignorar codigos repetidos. Default: ${DEFAULT_DEDUP_MINUTES}.
  --sound               Ruta del .wav local. Default: ${DEFAULT_SOUND_PATH}.
  --log-file            Archivo NDJSON de log. Default: ${DEFAULT_LOG_FILE}.
  --failure-log-file    Archivo NDJSON de fallos KeyDrop. Default: ${DEFAULT_FAILURE_LOG_FILE}.
  --sound-test          Prueba el sonido y sale.
  --keydrop-bridge      Activa puente local para la pagina de KeyDrop.
  --bridge-host         Host del puente. Default: ${DEFAULT_BRIDGE_HOST}.
  --bridge-port         Puerto del puente. Default: ${DEFAULT_BRIDGE_PORT}.
  --test                Simula mensajes sin conectar a Twitch.

Variables de entorno equivalentes:
  TWITCH_CHANNEL, TWITCH_CHANNELS, DEDUP_MINUTES, SOUND_PATH, LOG_FILE,
  FAILURE_LOG_FILE, KEYDROP_BRIDGE, KEYDROP_BRIDGE_HOST, KEYDROP_BRIDGE_PORT
`);
}

function normalizeChannels(value) {
  const unique = new Set();
  const channels = [];

  for (const part of String(value || '').split(/[,\s]+/)) {
    const channel = normalizeChannel(part);
    if (!channel || unique.has(channel)) continue;

    unique.add(channel);
    channels.push(channel);
  }

  return channels;
}

function mergeChannels(...lists) {
  return normalizeChannels(lists.flat().join(','));
}

function normalizeChannel(channel) {
  return String(channel || '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase();
}

function formatChannels(channels) {
  return channels.map((channel) => `#${channel}`).join(', ');
}

function booleanFrom(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function connectToTwitch(channels) {
  clearReconnectTimer();
  const announcedJoins = new Set();

  const ws = new WebSocket(TWITCH_IRC_WS, {
    perMessageDeflate: false,
    handshakeTimeout: 10_000
  });

  currentSocket = ws;
  console.log(`[twitch] Conectando a ${formatChannels(channels)}...`);

  ws.on('open', () => {
    reconnectAttempt = 0;
    const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
    currentNick = nick;
    ws.send('PASS SCHMOOPIIE');
    ws.send(`NICK ${nick}`);
    ws.send(`JOIN ${channels.map((channel) => `#${channel}`).join(',')}`);
    console.log(`[twitch] Sesion IRC abierta. Solicitando JOIN ${formatChannels(channels)}.`);
  });

  ws.on('message', (data) => {
    const payload = data.toString('utf8');
    const lines = payload.split('\r\n');

    for (const line of lines) {
      if (!line) continue;

      if (line.startsWith('PING')) {
        ws.send(line.replace('PING', 'PONG'));
        continue;
      }

      const joinedChannel = extractJoinConfirmation(line, currentNick);
      if (joinedChannel) {
        if (!announcedJoins.has(joinedChannel)) {
          announcedJoins.add(joinedChannel);
          console.log(`[twitch] Join OK #${joinedChannel}`);
        }
        continue;
      }

      const event = extractChatEvent(line);
      if (event) {
        void handleText(event.text, formatSource('twitch', event));
      }
    }
  });

  ws.on('close', (code, reason) => {
    if (currentSocket !== ws) return;
    const reasonText = reason?.length ? ` ${reason.toString()}` : '';
    console.error(`[twitch] Conexion cerrada (${code}).${reasonText}`);
    scheduleReconnect(channels);
  });

  ws.on('error', (error) => {
    if (currentSocket !== ws) return;
    console.error(`[twitch] Error de conexion: ${error.message}`);
    try {
      ws.close();
    } catch {
      scheduleReconnect(channels);
    }
  });
}

function extractJoinConfirmation(line, nick) {
  if (!nick) return null;

  const endOfNamesMatch = line.match(new RegExp(`\\s366\\s+${escapeRegExp(nick)}\\s+#([^\\s]+)\\s+`));
  if (endOfNamesMatch) {
    return normalizeChannel(endOfNamesMatch[1]);
  }

  const joinMatch = line.match(new RegExp(`^:${escapeRegExp(nick)}!.*\\sJOIN\\s+#([^\\s]+)`));
  if (joinMatch) {
    return normalizeChannel(joinMatch[1]);
  }

  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(channels) {
  if (reconnectTimer) return;

  reconnectAttempt += 1;
  const baseDelay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt - 1, 5));
  const jitter = Math.floor(Math.random() * 350);
  const delay = baseDelay + jitter;

  console.log(`[twitch] Reconexion automatica en ${delay} ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToTwitch(channels);
  }, delay);
}

function extractChatEvent(line) {
  const markerIndex = line.indexOf(' PRIVMSG ');
  if (markerIndex === -1) return null;

  const messageIndex = line.indexOf(' :', markerIndex);
  if (messageIndex === -1) return null;

  const channelStart = markerIndex + ' PRIVMSG '.length;
  const userMatch = line.slice(0, markerIndex).match(/(?:^|\s):([^!]+)!/);

  return {
    channel: normalizeChannel(line.slice(channelStart, messageIndex)),
    user: (userMatch?.[1] || 'unknown').toLowerCase(),
    text: line.slice(messageIndex + 2)
  };
}

function formatSource(source, event) {
  if (!event.channel) return source;
  return `${source}:${event.channel}`;
}

async function handleText(text, source) {
  const codes = extractCodes(text);
  if (codes.length === 0) return;

  for (const code of codes) {
    await handleCode(code, text, source);
  }
}

function extractCodes(text) {
  CODE_REGEX.lastIndex = 0;
  const matches = [];
  let match;

  while ((match = CODE_REGEX.exec(text)) !== null) {
    matches.push(match[1].toUpperCase());
  }

  return matches;
}

async function handleCode(code, text, source) {
  const now = Date.now();
  pruneDedup(now);

  const previous = seenCodes.get(code);
  if (previous && now - previous < dedupMs) {
    console.log(`[dedup] Ignorado codigo repetido: ${code}`);
    return;
  }

  seenCodes.set(code, now);

  let copyResult;
  try {
    copyResult = await copyToClipboard(code);
  } catch (error) {
    seenCodes.delete(code);
    console.error(`[clipboard] No se pudo copiar ${code}. ${error.message}`);
    return;
  }

  broadcastCodeToBridge(code);
  playSoundAsync(options.soundPath);
  console.log(`[${new Date().toISOString()}] COPIADO ${code} desde ${source} (${copyResult.method})`);
  writeLogAsync({
    ts: new Date().toISOString(),
    code,
    source,
    message: text,
    clipboard: copyResult.method
  });
}

function startKeydropBridge() {
  const server = createServer((request, response) => {
    if (!isAllowedBridgeOrigin(request.headers.origin)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      const origin = request.headers.origin;
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ...(origin ? { 'Access-Control-Allow-Origin': origin } : {})
      });
      response.end(JSON.stringify({
        ok: true,
        clients: bridgeClients.size,
        ts: new Date().toISOString()
      }));
      return;
    }

    response.writeHead(404);
    response.end('Not Found');
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (!isAllowedBridgeOrigin(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname !== '/codes') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request) => {
    bridgeClients.add(ws);
    console.log(`[bridge] KeyDrop conectado (${request.headers.origin || 'sin origin'}). Clientes: ${bridgeClients.size}`);

    ws.send(JSON.stringify({
      type: 'hello',
      ts: new Date().toISOString()
    }));

    ws.on('message', (data) => {
      handleBridgeMessage(data);
    });

    ws.on('close', () => {
      bridgeClients.delete(ws);
      console.log(`[bridge] KeyDrop desconectado. Clientes: ${bridgeClients.size}`);
    });

    ws.on('error', (error) => {
      console.error(`[bridge] Error WebSocket: ${error.message}`);
      bridgeClients.delete(ws);
    });
  });

  server.on('error', (error) => {
    console.error(`[bridge] No se pudo iniciar el puente KeyDrop: ${error.message}`);
  });

  server.listen(options.bridgePort, options.bridgeHost, () => {
    console.log(`[bridge] Puente KeyDrop escuchando en ws://${options.bridgeHost}:${options.bridgePort}/codes`);
  });
}

function handleBridgeMessage(data) {
  let message;
  try {
    message = JSON.parse(data.toString('utf8'));
  } catch {
    return;
  }

  if (message.type === 'redeem-failure') {
    handleRedeemFailureMessage(message);
    return;
  }

  if (message.type !== 'browser-alert') return;

  const now = Date.now();
  const reason = typeof message.reason === 'string' ? message.reason : 'sin detalle';
  console.error(`[bridge] Alerta navegador: ${reason}`);

  if (now - lastBridgeAlertAt >= BRIDGE_ALERT_THROTTLE_MS) {
    lastBridgeAlertAt = now;
    playSoundAsync(options.soundPath);
  }
}

function handleRedeemFailureMessage(message) {
  const failure = message.failure && typeof message.failure === 'object' ? message.failure : {};
  const code = typeof failure.code === 'string' ? failure.code : 'sin-codigo';
  const reason = typeof failure.reason === 'string' ? failure.reason : 'sin detalle';

  console.error(`[bridge] Fallo KeyDrop ${code}: ${reason}`);
  writeFailureLogAsync({
    ts: new Date().toISOString(),
    source: 'keydrop-browser',
    ...failure
  });
}

function isAllowedBridgeOrigin(origin) {
  return !origin || KEYDROP_ALLOWED_ORIGINS.has(origin);
}

function broadcastCodeToBridge(code) {
  if (!options.keydropBridge || bridgeClients.size === 0) return;

  const payload = JSON.stringify({
    type: 'code',
    code,
    ts: new Date().toISOString()
  });

  for (const client of bridgeClients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    try {
      client.send(payload);
    } catch (error) {
      console.error(`[bridge] No se pudo enviar ${code}: ${error.message}`);
    }
  }

  console.log(`[bridge] Codigo enviado a KeyDrop: ${code}`);
}

function pruneDedup(now) {
  if (dedupMs === 0) {
    seenCodes.clear();
    return;
  }

  for (const [code, firstSeen] of seenCodes) {
    if (now - firstSeen >= dedupMs) {
      seenCodes.delete(code);
    }
  }
}

async function copyToClipboard(code) {
  try {
    await clipboard.write(code);
    return { method: 'clipboardy' };
  } catch (clipboardyError) {
    try {
      await copyWithPowerShell(code);
      return { method: 'powershell fallback' };
    } catch (fallbackError) {
      throw new Error(`clipboardy fallo (${clipboardyError.message}); fallback PowerShell fallo (${fallbackError.message})`);
    }
  }
}

function copyWithPowerShell(code) {
  return new Promise((resolve, reject) => {
    const command = `Set-Clipboard -Value "${code}"`;
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `PowerShell salio con codigo ${exitCode}`));
      }
    });
  });
}

function playSoundAsync(soundPath) {
  const command = buildSoundCommand(soundPath);

  try {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command
    ], {
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
        console.error(`[sound] PowerShell salio con codigo ${exitCode}: ${stderr.trim() || 'sin detalle'}`);
      } else if (stderr.trim()) {
        console.error(`[sound] Aviso: ${stderr.trim()}`);
      }
    });
  } catch (error) {
    console.error(`[sound] No se pudo iniciar sonido: ${error.message}`);
  }
}

function buildSoundCommand(soundPath) {
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
    '    [Console]::Error.WriteLine("No existe el WAV: " + $path)',
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

async function runSoundTest() {
  console.log(`Probando sonido: ${options.soundPath}`);
  playSoundAsync(options.soundPath);
  await sleep(1200);
  console.log('Prueba de sonido finalizada. Si no se oyo nada, prueba otro WAV con --sound.');
}

function writeLogAsync(entry) {
  writeJsonLineAsync(options.logFile, entry, 'log');
}

function writeFailureLogAsync(entry) {
  writeJsonLineAsync(options.failureLogFile, entry, 'failure-log');
}

function writeJsonLineAsync(filePath, entry, label) {
  const line = `${JSON.stringify(entry)}\n`;
  const logDirectory = path.dirname(filePath);

  void mkdir(logDirectory, { recursive: true })
    .then(() => appendFile(filePath, line, 'utf8'))
    .catch((error) => {
      console.error(`[${label}] No se pudo escribir: ${error.message}`);
    });
}

async function runTestMode() {
  console.log('Modo de prueba: simulando mensajes de chat.');
  console.log(`Deduplicacion: ${options.dedupMinutes} minuto(s)`);
  console.log(`Sonido: ${options.soundPath}`);
  console.log(`Log: ${options.logFile}`);

  const messages = [
    'BE9D-EDF2-2DA6-2216',
    '\\u{1F37E}A1B2-C3D4-E5F6-7890\\u{1F37E}',
    'mensaje normal sin codigo',
    'claim BE9D-EDF2-2DA6-2216 rapido',
    'Codigo: 0bad-cafe-BEEF-1234'
  ];

  for (const rawMessage of messages) {
    const message = rawMessage.replaceAll('\\u{1F37E}', '\u{1F37E}');
    console.log(`[test] ${message}`);
    await handleText(message, 'test');
    await sleep(300);
  }

  await sleep(500);
  console.log('Modo de prueba finalizado.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
