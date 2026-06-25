import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';
import { DEFAULT_SOUND_PATH, playSoundAsync } from './platform.js';

const DEFAULT_LOG_FILE = path.resolve('logs', 'giveaway-alerts.ndjson');
const DEFAULT_THRESHOLD = 4;
const DEFAULT_WINDOW_SECONDS = 12;
const DEFAULT_COOLDOWN_SECONDS = 90;
const DEFAULT_MIN_LENGTH = 3;
const DEFAULT_MAX_LENGTH = 32;
const TWITCH_IRC_WS = 'wss://irc-ws.chat.twitch.tv:443';

const options = parseArgs(process.argv.slice(2));
const windowMs = Math.max(1, options.windowSeconds) * 1000;
const cooldownMs = Math.max(0, options.cooldownSeconds) * 1000;
const historyByChannel = new Map();
const lastAlerts = new Map();
let reconnectAttempt = 0;
let reconnectTimer = null;
let currentSocket = null;
let currentNick = null;

if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.soundTest) {
  await runSoundTest();
} else if (options.testMode) {
  await runTestMode();
} else {
  if (options.channels.length === 0) {
    console.error('Faltan canales. Usa: npm run giveaways -- --channels canal1,canal2');
    console.error('Tambien puedes definir TWITCH_CHANNELS=canal1,canal2.');
    process.exit(1);
  }

  console.log('Twitch Giveaway Listener');
  console.log(`Canales: ${formatChannels(options.channels)}`);
  console.log(`Regla: ${options.threshold} usuarios distintos con la misma palabra en ${options.windowSeconds}s`);
  console.log(`Cooldown: ${options.cooldownSeconds}s`);
  console.log(`Sonido: ${options.soundPath}`);
  console.log(`Log: ${options.logFile}`);
  connectToTwitch(options.channels);
}

