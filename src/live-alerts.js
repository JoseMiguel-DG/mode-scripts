import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const CONFIG_SECRETS_FILE = path.resolve('config', 'secrets.json');
const DEFAULT_LOG_FILE = path.resolve('logs', 'live-alerts.ndjson');
const DEFAULT_POLL_SECONDS = 60;
const MIN_POLL_SECONDS = 20;
const DECAPI_BASE_URL = 'https://decapi.me/twitch';

const options = await loadOptions();
const liveStates = new Map();

if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.channels.length === 0) {
  console.error('Faltan canales. Usa --channels canal1,canal2');
  process.exit(1);
}

if (!options.webhookUrl && !options.dryRun) {
  console.error('Falta DISCORD_WEBHOOK_URL o config/secrets.json con discordWebhookUrl.');
  process.exit(1);
}

if (options.dryRun) {
  console.log('[live] Dry-run: no se enviaran mensajes a Discord.');
}

console.log(`[live] Canales: ${options.channels.map((channel) => `#${channel}`).join(', ')}`);
console.log(`[live] Poll: ${options.pollSeconds}s`);
console.log(`[live] Mention everyone: ${options.mentionEveryone ? 'ON' : 'OFF'}`);

for (const channel of options.channels) {
  console.log(`[live] Monitor OK #${channel}`);
}

await pollAllChannels({ firstRun: true });
if (!options.once) {
  setInterval(() => {
    void pollAllChannels({ firstRun: false });
  }, options.pollSeconds * 1000);
}

async function loadOptions() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const secrets = await loadSecrets();
  const channels = normalizeChannels(cliOptions.channels || process.env.LIVE_CHANNELS || process.env.TWITCH_LIVE_CHANNELS);
  const pollSeconds = clampInteger(
    cliOptions.pollSeconds ?? process.env.LIVE_POLL_SECONDS,
    MIN_POLL_SECONDS,
    3600,
    DEFAULT_POLL_SECONDS
  );

  return {
    help: cliOptions.help,
    channels,
    pollSeconds,
    webhookUrl: cliOptions.webhookUrl || process.env.DISCORD_WEBHOOK_URL || secrets.discordWebhookUrl || '',
    mentionEveryone: cliOptions.mentionEveryone ?? parseBoolean(process.env.DISCORD_NOTIFY_EVERYONE, true),
    alertOnStartLive: cliOptions.alertOnStartLive ?? parseBoolean(process.env.LIVE_ALERT_ON_START_LIVE, false),
    logFile: path.resolve(cliOptions.logFile || process.env.LIVE_ALERT_LOG_FILE || DEFAULT_LOG_FILE),
    dryRun: Boolean(cliOptions.dryRun),
    once: Boolean(cliOptions.once)
  };
}

function parseArgs(args) {
  const parsed = {
    channels: '',
    pollSeconds: undefined,
    webhookUrl: '',
    mentionEveryone: undefined,
    alertOnStartLive: undefined,
    logFile: '',
    dryRun: false,
    once: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--channel' || arg === '--channels') {
      parsed.channels = args[++index] || '';
    } else if (arg.startsWith('--channel=')) {
      parsed.channels = arg.slice('--channel='.length);
    } else if (arg.startsWith('--channels=')) {
      parsed.channels = arg.slice('--channels='.length);
    } else if (arg === '--poll-seconds') {
      parsed.pollSeconds = args[++index];
    } else if (arg.startsWith('--poll-seconds=')) {
      parsed.pollSeconds = arg.slice('--poll-seconds='.length);
    } else if (arg === '--webhook-url') {
      parsed.webhookUrl = args[++index] || '';
    } else if (arg.startsWith('--webhook-url=')) {
      parsed.webhookUrl = arg.slice('--webhook-url='.length);
    } else if (arg === '--everyone') {
      parsed.mentionEveryone = true;
    } else if (arg === '--no-everyone') {
      parsed.mentionEveryone = false;
    } else if (arg === '--alert-on-start-live') {
      parsed.alertOnStartLive = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--once') {
      parsed.once = true;
    } else if (arg === '--log-file') {
      parsed.logFile = args[++index] || '';
    } else if (arg.startsWith('--log-file=')) {
      parsed.logFile = arg.slice('--log-file='.length);
    }
  }

  return parsed;
}

