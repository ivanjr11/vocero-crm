import { graphRequest, MetaApiError } from "@/lib/meta/client";

export type ConnectionCheck =
  | {
      ok: true;
      displayPhoneNumber: string;
      verifiedName: string | null;
    }
  | { ok: false; code: "invalid_token" | "meta_unavailable" | "meta_error"; message: string };

/**
 * Valida token↔número contra la Graph API SIN persistir nada (FR-040):
 * un GET del número con el token debe devolver su display_phone_number.
 */
export async function testConnection(
  phoneNumberId: string,
  token: string
): Promise<ConnectionCheck> {
  try {
    const res = await graphRequest<{
      display_phone_number?: string;
      verified_name?: string;
      id: string;
    }>(`${phoneNumberId}?fields=display_phone_number,verified_name`, {
      token,
    });
    if (!res.display_phone_number) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta no devolvió el número: verifica que el Phone Number ID sea correcto",
      };
    }
    return {
      ok: true,
      displayPhoneNumber: res.display_phone_number,
      verifiedName: res.verified_name ?? null,
    };
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        return {
          ok: false,
          code: "invalid_token",
          message:
            "El token no es válido o expiró. Verifica que corresponde a este número (modo directo: token de usuario del sistema; modo agencia: token entregado por tu backend).",
        };
      }
      if (err.status === 0 || err.status >= 500) {
        return {
          ok: false,
          code: "meta_unavailable",
          message: "Meta no está disponible en este momento; intenta de nuevo",
        };
      }
      return { ok: false, code: "meta_error", message: err.message };
    }
    throw err;
  }
}

/** Respuesta de `GET {WABA}/subscribed_apps`: una entrada por app suscrita. */
type SubscribedApps = {
  data?: {
    whatsapp_business_api_data?: { id?: string; name?: string; link?: string };
    override_callback_uri?: string;
  }[];
};

/** Respuesta de `GET {phone}?fields=webhook_configuration`. */
type WebhookConfiguration = {
  webhook_configuration?: {
    /** Override vigente a nivel del número. */
    phone_number?: string;
    /** Override vigente a nivel de la WABA. */
    waba?: string;
    /** La callback URL del panel de la app. */
    application?: string;
  };
};

/**
 * 065 — El registro en la Cuenta de mensajes del split de 2026. Va aparte del
 * resultado del número: que falle aquí no cambia si el número quedó.
 */
export type MessagingAccountRegistration =
  | { ok: true }
  | {
      ok: true;
      /** Otra app ya enruta esa cuenta a un override ajeno: se respeta. */
      skipped: "override_ajeno";
      host: string;
    }
  | {
      ok: false;
      code: "invalid_token" | "missing_permission" | "meta_unavailable" | "meta_error";
      message: string;
    };

export type WebhookRegistration =
  | {
      ok: true;
      /**
       * Meta no reporta callback URL a nivel app. Los campos (`messages`) se
       * suscriben por app, en su panel —la API de suscripciones de app no
       * admite WhatsApp—, y el override solo redirige lo que la app recibe.
       * Una app sin webhook propio es la sospechosa si no llega nada.
       */
      appWithoutWebhook: boolean;
      /** 065 — Solo si la conexión tiene Cuenta de mensajes. */
      messagingAccount?: MessagingAccountRegistration;
    }
  | {
      ok: true;
      /**
       * La WABA ya enruta sus webhooks a otro sitio (un cerebro externo que
       * recibe de Meta y conversa por `/api/bot/*`, o el backend de una
       * agencia). Se respeta: no se registra el del número, que ganaría.
       */
      skipped: "waba_override";
      /** Solo el host: la ruta de un override suele llevar un secreto. */
      host: string;
    }
  | {
      ok: false;
      code: "invalid_token" | "missing_permission" | "meta_unavailable" | "meta_error";
      message: string;
    };

/**
 * Registra en Meta el webhook de esta instancia para el número conectado,
 * para que nadie tenga que pegarlo a mano en el panel de la app.
 *
 * Tres pasos, por la API de Graph y con el token del propio negocio:
 *
 *   1. `GET /{waba}/subscribed_apps`: si alguna app ya enruta la WABA a un
 *      override AJENO, aquí termina (`skipped`): el override del número tiene
 *      prioridad sobre el de la WABA y dejaría sordo a quien lo puso. Y si un
 *      guardado anterior había dejado el nuestro en el número, se quita.
 *      Sin override, `POST /{waba}/subscribed_apps` sin cuerpo: Meta lo
 *      exige antes de cualquier override. Con uno nuestro (el de una agencia
 *      hacia esta misma instancia), no se re-suscribe: ese POST lo borraría.
 *   2. `POST /{phone}` con `webhook_configuration`: override a nivel NÚMERO.
 *      Meta verifica la URL en ese momento (handshake con el verify token).
 *   3. `GET /{phone}?fields=webhook_configuration`: confirma que quedó.
 *
 * Por qué en el número y no en la WABA: el del número sobrevive a cualquier
 * `subscribed_apps` sin cuerpo y es el que Meta mira primero. Jamás lanza por
 * una respuesta de Meta: guardar la conexión no puede fallar por esto.
 *
 * 065 — Con `messagingAccountId`, además se suscribe la app con override a la
 * Cuenta de mensajes del split de 2026: sin eso, en las cuentas ya partidas
 * los entrantes no llegaban aunque el número tuviera su override. Si la
 * cuenta de WhatsApp enruta a un override ajeno, la de mensajes tampoco se
 * toca: quien enruta una enruta la otra.
 */
