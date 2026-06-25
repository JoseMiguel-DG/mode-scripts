// ==UserScript==
// @name         KeyDrop Twitch Code Bridge
// @namespace    local.twitch-code-clipboard
// @version      1.0.0
// @description  Recibe codigos del monitor local, los canjea en KeyDrop y mantiene visible el estado del puente.
// @match        https://key-drop.com/*
// @match        https://www.key-drop.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    bridgeUrl: 'ws://127.0.0.1:17373/codes',
    payUrl: `${location.origin}/es/Pay/`,
    healthIntervalMs: 2 * 60 * 1000,
    postProbeCode: 'TEST-TEST-TEST-TEST',
    autoRepair: true,
    autoRepairMaxAttempts: 3,
    autoRepairWindowMs: 30 * 60 * 1000,
    autoRepairDelayMinMs: 1500,
    autoRepairDelayMaxMs: 3500,
    repairInfoStorageKey: 'keydrop-bridge-repair-info-v1',
    refreshMinMs: 10 * 60 * 1000,
    refreshMaxMs: 15 * 60 * 1000,
    reconnectMs: 1000,
    refreshAfterRedeemDelayMs: 2 * 60 * 1000,
    countdownTickMs: 1000,
    seenStorageKey: 'keydrop-bridge-seen-codes-v1',
    panelPositionStorageKey: 'keydrop-bridge-panel-position-v1',
    panelMinimizedStorageKey: 'keydrop-bridge-panel-minimized-v1',
    failureStorageKey: 'keydrop-bridge-failures-v1',
    failureMax: 50,
    seenMax: 40
  };

  const state = {
    ws: 'iniciando',
    redeem: 'esperando',
    availability: 'sin comprobar',
    autoRepair: 'activo',
    cloudflare: 'sin detectar',
    lastCode: '-',
    lastResult: '-',
    failureCount: 0,
    lastRefresh: localStorage.getItem('keydrop-bridge-last-refresh') || '-',
    nextRefreshAt: 0,
    refreshPaused: false,
    redeemInFlight: false,
    stopped: false
  };

  const seenCodes = loadSeenCodes();
  state.failureCount = loadFailureLog().length;
  let socket = null;
  let reconnectTimer = null;
  let refreshTimer = null;
  let healthTimer = null;
  let repairTimer = null;
  let countdownTimer = null;
  let panel = null;
  let els = {};
  let lastBrowserAlertAt = 0;

  createPanel();
  detectCloudflarePage();
  connect();
  void checkEndpointHealth();
  healthTimer = setInterval(() => {
    void checkEndpointHealth();
  }, CONFIG.healthIntervalMs);
  scheduleRandomRefresh('inicio');
  countdownTimer = setInterval(render, CONFIG.countdownTickMs);
  render();

  window.__KEYDROP_BRIDGE_STOP__ = () => {
    state.stopped = true;
    state.refreshPaused = true;
    clearTimeout(reconnectTimer);
    clearTimeout(refreshTimer);
    clearTimeout(repairTimer);
    clearInterval(healthTimer);
    clearInterval(countdownTimer);
    if (socket) socket.close();
    state.ws = 'detenido';
    state.redeem = 'detenido';
    render();
    console.log('[KeyDrop bridge] Detenido.');
  };

  window.__KEYDROP_BRIDGE_FAILURES__ = () => loadFailureLog();

  window.__KEYDROP_BRIDGE_CLEAR_FAILURES__ = () => {
    localStorage.removeItem(CONFIG.failureStorageKey);
    state.failureCount = 0;
    render();
    console.log('[KeyDrop bridge] Log local de fallos limpiado.');
  };

  function connect() {
    if (state.stopped) return;

    state.ws = 'conectando';
    render();
    socket = new WebSocket(CONFIG.bridgeUrl);

    socket.addEventListener('open', () => {
      state.ws = 'conectado';
      render();
      console.log('[KeyDrop bridge] Conectado al monitor local.');
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type !== 'code' || typeof payload.code !== 'string') return;
      if (seenCodes.has(payload.code)) {
        state.lastResult = `duplicado ignorado ${payload.code}`;
        render();
        return;
      }

      seenCodes.add(payload.code);
      persistSeenCodes();
      state.lastCode = payload.code;
      state.lastResult = 'codigo recibido';
      render();

      console.log('[KeyDrop bridge] Codigo recibido:', payload.code);
      void redeemGiftcard(payload.code);
    });

    socket.addEventListener('close', () => {
      if (state.stopped) return;
      state.ws = 'desconectado';
      render();
      console.log('[KeyDrop bridge] Desconectado. Reintentando...');
      reconnectTimer = setTimeout(connect, CONFIG.reconnectMs);
    });

    socket.addEventListener('error', () => {
      state.ws = 'error websocket';
      render();
      try {
        socket.close();
      } catch {
        // El cierre ya esta en curso.
      }
    });
  }

  async function redeemGiftcard(giftcardCode) {
    state.redeemInFlight = true;
    state.redeem = 'canjeando';
    state.lastResult = 'enviando peticion';
    render();

    const formData = new FormData();
    formData.append('method', 'giftcard-kinguin');
    formData.append('code', giftcardCode);

    try {
      const response = await fetch(CONFIG.payUrl, {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });

      const contentType = response.headers.get('content-type') || '';
      const mitigated = response.headers.get('cf-mitigated') || '';
      const rawText = await response.text();
      let result = null;

      if (mitigated === 'challenge' || looksLikeCloudflareChallenge(contentType, rawText)) {
        state.cloudflare = 'challenge en respuesta';
        state.redeem = 'bloqueado';
        state.lastResult = `Cloudflare intercepto ${giftcardCode}`;
        recordRedeemFailure({
          code: giftcardCode,
          stage: 'cloudflare-challenge',
          reason: 'Cloudflare intercepto el POST de canje',
          httpStatus: response.status,
          contentType,
          cloudflare: state.cloudflare,
          responsePreview: previewText(rawText)
        });
        render();
        console.warn('[KeyDrop bridge] Cloudflare challenge detectado en /es/Pay/. Refresca y completa la validacion si aparece.');
        console.warn('[KeyDrop bridge] Respuesta cruda:', rawText);
        return;
      }

      if (contentType.includes('application/json')) {
        try {
          result = JSON.parse(rawText);
        } catch {
          result = null;
        }
      }

      console.log('[KeyDrop bridge] Codigo:', giftcardCode);
      console.log('[KeyDrop bridge] HTTP status:', response.status);
      console.log('[KeyDrop bridge] Respuesta cruda:', rawText);

      if (!response.ok) {
        state.redeem = 'error http';
        state.lastResult = `HTTP ${response.status}`;
        recordRedeemFailure({
          code: giftcardCode,
          stage: 'http-error',
          reason: `HTTP ${response.status}`,
          httpStatus: response.status,
          contentType,
          cloudflare: state.cloudflare,
          responsePreview: previewText(rawText)
        });
        render();
        return;
      }

      if (result) {
        console.log('[KeyDrop bridge] Respuesta JSON:', result);

        if (
          result.status === true ||
          result.success === true ||
          result.status === 'success'
        ) {
          state.redeem = 'exito';
          state.lastResult = `canjeado ${giftcardCode}`;
          render();
          console.log('[KeyDrop bridge] Gift Card canjeada con exito.');
        } else {
          state.redeem = 'rechazado';
          state.lastResult = result.message || result.error || result.msg || 'codigo invalido/usado';
          recordRedeemFailure({
            code: giftcardCode,
            stage: 'keydrop-rejected',
            reason: state.lastResult,
            httpStatus: response.status,
            contentType,
            cloudflare: state.cloudflare,
            result,
            responsePreview: previewText(rawText)
          });
          render();
          console.log('[KeyDrop bridge] Error al canjear:', state.lastResult);
        }
      } else {
        state.redeem = 'respuesta no json';
        state.lastResult = 'respuesta no JSON';
        recordRedeemFailure({
          code: giftcardCode,
          stage: 'non-json-response',
          reason: 'KeyDrop no devolvio JSON',
          httpStatus: response.status,
          contentType,
          cloudflare: state.cloudflare,
          responsePreview: previewText(rawText)
        });
        render();
        console.log('[KeyDrop bridge] La respuesta no era JSON. Revisa el texto crudo de arriba.');
      }
    } catch (error) {
      state.redeem = 'error';
      state.lastResult = error.message;
      recordRedeemFailure({
        code: giftcardCode,
        stage: 'request-error',
        reason: error.message,
        cloudflare: state.cloudflare
      });
      render();
      console.error('[KeyDrop bridge] Error en la peticion:', error);
    } finally {
      state.redeemInFlight = false;
      if (!state.refreshPaused) {
        scheduleRefresh(CONFIG.refreshAfterRedeemDelayMs, 'post-canje');
      }
    }
  }

  function scheduleRandomRefresh(reason) {
    const delay = randomBetween(CONFIG.refreshMinMs, CONFIG.refreshMaxMs);
    scheduleRefresh(delay, reason);
  }

  function scheduleRefresh(delay, reason) {
    clearTimeout(refreshTimer);
    state.nextRefreshAt = Date.now() + delay;
    console.log(`[KeyDrop bridge] Proximo refresh (${reason}) en ${formatDuration(delay)}.`);
    render();

    refreshTimer = setTimeout(() => {
      if (state.refreshPaused || state.stopped) return;

      if (state.redeemInFlight) {
        scheduleRefresh(CONFIG.refreshAfterRedeemDelayMs, 'canje en curso');
        return;
      }

      localStorage.setItem('keydrop-bridge-last-refresh', new Date().toLocaleTimeString());
      location.reload();
    }, delay);
  }

  function createPanel() {
    panel = document.createElement('div');
    panel.id = 'keydrop-bridge-panel';
    panel.innerHTML = `
      <div class="kdb-title" data-kdb-drag>
        <span class="kdb-title-text">KeyDrop Bridge</span>
        <div class="kdb-title-actions">
          <button type="button" data-kdb-action="toggle-refresh">Pausar</button>
          <button type="button" data-kdb-action="toggle-minimize" title="Minimizar panel">Min</button>
        </div>
      </div>
      <div class="kdb-body">
        <div class="kdb-row"><span>WS</span><strong data-kdb="ws"></strong></div>
        <div class="kdb-row"><span>Canje</span><strong data-kdb="redeem"></strong></div>
        <div class="kdb-row"><span>Disponibilidad</span><strong data-kdb="availability"></strong></div>
        <div class="kdb-row"><span>Auto-repair</span><strong data-kdb="autoRepair"></strong></div>
        <div class="kdb-row"><span>Cloudflare</span><strong data-kdb="cloudflare"></strong></div>
        <div class="kdb-row"><span>Ultimo codigo</span><strong data-kdb="lastCode"></strong></div>
        <div class="kdb-row"><span>Resultado</span><strong data-kdb="lastResult"></strong></div>
        <div class="kdb-row"><span>Fallos</span><strong data-kdb="failureCount"></strong></div>
        <div class="kdb-row"><span>Ultimo refresh</span><strong data-kdb="lastRefresh"></strong></div>
        <div class="kdb-row"><span>Proximo refresh</span><strong data-kdb="nextRefresh"></strong></div>
        <div class="kdb-actions">
          <button type="button" data-kdb-action="post-probe">Probar POST</button>
          <button type="button" data-kdb-action="refresh-now">Refrescar ahora</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #keydrop-bridge-panel {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2147483647;
        width: min(360px, calc(100vw - 28px));
        box-sizing: border-box;
        padding: 12px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-left: 4px solid #34d399;
        border-radius: 8px;
        background: rgba(17, 24, 39, 0.94);
        color: #f9fafb;
        font: 12px/1.35 Arial, Helvetica, sans-serif;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      }
      #keydrop-bridge-panel.kdb-warn { border-left-color: #f59e0b; }
      #keydrop-bridge-panel.kdb-error { border-left-color: #ef4444; }
      #keydrop-bridge-panel.kdb-dragging {
        transition: none;
        user-select: none;
      }
      #keydrop-bridge-panel.kdb-minimized {
        width: min(240px, calc(100vw - 28px));
      }
      #keydrop-bridge-panel .kdb-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
        font-size: 13px;
        font-weight: 700;
        cursor: move;
        user-select: none;
      }
      #keydrop-bridge-panel.kdb-minimized .kdb-title {
        margin-bottom: 0;
      }
      #keydrop-bridge-panel .kdb-title-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #keydrop-bridge-panel .kdb-title-actions {
        display: flex;
        flex: 0 0 auto;
        gap: 6px;
        cursor: default;
      }
      #keydrop-bridge-panel.kdb-minimized .kdb-body {
        display: none;
      }
      #keydrop-bridge-panel .kdb-row {
        display: grid;
        grid-template-columns: 96px minmax(0, 1fr);
        gap: 8px;
        padding: 3px 0;
      }
      #keydrop-bridge-panel .kdb-row span {
        color: #cbd5e1;
      }
      #keydrop-bridge-panel .kdb-row strong {
        min-width: 0;
        color: #ffffff;
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      #keydrop-bridge-panel .kdb-actions {
        display: flex;
        gap: 7px;
        justify-content: flex-end;
        margin-top: 9px;
      }
      #keydrop-bridge-panel button {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
        padding: 5px 8px;
        font: inherit;
        cursor: pointer;
      }
      #keydrop-bridge-panel button:hover {
        background: rgba(255, 255, 255, 0.18);
      }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);

    els = {
      title: panel.querySelector('[data-kdb-drag]'),
      ws: panel.querySelector('[data-kdb="ws"]'),
      redeem: panel.querySelector('[data-kdb="redeem"]'),
      availability: panel.querySelector('[data-kdb="availability"]'),
      autoRepair: panel.querySelector('[data-kdb="autoRepair"]'),
      cloudflare: panel.querySelector('[data-kdb="cloudflare"]'),
      lastCode: panel.querySelector('[data-kdb="lastCode"]'),
      lastResult: panel.querySelector('[data-kdb="lastResult"]'),
      failureCount: panel.querySelector('[data-kdb="failureCount"]'),
      lastRefresh: panel.querySelector('[data-kdb="lastRefresh"]'),
      nextRefresh: panel.querySelector('[data-kdb="nextRefresh"]'),
      toggleRefresh: panel.querySelector('[data-kdb-action="toggle-refresh"]'),
      toggleMinimize: panel.querySelector('[data-kdb-action="toggle-minimize"]'),
      postProbe: panel.querySelector('[data-kdb-action="post-probe"]'),
      refreshNow: panel.querySelector('[data-kdb-action="refresh-now"]')
    };

    bindPanelDragging();
    applyPanelPreferences();
    window.addEventListener('resize', () => {
      clampPanelToViewport(true);
    });

    els.toggleRefresh.addEventListener('click', () => {
      state.refreshPaused = !state.refreshPaused;
      els.toggleRefresh.textContent = state.refreshPaused ? 'Reanudar' : 'Pausar';

      if (state.refreshPaused) {
        clearTimeout(refreshTimer);
        state.nextRefreshAt = 0;
      } else {
        scheduleRandomRefresh('reanudado');
      }

      render();
    });

    els.toggleMinimize.addEventListener('click', () => {
      setPanelMinimized(!panel.classList.contains('kdb-minimized'), true);
    });

    els.postProbe.addEventListener('click', () => {
      void probeRedeemReadiness();
    });

    els.refreshNow.addEventListener('click', () => {
      if (state.redeemInFlight) {
        state.lastResult = 'no refresca: canje en curso';
        render();
        return;
      }

      localStorage.setItem('keydrop-bridge-last-refresh', new Date().toLocaleTimeString());
      location.reload();
    });
  }

  function bindPanelDragging() {
    let dragState = null;

    els.title.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;

      const rect = panel.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };

      event.preventDefault();
      panel.classList.add('kdb-dragging');
      els.title.setPointerCapture(event.pointerId);
      setPanelPosition(rect.left, rect.top, false);
    });

    els.title.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      setPanelPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY, false);
    });

    const finishDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      dragState = null;
      panel.classList.remove('kdb-dragging');
      clampPanelToViewport(true);
    };

    els.title.addEventListener('pointerup', finishDrag);
    els.title.addEventListener('pointercancel', finishDrag);
  }

  function applyPanelPreferences() {
    const position = loadPanelPosition();
    if (position) {
      setPanelPosition(position.left, position.top, false);
    }

    setPanelMinimized(localStorage.getItem(CONFIG.panelMinimizedStorageKey) === '1', false);

    requestAnimationFrame(() => {
      clampPanelToViewport(Boolean(position));
    });
  }

  function loadPanelPosition() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.panelPositionStorageKey) || '{}');
      const left = Number(parsed.left);
      const top = Number(parsed.top);

      if (Number.isFinite(left) && Number.isFinite(top)) {
        return { left, top };
      }
    } catch {
      // Ignorar posicion corrupta.
    }

    return null;
  }

  function setPanelMinimized(minimized, persist) {
    panel.classList.toggle('kdb-minimized', minimized);
    els.toggleMinimize.textContent = minimized ? 'Max' : 'Min';
    els.toggleMinimize.title = minimized ? 'Mostrar panel' : 'Minimizar panel';

    if (persist) {
      localStorage.setItem(CONFIG.panelMinimizedStorageKey, minimized ? '1' : '0');
    }

    requestAnimationFrame(() => {
      clampPanelToViewport(Boolean(panel.style.left));
    });
  }

  function setPanelPosition(left, top, persist) {
    const { clampedLeft, clampedTop } = getClampedPanelPosition(left, top);

    panel.style.left = `${clampedLeft}px`;
    panel.style.top = `${clampedTop}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';

    if (persist) {
      savePanelPosition(clampedLeft, clampedTop);
    }
  }

  function clampPanelToViewport(persist) {
    if (!panel.style.left || !panel.style.top) return;

    const left = Number.parseFloat(panel.style.left);
    const top = Number.parseFloat(panel.style.top);

    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    setPanelPosition(left, top, persist);
  }

  function getClampedPanelPosition(left, top) {
    const margin = 8;
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

    return {
      clampedLeft: Math.min(Math.max(margin, left), maxLeft),
      clampedTop: Math.min(Math.max(margin, top), maxTop)
    };
  }

  function savePanelPosition(left, top) {
    localStorage.setItem(CONFIG.panelPositionStorageKey, JSON.stringify({ left, top }));
  }

  function render() {
    detectCloudflarePage();

    els.ws.textContent = state.ws;
    els.redeem.textContent = state.redeem;
    els.availability.textContent = state.availability;
    els.autoRepair.textContent = state.autoRepair;
    els.cloudflare.textContent = state.cloudflare;
    els.lastCode.textContent = state.lastCode;
    els.lastResult.textContent = state.lastResult;
    els.failureCount.textContent = String(state.failureCount);
    els.lastRefresh.textContent = state.lastRefresh;
    els.nextRefresh.textContent = state.refreshPaused
      ? 'pausado'
      : state.nextRefreshAt
        ? formatDuration(Math.max(0, state.nextRefreshAt - Date.now()))
        : '-';

    panel.classList.toggle('kdb-error', isErrorState());
    panel.classList.toggle('kdb-warn', !isErrorState() && isWarnState());
  }

  function detectCloudflarePage() {
    const title = document.title || '';
    const bodyText = document.body?.innerText?.slice(0, 3000) || '';
    const html = document.documentElement?.innerHTML?.slice(0, 10000) || '';
    const combined = `${title}\n${bodyText}\n${html}`.toLowerCase();

    if (
      combined.includes('just a moment') ||
      combined.includes('checking your browser') ||
      combined.includes('/cdn-cgi/challenge-platform') ||
      combined.includes('cf-challenge') ||
      title.toLowerCase().includes('cloudflare') ||
      bodyText.toLowerCase().includes('cloudflare ray id')
    ) {
      state.cloudflare = 'challenge visible';
      requestAutoRepair('challenge visible');
    } else if (state.cloudflare === 'challenge visible') {
      state.cloudflare = 'sin detectar';
    }
  }

  async function checkEndpointHealth() {
    try {
      const response = await fetch(CONFIG.payUrl, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store'
      });

      const contentType = response.headers.get('content-type') || '';
      const mitigated = response.headers.get('cf-mitigated') || '';
      const rawText = await response.text();
      const checkedAt = new Date().toLocaleTimeString();

      if (mitigated === 'challenge' || looksLikeCloudflareChallenge(contentType, rawText)) {
        state.cloudflare = 'challenge en health';
        state.availability = `bloqueado Cloudflare ${checkedAt}`;
        requestAutoRepair('health bloqueado por Cloudflare');
      } else if (contentType.includes('application/json') || looksLikeKeydropJson(rawText)) {
        state.availability = `GET OK ${checkedAt}`;
        if (state.cloudflare.startsWith('challenge en')) {
          state.cloudflare = 'sin detectar';
        }
        resetAutoRepair('GET OK');
      } else if (contentType.includes('text/html')) {
        state.availability = `HTML inesperado ${checkedAt}`;
        requestAutoRepair('health devolvio HTML inesperado');
      } else {
        state.availability = `respuesta rara ${checkedAt}`;
      }
    } catch (error) {
      state.availability = `health error: ${error.message}`;
    } finally {
      render();
    }
  }

  async function probeRedeemReadiness() {
    if (state.redeemInFlight) {
      state.lastResult = 'no prueba: canje en curso';
      render();
      return;
    }

    state.availability = 'probando POST';
    state.lastResult = `test ${CONFIG.postProbeCode}`;
    render();

    const formData = new FormData();
    formData.append('method', 'giftcard-kinguin');
    formData.append('code', CONFIG.postProbeCode);

    try {
      const response = await fetch(CONFIG.payUrl, {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });

      const contentType = response.headers.get('content-type') || '';
      const mitigated = response.headers.get('cf-mitigated') || '';
      const rawText = await response.text();
      let result = null;
      const checkedAt = new Date().toLocaleTimeString();

      if (mitigated === 'challenge' || looksLikeCloudflareChallenge(contentType, rawText)) {
        state.cloudflare = 'challenge en POST';
        state.availability = `POST bloqueado ${checkedAt}`;
        state.lastResult = 'Cloudflare bloqueo la prueba POST';
        requestAutoRepair('POST bloqueado por Cloudflare');
        console.warn('[KeyDrop bridge] Cloudflare challenge detectado en prueba POST.');
        console.warn('[KeyDrop bridge] Respuesta cruda:', rawText);
        return;
      }

      if (contentType.includes('application/json')) {
        try {
          result = JSON.parse(rawText);
        } catch {
          result = null;
        }
      }

      console.log('[KeyDrop bridge] Prueba POST status:', response.status);
      console.log('[KeyDrop bridge] Prueba POST respuesta cruda:', rawText);

      if (!response.ok) {
        state.availability = `POST HTTP ${response.status} ${checkedAt}`;
        state.lastResult = `test POST HTTP ${response.status}`;
        return;
      }

      if (result) {
        if (state.cloudflare.startsWith('challenge en')) {
          state.cloudflare = 'sin detectar';
        }
        resetAutoRepair('POST OK');

        if (
          result.status === true ||
          result.success === true ||
          result.status === 'success'
        ) {
          state.availability = `POST acepto TEST ${checkedAt}`;
          state.lastResult = 'alerta: KeyDrop acepto el codigo de prueba';
        } else {
          state.availability = `POST OK ${checkedAt}`;
          state.lastResult = result.message || result.error || result.msg || 'rechazo esperado';
        }
      } else {
        state.availability = `POST no JSON ${checkedAt}`;
        state.lastResult = 'test POST no devolvio JSON';
      }
    } catch (error) {
      state.availability = `POST error: ${error.message}`;
      state.lastResult = error.message;
    } finally {
      render();
    }
  }

  function looksLikeKeydropJson(rawText) {
    const text = rawText.trim();
    return text.startsWith('{') && (
      text.includes('"status"') ||
      text.includes('"message"') ||
      text.includes('"errorCode"')
    );
  }

  function recordRedeemFailure(details) {
    const failure = {
      ts: new Date().toISOString(),
      pageUrl: location.href,
      payUrl: CONFIG.payUrl,
      ws: state.ws,
      availability: state.availability,
      autoRepair: state.autoRepair,
      ...details
    };

    const failures = loadFailureLog();
    failures.push(failure);
    const recentFailures = failures.slice(-CONFIG.failureMax);
    localStorage.setItem(CONFIG.failureStorageKey, JSON.stringify(recentFailures));
    state.failureCount = recentFailures.length;

    console.warn('[KeyDrop bridge] Fallo registrado:', failure);

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'redeem-failure',
        failure
      }));
    }
  }

  function loadFailureLog() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.failureStorageKey) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function previewText(text) {
    return String(text || '').slice(0, 2000);
  }

  function requestAutoRepair(reason) {
    if (!CONFIG.autoRepair || state.stopped) return;

    if (state.redeemInFlight) {
      state.autoRepair = `pausado: canje en curso`;
      return;
    }

    if (repairTimer) return;

    const info = loadRepairInfo();
    if (info.attempts >= CONFIG.autoRepairMaxAttempts) {
      state.autoRepair = `requiere accion: ${reason}`;
      sendBrowserAlert(`KeyDrop requiere accion manual: ${reason}`);
      return;
    }

    const nextInfo = {
      firstAt: info.firstAt,
      attempts: info.attempts + 1,
      lastAt: Date.now(),
      lastReason: reason
    };
    saveRepairInfo(nextInfo);

    clearTimeout(refreshTimer);
    state.nextRefreshAt = 0;

    const delay = randomBetween(CONFIG.autoRepairDelayMinMs, CONFIG.autoRepairDelayMaxMs);
    state.autoRepair = `refresh ${nextInfo.attempts}/${CONFIG.autoRepairMaxAttempts}: ${reason}`;
    console.warn(`[KeyDrop bridge] Auto-repair ${nextInfo.attempts}/${CONFIG.autoRepairMaxAttempts}: ${reason}. Refrescando en ${delay} ms.`);

    repairTimer = setTimeout(() => {
      repairTimer = null;

      if (state.stopped) return;
      if (state.redeemInFlight) {
        requestAutoRepair('canje en curso');
        return;
      }

      localStorage.setItem('keydrop-bridge-last-refresh', new Date().toLocaleTimeString());
      location.reload();
    }, delay);
  }

  function resetAutoRepair(reason) {
    clearTimeout(repairTimer);
    repairTimer = null;
    localStorage.removeItem(CONFIG.repairInfoStorageKey);
    state.autoRepair = `activo (${reason})`;
  }

  function loadRepairInfo() {
    const now = Date.now();

    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.repairInfoStorageKey) || '{}');
      const firstAt = Number(parsed.firstAt);
      const attempts = Number(parsed.attempts);

      if (
        Number.isFinite(firstAt) &&
        Number.isFinite(attempts) &&
        now - firstAt <= CONFIG.autoRepairWindowMs
      ) {
        return {
          firstAt,
          attempts: Math.max(0, attempts)
        };
      }
    } catch {
      // Reiniciar contador si el storage esta corrupto.
    }

    return {
      firstAt: now,
      attempts: 0
    };
  }

  function saveRepairInfo(info) {
    localStorage.setItem(CONFIG.repairInfoStorageKey, JSON.stringify(info));
  }

  function sendBrowserAlert(reason) {
    const now = Date.now();
    if (now - lastBrowserAlertAt < 60_000) return;
    lastBrowserAlertAt = now;

    console.error(`[KeyDrop bridge] ${reason}`);

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'browser-alert',
        reason,
        ts: new Date().toISOString()
      }));
    }
  }

  function looksLikeCloudflareChallenge(contentType, rawText) {
    if (!contentType.includes('text/html')) return false;
    const text = rawText.slice(0, 8000).toLowerCase();
    return (
      text.includes('just a moment') ||
      text.includes('/cdn-cgi/challenge-platform') ||
      text.includes('cf-challenge') ||
      text.includes('cloudflare ray id')
    );
  }

  function isWarnState() {
    return (
      state.ws !== 'conectado' ||
      state.availability === 'sin comprobar' ||
      state.availability.startsWith('probando') ||
      state.cloudflare !== 'sin detectar' ||
      state.redeem === 'canjeando'
    );
  }

  function isErrorState() {
    return (
      state.redeem === 'bloqueado' ||
      state.redeem === 'error' ||
      state.redeem === 'error http' ||
      state.availability.includes('bloqueado') ||
      state.availability.includes('error') ||
      state.autoRepair.startsWith('requiere accion') ||
      state.ws === 'error websocket'
    );
  }

  function loadSeenCodes() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(CONFIG.seenStorageKey) || '[]');
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  }

  function persistSeenCodes() {
    const codes = Array.from(seenCodes).slice(-CONFIG.seenMax);
    seenCodes.clear();
    for (const code of codes) {
      seenCodes.add(code);
    }
    sessionStorage.setItem(CONFIG.seenStorageKey, JSON.stringify(codes));
  }

  function randomBetween(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function formatDuration(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
})();