async function pollAllChannels({ firstRun }) {
  await Promise.all(options.channels.map((channel) => pollChannel(channel, firstRun)));
}

async function pollChannel(channel, firstRun) {
  try {
    const status = await fetchTwitchUptime(channel);
    const previousState = liveStates.get(channel);
    liveStates.set(channel, status.live);

    if (!status.live) {
      if (previousState !== false) {
        console.log(`[live] OFFLINE #${channel}`);
      }
      return;
    }

    const shouldNotify = previousState === false || (previousState === undefined && firstRun && options.alertOnStartLive);
    if (!shouldNotify) {
      if (previousState === undefined) {
        console.log(`[live] Ya estaba en directo #${channel}: ${status.detail}`);
      }
      return;
    }

    await sendLiveAlert(channel, status);
  } catch (error) {
    console.error(`[live] Error #${channel}: ${error.message}`);
  }
}

async function fetchTwitchUptime(channel) {
  const text = await fetchText(`${DECAPI_BASE_URL}/uptime/${encodeURIComponent(channel)}`);
  const normalized = text.trim();
  const offline = normalized.toLowerCase().includes(' is offline');

  return {
    channel,
    live: !offline,
    detail: normalized
  };
}

async function sendLiveAlert(channel, status) {
  const url = `https://www.twitch.tv/${channel}`;
  const content = `${options.mentionEveryone ? '@everyone ' : ''}[LIVE] #${channel} acaba de iniciar directo: ${url}`;
  const payload = {
    content,
    allowed_mentions: options.mentionEveryone ? { parse: ['everyone'] } : { parse: [] },
    embeds: [
      {
        title: `#${channel} esta en directo`,
        url,
        description: status.detail,
        color: 0xff0018,
        timestamp: new Date().toISOString()
      }
    ]
  };

  if (options.dryRun) {
    console.log(`[live-alert] DRY RUN #${channel}: ${content}`);
  } else {
    await postDiscordWebhook(payload);
    console.log(`[live-alert] Discord enviado #${channel}`);
  }

  writeLogAsync({
    ts: new Date().toISOString(),
    channel,
    twitchUrl: url,
    detail: status.detail,
    mentionEveryone: options.mentionEveryone,
    dryRun: options.dryRun
  });
}

async function postDiscordWebhook(payload) {
  const response = await fetchWithTimeout(options.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      'user-agent': 'mode-scripts-live-alerts/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadSecrets() {
  try {
    const raw = await readFile(CONFIG_SECRETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLogAsync(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  const logDirectory = path.dirname(options.logFile);

  void mkdir(logDirectory, { recursive: true })
    .then(() => appendFile(options.logFile, line, 'utf8'))
    .catch((error) => {
      console.error(`[live-log] No se pudo escribir: ${error.message}`);
    });
}

function normalizeChannels(value) {
  const unique = new Set();
  const channels = [];

  for (const part of String(value || '').split(/[,\s]+/)) {
    const channel = String(part || '')
      .trim()
      .replace(/^#/, '')
      .toLowerCase();
    if (!channel || unique.has(channel)) continue;

    unique.add(channel);
    channels.push(channel);
  }

  return channels;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'si', 's', 'on'].includes(String(value).toLowerCase());
}

function printHelp() {
  console.log(`Uso:
  npm run live-alerts -- --channels canal1,canal2

Opciones:
  --channels             Canales separados por coma.
  --poll-seconds         Intervalo de comprobacion. Default: ${DEFAULT_POLL_SECONDS}.
  --webhook-url          Webhook de Discord. Mejor usar DISCORD_WEBHOOK_URL o config/secrets.json.
  --everyone             Envia @everyone. Activado por defecto.
  --no-everyone          No menciona @everyone.
  --alert-on-start-live  Avisa si el canal ya estaba en directo al arrancar.
  --dry-run              No envia a Discord.
  --once                 Comprueba una vez y sale.
`);
}