function parseArgs(args) {
  const parsed = {
    channels: normalizeChannels(process.env.TWITCH_CHANNELS || process.env.TWITCH_CHANNEL || ''),
    threshold: numberFrom(process.env.GIVEAWAY_THRESHOLD, DEFAULT_THRESHOLD),
    windowSeconds: numberFrom(process.env.GIVEAWAY_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS),
    cooldownSeconds: numberFrom(process.env.GIVEAWAY_COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS),
    minLength: numberFrom(process.env.GIVEAWAY_MIN_LENGTH, DEFAULT_MIN_LENGTH),
    maxLength: numberFrom(process.env.GIVEAWAY_MAX_LENGTH, DEFAULT_MAX_LENGTH),
    soundPath: process.env.SOUND_PATH || DEFAULT_SOUND_PATH,
    logFile: path.resolve(process.env.GIVEAWAY_LOG_FILE || DEFAULT_LOG_FILE),
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
    } else if (arg === '--channel' || arg === '-c' || arg === '--channels') {
      parsed.channels = normalizeChannels(args[++index] || '');
    } else if (arg.startsWith('--channel=')) {
      parsed.channels = normalizeChannels(arg.slice('--channel='.length));
    } else if (arg.startsWith('--channels=')) {
      parsed.channels = normalizeChannels(arg.slice('--channels='.length));
    } else if (arg === '--threshold' || arg === '--giveaway-threshold') {
      parsed.threshold = numberFrom(args[++index], DEFAULT_THRESHOLD);
    } else if (arg.startsWith('--threshold=')) {
      parsed.threshold = numberFrom(arg.slice('--threshold='.length), DEFAULT_THRESHOLD);
    } else if (arg.startsWith('--giveaway-threshold=')) {
      parsed.threshold = numberFrom(arg.slice('--giveaway-threshold='.length), DEFAULT_THRESHOLD);
    } else if (arg === '--window-seconds' || arg === '--giveaway-window-seconds') {
      parsed.windowSeconds = numberFrom(args[++index], DEFAULT_WINDOW_SECONDS);
    } else if (arg.startsWith('--window-seconds=')) {
      parsed.windowSeconds = numberFrom(arg.slice('--window-seconds='.length), DEFAULT_WINDOW_SECONDS);
    } else if (arg.startsWith('--giveaway-window-seconds=')) {
      parsed.windowSeconds = numberFrom(arg.slice('--giveaway-window-seconds='.length), DEFAULT_WINDOW_SECONDS);
    } else if (arg === '--cooldown-seconds' || arg === '--giveaway-cooldown-seconds') {
      parsed.cooldownSeconds = numberFrom(args[++index], DEFAULT_COOLDOWN_SECONDS);
    } else if (arg.startsWith('--cooldown-seconds=')) {
      parsed.cooldownSeconds = numberFrom(arg.slice('--cooldown-seconds='.length), DEFAULT_COOLDOWN_SECONDS);
    } else if (arg.startsWith('--giveaway-cooldown-seconds=')) {
      parsed.cooldownSeconds = numberFrom(arg.slice('--giveaway-cooldown-seconds='.length), DEFAULT_COOLDOWN_SECONDS);
    } else if (arg === '--min-length' || arg === '--giveaway-min-length') {
      parsed.minLength = numberFrom(args[++index], DEFAULT_MIN_LENGTH);
    } else if (arg.startsWith('--min-length=')) {
      parsed.minLength = numberFrom(arg.slice('--min-length='.length), DEFAULT_MIN_LENGTH);
    } else if (arg.startsWith('--giveaway-min-length=')) {
      parsed.minLength = numberFrom(arg.slice('--giveaway-min-length='.length), DEFAULT_MIN_LENGTH);
    } else if (arg === '--max-length' || arg === '--giveaway-max-length') {
      parsed.maxLength = numberFrom(args[++index], DEFAULT_MAX_LENGTH);
    } else if (arg.startsWith('--max-length=')) {
      parsed.maxLength = numberFrom(arg.slice('--max-length='.length), DEFAULT_MAX_LENGTH);
    } else if (arg.startsWith('--giveaway-max-length=')) {
      parsed.maxLength = numberFrom(arg.slice('--giveaway-max-length='.length), DEFAULT_MAX_LENGTH);
    } else if (arg === '--sound') {
      parsed.soundPath = args[++index] || DEFAULT_SOUND_PATH;
    } else if (arg.startsWith('--sound=')) {
      parsed.soundPath = arg.slice('--sound='.length) || DEFAULT_SOUND_PATH;
    } else if (arg === '--log-file' || arg === '--giveaway-log-file') {
      parsed.logFile = path.resolve(args[++index] || DEFAULT_LOG_FILE);
    } else if (arg.startsWith('--log-file=')) {
      parsed.logFile = path.resolve(arg.slice('--log-file='.length) || DEFAULT_LOG_FILE);
    } else if (arg.startsWith('--giveaway-log-file=')) {
      parsed.logFile = path.resolve(arg.slice('--giveaway-log-file='.length) || DEFAULT_LOG_FILE);
    } else if (!arg.startsWith('-')) {
      parsed.channels = mergeChannels(parsed.channels, normalizeChannels(arg));
    }
  }

  parsed.threshold = clampInteger(parsed.threshold, 2, 50, DEFAULT_THRESHOLD);
  parsed.windowSeconds = clampInteger(parsed.windowSeconds, 1, 300, DEFAULT_WINDOW_SECONDS);
  parsed.cooldownSeconds = clampInteger(parsed.cooldownSeconds, 0, 3600, DEFAULT_COOLDOWN_SECONDS);
  parsed.minLength = clampInteger(parsed.minLength, 1, 128, DEFAULT_MIN_LENGTH);
  parsed.maxLength = clampInteger(parsed.maxLength, parsed.minLength, 256, DEFAULT_MAX_LENGTH);

  return parsed;
}

