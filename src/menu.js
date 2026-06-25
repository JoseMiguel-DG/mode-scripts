import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { formatSyncResult, syncConfigToGit } from './config-sync.js';

const APP_TITLE = 'Mode-Scripts v1';
const CONFIG_FILE = path.resolve('config', 'mode-scripts.json');
const DEFAULT_THRESHOLD = 4;
const DEFAULT_WINDOW_SECONDS = 12;
const DEFAULT_COOLDOWN_SECONDS = 90;
const LOG_LINES = 13;
const UI_WIDTH = 92;
const BODY_START_ROW = 11;
const MODES = new Set(['codes', 'codes-giveaways', 'giveaways']);
const MODE_LABELS = {
  codes: 'Solo codigos',
  'codes-giveaways': 'Codigos + deteccion de sorteos',
  giveaways: 'Solo deteccion de sorteos'
};
const DEFAULT_CONFIG = {
  mode: 'codes-giveaways',
  codeChannels: [],
  giveawayChannels: [],
  keydropBridge: false,
  giveawayThreshold: DEFAULT_THRESHOLD,
  giveawayWindowSeconds: DEFAULT_WINDOW_SECONDS,
  giveawayCooldownSeconds: DEFAULT_COOLDOWN_SECONDS
};
const childProcesses = new Set();
let dashboardTimer = null;
let dashboardState = null;
let dashboardCommandsActive = false;
let dashboardForceStopTimer = null;
let dashboardScrollOffset = 0;

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  blood: '\x1b[38;2;255;0;24m',
  darkRed: '\x1b[38;2;126;0;18m',
  inferno: '\x1b[38;2;255;38;0m',
  ember: '\x1b[38;2;255;112;0m',
  ash: '\x1b[38;2;148;163;184m',
  bone: '\x1b[38;2;241;245;249m',
  neon: '\x1b[38;2;57;255;20m',
  acid: '\x1b[38;2;190;255;0m',
  hot: '\x1b[38;2;255;0;128m',
  alert: '\x1b[38;2;255;49;49m',
  amber: '\x1b[38;2;255;184;28m',
  violet: '\x1b[38;2;177;94;255m',
  steel: '\x1b[38;2;125;211;252m',
  panel: '\x1b[38;2;15;255;210m',
  muted: '\x1b[38;2;100;116;139m'
};
let tuiActive = false;

if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
  printHelp();
  process.exit(0);
}

if (!input.isTTY || !output.isTTY) {
  console.error('El menu TUI necesita una terminal interactiva. Ejecuta: npm run menu');
  process.exit(1);
}

enterTui();
process.on('exit', leaveTui);
const rl = createInterface({ input, output });

try {
  const config = await loadConfig();
  const shouldLaunch = await mainMenu(config);

  if (!shouldLaunch) {
    await rl.close();
    process.exit(0);
  }
} catch (error) {
  await rl.close();
  leaveTui();
  console.error(style(`No se pudo iniciar el menu: ${error.message}`, 'red'));
  process.exit(1);
}

async function mainMenu(config) {
  while (true) {
    renderHome(config);
    const choice = await askChoice('Selecciona opcion [1]: ', ['1', '2', '3', '4', '5', '6', '7', '8', '9'], '1');

    if (choice === '1') {
      const session = await buildSessionConfig(config);
      if (!session) {
        await pause();
        continue;
      }

      startDashboard(session);
      return true;
    }

    if (choice === '2') {
      await changeMode(config);
    } else if (choice === '3') {
      await manageCodeChannel(config);
    } else if (choice === '4') {
      await manageGiveawayChannels(config);
    } else if (choice === '5') {
      await manageGiveawaySettings(config);
    } else if (choice === '6') {
      config.keydropBridge = !config.keydropBridge;
      await saveConfig(config);
      printStatus(`KeyDrop bridge: ${config.keydropBridge ? 'activado' : 'desactivado'}.`);
      await pause();
    } else if (choice === '7') {
      renderConfigPath();
      await pause();
    } else if (choice === '8') {
      await pushConfigToGitHub(config);
    } else if (choice === '9') {
      return false;
    }
  }
}

function renderHome(config) {
  clearScreen();
  printBanner('CONTROL PANEL');
  printSignalStrip(config);
  printBox('CONFIG GUARDADA // SIGNAL MAP', [
    metric('MODO', MODE_LABELS[config.mode] || config.mode, 'hot'),
    metric('CODIGOS', formatChannels(config.codeChannels) || 'sin configurar', config.codeChannels.length ? 'neon' : 'muted'),
    metric('SORTEOS', formatChannels(config.giveawayChannels) || 'sin configurar', config.giveawayChannels.length ? 'acid' : 'muted'),
    metric('REGLA', `${config.giveawayThreshold} usuarios / ${config.giveawayWindowSeconds}s`, 'amber'),
    metric('COOLDOWN', `${config.giveawayCooldownSeconds}s`, 'steel'),
    metric('KEYDROP', config.keydropBridge ? 'BRIDGE ON' : 'BRIDGE OFF', config.keydropBridge ? 'neon' : 'muted'),
    metric('CONFIG', CONFIG_FILE, 'steel')
  ]);
  printBox('MENU // SELECT VECTOR', [
    menuOption('1', 'Arrancar con configuracion guardada', 'lanza dashboard live'),
    menuOption('2', 'Cambiar modo de arranque', 'codigos / sorteos / ambos'),
    menuOption('3', 'Canales de codigos', 'anadir, eliminar o reemplazar'),
    menuOption('4', 'Canales de sorteos', 'anadir, eliminar o reemplazar'),
    menuOption('5', 'Ajustes detector de sorteos', 'umbral, ventana y cooldown'),
    menuOption('6', 'Activar/desactivar KeyDrop bridge', config.keydropBridge ? 'actualmente ON' : 'actualmente OFF'),
    menuOption('7', 'Ver ruta de configuracion', 'archivo JSON persistente'),
    menuOption('8', 'Subir configuracion a GitHub', 'commit + push automatico'),
    menuOption('9', 'Salir', 'cerrar launcher')
  ]);
}

