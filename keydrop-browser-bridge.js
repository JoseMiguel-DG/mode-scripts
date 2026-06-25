(() => {
  const BRIDGE_URL = "ws://127.0.0.1:17373/codes";
  const PAY_URL = `${location.origin}/es/Pay/`;
  const seenCodes = new Set();
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;

  async function redeemGiftcard(giftcardCode) {
    const formData = new FormData();
    formData.append("method", "giftcard-kinguin");
    formData.append("code", giftcardCode);

    try {
      const response = await fetch(PAY_URL, {
        method: "POST",
        body: formData,
        credentials: "include"
      });

      const contentType = response.headers.get("content-type") || "";
      const rawText = await response.text();
      let result = null;

      if (contentType.includes("application/json")) {
        try {
          result = JSON.parse(rawText);
        } catch {
          result = null;
        }
      }

      console.log("[KeyDrop bridge] Codigo:", giftcardCode);
      console.log("[KeyDrop bridge] HTTP status:", response.status);
      console.log("[KeyDrop bridge] Respuesta cruda:", rawText);

      if (!response.ok) {
        console.log("[KeyDrop bridge] Error HTTP:", response.status);
        return;
      }

      if (result) {
        console.log("[KeyDrop bridge] Respuesta JSON:", result);

        if (
          result.status === true ||
          result.success === true ||
          result.status === "success"
        ) {
          console.log("[KeyDrop bridge] Gift Card canjeada con exito.");
        } else {
          console.log(
            "[KeyDrop bridge] Error al canjear:",
            result.message || result.error || result.msg || "Codigo invalido, usado o proveedor incorrecto."
          );
        }
      } else {
        console.log("[KeyDrop bridge] La respuesta no era JSON. Revisa el texto crudo de arriba.");
      }
    } catch (error) {
      console.error("[KeyDrop bridge] Error en la peticion:", error);
    }
  }

  function connect() {
    if (stopped) return;

    socket = new WebSocket(BRIDGE_URL);

    socket.addEventListener("open", () => {
      console.log("[KeyDrop bridge] Conectado al monitor local.");
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type !== "code" || typeof payload.code !== "string") return;
      if (seenCodes.has(payload.code)) return;
      seenCodes.add(payload.code);

      console.log("[KeyDrop bridge] Codigo recibido:", payload.code);
      void redeemGiftcard(payload.code);
    });

    socket.addEventListener("close", () => {
      if (stopped) return;
      console.log("[KeyDrop bridge] Desconectado. Reintentando...");
      reconnectTimer = setTimeout(connect, 1000);
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        // Ignorar: el cierre ya esta en curso.
      }
    });
  }

  window.__KEYDROP_BRIDGE_STOP__ = () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
    console.log("[KeyDrop bridge] Detenido.");
  };

  connect();
})();