function printHelp() {
  console.log(`
Uso:
  npm run giveaways -- --channels canal1,canal2

Opciones:
  --channel, -c          Canal de Twitch sin #.
  --channels             Varios canales separados por coma o espacios.
  --threshold            Usuarios distintos necesarios. Default: ${DEFAULT_THRESHOLD}.
  --window-seconds       Ventana de deteccion. Default: ${DEFAULT_WINDOW_SECONDS}.
  --cooldown-seconds     Segundos antes de repetir canal/palabra. Default: ${DEFAULT_COOLDOWN_SECONDS}.
  --min-length           Longitud minima de palabra. Default: ${DEFAULT_MIN_LENGTH}.
  --max-length           Longitud maxima de palabra. Default: ${DEFAULT_MAX_LENGTH}.
  --sound                Ruta del archivo de sonido. Default: ${DEFAULT_SOUND_PATH}.
  --log-file             Archivo NDJSON de alertas. Default: ${DEFAULT_LOG_FILE}.
  --sound-test           Prueba el sonido y sale.
  --test                 Simula mensajes sin conectar a Twitch.

Variables de entorno equivalentes:
  TWITCH_CHANNELS, TWITCH_CHANNEL, GIVEAWAY_THRESHOLD,
  GIVEAWAY_WINDOW_SECONDS, GIVEAWAY_COOLDOWN_SECONDS,
  GIVEAWAY_MIN_LENGTH, GIVEAWAY_MAX_LENGTH, GIVEAWAY_LOG_FILE, SOUND_PATH
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

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
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
        handleChatEvent(event, 'twitch');
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

function handleChatEvent(event, source) {
  const keyword = normalizeGiveawayCandidate(event.text);
  if (!keyword) return;

  const now = Date.now();
  const history = getChannelHistory(event.channel, now);

  history.push({
    at: now,
    user: event.user,
    keyword,
    raw: event.text
  });

  const matching = history.filter((item) => item.keyword === keyword);
  const users = new Set(matching.map((item) => item.user));
  if (users.size < options.threshold) return;

  const alertKey = `${event.channel}:${keyword}`;
  const lastAlertAt = lastAlerts.get(alertKey) || 0;
  if (now - lastAlertAt < cooldownMs) return;

  lastAlerts.set(alertKey, now);

  console.log(`[sorteo] Posible sorteo en #${event.channel}: "${keyword}" (${users.size} usuarios distintos en ${options.windowSeconds}s)`);
  playSoundAsync(options.soundPath);
  writeLogAsync({
    ts: new Date().toISOString(),
    source,
    channel: event.channel,
    keyword,
    distinctUsers: users.size,
    threshold: options.threshold,
    windowSeconds: options.windowSeconds,
    samples: matching.slice(-options.threshold).map((item) => ({
      user: item.user,
      message: item.raw
    }))
  });
}

function getChannelHistory(channel, now) {
  const existing = historyByChannel.get(channel) || [];
  const fresh = existing.filter((item) => now - item.at <= windowMs);
  historyByChannel.set(channel, fresh);
  return fresh;
}

function normalizeGiveawayCandidate(text) {
  const compact = String(text || '').trim().replace(/\s+/g, ' ');
  if (!compact || compact.includes(' ')) return null;

  const normalized = compact
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^[."'`,;:()[\]{}<>]+|[."'`,;:()[\]{}<>]+$/g, '');

  const lengthForLimit = normalized.replace(/^[!#]+/, '').length;
  if (lengthForLimit < options.minLength || lengthForLimit > options.maxLength) {
    return null;
  }

  if (!/^[!#]?[a-z0-9_-]+$/.test(normalized)) return null;

  return normalized;
}

async function runSoundTest() {
  console.log(`Probando sonido: ${options.soundPath}`);
  playSoundAsync(options.soundPath);
  await sleep(1200);
  console.log('Prueba de sonido finalizada. Si no se oyo nada, prueba otro WAV con --sound.');
}

function writeLogAsync(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  const logDirectory = path.dirname(options.logFile);

  void mkdir(logDirectory, { recursive: true })
    .then(() => appendFile(options.logFile, line, 'utf8'))
    .catch((error) => {
      console.error(`[log] No se pudo escribir: ${error.message}`);
    });
}

async function runTestMode() {
  console.log('Modo de prueba: simulando posible sorteo con palabra "diamante".');
  console.log(`Regla: ${options.threshold} usuarios distintos en ${options.windowSeconds}s`);
  console.log(`Sonido: ${options.soundPath}`);
  console.log(`Log: ${options.logFile}`);

  for (let index = 1; index <= options.threshold; index += 1) {
    handleChatEvent({
      channel: 'test',
      user: `viewer${index}`,
      text: 'diamante'
    }, 'test');
    await sleep(150);
  }

  await sleep(500);
  console.log('Modo de prueba finalizado.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
