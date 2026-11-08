/**
 * Self-test E2E de comportamiento — 065, la Cuenta de mensajes del split de
 * Meta de 2026 e importar las plantillas creadas fuera de Vocero (guion
 * tests/e2e/us-cuenta-de-mensajes.md).
 *
 * Reproduce las dos fallas vistas en producción el 28-oct-2026: crear una
 * plantilla en la cuenta de WhatsApp ya partida respondía «Invalid parameter»
 * (#100/2388339), y `hello_world` o las del Administrador de WhatsApp nunca
 * aparecían al sincronizar.
 *
 * Uso: node --env-file=.env scripts/e2e-cuenta-de-mensajes.mjs
 * Requiere: app corriendo con WA_MOCK_ENABLED=true, META_GRAPH_BASE_URL al
 * wa-mock y BD migrada.
 */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";

let cookie = "";
let failures = 0;
let checks = 0;

function ok(name, cond, extra = "") {
  checks++;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) {
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  }
  let json = null;
  try {
    json = await res.clone().json();
  } catch {}
  return { res, json };
}

const stamp = Date.now().toString(36);
const n = Date.now().toString().slice(-7);
const PN = `PN-065-${stamp}`;
const WABA = `WABA-065-${stamp}`;
const MA = `9${n}01`;
const WABA_DESC = `WABA-065D-${stamp}`;
const MA_DESC = `9${n}02`;
const WEBHOOK_PATH_HINT = "/api/webhooks/";

const nombres = {
  hello: `hello_world_${stamp}`,
  conBotones: `promo_botones_${stamp}`,
  conImagen: `catalogo_imagen_${stamp}`,
  otp: `codigo_${stamp}`,
  urlDinamica: `rastreo_${stamp}`,
  rechazada: `vieja_${stamp}`,
};

async function plantillas() {
  const { json } = await api("/api/templates");
  return json?.templates ?? [];
}

async function suscripciones() {
  const { json } = await api("/api/dev/wa-mock/webhooks");
  return json?.wabaSubscriptions ?? {};
}

function guardar(extra = {}, token = "tok-065") {
  return api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ wabaId: WABA, phoneNumberId: PN, token, ...extra }),
  });
}