async function changeMode(config) {
  clearScreen();
  printBanner('BOOT MODE');
  printBox('MODO DE ARRANQUE // ROUTING', [
    menuOption('1', 'Solo codigos', 'copia codigos al portapapeles'),
    menuOption('2', 'Codigos + deteccion de sorteos', 'modo completo'),
    menuOption('3', 'Solo deteccion de sorteos', 'radar de palabras repetidas')
  ]);

  const choice = await askChoice('Nuevo modo [2]: ', ['1', '2', '3'], '2');
  config.mode = choice === '1' ? 'codes' : choice === '2' ? 'codes-giveaways' : 'giveaways';
  await saveConfig(config);
  printStatus(`Modo guardado: ${MODE_LABELS[config.mode]}.`);
  await pause();
}

async function manageCodeChannel(config) {
  while (true) {
    clearScreen();
    printBanner('CODE CHANNELS');
    const channelRows = config.codeChannels.length > 0
      ? config.codeChannels.map(formatSavedChannelRow)
      : [muted('No hay canales de codigos guardados.')];

    printBox('CANALES DE CODIGOS // CLIPBOARD RADAR', [
      ...channelRows,
      '',
      menuOption('1', 'Anadir canal(es)', 'separados por coma'),
      menuOption('2', 'Eliminar canal', 'por numero o nombre'),
      menuOption('3', 'Reemplazar lista completa', 'sobrescribe esta lista'),
      menuOption('4', 'Borrar todos', 'deja la lista vacia'),
      menuOption('5', 'Volver', 'menu principal')
    ]);

    const choice = await askChoice('Selecciona opcion [1]: ', ['1', '2', '3', '4', '5'], '1');
    if (choice === '1') {
      const channels = await askChannels('Canales a anadir separados por coma: ', '');
      config.codeChannels = mergeChannels(config.codeChannels, channels);
      await saveConfig(config);
      printStatus(`Canales guardados: ${formatChannels(config.codeChannels)}.`);
      await pause();
    } else if (choice === '2') {
      if (config.codeChannels.length === 0) {
        printStatus('No hay canales para eliminar.');
        await pause();
        continue;
      }

      const target = (await rl.question(promptText('Numero o nombre de canal a eliminar: '))).trim();
      const removed = removeChannel(config.codeChannels, target);
      if (removed) {
        await saveConfig(config);
        printStatus(`Canal eliminado: #${removed}.`);
      } else {
        printStatus('No se encontro ese canal.');
      }
      await pause();
    } else if (choice === '3') {
      config.codeChannels = await askChannels('Nueva lista completa separada por coma: ', '');
      await saveConfig(config);
      printStatus(`Lista reemplazada: ${formatChannels(config.codeChannels)}.`);
      await pause();
    } else if (choice === '4') {
      config.codeChannels = [];
      await saveConfig(config);
      printStatus('Canales de codigos borrados.');
      await pause();
    } else {
      return;
    }
  }
}

async function manageGiveawayChannels(config) {
  while (true) {
    clearScreen();
    printBanner('GIVEAWAY CHANNELS');
    const channelRows = config.giveawayChannels.length > 0
      ? config.giveawayChannels.map(formatSavedChannelRow)
      : [muted('No hay canales de sorteos guardados.')];

    printBox('CANALES DE SORTEOS // GIVEAWAY RADAR', [
      ...channelRows,
      '',
      menuOption('1', 'Anadir canal(es)', 'separados por coma'),
      menuOption('2', 'Eliminar canal', 'por numero o nombre'),
      menuOption('3', 'Reemplazar lista completa', 'sobrescribe esta lista'),
      menuOption('4', 'Borrar todos', 'deja la lista vacia'),
      menuOption('5', 'Volver', 'menu principal')
    ]);

    const choice = await askChoice('Selecciona opcion [1]: ', ['1', '2', '3', '4', '5'], '1');
    if (choice === '1') {
      const channels = await askChannels('Canales a anadir separados por coma: ', '');
      config.giveawayChannels = mergeChannels(config.giveawayChannels, channels);
      await saveConfig(config);
      printStatus(`Canales guardados: ${formatChannels(config.giveawayChannels)}.`);
      await pause();
    } else if (choice === '2') {
      if (config.giveawayChannels.length === 0) {
        printStatus('No hay canales para eliminar.');
        await pause();
        continue;
      }

      const target = (await rl.question(promptText('Numero o nombre de canal a eliminar: '))).trim();
      const removed = removeChannel(config.giveawayChannels, target);
      if (removed) {
        await saveConfig(config);
        printStatus(`Canal eliminado: #${removed}.`);
      } else {
        printStatus('No se encontro ese canal.');
      }
      await pause();
    } else if (choice === '3') {
      config.giveawayChannels = await askChannels('Nueva lista completa separada por coma: ', '');
      await saveConfig(config);
      printStatus(`Lista reemplazada: ${formatChannels(config.giveawayChannels)}.`);
      await pause();
    } else if (choice === '4') {
      config.giveawayChannels = [];
      await saveConfig(config);
      printStatus('Canales de sorteos borrados.');
      await pause();
    } else {
      return;
    }
  }
}

