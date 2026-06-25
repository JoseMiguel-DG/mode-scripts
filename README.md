# Twitch Code Clipboard / Mode-Scripts

Herramienta Node.js para Windows y macOS que escucha chats publicos de Twitch por IRC WebSocket.

Tiene tres piezas:

- `src/index.js`: detector de codigos. Escucha uno o varios canales, detecta codigos `FFFF-FFFF-FFFF-FFFF`, los copia al portapapeles y reproduce sonido.
- `src/giveaways.js`: detector de posibles sorteos. Escucha uno o varios canales y avisa si varios usuarios escriben la misma palabra en una ventana corta.
- `src/menu.js`: launcher TUI `Mode-Scripts v1`. Permite guardar canales, elegir modo, arrancar procesos y ver estado de conexion por canal.

El bot no escribe en el chat. Usa conexion anonima de lectura tipo `justinfan...`.

## Requisitos

- Windows 10/11 o macOS.
- Node.js 18.17 o superior.
- Git si quieres clonar/actualizar desde GitHub.
- Acceso al chat publico de los canales de Twitch.

## Instalacion

Desde cero:

```powershell
git clone https://github.com/JoseMiguel-DG/mode-scripts.git
cd mode-scripts
npm install
```

En macOS es el mismo flujo desde Terminal:

```bash
git clone https://github.com/JoseMiguel-DG/mode-scripts.git
cd mode-scripts
npm install
```

Para actualizar en cualquiera de los dos equipos:

```powershell
git pull
npm install
```

`npm install` solo hace falta repetirlo cuando cambien dependencias, pero no hace daño ejecutarlo despues de `git pull`.

## Usar el Mismo Repo en Windows y macOS

El repositorio es el mismo para los dos sistemas. La diferencia la decide el programa en runtime con `process.platform`.

En Windows:

- portapapeles: `clipboardy`, fallback `Set-Clipboard`;
- sonido: PowerShell + sonidos del sistema;
- TUI: PowerShell, Windows Terminal o similar.

En macOS:

- portapapeles: `clipboardy`, fallback `pbcopy`;
- sonido: `afplay`, fallback `osascript`;
- TUI: Terminal, iTerm2 o similar.

Flujo recomendado:

```bash
git clone https://github.com/JoseMiguel-DG/mode-scripts.git
cd mode-scripts
npm install
npm run menu
```

Para sincronizar cambios entre equipos:

```bash
git pull
npm install
```

La configuracion compartida del menu vive en `config/mode-scripts.json` y se sube al repositorio. Si cambias canales en Windows, usa la opcion `Subir configuracion a GitHub` del menu o ejecuta `npm run config:push`; despues, en macOS ejecuta `git pull`. El flujo inverso es igual.

Importante: el repositorio es publico, asi que los canales guardados en `config/mode-scripts.json` tambien seran visibles en GitHub.

## Funcionamiento General

El flujo normal es:

1. Arrancas `npm run menu`.
2. Configuras canales de codigos y/o canales de sorteos.
3. Guardas la configuracion.
4. Arrancas desde el menu.
5. El dashboard muestra cada proceso y cada canal como `[WAIT]` hasta que Twitch confirma el `JOIN`.
6. Cuando Twitch confirma un canal, aparece `Join OK #canal` y el dashboard cambia ese canal a `[OK]`.

Si se detecta un codigo:

1. Se extrae el codigo.
2. Se copia inmediatamente al portapapeles.
3. Si el puente KeyDrop esta activo, se envia al navegador.
4. Se reproduce sonido.
5. Se imprime en consola el codigo y el canal origen.
6. Se guarda log en `logs/codes.ndjson`.

Si se detecta posible sorteo:

1. Se normaliza el mensaje: minusculas, sin acentos, una sola palabra.
2. Se cuentan usuarios distintos por canal y palabra.
3. Si se alcanza el umbral, suena alerta.
4. Se imprime el canal y la palabra.
5. Se guarda log en `logs/giveaway-alerts.ndjson`.

## Menu TUI

Arranque recomendado:

```powershell
npm run menu
```

Ejecutalo directamente en una terminal interactiva: PowerShell en Windows o Terminal en macOS. No esta pensado para usarse por pipe o redireccion de entrada.

El menu muestra una cabecera fija `Mode-Scripts v1 // INFERNO OPS` en todas las pantallas, con estetica roja tipo consola hacker, paneles oscuros, linea de senal IRC y estado rapido de modo, canales y bridge. En terminales compatibles usa una superficie TUI propia para que el banner quede anclado arriba y el cuerpo se mueva debajo. Guarda configuracion en:

```text
config/mode-scripts.json
```

Ese archivo esta versionado por Git para compartir la misma configuracion entre Windows y macOS.

Desde el menu puedes:

- arrancar con la configuracion guardada;
- elegir modo: solo codigos, codigos + sorteos, o solo sorteos;
- anadir, eliminar, reemplazar o borrar canales de codigos;
- anadir, eliminar, reemplazar o borrar canales de sorteos;
- ajustar sensibilidad del detector de sorteos;
- activar o desactivar el puente KeyDrop;
- ver la ruta del archivo de configuracion.
- subir la configuracion actual a GitHub con commit y push automatico.

### Canales Persistentes

Para modificar canales desde el TUI:

1. Ejecuta `npm run menu`.
2. Entra en `Anadir / eliminar / modificar canales de codigos` o `Anadir / eliminar / modificar canales de sorteos`.
3. Usa `Anadir canal(es)`, `Eliminar canal`, `Reemplazar lista completa` o `Borrar todos`.
4. Vuelve al menu principal.
5. Usa `Arrancar con configuracion guardada`.

Los canales se escriben sin `#` y separados por coma:

```text
canal1,canal2,canal3
```

Puedes usar canales distintos para codigos y para sorteos. Si el modo incluye sorteos pero no hay canales de sorteos guardados, el menu puede usar los canales de codigos como fallback.

### Sincronizar Configuracion

Desde el menu principal puedes usar:

```text
Subir configuracion a GitHub
```

Esa opcion hace automaticamente:

1. Guarda `config/mode-scripts.json`.
2. Ejecuta `git add -f config/mode-scripts.json`.
3. Crea un commit solo con ese archivo si hay cambios.
4. Ejecuta `git push origin <branch>`.

Tambien puedes hacerlo sin abrir el menu:

```powershell
npm run config:push
```

Si en macOS Git pide `Username for 'https://github.com'`, significa que ese equipo aun no tiene credenciales de GitHub guardadas. El push automatico no abre un prompt interactivo para evitar que el menu se quede esperando input oculto. Configura GitHub una vez con GitHub CLI:

```bash
gh auth login
gh auth setup-git
```

Luego vuelve a ejecutar:

```bash
npm run config:push
```

Alternativa con SSH:

```bash
git remote set-url origin git@github.com:JoseMiguel-DG/mode-scripts.git
```

Para usar los cambios en el otro equipo:

```bash
git pull
npm install
npm run menu
```

### Dashboard

Durante la ejecucion, el TUI cambia a dashboard visual:

- `RUNNING DASHBOARD // ACTIVE SESSION`: modo activo, uptime y estado del puente KeyDrop.
- `CODE CLIPBOARD // PROCESS NODE`: proceso del detector de codigos, PID, canales conectados y barra de senal.
- `GIVEAWAY LISTENER // PROCESS NODE`: proceso del detector de sorteos, PID, canales conectados y barra de senal.
- `LIVE FEED // IRC STREAM`: ultimos eventos importantes coloreados por tipo.

El banner superior queda fijo y el contenido del dashboard se pinta dentro de un viewport. Si hay muchos canales o no caben todos los bloques en la terminal, navega escribiendo estos comandos y pulsando Enter:

```text
down
up
pgdn
pgup
top
bottom
```

Estados por canal:

- `[WAIT] #canal`: aun no se ha confirmado el JOIN.
- `[JOIN OK] #canal`: Twitch confirmo la conexion al canal.

Para parar todo de forma ordenada, escribe en el dashboard:

```text
stop
```

Tambien funcionan `exit`, `quit` o `q`. El dashboard enviara cierre a los procesos activos y, si alguno no termina tras unos segundos, intentara forzar el cierre.

Atajo equivalente:

```text
Ctrl+C
```

## Detector de Codigos

Comando directo para un canal:

```powershell
npm start -- --channel nombre_del_canal
```

Comando directo para varios canales:

```powershell
npm start -- --channels canal1,canal2,canal3
```

Tambien puedes usar variables de entorno:

```powershell
$env:TWITCH_CHANNEL="nombre_del_canal"
npm start
```

```powershell
$env:TWITCH_CHANNELS="canal1,canal2,canal3"
npm start
```

Cuando aparece un codigo, queda copiado al portapapeles. Si no usas automatizacion de KeyDrop, pulsa `Ctrl+V` en la pagina donde quieras reclamarlo.

Opciones:

- `--channel`: canal de Twitch sin `#`.
- `--channels`: varios canales separados por coma o espacios.
- `--dedup-minutes`: minutos para ignorar codigos repetidos. Por defecto: `10`.
- `--sound`: ruta del archivo de sonido. Por defecto: `C:\Windows\Media\Alarm01.wav` en Windows y `/System/Library/Sounds/Glass.aiff` en macOS.
- `--log-file`: archivo NDJSON de codigos. Por defecto: `logs/codes.ndjson`.
- `--failure-log-file`: archivo NDJSON de fallos KeyDrop. Por defecto: `logs/keydrop-failures.ndjson`.
- `--sound-test`: prueba el sonido y sale.
- `--keydrop-bridge`: activa el puente local para KeyDrop.
- `--bridge-host`: host del puente. Por defecto: `127.0.0.1`.
- `--bridge-port`: puerto del puente. Por defecto: `17373`.
- `--test`: simula mensajes sin conectar a Twitch.

Variables equivalentes:

- `TWITCH_CHANNEL`
- `TWITCH_CHANNELS`
- `DEDUP_MINUTES`
- `SOUND_PATH`
- `LOG_FILE`
- `FAILURE_LOG_FILE`
- `KEYDROP_BRIDGE`
- `KEYDROP_BRIDGE_HOST`
- `KEYDROP_BRIDGE_PORT`

Formato detectado:

```text
4 caracteres hexadecimales
guion
4 caracteres hexadecimales
guion
4 caracteres hexadecimales
guion
4 caracteres hexadecimales
```

Ejemplos validos:

```text
BE9D-EDF2-2DA6-2216
Codigo: BE9D-EDF2-2DA6-2216
claim BE9D-EDF2-2DA6-2216 rapido
```

## Detector de Sorteos

Comando directo:

```powershell
npm run giveaways -- --channels canal1,canal2,canal3
```

Mas sensible:

```powershell
npm run giveaways -- --channels canal1,canal2 --threshold 3 --window-seconds 15
```

Por defecto avisa si `4` usuarios distintos escriben la misma palabra en `12` segundos.

El detector:

- solo considera mensajes de una sola palabra;
- normaliza mayusculas y acentos;
- cuenta usuarios distintos, no mensajes totales;
- aplica cooldown por canal/palabra para no repetir la misma alerta constantemente.

Opciones:

- `--channel`: un canal de Twitch sin `#`.
- `--channels`: varios canales separados por coma o espacios.
- `--threshold`: usuarios distintos necesarios. Por defecto: `4`.
- `--window-seconds`: ventana de deteccion. Por defecto: `12`.
- `--cooldown-seconds`: segundos antes de repetir canal/palabra. Por defecto: `90`.
- `--min-length`: longitud minima de palabra. Por defecto: `3`.
- `--max-length`: longitud maxima de palabra. Por defecto: `32`.
- `--sound`: ruta del archivo de sonido. Por defecto: `C:\Windows\Media\Alarm01.wav` en Windows y `/System/Library/Sounds/Glass.aiff` en macOS.
- `--log-file`: archivo NDJSON de alertas. Por defecto: `logs/giveaway-alerts.ndjson`.
- `--sound-test`: prueba el sonido y sale.
- `--test`: simula una alerta sin conectar a Twitch.

Variables equivalentes:

- `TWITCH_CHANNELS`
- `TWITCH_CHANNEL`
- `GIVEAWAY_THRESHOLD`
- `GIVEAWAY_WINDOW_SECONDS`
- `GIVEAWAY_COOLDOWN_SECONDS`
- `GIVEAWAY_MIN_LENGTH`
- `GIVEAWAY_MAX_LENGTH`
- `GIVEAWAY_LOG_FILE`
- `SOUND_PATH`

Ejemplo de alerta:

```text
[sorteo] Posible sorteo en #canal1: "diamante" (4 usuarios distintos en 12s)
```

## Sonido

Probar sonido del detector de codigos:

```powershell
npm run sound-test
```

Probar sonido con otro WAV:

```powershell
npm run sound-test -- --sound "C:\Windows\Media\Alarm05.wav"
```

Ejemplo en macOS:

```bash
npm run sound-test -- --sound "/System/Library/Sounds/Ping.aiff"
```

Probar sonido del detector de sorteos:

```powershell
npm run giveaways -- --sound-test
```

El programa intenta:

1. Reproducir el archivo configurado.
2. En Windows, usar sonidos del sistema y `Console.Beep` como fallback.
3. En macOS, usar `afplay` y `osascript -e "beep 2"` como fallback.

