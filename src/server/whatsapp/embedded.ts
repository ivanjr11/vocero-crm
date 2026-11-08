import { randomInt } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { getEnv } from "@/lib/env";
import { graphRequest, MetaApiError } from "@/lib/meta/client";
import { saveCredentials } from "@/server/whatsapp/credentials";
import {
  descubrirCuentaDeMensajes,
  registerWebhookForNumber,
  type WebhookRegistration,
} from "@/server/whatsapp/connect";
import { webhookUrl, webhookVerifyToken } from "@/server/whatsapp/webhook-url";

/**
 * 066 — «Conectar con Meta» (Embedded Signup v4), del lado del servidor.
 *
 * Puerto de la spec 104 del fork de un cliente, sin la coexistencia:
 *
 *   canje del `code` → número de la WABA → registro con PIN →
 *   credenciales cifradas → webhook (cuenta de WhatsApp, de mensajes y número)
 *
 * Regla de esta frontera: ni el `code`, ni el token, ni el secreto, ni el
 * error crudo de Meta salen de aquí. Todo fallo es un `EmbeddedSignupError`
 * con un mensaje para quien conecta. Nada se guarda si algo falla antes de
 * las credenciales: la conexión anterior sigue como estaba.
 */

/** Lo que necesita la instancia para ofrecer el botón (CA-1). */
export function embeddedConfig() {
  const env = getEnv();
  const appId = env.META_APP_ID?.trim() ?? "";
  const configId = env.META_EMBEDDED_CONFIG_ID?.trim() ?? "";
  const secret = env.META_APP_SECRET?.trim() ?? "";
  const ready = /^\d+$/.test(appId) && /^\d+$/.test(configId) && secret.length > 0;
  return { ready, appId, configId, secret, graphVersion: env.META_GRAPH_API_VERSION };
}

export class EmbeddedSignupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "EmbeddedSignupError";
  }
}

/**
 * Canje del código por el token del negocio. Meta exige los parámetros en la
 * query; se usa `node:https` y no `fetch` para que la URL (con el secreto)
 * no termine en las trazas de Next. Sin `redirect_uri`: el flujo del SDK de
 * JS no lo usa. Nunca se propaga la URL ni la respuesta.
 */