async function manageGiveawaySettings(config) {
  clearScreen();
  printBanner('GIVEAWAY TUNING');
  printBox('AJUSTES DE SORTEOS // DETECTION RULES', [
    metric('USUARIOS', config.giveawayThreshold, 'acid'),
    metric('VENTANA', `${config.giveawayWindowSeconds}s`, 'amber'),
    metric('COOLDOWN', `${config.giveawayCooldownSeconds}s`, 'steel')
  ]);

  config.giveawayThreshold = await askInteger(`Usuarios distintos [${config.giveawayThreshold}]: `, config.giveawayThreshold, 2, 50);
  config.giveawayWindowSeconds = await askInteger(`Ventana en segundos [${config.giveawayWindowSeconds}]: `, config.giveawayWindowSeconds, 1, 300);
  config.giveawayCooldownSeconds = await askInteger(`Cooldown en segundos [${config.giveawayCooldownSeconds}]: `, config.giveawayCooldownSeconds, 0, 3600);
  await saveConfig(config);
  printStatus('Ajustes de sorteos guardados.');
  await pause();
}

function renderConfigPath() {
  clearScreen();
  printBanner('CONFIG FILE');
  printBox('CONFIG FILE // PERSISTENT STATE', [
    steel(CONFIG_FILE),
    '',
    'Puedes editar este JSON manualmente si quieres.',
    'El menu lo vuelve a cargar cada vez que arrancas npm run menu.'
  ]);
}

async function pushConfigToGitHub(config) {
  clearScreen();
  printBanner('GIT SYNC');
  printBox('SUBIR CONFIG // GITHUB', [
    metric('ARCHIVO', 'config/mode-scripts.json', 'inferno'),
    metric('ALCANCE', 'solo configuracion compartida', 'ember'),
    metric('ACCION', 'git add + commit + push', 'blood'),
    '',
    'Aviso: si el repositorio es publico, los canales guardados tambien seran publicos.'
  ]);

  await saveConfig(config);
  printStatus('Sincronizando configuracion con GitHub...', 'info');

  try {
    const result = await syncConfigToGit();
    printBox('GIT SYNC // OK', formatSyncResult(result).split('\n').map((line) => steel(line)));
  } catch (error) {
    const outputLines = String(error.message || error)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => alert(line));
    printBox('GIT SYNC // ERROR', outputLines.length > 0 ? outputLines : [alert('No se pudo completar el push.')]);
  }

  await pause();
}

async function buildSessionConfig(config) {
  if (modeUsesCodes(config.mode) && config.codeChannels.length === 0) {
    printStatus('Faltan canales de codigos para este modo.');
    config.codeChannels = await askChannels('Canales de codigos separados por coma: ', '');
    await saveConfig(config);
  }

  if (modeUsesGiveaways(config.mode) && config.giveawayChannels.length === 0) {
    if (config.codeChannels.length > 0) {
      const useCodeChannel = await askYesNo(`No hay canales de sorteos. Usar los canales de codigos (${formatChannels(config.codeChannels)})? [S/n]: `, true);
      if (useCodeChannel) {
        config.giveawayChannels = [...config.codeChannels];
      }
    }

    if (config.giveawayChannels.length === 0) {
      config.giveawayChannels = await askChannels('Canales de sorteos separados por coma: ', '');
    }

    await saveConfig(config);
  }

  const processes = [];
  if (modeUsesCodes(config.mode)) {
    const args = ['--channels', config.codeChannels.join(',')];
    if (config.keydropBridge) {
      args.push('--keydrop-bridge');
    }

    processes.push({
      key: 'codigos',
      title: 'Code Clipboard',
      script: 'src/index.js',
      args,
      channels: config.codeChannels,
      connectedChannels: new Set(),
      status: 'starting',
      pid: null
    });
  }

  if (modeUsesGiveaways(config.mode)) {
    processes.push({
      key: 'sorteos',
      title: 'Giveaway Listener',
      script: 'src/giveaways.js',
      args: [
        '--channels',
        config.giveawayChannels.join(','),
        '--threshold',
        String(config.giveawayThreshold),
        '--window-seconds',
        String(config.giveawayWindowSeconds),
        '--cooldown-seconds',
        String(config.giveawayCooldownSeconds)
      ],
      channels: config.giveawayChannels,
      connectedChannels: new Set(),
      status: 'starting',
      pid: null
    });
  }

  if (processes.length === 0) {
    printStatus('No hay procesos para arrancar.');
    return null;
  }

  return {
    mode: config.mode,
    keydropBridge: config.keydropBridge,
    startedAt: Date.now(),
    processes,
    logs: []
  };
}