export async function registerWebhookForNumber(opts: {
  wabaId: string;
  phoneNumberId: string;
  token: string;
  webhookUrl: string;
  verifyToken: string;
  /**
   * 035 — «Recuperar el webhook»: quien administra decidió que los mensajes
   * vuelvan al CRM aunque la WABA enrute a un override ajeno (el de Nea 1.x,
   * o el backend de una agencia). Se re-suscribe la app SIN cuerpo —así borra
   * Meta el override de la WABA— y se registra el del número. Quitar también
   * el de la WABA es lo que hace que dure: si se quedara, el siguiente
   * «Guardar» lo vería y quitaría el del número, por la regla de arriba.
   */
  forzar?: boolean;
  /** 065 — La Cuenta de mensajes; sin ella, todo como antes del split. */
  messagingAccountId?: string | null;
}): Promise<WebhookRegistration> {
  const { wabaId, phoneNumberId, token, webhookUrl, verifyToken } = opts;
  const ownPath = pathOf(webhookUrl);

  const override = await wabaOverride(wabaId, token);
  if (override && !sameWebhookPath(override, ownPath) && !opts.forzar) {
    const host = hostOf(override);
    console.log(
      `[connect] la WABA ${wabaId} enruta sus webhooks a un override (${host}): se respeta y no se registra el del número`
    );
    await unregisterWebhookForNumber({ phoneNumberId, token, webhookPath: ownPath });
    return { ok: true, skipped: "waba_override", host };
  }
  let cuentaPartida = false;
  if (!override || (opts.forzar && !sameWebhookPath(override, ownPath))) {
    if (override) {
      console.log(
        `[connect] recuperar el webhook: se quita el override de la WABA ${wabaId} (${hostOf(override)})`
      );
    }
    try {
      await graphRequest(`${wabaId}/subscribed_apps`, { method: "POST", token });
    } catch (err) {
      // 066 — Desde el 28-oct-2026 Meta responde 2388339 aquí en las cuentas
      // ya partidas: lo que hace llegar los mensajes es la Cuenta de
      // mensajes. Se decide abajo, con su resultado a la vista.
      if (!esCuentaPartida(err)) {
        return registrationError(err, "No se pudo suscribir la app a la cuenta de WhatsApp");
      }
      cuentaPartida = true;
    }
  }

  // 065 — Si la «WABA» guardada YA es la cuenta de mensajes (el parche de
  // una sola ID), el paso de arriba la cubrió.
  const messagingAccountId = opts.messagingAccountId?.trim();
  const messagingAccount =
    messagingAccountId && messagingAccountId !== wabaId
      ? await registerWebhookForMessagingAccount({
          messagingAccountId,
          token,
          webhookUrl,
          verifyToken,
          forzar: opts.forzar,
        })
      : undefined;

  if (cuentaPartida) {
    if (!messagingAccount) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta ya no acepta suscribir la app en la cuenta de WhatsApp (#100/2388339, el split de 2026): escribe el ID de la Cuenta de mensajes y vuelve a registrar el webhook.",
      };
    }
    if (!messagingAccount.ok) return messagingAccount;
    console.log(
      `[connect] la cuenta de WhatsApp ${wabaId} respondió 2388339; la de mensajes quedó suscrita y se sigue`
    );
  }

  try {
    await graphRequest(phoneNumberId, {
      method: "POST",
      token,
      body: {
        webhook_configuration: {
          override_callback_uri: webhookUrl,
          verify_token: verifyToken,
        },
      },
    });
  } catch (err) {
    return registrationError(err, "Meta no aceptó la dirección del webhook");
  }

  try {
    const res = await graphRequest<WebhookConfiguration>(
      `${phoneNumberId}?fields=webhook_configuration`,
      { token }
    );
    if (res.webhook_configuration?.phone_number !== webhookUrl) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta aceptó el webhook pero no lo confirma en el número. Vuelve a intentarlo en unos minutos.",
      };
    }
    return {
      ok: true,
      appWithoutWebhook: !res.webhook_configuration.application,
      ...(messagingAccount ? { messagingAccount } : {}),
    };
  } catch (err) {
    return registrationError(err, "No se pudo confirmar el webhook en Meta");
  }
}