async function main() {
  console.log("== Setup: operador y una cuenta de WhatsApp ya partida ==");
  const email = "e2e@vocero.test";
  const password = "password-e2e-123";
  let su = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "Operador E2E" }),
  });
  if (!su.res.ok) {
    su = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  ok("registro o login del operador", su.res.ok, JSON.stringify(su.json));

  // 105 plantillas de relleno: con `limit=100`, la importación necesita la
  // segunda página. Antes de la 065 el sync leía solo la primera.
  const relleno = Array.from({ length: 105 }, (_, i) => ({
    name: `relleno_${stamp}_${i}`,
    components: [{ type: "BODY", text: `Aviso ${i} para {{1}}` }],
  }));
  const split = await api("/api/dev/wa-mock/cuenta-de-mensajes", {
    method: "POST",
    body: JSON.stringify({
      wabaId: WABA,
      messagingAccountId: MA,
      descubrible: false,
      plantillasExternas: [
        ...relleno,
        // Se envía tal cual: solo cuerpo con variable.
        {
          name: nombres.hello,
          language: "en_US",
          components: [{ type: "BODY", text: "Hello {{1}}, welcome!" }],
        },
        // Encabezado de texto fijo, pie y botones sin variables: se importa.
        {
          name: nombres.conBotones,
          category: "MARKETING",
          components: [
            { type: "HEADER", format: "TEXT", text: "Promoción" },
            { type: "BODY", text: "Hola {{1}}, hoy tenemos {{2}}." },
            { type: "FOOTER", text: "Responde BAJA para no recibir más" },
            {
              type: "BUTTONS",
              buttons: [
                { type: "QUICK_REPLY", text: "Me interesa" },
                { type: "URL", text: "Ver", url: "https://tienda.mock/promo" },
              ],
            },
          ],
        },
        // Lo que Vocero no sabe enviar: NO se importa.
        {
          name: nombres.conImagen,
          components: [
            { type: "HEADER", format: "IMAGE" },
            { type: "BODY", text: "Nuestro catálogo" },
          ],
        },
        {
          name: nombres.otp,
          category: "AUTHENTICATION",
          components: [{ type: "BODY", text: "Tu código es {{1}}" }],
        },
        {
          name: nombres.urlDinamica,
          components: [
            { type: "BODY", text: "Tu pedido va en camino" },
            {
              type: "BUTTONS",
              buttons: [{ type: "URL", text: "Rastrear", url: "https://envios.mock/{{1}}" }],
            },
          ],
        },
        // Una rechazada se importa con su estado, para que se vea.
        {
          name: nombres.rechazada,
          status: "REJECTED",
          components: [{ type: "BODY", text: "Oferta vieja" }],
        },
      ],
    }),
  });
  ok("wa-mock: cuenta partida y plantillas externas sembradas", split.res.ok, JSON.stringify(split.json));

  console.log("\n== Sin la Cuenta de mensajes: el 2388339 se explica ==");
  let conn = await guardar();
  ok("conexión guardada sin Cuenta de mensajes", conn.res.ok, JSON.stringify(conn.json));
  ok(
    "no se inventa una Cuenta de mensajes si Meta no la revela",
    conn.json?.messagingAccountId == null,
    JSON.stringify(conn.json?.messagingAccountId)
  );
  const fallida = await api("/api/templates", {
    method: "POST",
    body: JSON.stringify({
      name: `nueva_${stamp}`,
      language: "es_MX",
      category: "UTILITY",
      body: "Hola {{1}}",
      examples: ["Ana"],
    }),
  });
  ok(
    "crear plantilla → error tipado (no 500)",
    fallida.res.status >= 400 && fallida.res.status < 500,
    `status ${fallida.res.status}`
  );
  ok(
    "el error dice dónde agregar la Cuenta de mensajes (no «Invalid parameter»)",
    /Cuenta de mensajes/.test(fallida.json?.error?.message ?? ""),
    fallida.json?.error?.message
  );
  const syncFallido = await api("/api/templates/sync", { method: "POST" });
  ok(
    "sincronizar sin Cuenta de mensajes → error tipado, sin colgarse",
    syncFallido.res.status >= 400 && syncFallido.res.status < 600,
    `status ${syncFallido.res.status}`
  );

  console.log("\n== Con la Cuenta de mensajes: webhook en las dos cuentas ==");
  conn = await guardar({ messagingAccountId: MA });
  ok("conexión guardada con la Cuenta de mensajes", conn.res.ok, JSON.stringify(conn.json));
  ok("la respuesta trae la Cuenta de mensajes", conn.json?.messagingAccountId === MA);
  ok(
    "el webhook quedó registrado también en la Cuenta de mensajes",
    conn.json?.webhook?.messagingAccount?.ok === true &&
      !conn.json?.webhook?.messagingAccount?.skipped,
    JSON.stringify(conn.json?.webhook)
  );
  let subs = await suscripciones();
  ok(
    "Meta (mock) tiene el override de esta instancia en la Cuenta de mensajes",
    (subs[MA]?.overrideCallbackUri ?? "").includes(WEBHOOK_PATH_HINT),
    JSON.stringify(subs[MA])
  );
  const get = await api("/api/settings/whatsapp");
  ok(
    "Ajustes → WhatsApp devuelve la Cuenta de mensajes guardada",
    get.json?.connection?.messagingAccountId === MA,
    JSON.stringify(get.json?.connection)
  );

  console.log("\n== Crear plantilla va a la Cuenta de mensajes ==");
  const nueva = `nueva_${stamp}`;
  const creada = await api("/api/templates", {
    method: "POST",
    body: JSON.stringify({
      name: nueva,
      language: "es_MX",
      category: "UTILITY",
      body: "Hola {{1}}, ¿seguimos?",
      examples: ["Ana"],
    }),
  });
  ok("plantilla creada", creada.res.ok, JSON.stringify(creada.json));
  ok(
    "queda Pendiente de Meta",
    (await plantillas()).find((t) => t.name === nueva)?.status === "pending"
  );

  console.log("\n== Sincronizar importa las plantillas externas ==");
  const sync = await api("/api/templates/sync", { method: "POST" });
  ok("sync 200", sync.res.ok, JSON.stringify(sync.json));
  let lista = await plantillas();
  const por = (name) => lista.find((t) => t.name === name);
  ok("hello_world importada y aprobada", por(nombres.hello)?.status === "approved", JSON.stringify(por(nombres.hello)));
  ok(
    "la de encabezado de texto, pie y botones fijos se importa (MARKETING)",
    por(nombres.conBotones)?.category === "MARKETING"
  );
  ok("la rechazada se importa con su estado", por(nombres.rechazada)?.status === "rejected");
  ok("encabezado con imagen NO se importa", !por(nombres.conImagen));
  ok("AUTHENTICATION NO se importa", !por(nombres.otp));
  ok("botón de URL dinámica NO se importa", !por(nombres.urlDinamica));
  const rellenos = lista.filter((t) => t.name.startsWith(`relleno_${stamp}_`)).length;
  ok("se recorrió toda la paginación (105 de relleno)", rellenos === 105, `${rellenos}`);
  ok(
    "el sync cuenta las importadas",
    (sync.json?.updated ?? 0) >= 108,
    JSON.stringify(sync.json)
  );
  const otra = await api("/api/templates/sync", { method: "POST" });
  ok("segundo sync no duplica ni reescribe", otra.json?.updated === 0, JSON.stringify(otra.json));
  lista = await plantillas();
  ok(
    "sin duplicados de hello_world",
    lista.filter((t) => t.name === nombres.hello).length === 1
  );

  console.log("\n== El webhook de estado llega por la Cuenta de mensajes ==");
  const aprob = await api("/api/dev/wa-mock/template-status", {
    method: "POST",
    body: JSON.stringify({ wabaId: MA, name: nueva, language: "es_MX", event: "APPROVED" }),
  });
  ok("webhook entregado con entry.id = Cuenta de mensajes", aprob.json?.delivered === true, JSON.stringify(aprob.json));
  ok(
    "la plantilla nueva pasa a aprobada",
    (await plantillas()).find((t) => t.name === nueva)?.status === "approved"
  );

  console.log("\n== Una plantilla importada se puede enviar ==");
  const tel = `52155${n}`;
  const contacto = await api("/api/contacts", {
    method: "POST",
    body: JSON.stringify({ name: `Cliente 065 ${stamp}`, phone: tel, source: "otro" }),
  });
  ok("contacto capturado", contacto.res.status === 201, JSON.stringify(contacto.json));
  // Sin vaciar el outbox: su DELETE reinicia TODO el estado del mock (el
  // split y las plantillas sembradas). Se mira solo lo nuevo.
  const antes = (await api("/api/dev/wa-mock/outbox")).json?.outbox?.length ?? 0;
  const hello = (await plantillas()).find((t) => t.name === nombres.hello);
  const envio = await api(`/api/contacts/${contacto.json?.contact?.id}/start-conversation`, {
    method: "POST",
    body: JSON.stringify({ templateId: hello?.id, variables: ["Ana"] }),
  });
  ok("iniciar conversación con hello_world importada", envio.res.ok, JSON.stringify(envio.json));
  const { json: out } = await api("/api/dev/wa-mock/outbox");
  const enviado = (out?.outbox ?? []).slice(antes).find((e) => e.type === "template");
  ok(
    "a Meta (mock) le llega la plantilla con su nombre e idioma",
    enviado?.body?.template?.name === nombres.hello &&
      enviado?.body?.template?.language?.code === "en_US",
    JSON.stringify(enviado?.body?.template)
  );

  console.log("\n== Rotar el token conserva la Cuenta de mensajes; vacía la borra ==");
  conn = await guardar({}, "tok-065-nuevo");
  ok("rotar el token sin mandarla la conserva", conn.json?.messagingAccountId === MA, JSON.stringify(conn.json?.messagingAccountId));
  conn = await guardar({ messagingAccountId: "" }, "tok-065-nuevo");
  ok("mandarla vacía la borra", conn.res.ok && conn.json?.messagingAccountId == null, JSON.stringify(conn.json?.messagingAccountId));
  const basura = await guardar({ messagingAccountId: "no-es-numero" });
  ok("una ID no numérica → 422/400, sin guardar", basura.res.status === 400 || basura.res.status === 422, `status ${basura.res.status}`);

  console.log("\n== Desconectar quita el override de la Cuenta de mensajes ==");
  await guardar({ messagingAccountId: MA });
  const desc = await api("/api/settings/whatsapp", { method: "DELETE" });
  ok("desconectar 200", desc.res.ok, JSON.stringify(desc.json));
  subs = await suscripciones();
  ok(
    "el override de esta instancia ya no está en la Cuenta de mensajes",
    !(subs[MA]?.overrideCallbackUri ?? ""),
    JSON.stringify(subs[MA])
  );

  console.log("\n== Descubrir la Cuenta de mensajes (best-effort) ==");
  await api("/api/dev/wa-mock/cuenta-de-mensajes", {
    method: "POST",
    body: JSON.stringify({ wabaId: WABA_DESC, messagingAccountId: MA_DESC, descubrible: true }),
  });
  const descubierta = await api("/api/settings/whatsapp", {
    method: "PUT",
    body: JSON.stringify({ wabaId: WABA_DESC, phoneNumberId: PN, token: "tok-065" }),
  });
  ok(
    "si Meta la revela, se guarda sola",
    descubierta.json?.messagingAccountId === MA_DESC,
    JSON.stringify(descubierta.json?.messagingAccountId)
  );

  await api("/api/settings/whatsapp", { method: "DELETE" });
  await api(`/api/dev/wa-mock/cuenta-de-mensajes`, { method: "DELETE" });

  console.log(
    `\n${failures === 0 ? "TODO VERDE" : "CON FALLOS"} — ${checks - failures}/${checks} checks`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