function startDashboard(session) {
  dashboardState = session;
  dashboardScrollOffset = 0;
  startDashboardCommands();
  renderDashboard();

  for (const childConfig of session.processes) {
    startChild(childConfig);
  }

  dashboardTimer = setInterval(renderDashboard, 1000);
}

function startChild(childConfig) {
  const scriptPath = path.resolve(childConfig.script);
  const child = spawn(process.execPath, [scriptPath, ...childConfig.args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  childConfig.pid = child.pid;
  childConfig.status = 'booting';
  childProcesses.add(child);
  prefixStream(child.stdout, childConfig, false);
  prefixStream(child.stderr, childConfig, true);

  child.on('exit', (code, signal) => {
    childProcesses.delete(child);
    childConfig.status = signal ? `stopped:${signal}` : `exit:${code}`;
    addLog(childConfig.key, `Proceso terminado (${signal ? `signal ${signal}` : `codigo ${code}`}).`, code ? 'error' : 'info');
    renderDashboard();

    if (childProcesses.size === 0) {
      setTimeout(() => finishDashboardExit(code || 0), 500);
    }
  });

  child.on('error', (error) => {
    childProcesses.delete(child);
    childConfig.status = 'error';
    addLog(childConfig.key, `No se pudo arrancar: ${error.message}`, 'error');
    renderDashboard();
  });
}

function prefixStream(stream, childConfig, isError) {
  let buffered = '';

  stream.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || '';

    for (const line of lines) {
      if (line) {
        handleChildLine(childConfig, line, isError);
      }
    }
  });

  stream.on('end', () => {
    if (buffered) {
      handleChildLine(childConfig, buffered, isError);
      buffered = '';
    }
  });
}