export async function canjearCodigo(code: string): Promise<string> {
  const cfg = embeddedConfig();
  const env = getEnv();
  const url = new URL(`${env.META_GRAPH_BASE_URL}/${cfg.graphVersion}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.secret,
    code,
  }).toString();
  try {
    const token = await oauthGet(url);
    if (token) return token;
  } catch {
    // cae abajo
  }
  throw new EmbeddedSignupError(
    "exchange_failed",
    "Meta no pudo completar la autorización. Revisa que META_APP_ID, META_APP_SECRET y la configuración de Embedded Signup sean de la misma app y vuelve a conectar."
  );
}

function oauthGet(url: URL): Promise<string | null> {
  // http solo hacia el wa-mock local, nunca en producción.
  const local =
    url.protocol === "http:" &&
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    return Promise.reject(new Error("transporte no permitido"));
  }
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      { method: "GET", timeout: 15_000, headers: { Accept: "application/json" } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          raw += c;
          if (raw.length > 131_072) req.destroy();
        });
        res.on("error", () => reject(new Error("fallo")));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) return resolve(null);
            const v = JSON.parse(raw) as { access_token?: unknown };
            resolve(typeof v.access_token === "string" && v.access_token ? v.access_token : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => reject(new Error("fallo")));
    req.end();
  });
}

export type NumeroDeLaWaba = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  status?: string;
  platform_type?: string;
};

async function graph<T>(
  path: string,
  token: string,
  opts: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<T> {
  try {
    return await graphRequest<T>(path, { token, method: opts.method, body: opts.body });
  } catch (err) {
    if (err instanceof MetaApiError && (err.status === 0 || err.status >= 500)) {
      throw new EmbeddedSignupError(
        "meta_unavailable",
        "No pudimos contactar con Meta. Inténtalo de nuevo; tu conexión anterior se conserva.",
        503
      );
    }
    throw new EmbeddedSignupError(
      "meta_rejected",
      "Meta no aceptó este paso. Revisa que hayas compartido la cuenta de WhatsApp y el número en la ventana de Meta, y vuelve a conectar."
    );
  }
}

/**
 * El número que se conecta. Con `phoneNumberId` (el del evento) se comprueba
 * que sea de la WABA autorizada. Sin él, se usa el único número de la WABA;
 * con varios no se adivina (CA-3).
 */
export async function resolverNumero(
  token: string,
  wabaId: string,
  phoneNumberId: string | null
): Promise<NumeroDeLaWaba> {
  const numeros: NumeroDeLaWaba[] = [];
  let after: string | undefined;
  // No se sigue `paging.next`: una URL de fuera nunca recibe el token.
  for (let pagina = 0; pagina < 10; pagina++) {
    const res = await graph<{
      data?: NumeroDeLaWaba[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(
      `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type&limit=100${
        after ? `&after=${encodeURIComponent(after)}` : ""
      }`,
      token
    );
    numeros.push(...(res.data ?? []));
    if (!res.paging?.next || !res.paging.cursors?.after) break;
    after = res.paging.cursors.after;
  }
  const elegido = phoneNumberId
    ? numeros.find((n) => n.id === phoneNumberId)
    : numeros.length === 1
      ? numeros[0]
      : undefined;
  if (!elegido) {
    throw new EmbeddedSignupError(
      phoneNumberId ? "asset_mismatch" : numeros.length > 1 ? "varios_numeros" : "sin_numero",
      phoneNumberId
        ? "El número elegido no pertenece a la cuenta de WhatsApp que se autorizó."
        : numeros.length > 1
          ? "La cuenta de WhatsApp tiene varios números y Meta no dijo cuál se conectó. Repite la conexión eligiendo el número, o conéctalo a mano."
          : "Meta no devolvió ningún número en esa cuenta de WhatsApp. Repite la conexión y agrega el número en la ventana de Meta."
    );
  }
  if (!elegido.display_phone_number) {
    throw new EmbeddedSignupError("asset_mismatch", "Meta no devolvió los datos del número.");
  }
  if (elegido.platform_type === "ON_PREMISE") {
    throw new EmbeddedSignupError(
      "migration_required",
      "Ese número usa la API local antigua y requiere una migración. No se modificó nada."
    );
  }
  return elegido;
}

/** Seis dígitos para la verificación en dos pasos del número. */
export function generarPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Registra el número en la Cloud API con su PIN (CA-4). Si ya está
 * `CONNECTED`, no se toca: re-registrar con otro PIN fallaría.
 */
export async function registrarNumero(
  token: string,
  numero: NumeroDeLaWaba,
  pin: string
): Promise<boolean> {
  if (numero.status === "CONNECTED") return false;
  let res: { success?: boolean };
  try {
    res = await graph<{ success?: boolean }>(`${numero.id}/register`, token, {
      method: "POST",
      body: { messaging_product: "whatsapp", pin },
    });
  } catch (err) {
    if (err instanceof EmbeddedSignupError && err.code === "meta_rejected") {
      throw new EmbeddedSignupError(
        "registration_failed",
        "Meta no registró el número. Si ya tenía verificación en dos pasos, escribe su PIN y repite la conexión. No se guardó nada."
      );
    }
    throw err;
  }
  if (!res.success) {
    throw new EmbeddedSignupError(
      "registration_failed",
      "Meta no confirmó el registro del número. Repite la conexión; no se guardó nada."
    );
  }
  return true;
}

export type ResultadoAlta = {
  displayPhoneNumber: string;
  wabaId: string;
  phoneNumberId: string;
  messagingAccountId: string | null;
  /** true si esta alta llamó a `/register` (el número no estaba conectado). */
  registered: boolean;
  /**
   * El PIN que generó el servidor, para que el dueño lo guarde. Solo viaja
   * en esta respuesta: no se guarda ni se registra en logs.
   */
  generatedPin?: string;
  webhook: WebhookRegistration;
};

export async function completarAltaEmbebida(input: {
  organizationId: string;
  code: string;
  wabaId: string;
  phoneNumberId: string | null;
  /** El PIN que ya tenía el número; sin él, se genera uno. */
  pin: string | null;
}): Promise<ResultadoAlta> {
  const token = await canjearCodigo(input.code);
  const numero = await resolverNumero(token, input.wabaId, input.phoneNumberId);
  const pin = input.pin ?? generarPin();
  const registered = await registrarNumero(token, numero, pin);

  // 065 — Best-effort: sin ella, el dueño la escribe en el formulario manual.
  const messagingAccountId = await descubrirCuentaDeMensajes(input.wabaId, token);

  await saveCredentials({
    organizationId: input.organizationId,
    wabaId: input.wabaId,
    messagingAccountId,
    phoneNumberId: numero.id,
    token,
    displayPhoneNumber: numero.display_phone_number ?? null,
    verifiedName: numero.verified_name ?? null,
  });

  const webhook = await registerWebhookForNumber({
    wabaId: input.wabaId,
    phoneNumberId: numero.id,
    token,
    webhookUrl: webhookUrl("wa"),
    verifyToken: webhookVerifyToken(),
    messagingAccountId,
  });

  return {
    displayPhoneNumber: numero.display_phone_number!,
    wabaId: input.wabaId,
    phoneNumberId: numero.id,
    messagingAccountId,
    registered,
    ...(registered && !input.pin ? { generatedPin: pin } : {}),
    webhook,
  };
}
