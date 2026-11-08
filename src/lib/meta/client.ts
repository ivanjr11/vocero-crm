import { getEnv } from "@/lib/env";

/**
 * Cliente propio de la Graph API de Meta (WhatsApp Cloud API).
 * Única frontera de salida hacia Meta (Constitución II): todo request pasa
 * por graphRequest. En self-test, META_GRAPH_BASE_URL apunta al wa-mock.
 */

export class MetaApiError extends Error {
  status: number;
  code: number | null;
  type: string | null;
  details: unknown;

  constructor(
    message: string,
    opts: { status: number; code?: number | null; type?: string | null; details?: unknown }
  ) {
    super(message);
    this.name = "MetaApiError";
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.type = opts.type ?? null;
    this.details = opts.details;
  }

  /**
   * Token vencido/revocado → la conexión requiere re-autenticación.
   * Meta etiqueta como "OAuthException" también errores transitorios 5xx
   * (ej. código 2 "service temporarily unavailable"), así que el type por sí
   * solo NO basta: solo 401 o código 190, y jamás con status ≥ 500.
   */
  get isAuthError(): boolean {
    if (this.status >= 500) return false;
    return this.status === 401 || this.code === 190;
  }

  /** El `error_subcode` de Meta, si vino (ej. 2388339 del split de 2026). */
  get subcode(): number | null {
    const sub = (this.details as { error?: { error_subcode?: unknown } } | null)
      ?.error?.error_subcode;
    return typeof sub === "number" || typeof sub === "string"
      ? Number(sub) || null
      : null;
  }
}

export async function graphRequest<T>(
  path: string,
  opts: {
    method?: "GET" | "POST" | "DELETE";
    token: string;
    body?: unknown;
  }
): Promise<T> {
  const env = getEnv();
  const url = `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(opts.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (cause) {
    throw new MetaApiError("No se pudo contactar la API de Meta", {
      status: 0,
      details: cause,
    });
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // respuesta no-JSON: se conserva el texto crudo en details
  }

  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; type?: string } })
      ?.error;
    throw new MetaApiError(err?.message ?? `Meta respondió ${res.status}`, {
      status: res.status,
      code: err?.code ?? null,
      type: err?.type ?? null,
      details: json ?? text,
    });
  }
  return json as T;
}

/**
 * Normaliza un número al formato canónico. Números móviles de México llegan
 * de Meta como `521` + 10 dígitos (13 en total); enviar con ese `1` extra
 * produce el error 131030 — se usa `52` + 10 dígitos.
 *
 * Desde la identidad resiliente (003) esta normalización es SIMÉTRICA: se
 * aplica también al escribir la identidad del contacto en la ingesta
 * (`wa_identity`), para que `521...` y `52...` resuelvan al mismo contacto.
 */
export function normalizeMx(phone: string): string {
  if (/^521\d{10}$/.test(phone)) {
    return `52${phone.slice(3)}`;
  }
  return phone;
}

/**
 * Troncales que WhatsApp REPORTA pero que no se usan para ENVIAR, y que la
 * identidad deja intactos a propósito.
 *
 * A diferencia de México, aquí la normalización NO puede ser simétrica: si la
 * ingesta reescribiera la identidad, dejaría de coincidir con el `wa_id` que
 * Meta manda en cada webhook —y con el que un cerebro externo consulta el
 * gateway—, así que el contacto se partiría en dos. Se normaliza solo el
 * número que viaja por el cable.
 *
 * Para agregar un país: una línea aquí y su caso en
 * `tests/unit/meta-client.test.ts`.
 */
const SEND_ONLY_TRUNKS = [
  // Argentina: Meta reporta `549` + 10 dígitos; se envía sin el 9 (issue #35).
  { reported: "549", dialable: "54", nationalDigits: 10 },
] as const;

/**
 * El número tal como hay que mandárselo a Meta.
 *
 * Es lo que la identidad ya canoniza, MÁS los troncales que solo estorban al
 * enviar. Ojo con el alcance real del problema que arregla: el `131030`
 * ("Recipient phone number not in allowed list") viene de la lista de
 * destinatarios de prueba, que solo existe MIENTRAS el negocio no está
 * verificado. Ya en producción no hay lista y Meta acepta las dos formas —
 * normaliza internamente y responde el `wa_id` con el troncal puesto. O sea:
 * esto desatasca la puesta en marcha, que es justo cuando una agencia está
 * probando la instancia y el mensaje de error la manda a revisar una lista de
 * permitidos que está bien.
 */
export function normalizeRecipient(phone: string): string {
  const canonical = normalizeMx(phone);
  for (const trunk of SEND_ONLY_TRUNKS) {
    const expected = trunk.reported.length + trunk.nationalDigits;
    if (canonical.length === expected && canonical.startsWith(trunk.reported)) {
      return trunk.dialable + canonical.slice(trunk.reported.length);
    }
  }
  return canonical;
}