function handleChildLine(childConfig, line, isError) {
  const joinedChannel = line.match(/Join OK #([a-z0-9_]+)/i)?.[1];
  if (joinedChannel) {
    childConfig.connectedChannels.add(normalizeChannel(joinedChannel));
    childConfig.status = 'connected';
  } else if (line.includes('Sesion IRC abierta')) {
    childConfig.status = 'joining';
  } else if (line.includes('Reconexion automatica')) {
    childConfig.status = 'reconnecting';
    childConfig.connectedChannels.clear();
  } else if (line.includes('Conexion cerrada') || line.includes('Error de conexion')) {
    childConfig.status = 'disconnected';
  } else if (line.includes('Puente KeyDrop escuchando')) {
    childConfig.bridgeStatus = 'online';
  }

  let level = isError ? 'error' : 'info';
  if (line.includes('[sorteo]') || line.includes('COPIADO')) {
    level = 'hit';
  } else if (joinedChannel) {
    level = 'ok';
  } else if (line.includes('Error') || line.includes('Fallo') || line.includes('cerrada')) {
    level = 'error';
  }

  addLog(childConfig.key, line, level);
  renderDashboard();
}

function renderDashboard() {
  if (!dashboardState) return;

  clearScreen();
  printBanner('LIVE OPS');
  renderDashboardViewport(buildDashboardRows());
}

function buildDashboardRows() {
  if (!dashboardState) return [];

  const rows = [];
  rows.push(...buildBoxRows('RUNNING DASHBOARD // ACTIVE SESSION', [
    metric('MODO', MODE_LABELS[dashboardState.mode], 'hot'),
    metric('UPTIME', formatDuration(Date.now() - dashboardState.startedAt), 'acid'),
    metric('KEYDROP', dashboardState.keydropBridge ? 'BRIDGE ON' : 'BRIDGE OFF', dashboardState.keydropBridge ? 'neon' : 'muted'),
    `${statusPill('SCROLL', 'warn')} down/up, pgdn/pgup, top/bottom`,
    `${statusPill('STOP', 'alert')} escribe stop + Enter para cerrar limpio`,
    `${statusPill('CTRL+C', 'alert')} atajo de parada`
  ]));

  for (const processInfo of dashboardState.processes) {
    rows.push(...buildProcessBoxRows(processInfo));
  }

  rows.push(...buildLogBoxRows(dashboardState.logs));
  return rows;
}

function renderDashboardViewport(rows) {
  const viewportHeight = getDashboardViewportHeight();
  const footerHeight = 3;
  const contentHeight = Math.max(1, viewportHeight - footerHeight);
  const maxOffset = Math.max(0, rows.length - contentHeight);
  dashboardScrollOffset = clampNumber(dashboardScrollOffset, 0, maxOffset);

  const contentRows = rows.slice(dashboardScrollOffset, dashboardScrollOffset + contentHeight);
  while (contentRows.length < contentHeight) {
    contentRows.push('');
  }

  const footerRows = buildDashboardFooterRows(rows.length, contentHeight);
  const outputRows = [...contentRows, ...footerRows].slice(0, viewportHeight);
  writeViewportRows(outputRows);
}

function buildDashboardFooterRows(totalRows, contentHeight) {
  const maxOffset = Math.max(0, totalRows - contentHeight);
  const start = totalRows === 0 ? 0 : dashboardScrollOffset + 1;
  const end = Math.min(totalRows, dashboardScrollOffset + contentHeight);
  const scrollState = maxOffset > 0
    ? `${start}-${end}/${totalRows}`
    : `todo visible (${totalRows})`;

  return [
    panel(boxBorder('', '-')),
    `${statusPill('VIEW', 'info')} ${steel(scrollState)} ${muted('//')} ${statusPill('CMD', 'warn')} ${steel('down up pgdn pgup top bottom stop')}`,
    promptText('cmd: ')
  ];
}

function writeViewportRows(rows) {
  const fittedRows = rows.map((row, index) => {
    if (index === rows.length - 1) {
      return truncateVisible(row, UI_WIDTH);
    }

    return fitVisibleLine(row, UI_WIDTH);
  });
  output.write(fittedRows.join('\n'));
}

function getDashboardViewportHeight() {
  const rows = output.rows || 40;
  return Math.max(4, rows - BODY_START_ROW + 1);
}

function getDashboardContentHeight() {
  return Math.max(1, getDashboardViewportHeight() - 3);
}

function getDashboardMaxScroll() {
  return Math.max(0, buildDashboardRows().length - getDashboardContentHeight());
}

function scrollDashboard(delta) {
  dashboardScrollOffset = clampNumber(dashboardScrollOffset + delta, 0, getDashboardMaxScroll());
  renderDashboard();
}

function setDashboardScroll(position) {
  dashboardScrollOffset = clampNumber(position, 0, getDashboardMaxScroll());
  renderDashboard();
}

function startDashboardCommands() {
  if (dashboardCommandsActive) return;

  dashboardCommandsActive = true;
  rl.on('line', handleDashboardCommand);
  input.resume();
}

function stopDashboardCommands() {
  if (!dashboardCommandsActive) return;

  rl.off('line', handleDashboardCommand);
  dashboardCommandsActive = false;
}

function handleDashboardCommand(rawCommand) {
  if (!dashboardState) return;

  const command = String(rawCommand || '').trim().toLowerCase();
  if (!command) {
    renderDashboard();
    return;
  }

  if (['stop', 'exit', 'quit', 'q'].includes(command)) {
    requestDashboardStop(`Comando "${command}" recibido.`);
    return;
  }

  if (['down', 'd', 'j'].includes(command)) {
    scrollDashboard(3);
    return;
  }

  if (['up', 'u', 'k'].includes(command)) {
    scrollDashboard(-3);
    return;
  }

  if (['pgdn', 'pagedown', 'page down'].includes(command)) {
    scrollDashboard(getDashboardContentHeight());
    return;
  }

  if (['pgup', 'pageup', 'page up'].includes(command)) {
    scrollDashboard(-getDashboardContentHeight());
    return;
  }

  if (['top', 'home'].includes(command)) {
    setDashboardScroll(0);
    return;
  }

  if (['bottom', 'end', 'logs'].includes(command)) {
    setDashboardScroll(getDashboardMaxScroll());
    return;
  }

  addLog('system', `Comando no reconocido: "${command}". Usa stop para cerrar.`, 'error');
  renderDashboard();
}

function requestDashboardStop(reason) {
  if (dashboardState) {
    addLog('system', `${reason} Cerrando listeners...`, 'error');
    renderDashboard();
  }

  stopDashboardCommands();
  stopChildren('SIGTERM');

  if (childProcesses.size === 0) {
    finishDashboardExit(0);
    return;
  }

  if (!dashboardForceStopTimer) {
    dashboardForceStopTimer = setTimeout(() => {
      dashboardForceStopTimer = null;
      if (childProcesses.size === 0) {
        finishDashboardExit(0);
        return;
      }

      addLog('system', 'Forzando cierre de procesos restantes...', 'error');
      renderDashboard();
      stopChildren('SIGKILL');

      if (childProcesses.size === 0) {
        finishDashboardExit(0);
      }
    }, 5000);
  }
}

function finishDashboardExit(code = 0) {
  if (dashboardTimer) {
    clearInterval(dashboardTimer);
    dashboardTimer = null;
  }

  if (dashboardForceStopTimer) {
    clearTimeout(dashboardForceStopTimer);
    dashboardForceStopTimer = null;
  }

  stopDashboardCommands();
  try {
    rl.close();
  } catch {
    // La interfaz puede estar ya cerrada.
  }
  process.exit(code);
}

function printProcessBox(processInfo) {
  for (const row of buildProcessBoxRows(processInfo)) {
    console.log(row);
  }
}

function buildProcessBoxRows(processInfo) {
  const connectedCount = processInfo.channels.filter((channel) => processInfo.connectedChannels.has(channel)).length;
  const channelRows = processInfo.channels.map((channel) => {
    const connected = processInfo.connectedChannels.has(channel);
    return `${connected ? statusPill('JOIN OK', 'ok') : statusPill('WAIT', 'warn')} ${steel('IRC')} ${connected ? neon(`#${channel}`) : amber(`#${channel}`)}`;
  });

  return buildBoxRows(`${processInfo.title.toUpperCase()} // PROCESS NODE`, [
    `${metric('ESTADO', formatProcessStatus(processInfo.status), 'steel')}${processInfo.pid ? `  ${metric('PID', processInfo.pid, 'violet')}` : ''}`,
    `${metric('CANALES', `${connectedCount}/${processInfo.channels.length}`, connectedCount === processInfo.channels.length ? 'neon' : 'amber')} ${signalBar(connectedCount, processInfo.channels.length)}`,
    processInfo.bridgeStatus ? metric('BRIDGE', processInfo.bridgeStatus.toUpperCase(), 'neon') : '',
    ...channelRows
  ].filter(Boolean));
}

function printLogBox(logs) {
  for (const row of buildLogBoxRows(logs)) {
    console.log(row);
  }
}

function buildLogBoxRows(logs) {
  const rows = logs.length > 0
    ? logs.slice(-LOG_LINES).map(formatLogEntry)
    : [muted('Esperando eventos...')];

  return buildBoxRows('LIVE FEED // IRC STREAM', rows);
}

function addLog(source, line, level = 'info') {
  if (!dashboardState) return;

  dashboardState.logs.push({
    time: formatClock(new Date()),
    source,
    line,
    level
  });

  while (dashboardState.logs.length > LOG_LINES) {
    dashboardState.logs.shift();
  }
}

function formatProcessStatus(status) {
  if (status === 'connected') return statusPill('CONNECTED', 'ok');
  if (status === 'joining') return statusPill('JOINING', 'warn');
  if (status === 'booting' || status === 'starting') return statusPill('STARTING', 'warn');
  if (status === 'reconnecting') return statusPill('RECONNECT', 'warn');
  if (status === 'disconnected') return statusPill('DISCONNECTED', 'alert');
  if (status === 'error' || status.startsWith('exit:1')) return statusPill(status.toUpperCase(), 'alert');
  if (status.startsWith('exit:') || status.startsWith('stopped:')) return statusPill(status.toUpperCase(), 'off');
  return status.toUpperCase();
}

function formatLogLine(line, level) {
  if (level === 'error') return alert(line);
  if (level === 'hit') return hot(line);
  if (level === 'ok') return neon(line);
  return steel(line);
}

function formatLogEntry(entry) {
  const level = entry.level === 'error'
    ? 'alert'
    : entry.level === 'hit'
      ? 'hot'
      : entry.level === 'ok'
        ? 'ok'
        : 'info';
  return `${muted(entry.time)} ${statusPill(entry.source.toUpperCase(), level)} ${formatLogLine(entry.line, entry.level)}`;
}

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(style(`Aviso: no se pudo leer ${CONFIG_FILE}. Se usaran valores por defecto.`, 'yellow'));
    }

    const config = normalizeConfig(DEFAULT_CONFIG);
    await saveConfig(config);
    return config;
  }
}