## Modo de Prueba

Detector de codigos:

```powershell
npm test
```

Este modo simula codigos normales, codigos duplicados y mensajes sin codigo. Copia al portapapeles, reproduce sonido y escribe log.

Detector de sorteos:

```powershell
npm run giveaways -- --test
```

Este modo simula una rafaga de usuarios escribiendo `diamante`, reproduce sonido y escribe en `logs/giveaway-alerts.ndjson`.

## Puente KeyDrop

Node.js no puede usar automaticamente las cookies de tu navegador con `credentials: "include"`. Para ejecutar la peticion desde tu sesion abierta en KeyDrop, esta herramienta puede abrir un puente local en `127.0.0.1`. Despues, un script ejecutado dentro de la propia pagina de KeyDrop recibe el codigo y lanza el `fetch` desde el navegador.

Usalo solo si cumple las normas de la pagina y bajo tu responsabilidad.

Arranque con puente:

```powershell
npm start -- --channels canal1,canal2 --keydrop-bridge
```

Veras algo como:

```text
[bridge] Puente KeyDrop escuchando en ws://127.0.0.1:17373/codes
```

Cuando el monitor detecta un codigo:

1. Lo copia al portapapeles.
2. Lo envia al script de KeyDrop por WebSocket local.
3. El navegador ejecuta el `POST` con tus cookies.

### Script Manual de Navegador

El archivo `keydrop-browser-bridge.js` puede pegarse manualmente en DevTools:

1. Abre `https://key-drop.com/es/Pay/`.
2. Inicia sesion.
3. Abre DevTools con `F12`.
4. Ve a consola.
5. Pega el contenido de `keydrop-browser-bridge.js`.

Para detenerlo:

```js
window.__KEYDROP_BRIDGE_STOP__()
```

### Tampermonkey

Para uso real es mas comodo usar `keydrop-tampermonkey.user.js` en Tampermonkey. Asi el puente se carga solo cada vez que KeyDrop refresca.

El userscript:

- conecta automaticamente con `ws://127.0.0.1:17373/codes`;
- muestra panel con estado del WebSocket, canje, disponibilidad, Cloudflare, ultimo codigo y proximo refresh;
- permite mover/minimizar el panel;
- registra fallos reales en navegador y en `logs/keydrop-failures.ndjson`;
- comprueba `/es/Pay/` periodicamente;
- incluye boton `Probar POST`;
- intenta autorepararse con refresh ante Cloudflare o HTML inesperado;
- no resuelve desafios interactivos de Cloudflare.

Instalacion:

1. Abre Tampermonkey.
2. Crea un script nuevo.
3. Borra el contenido inicial.
4. Pega `keydrop-tampermonkey.user.js`.
5. Guarda con `Ctrl+S`.
6. Abre `https://key-drop.com/es/Pay/`.
7. Arranca el monitor con `--keydrop-bridge`.

Estado ideal:

```text
WS: conectado
Canje: esperando
Disponibilidad: GET OK ...
Auto-repair: activo ...
Cloudflare: sin detectar
```

Si ves Cloudflare o `Auto-repair: requiere accion`, completa la validacion manualmente.

## Logs

Codigos detectados:

```text
logs/codes.ndjson
```

Alertas de sorteo:

```text
logs/giveaway-alerts.ndjson
```

Fallos KeyDrop:

```text
logs/keydrop-failures.ndjson
```

Ver logs desde terminal:

```powershell
Get-Content .\logs\codes.ndjson
Get-Content .\logs\giveaway-alerts.ndjson
Get-Content .\logs\keydrop-failures.ndjson
```

Los logs no guardan cookies ni cabeceras sensibles.

## Portapapeles y Latencia

La herramienta usa WebSocket directo al IRC de Twitch y procesa solo mensajes `PRIVMSG`.

En codigos, la prioridad es copiar al portapapeles. El sonido, el puente y el log se lanzan despues o en paralelo para no bloquear mas de lo necesario.

Primero intenta copiar con `clipboardy`. Si falla, usa fallback por sistema:

```powershell
Set-Clipboard -Value "CODIGO"
```

En macOS usa:

```bash
pbcopy
```

## AutoHotkey Opcional Solo Windows

El archivo `manual-hotkey.ahk` requiere AutoHotkey v2. No reclama nada por si solo: necesitas pulsar manualmente `F8`.

Al pulsar `F8` hace:

1. `Ctrl+V`
2. pausa de `20 ms`
3. `Enter`

Usalo solo cuando el campo correcto este enfocado.