/**
 * Quita el override del número al desconectar, si es el de esta instancia.
 *
 * Sin esto, el número seguiría mandando sus mensajes aquí después de
 * soltarlo: el override del número gana a cualquier otro webhook, así que el
 * dueño configuraría el suyo en el panel de Meta y no le llegaría nada.
 *
 * Se compara por la RUTA (`/api/webhooks/wa/<verify token>`), no por la URL
 * entera: el dominio pudo cambiar desde que se guardó. Y solo se toca si es
 * nuestro — un override ajeno no es asunto del CRM. Best-effort: desconectar
 * no puede fallar porque Meta no conteste.
 */
export async function unregisterWebhookForNumber(opts: {
  phoneNumberId: string;
  token: string;
  webhookPath: string;
}): Promise<void> {
  const { phoneNumberId, token, webhookPath } = opts;
  try {
    const res = await graphRequest<WebhookConfiguration>(
      `${phoneNumberId}?fields=webhook_configuration`,
      { token }
    );
    const actual = res.webhook_configuration?.phone_number;
    if (!actual || !sameWebhookPath(actual, webhookPath)) return;
    await graphRequest(phoneNumberId, {
      method: "POST",
      token,
      body: { webhook_configuration: { override_callback_uri: "" } },
    });
  } catch (err) {
    console.warn(
      "[connect] no se pudo quitar el webhook del número al desconectar:",
      err instanceof MetaApiError ? `${err.status} ${err.code ?? ""}` : "sin respuesta"
    );
  }
}

/**
 * 065 — Suscribe la app a la Cuenta de mensajes con el override de esta
 * instancia y lo confirma releyendo. Mismas reglas que la cuenta de WhatsApp:
 * un override nuestro no se toca, uno ajeno se respeta salvo `forzar`.
 *
 * Aquí el override va en el cuerpo de `subscribed_apps` (a nivel cuenta): es
 * lo que destrabó los entrantes en el caso real. Jamás lanza por Meta.
 */
async function registerWebhookForMessagingAccount(opts: {
  messagingAccountId: string;
  token: string;
  webhookUrl: string;
  verifyToken: string;
  forzar?: boolean;
}): Promise<MessagingAccountRegistration> {
  const { messagingAccountId, token, webhookUrl, verifyToken } = opts;
  const ownPath = pathOf(webhookUrl);

  const actual = await wabaOverride(messagingAccountId, token);
  if (actual && sameWebhookPath(actual, ownPath)) return { ok: true };
  if (actual && !opts.forzar) {
    const host = hostOf(actual);
    console.log(
      `[connect] la cuenta de mensajes ${messagingAccountId} enruta a un override (${host}): se respeta`
    );
    return { ok: true, skipped: "override_ajeno", host };
  }

  try {
    await graphRequest(`${messagingAccountId}/subscribed_apps`, {
      method: "POST",
      token,
      body: { override_callback_uri: webhookUrl, verify_token: verifyToken },
    });
  } catch (err) {
    return messagingAccountError(err, "No se pudo suscribir la app a la Cuenta de mensajes");
  }

  try {
    const res = await graphRequest<SubscribedApps | null>(
      `${messagingAccountId}/subscribed_apps`,
      { token }
    );
    if (!hasOwnOverride(res, ownPath)) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta aceptó el webhook en la Cuenta de mensajes pero no lo confirma. Vuelve a intentarlo en unos minutos.",
      };
    }
    return { ok: true };
  } catch (err) {
    return messagingAccountError(err, "No se pudo confirmar el webhook en la Cuenta de mensajes");
  }
}

/**
 * 065 — Al desconectar, quita el override de la Cuenta de mensajes si es el
 * de esta instancia (`POST …/subscribed_apps` sin cuerpo: así documenta Meta
 * borrar el callback alterno). Sin esto, los mensajes seguirían llegando aquí.
 * Best-effort, como la baja del número.
 */
export async function unregisterWebhookForMessagingAccount(opts: {
  messagingAccountId: string;
  token: string;
  webhookPath: string;
}): Promise<void> {
  const { messagingAccountId, token, webhookPath } = opts;
  try {
    const res = await graphRequest<SubscribedApps | null>(
      `${messagingAccountId}/subscribed_apps`,
      { token }
    );
    if (!hasOwnOverride(res, webhookPath)) return;
    await graphRequest(`${messagingAccountId}/subscribed_apps`, {
      method: "POST",
      token,
    });
  } catch (err) {
    console.warn(
      "[connect] no se pudo quitar el webhook de la cuenta de mensajes al desconectar:",
      err instanceof MetaApiError ? `${err.status} ${err.code ?? ""}` : "sin respuesta"
    );
  }
}