async function saveConfig(config) {
  const normalized = normalizeConfig(config);
  await mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  Object.assign(config, normalized);
}

function normalizeConfig(config) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config && typeof config === 'object' ? config : {})
  };

  return {
    mode: MODES.has(merged.mode) ? merged.mode : DEFAULT_CONFIG.mode,
    codeChannels: normalizeChannels(
      Array.isArray(merged.codeChannels)
        ? merged.codeChannels.join(',')
        : merged.codeChannels || merged.codeChannel
    ),
    giveawayChannels: normalizeChannels(Array.isArray(merged.giveawayChannels) ? merged.giveawayChannels.join(',') : merged.giveawayChannels),
    keydropBridge: Boolean(merged.keydropBridge),
    giveawayThreshold: clampInteger(merged.giveawayThreshold, 2, 50, DEFAULT_THRESHOLD),
    giveawayWindowSeconds: clampInteger(merged.giveawayWindowSeconds, 1, 300, DEFAULT_WINDOW_SECONDS),
    giveawayCooldownSeconds: clampInteger(merged.giveawayCooldownSeconds, 0, 3600, DEFAULT_COOLDOWN_SECONDS)
  };
}

function modeUsesCodes(mode) {
  return mode === 'codes' || mode === 'codes-giveaways';
}

function modeUsesGiveaways(mode) {
  return mode === 'giveaways' || mode === 'codes-giveaways';
}

function removeChannel(channels, target) {
  const normalized = normalizeChannel(target);
  const numericIndex = Number(target) - 1;
  let index = -1;

  if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < channels.length) {
    index = numericIndex;
  } else {
    index = channels.findIndex((channel) => channel === normalized);
  }

  if (index === -1) return null;
  const [removed] = channels.splice(index, 1);
  return removed;
}

async function askChoice(question, allowed, fallback) {
  while (true) {
    const answer = (await rl.question(promptText(question))).trim() || fallback;
    if (allowed.includes(answer)) return answer;
    printStatus(`Opcion no valida. Usa: ${allowed.join(', ')}`, 'error');
  }
}

async function askRequiredChannel(question) {
  while (true) {
    const channel = normalizeChannel(await rl.question(promptText(question)));
    if (channel) return channel;
    printStatus('Escribe un canal de Twitch sin #.', 'error');
  }
}

async function askChannels(question, fallback) {
  while (true) {
    const raw = (await rl.question(promptText(question))).trim() || fallback;
    const channels = normalizeChannels(raw);
    if (channels.length > 0) return channels;
    printStatus('Escribe uno o varios canales separados por coma, por ejemplo: canal1,canal2', 'error');
  }
}

