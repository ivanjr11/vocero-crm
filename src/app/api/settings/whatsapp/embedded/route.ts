import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { getEnv } from "@/lib/env";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  completarAltaEmbebida,
  EmbeddedSignupError,
  embeddedConfig,
} from "@/server/whatsapp/embedded";

/**
 * 066 — «Conectar con Meta» (Embedded Signup v4) en Ajustes → WhatsApp.
 *
 * GET  → si está disponible, si quien pregunta puede usarlo y, si puede, lo
 *        que necesita el SDK (App ID, Config ID y versión; nunca el secreto).
 * POST → termina el alta con el `code` y los IDs del evento de sesión. Solo
 *        quien configura la instancia y desde el mismo origen.
 *
 * Sin `META_APP_ID` + `META_EMBEDDED_CONFIG_ID` + `META_APP_SECRET` todo
 * responde 404 (CA-1) y queda solo el alta manual.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export const GET = withAuth(async (session) => {
  const cfg = embeddedConfig();
  if (!cfg.ready) return new Response(null, { status: 404 });
  const canManage = canConfigure(session.role);
  if (!canManage) return Response.json({ ready: true, canManage }, { headers: NO_STORE });
  return Response.json(
    {
      ready: true,
      canManage,
      appId: cfg.appId,
      configId: cfg.configId,
      graphVersion: cfg.graphVersion,
    },
    { headers: NO_STORE }
  );
});

const id = z.string().regex(/^\d{1,32}$/);
const inputSchema = z.object({
  code: z.string().min(1).max(4096),
  wabaId: id,
  phoneNumberId: id.nullable(),
  /** El PIN que ya tenía el número; `null` = que el servidor genere uno. */
  pin: z.string().regex(/^\d{6}$/).nullable(),
});

export const POST = withAuth(async (session, req: Request) => {
  if (!embeddedConfig().ready) return new Response(null, { status: 404 });
  if (!canConfigure(session.role)) {
    return apiError(403, "forbidden", "Solo quien administra la cuenta puede conectar WhatsApp.");
  }
  if (!mismoOrigen(req)) return apiError(403, "invalid_origin", "Origen no autorizado.");
  if (
    !checkRateLimit(`embedded:${session.organizationId}:${session.userId}`, {
      max: 10,
      windowMs: 60_000,
    }).allowed
  ) {
    return apiError(429, "rate_limit", "Espera un minuto antes de volver a intentarlo.");
  }
  const body = await parseBody(req, inputSchema);
  if (!body.ok) return body.response;
  try {
    const r = await completarAltaEmbebida({
      organizationId: session.organizationId,
      ...body.data,
    });
    return Response.json({ connected: true, ...r }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof EmbeddedSignupError) return apiError(err.status, err.code, err.message);
    // Nunca el error crudo: puede traer el código o el token.
    console.error("[embedded] fallo no controlado en el alta");
    return apiError(
      503,
      "connection_failed",
      "No pudimos guardar la conexión. Repite el proceso; tu conexión anterior se conserva."
    );
  }
});

/**
 * El popup se abre desde esta instancia y desde ningún otro sitio: el
 * `Origin` tiene que ser el de `APP_BASE_URL` o el host que atendió la
 * petición (detrás del proxy, `x-forwarded-host`).
 */
function mismoOrigen(req: Request): boolean {
  try {
    const origin = new URL(req.headers.get("origin") ?? "");
    if (origin.origin === new URL(getEnv().APP_BASE_URL).origin) return true;
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return Boolean(host) && origin.host === host;
  } catch {
    return false;
  }
}