/**
 * 065 — Intenta descubrir la Cuenta de mensajes de una cuenta de WhatsApp.
 *
 * NEEDS CLARIFICATION: `paid_messaging_account_id` lo citan terceros y no
 * está en la doc oficial. Por eso es un extra: cualquier error o respuesta
 * rara devuelve `null` y la conexión se guarda igual, sin ella.
 */
export async function descubrirCuentaDeMensajes(
  wabaId: string,
  token: string
): Promise<string | null> {
  try {
    const res = await graphRequest<{
      paid_messaging_account_id?: string | { id?: string } | null;
    } | null>(`${wabaId}?fields=paid_messaging_account_id`, { token });
    const campo = res?.paid_messaging_account_id;
    const id = (typeof campo === "string" ? campo : campo?.id)?.trim();
    return id && /^\d+$/.test(id) && id !== wabaId ? id : null;
  } catch {
    return null;
  }
}

function hasOwnOverride(res: SubscribedApps | null, path: string): boolean {
  return (Array.isArray(res?.data) ? res.data : []).some(
    (app) =>
      typeof app?.override_callback_uri === "string" &&
      sameWebhookPath(app.override_callback_uri, path)
  );
}

/**
 * El override de callback vigente en la WABA, si alguna app suscrita lo tiene.
 *
 * Un `POST {WABA}/subscribed_apps` sin cuerpo no es inocuo: es justo como Meta
 * documenta BORRAR el callback alterno de la WABA ("Delete WABA alternate
 * callback"). Si la WABA ya enruta a un override (el backend de una agencia,
 * o un cerebro externo que recibe los webhooks directo de Meta), re-suscribir
 * en cada "Guardar" —o al rotar el token— lo desconectaba en silencio. Por eso
 * se consulta antes de tocar nada.
 *
 * `null` = ninguna app tiene override; `undefined` = no se pudo consultar (se
 * suscribe como siempre, best-effort).
 */
async function wabaOverride(
  wabaId: string,
  token: string
): Promise<string | null | undefined> {
  try {
    const res = await graphRequest<SubscribedApps | null>(
      `${wabaId}/subscribed_apps`,
      { token }
    );
    return (
      (Array.isArray(res?.data) ? res.data : [])
        .map((app) => app?.override_callback_uri)
        .find(
          (uri): uri is string => typeof uri === "string" && uri.trim() !== ""
        ) ?? null
    );
  } catch (err) {
    console.warn(
      "[connect] no se pudo consultar subscribed_apps; se suscribe igual (best-effort):",
      err instanceof Error ? err.message : err
    );
    return undefined;
  }
}

function registrationError(err: unknown, context: string): WebhookRegistration {
  if (!(err instanceof MetaApiError)) throw err;
  if (err.isAuthError) {
    return {
      ok: false,
      code: "invalid_token",
      message: `${context}: el token no es válido o expiró.`,
    };
  }
  if (err.status === 0 || err.status >= 500) {
    return {
      ok: false,
      code: "meta_unavailable",
      message: `${context}: Meta no está disponible en este momento; intenta de nuevo.`,
    };
  }
  // 200 y 10 son los de permisos: el token puede enviar mensajes pero no
  // administrar la cuenta (falta whatsapp_business_management).
  if (err.code === 200 || err.code === 10 || err.status === 403) {
    return {
      ok: false,
      code: "missing_permission",
      message: `${context}: el token no tiene el permiso whatsapp_business_management sobre esta cuenta.`,
    };
  }
  return { ok: false, code: "meta_error", message: `${context}: ${err.message}` };
}

/**
 * 065 — Como `registrationError`, pero el permiso que falta casi siempre es el
 * de la Cuenta de mensajes: el token ya administra la de WhatsApp.
 */
function messagingAccountError(
  err: unknown,
  context: string
): MessagingAccountRegistration {
  const res = registrationError(err, context);
  if (res.ok || res.code !== "missing_permission") return res.ok ? { ok: true } : res;
  return {
    ...res,
    message: `${context}: el usuario del sistema no tiene asignada la Cuenta de mensajes (Usuarios del sistema › Asignar activos › Messaging accounts). El mismo token sirve en cuanto se asigna.`,
  };
}

/** 066 — `#100` subcode `2388339`: la cuenta de WhatsApp ya está partida. */
function esCuentaPartida(err: unknown): boolean {
  return err instanceof MetaApiError && err.subcode === 2388339;
}

function sameWebhookPath(url: string, path: string): boolean {
  return pathOf(url) === path;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host || "host desconocido";
  } catch {
    return "URL no válida";
  }
}