async function askInteger(question, fallback, min, max) {
  while (true) {
    const raw = (await rl.question(promptText(question))).trim();
    if (!raw) return fallback;

    const value = Number(raw);
    if (Number.isInteger(value) && value >= min && value <= max) {
      return value;
    }

    printStatus(`Escribe un numero entero entre ${min} y ${max}.`, 'error');
  }
}

async function askYesNo(question, fallback) {
  while (true) {
    const raw = (await rl.question(promptText(question))).trim().toLowerCase();
    if (!raw) return fallback;
    if (['s', 'si', 'y', 'yes'].includes(raw)) return true;
    if (['n', 'no'].includes(raw)) return false;
    printStatus('Responde s o n.', 'error');
  }
}

async function pause() {
  await rl.question(dim('Enter para continuar...'));
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

function clampInteger(value, min, max, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function menuOption(index, label, hint = '') {
  const prefix = `${hot(`[${index}]`)} ${neon(label)}`;
  return hint ? `${prefix} ${muted('//')} ${steel(hint)}` : prefix;
}

function metric(label, value, color = 'steel') {
  const text = String(value);
  const renderedValue = stripAnsi(text) === text ? style(text, color) : text;
  return `${muted(label.padEnd(9))} ${renderedValue}`;
}

function statusPill(text, level = 'info') {
  const colors = {
    ok: 'neon',
    warn: 'amber',
    alert: 'alert',
    error: 'alert',
    hot: 'hot',
    off: 'muted',
    info: 'steel'
  };
  return style(`[${text}]`, colors[level] || colors.info);
}

function bannerPill(text, color = 'blood') {
  return style(`[${text}]`, color);
}

function signalBar(connected, total) {
  const width = 18;
  const ratio = total > 0 ? connected / total : 0;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `${muted('[')}${neon('#'.repeat(filled))}${muted('-'.repeat(width - filled))}${muted(']')}`;
}

function formatSavedChannelRow(channel, index) {
  return `${muted(String(index + 1).padStart(2, '0'))} ${statusPill('SAVED', 'info')} ${steel('IRC')} ${neon(`#${channel}`)}`;
}

function formatOneChannel(channel) {
  return channel ? `#${channel}` : dim('sin configurar');
}

function formatChannels(channels) {
  return channels.map((channel) => `#${channel}`).join(', ');
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatClock(date) {
  return [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ].map((part) => String(part).padStart(2, '0')).join(':');
}

function promptText(text) {
  return `${hot('mode')}${muted('@')}${neon('scripts')} ${acid('>')} ${steel(text)}`;
}

function printStatus(text, level = 'info') {
  const pillLevel = level === 'error' ? 'alert' : level === 'ok' ? 'ok' : 'warn';
  console.log(`${statusPill(level.toUpperCase(), pillLevel)} ${steel(text)}`);
}

function printHelp() {
  printBanner('HELP');
  console.log(`
Uso:
  npm run menu

Menu TUI:
  - Arranca codigos, sorteos o ambos.
  - Guarda canales en ${CONFIG_FILE}.
  - Permite anadir, eliminar y reemplazar canales de codigos y sorteos.
  - Puede commitear y pushear config/mode-scripts.json a GitHub.
  - Muestra dashboard con estado por proceso y JOIN OK por canal.
  - En dashboard puedes navegar con down/up, pgdn/pgup, top/bottom.
  - En dashboard puedes escribir stop + Enter para cerrar procesos.

Comandos directos equivalentes:
  npm start -- --channels canal1,canal2
  npm run giveaways -- --channels canal1,canal2
`);
}

function printSignalStrip(config) {
  const cells = [
    `${muted('IRC')} ${statusPill('ANON READ', 'ok')}`,
    `${muted('MODE')} ${hot(MODE_LABELS[config.mode] || config.mode)}`,
    `${muted('CODE CH')} ${neon(config.codeChannels.length)}`,
    `${muted('RAFFLE CH')} ${acid(config.giveawayChannels.length)}`,
    `${muted('BRIDGE')} ${config.keydropBridge ? statusPill('ON', 'ok') : statusPill('OFF', 'off')}`
  ];

  console.log(center(cells.join(` ${muted('//')} `), UI_WIDTH));
  console.log('');
}

function printBanner(section = 'CONTROL PANEL') {
  const banner = [
    ' __  __           _        ____            _       _       ',
    '|  \\/  | ___   __| | ___  / ___|  ___ _ __(_)_ __ | |_ ___ ',
    '| |\\/| |/ _ \\ / _  |/ _ \\ \\___ \\ / __| \'__| | \'_ \\| __/ __|',
    '| |  | | (_) | (_| |  __/  ___) | (__| |  | | |_) | |_\\__ \\',
    '|_|  |_|\\___/ \\__,_|\\___| |____/ \\___|_|  |_| .__/ \\__|___/',
    '                                            |_|            '
  ];
  const palette = ['blood', 'inferno', 'ember', 'blood', 'darkRed', 'blood'];

  console.log(blood(makeRail(` ${APP_TITLE.toUpperCase()} // ${section.toUpperCase()} // INFERNO OPS `, '=')));
  for (const [index, line] of banner.entries()) {
    console.log(center(style(line, palette[index % palette.length]), UI_WIDTH));
  }
  console.log(center(`${bannerPill('TWITCH IRC')} ${darkRed('//')} ${bannerPill('CODE CLIPBOARD', 'inferno')} ${darkRed('//')} ${bannerPill('GIVEAWAY RADAR', 'ember')}`, UI_WIDTH));
  console.log(darkRed(makeRail('', '=')));
  console.log('');
  pinBodyRegion();
}

function printBox(title, rows) {
  for (const row of buildBoxRows(title, rows)) {
    console.log(row);
  }
}

function buildBoxRows(title, rows) {
  const safeRows = rows.length > 0 ? rows : [''];
  const contentWidth = UI_WIDTH - 6;
  const outputRows = [panel(boxBorder(` ${title} `, '='))];

  for (const row of safeRows) {
    const text = truncateVisible(String(row), contentWidth);
    const padding = ' '.repeat(Math.max(0, contentWidth - visibleLength(text)));
    outputRows.push(`${panel('|| ')}${text}${padding}${panel(' ||')}`);
  }

  outputRows.push(panel(boxBorder('', '=')));
  outputRows.push('');
  return outputRows;
}

function makeRail(label, fill) {
  if (!label) return fill.repeat(UI_WIDTH);

  const remaining = Math.max(0, UI_WIDTH - visibleLength(label));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${fill.repeat(left)}${label}${fill.repeat(right)}`;
}

function boxBorder(label, fill) {
  if (!label) return `#${fill.repeat(UI_WIDTH - 2)}#`;

  const remaining = Math.max(0, UI_WIDTH - visibleLength(label) - 2);
  return `#${label}${fill.repeat(remaining)}#`;
}

function clearScreen() {
  if (process.stdout.isTTY) {
    resetScrollRegion();
    process.stdout.write('\x1b[2J\x1b[H');
  }
}

function enterTui() {
  if (!output.isTTY || tuiActive) return;

  tuiActive = true;
  output.write('\x1b[?1049h\x1b[?25h\x1b[2J\x1b[H');
}

function leaveTui() {
  if (!output.isTTY || !tuiActive) return;

  resetScrollRegion();
  output.write('\x1b[?25h\x1b[?1049l');
  tuiActive = false;
}

function pinBodyRegion() {
  if (!output.isTTY || !tuiActive) return;

  const rows = output.rows || 40;
  if (rows <= BODY_START_ROW + 2) {
    resetScrollRegion();
    return;
  }

  output.write(`\x1b[${BODY_START_ROW};${rows}r\x1b[${BODY_START_ROW};1H`);
}

function resetScrollRegion() {
  if (!output.isTTY || !tuiActive) return;
  output.write('\x1b[r');
}

function stopChildren(signal = 'SIGTERM') {
  for (const child of childProcesses) {
    try {
      if (signal === 'SIGKILL' && process.platform === 'win32' && child.pid) {
        const killResult = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        });
        if (!killResult.error && killResult.status === 0) {
          continue;
        }
      }

      child.kill(signal);
    } catch {
      // El proceso ya puede haber terminado.
    }
  }
}

function center(text, width) {
  const pad = Math.max(0, Math.floor((width - visibleLength(text)) / 2));
  return `${' '.repeat(pad)}${text}`;
}

function truncateVisible(text, maxLength) {
  if (visibleLength(text) <= maxLength) return text;

  const plain = stripAnsi(text);
  return `${plain.slice(0, Math.max(0, maxLength - 3))}...`;
}

function fitVisibleLine(text, width) {
  const truncated = truncateVisible(String(text), width);
  const padding = ' '.repeat(Math.max(0, width - visibleLength(truncated)));
  return `${truncated}${padding}`;
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function style(text, color) {
  if (!colorEnabled) return String(text);
  return `${ansi[color] || ''}${text}${ansi.reset}`;
}

function green(text) {
  return style(text, 'green');
}

function yellow(text) {
  return style(text, 'yellow');
}

function red(text) {
  return style(text, 'red');
}

function cyan(text) {
  return style(text, 'cyan');
}

function magenta(text) {
  return style(text, 'magenta');
}

function dim(text) {
  return style(text, 'dim');
}

function neon(text) {
  return style(text, 'neon');
}

function acid(text) {
  return style(text, 'acid');
}

function hot(text) {
  return style(text, 'hot');
}

function alert(text) {
  return style(text, 'alert');
}

function amber(text) {
  return style(text, 'amber');
}

function violet(text) {
  return style(text, 'violet');
}

function steel(text) {
  return style(text, 'steel');
}

function muted(text) {
  return style(text, 'muted');
}

function panel(text) {
  return style(text, 'darkRed');
}

function blood(text) {
  return style(text, 'blood');
}

function darkRed(text) {
  return style(text, 'darkRed');
}

function inferno(text) {
  return style(text, 'inferno');
}

function ember(text) {
  return style(text, 'ember');
}

function ash(text) {
  return style(text, 'ash');
}

function bone(text) {
  return style(text, 'bone');
}

process.on('SIGINT', () => {
  if (dashboardState) {
    requestDashboardStop('Ctrl+C recibido.');
    return;
  } else {
    console.log('');
    console.log('Deteniendo procesos...');
  }
  stopChildren();
  if (childProcesses.size === 0) {
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  if (dashboardState) {
    requestDashboardStop('SIGTERM recibido.');
    return;
  }

  stopChildren();
  if (childProcesses.size === 0) {
    process.exit(0);
  }
});
