import { and, eq } from "drizzle-orm";
import {
  countVariables,
  renderBody,
  validateBodyVariables,
} from "@/lib/templates";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { graphRequest, MetaApiError, normalizeRecipient } from "@/lib/meta/client";
import { destinatarioMeta } from "@/lib/meta/destinatario";
import { scoped } from "@/lib/db/tenant";
import { publish } from "@/server/events/bus";
import {
  cuentaDePlantillas,
  getCredentialsByOrg,
  getCredentialsByWabaId,
  markReconnectRequired,
} from "@/server/whatsapp/credentials";
import { callGraphSend, SendError } from "@/server/inbox/send";
import { serializeMessage } from "@/server/inbox/ingest";
import type { WebhookValue } from "@/server/inbox/webhook";

/** Errores tipados del servicio de plantillas → HTTP en la capa de API. */
export class TemplateError extends Error {
  code:
    | "not_connected"
    | "reconnect_required"
    | "invalid"
    | "not_found"
    | "meta_error"
    | "meta_unavailable";

  constructor(code: TemplateError["code"], message: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

const TEMPLATE_ERROR_STATUS: Record<TemplateError["code"], number> = {
  not_connected: 409,
  reconnect_required: 409,
  invalid: 422,
  not_found: 404,
  meta_error: 422,
  meta_unavailable: 503,
};

export function templateErrorStatus(err: TemplateError): number {
  return TEMPLATE_ERROR_STATUS[err.code];
}

export { countVariables, renderBody, validateBodyVariables };

type TemplateRow = typeof schema.template.$inferSelect;

export function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    body: t.body,
    status: t.status,
    rejectionReason: t.rejectionReason,
  };
}

/** Crea la plantilla y la manda a aprobación de Meta (FR-050). */
export async function createTemplate(
  organizationId: string,
  input: {
    name: string;
    language: string;
    category: string;
    body: string;
    /** Un ejemplo por variable, en orden; es lo que ve quien revisa en Meta. */
    examples?: string[];
  }
): Promise<TemplateRow> {
  const variableError = validateBodyVariables(input.body);
  if (variableError) throw new TemplateError("invalid", variableError);

  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) {
    throw new TemplateError("not_connected", "Conecta tu número de WhatsApp primero");
  }
  if (creds.status === "reconnect_required") {
    throw new TemplateError("reconnect_required", "Reconecta tu número antes de crear plantillas");
  }

  const name = input.name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  if (!name) throw new TemplateError("invalid", "Nombre de plantilla inválido");

  // Meta pide un ejemplo por variable: si faltan, rechaza la plantilla. Uno
  // realista («Ana», «martes 14») ayuda a que la aprueben; si el dueño no
  // escribió alguno, va el genérico.
  const variableCount = countVariables(input.body);
  const examples = Array.from(
    { length: variableCount },
    (_, i) => input.examples?.[i]?.trim() || `ejemplo ${i + 1}`
  );
  let waTemplateId: string | null = null;
  try {
    // 065: desde el split de 2026, las plantillas se crean en la Cuenta de
    // mensajes; en la de WhatsApp Meta responde #100/2388339.
    const res = await graphRequest<{ id?: string; status?: string }>(
      `${cuentaDePlantillas(creds)}/message_templates`,
      {
        method: "POST",
        token: creds.token,
        body: {
          name,
          language: input.language,
          category: input.category,
          components: [
            {
              type: "BODY",
              text: input.body,
              ...(variableCount > 0
                ? { example: { body_text: [examples] } }
                : {}),
            },
          ],
        },
      }
    );
    waTemplateId = res.id ?? null;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(organizationId);
        throw new TemplateError("reconnect_required", "El token expiró: reconecta el número");
      }
      if (err.status === 0 || err.status >= 500) {
        throw new TemplateError("meta_unavailable", "Meta no está disponible ahora");
      }
      if (esCuentaSinPlantillas(err) && !creds.messagingAccountId) {
        throw new TemplateError(
          "meta_error",
          "Meta ya no crea plantillas en la cuenta de WhatsApp: ahora viven en la Cuenta de mensajes. Agrega su ID en Ajustes → WhatsApp (Business Settings › Cuentas › Cuentas de mensajes) y vuelve a intentarlo."
        );
      }
      throw new TemplateError("meta_error", err.message);
    }
    throw err;
  }

  const db = getDb();
  const inserted = await db
    .insert(schema.template)
    .values({
      id: newId("template"),
      organizationId,
      name,
      language: input.language,
      category: input.category,
      body: input.body,
      status: "pending",
      waTemplateId,
    })
    .onConflictDoUpdate({
      target: [
        schema.template.organizationId,
        schema.template.name,
        schema.template.language,
      ],
      set: {
        category: input.category,
        body: input.body,
        status: "pending",
        rejectionReason: null,
        waTemplateId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return inserted[0]!;
}

/**
 * 065 — `#100` subcode `2388339`, «This API is not supported for this
 * WhatsApp Business Account»: la llamada fue a la Cuenta de WhatsApp y Meta
 * ya solo la acepta en la Cuenta de mensajes.
 */
export function esCuentaSinPlantillas(err: MetaApiError): boolean {
  const detalle = (err.details as { error?: { error_subcode?: unknown } } | null)
    ?.error;
  return (
    Number(detalle?.error_subcode) === 2388339 ||
    /not supported for this WhatsApp Business Account/i.test(err.message)
  );
}

function mapMetaStatus(
  status: string | undefined
): TemplateRow["status"] | null {
  const s = (status ?? "").toUpperCase();
  if (s === "APPROVED") return "approved";
  if (s === "REJECTED") return "rejected";
  if (s === "PENDING" || s === "IN_APPEAL" || s === "PENDING_DELETION") {
    return "pending";
  }
  return null;
}

type RemoteComponent = {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; url?: string; text?: string }[];
};

export type RemoteTemplate = {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  rejected_reason?: string;
  components?: RemoteComponent[];
};

const VARIABLE_RE = /\{\{\s*\d+\s*\}\}/;

/**
 * 065 (puerto de la spec 101 de un fork): convierte una plantilla que ya
 * existe en Meta (creada en el Administrador de WhatsApp, o la `hello_world`
 * que trae toda cuenta) en una fila que Vocero sabe enviar. Vocero solo manda
 * parámetros del CUERPO, así que se importa únicamente lo que no pide nada
 * más: encabezado de texto fijo, pie y botones sin variables. Lo demás
 * (encabezado con imagen, botón de URL dinámica, autenticación) se deja fuera
 * — importarlo sería ofrecer una plantilla que Meta rechaza al enviar.
 */
export function importableTemplate(remote: RemoteTemplate): {
  name: string;
  language: string;
  category: string;
  body: string;
  status: TemplateRow["status"];
  waTemplateId: string | null;
  rejectionReason: string | null;
} | null {
  const status = mapMetaStatus(remote.status);
  if (!status || !remote.name || !remote.language) return null;
  const category = (remote.category ?? "").toUpperCase();
  if (category !== "UTILITY" && category !== "MARKETING") return null;
  const components = remote.components ?? [];
  const body = components.find((c) => (c.type ?? "").toUpperCase() === "BODY")?.text;
  if (!body || validateBodyVariables(body)) return null;
  for (const c of components) {
    const type = (c.type ?? "").toUpperCase();
    if (type === "BODY" || type === "FOOTER") continue;
    if (type === "HEADER") {
      if ((c.format ?? "TEXT").toUpperCase() !== "TEXT") return null;
      if (VARIABLE_RE.test(c.text ?? "")) return null;
      continue;
    }
    if (type === "BUTTONS") {
      const ok = (c.buttons ?? []).every((b) => {
        const t = (b.type ?? "").toUpperCase();
        if (t === "QUICK_REPLY" || t === "PHONE_NUMBER") return true;
        return t === "URL" && !VARIABLE_RE.test(b.url ?? "");
      });
      if (!ok) return null;
      continue;
    }
    return null;
  }
  return {
    name: remote.name,
    language: remote.language,
    category,
    body,
    status,
    waTemplateId: remote.id ?? null,
    rejectionReason: remote.rejected_reason ?? null,
  };
}

const TEMPLATE_FIELDS =
  "id,name,language,status,category,rejected_reason,components";

/**
 * Sincroniza estados desde Graph (`GET {cuenta}/message_templates`). Cubre el
 * modo agencia: los webhooks de plantillas NO siguen el override de callback,
 * así que el pull es la vía universal (DV-VC-04/DV-VC-15).
 *
 * 065: lee la Cuenta de mensajes si se conoce, recorre la paginación y además
 * IMPORTA las plantillas que Vocero no conocía (creadas fuera de Vocero), si
 * se pueden enviar desde aquí. Devuelve cuántas filas cambió: actualizadas +
 * importadas.
 */
export async function syncTemplates(organizationId: string): Promise<number> {
  const creds = await getCredentialsByOrg(organizationId);
  if (!creds) {
    throw new TemplateError("not_connected", "Conecta tu número de WhatsApp primero");
  }

  const cuenta = cuentaDePlantillas(creds);
  const remotes: RemoteTemplate[] = [];
  try {
    let after: string | undefined;
    // Paginado por cursor hasta que Meta no dé `paging.next`: una cuenta
    // verificada puede tener hasta 6.000 plantillas (60 páginas de 100). Se
    // corta si Meta repite un cursor; el tope de páginas es solo la red final.
    const vistos = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const res: {
        data?: RemoteTemplate[];
        paging?: { cursors?: { after?: string }; next?: string };
      } | null = await graphRequest(
        `${cuenta}/message_templates?fields=${TEMPLATE_FIELDS}&limit=100${
          after ? `&after=${encodeURIComponent(after)}` : ""
        }`,
        { token: creds.token }
      );
      remotes.push(...(Array.isArray(res?.data) ? res.data : []));
      after = res?.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after || vistos.has(after)) break;
      vistos.add(after);
    }
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markReconnectRequired(organizationId);
        throw new TemplateError("reconnect_required", "El token expiró: reconecta el número");
      }
      throw new TemplateError("meta_unavailable", "No se pudo consultar Meta");
    }
    throw err;
  }

  const db = getDb();
  const local = await db
    .select()
    .from(schema.template)
    .where(scoped(schema.template.organizationId, organizationId));

  let updated = 0;
  for (const remote of remotes) {
    const status = mapMetaStatus(remote.status);
    if (!status) continue;
    const match = local.find(
      (t) =>
        (remote.id && t.waTemplateId === remote.id) ||
        (t.name === remote.name && t.language === remote.language)
    );
    if (!match) {
      const row = importableTemplate(remote);
      if (!row) continue;
      const nueva = await db
        .insert(schema.template)
        .values({ id: newId("template"), organizationId, ...row })
        .onConflictDoNothing()
        .returning({ id: schema.template.id });
      if (nueva.length > 0) updated += 1;
      continue;
    }
    // Meta reclasifica la categoría al aprobar (una UTILITY puede volverse
    // MARKETING, lo que cambia el costo por conversación): es autoridad.
    const category = remote.category ?? match.category;
    if (match.status === status && match.category === category) continue;
    await db
      .update(schema.template)
      .set({
        status,
        category,
        rejectionReason: remote.rejected_reason ?? null,
        waTemplateId: match.waTemplateId ?? remote.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.template.id, match.id));
    updated += 1;
  }
  return updated;
}

/** Evento webhook `message_template_status_update` (modo directo, FR-050). */
export async function applyTemplateStatusEvent(
  wabaId: string | null,
  value: WebhookValue
): Promise<void> {
  if (!wabaId) return;
  const creds = await getCredentialsByWabaId(wabaId);
  if (!creds) return;

  const status = mapMetaStatus(value.event);
  const name = value.message_template_name;
  const language = value.message_template_language;
  if (!status || !name || !language) return;

  const db = getDb();
  await db
    .update(schema.template)
    .set({
      status,
      rejectionReason: status === "rejected" ? (value.reason ?? null) : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.template.organizationId, creds.organizationId),
        eq(schema.template.name, name),
        eq(schema.template.language, language)
      )
    );
}

/** Envía una plantilla APROBADA a una conversación (ventana cerrada, FR-051). */
export async function sendTemplate(input: {
  organizationId: string;
  conversationId: string;
  templateId: string;
  variables?: string[];
}): Promise<{ messageId: string }> {
  const db = getDb();

  const templates = await db
    .select()
    .from(schema.template)
    .where(
      scoped(
        schema.template.organizationId,
        input.organizationId,
        eq(schema.template.id, input.templateId)
      )
    )
    .limit(1);
  const template = templates[0];
  if (!template) throw new TemplateError("not_found", "Plantilla no encontrada");
  if (template.status !== "approved") {
    throw new TemplateError("invalid", "Solo se pueden enviar plantillas aprobadas");
  }
  // Meta exige EXACTAMENTE un parámetro por variable del cuerpo: si sobran o
  // falta alguno responde 132000 (plantilla y parámetros no coinciden).
  const variableCount = countVariables(template.body);
  const values = (input.variables ?? [])
    .slice(0, variableCount)
    .map((v) => v.trim());
  if (values.length < variableCount || values.some((v) => !v)) {
    const missing = values.findIndex((v) => !v);
    const n = missing === -1 ? values.length + 1 : missing + 1;
    throw new TemplateError(
      "invalid",
      variableCount === 1
        ? "La plantilla requiere el valor de {{1}}"
        : `La plantilla requiere ${variableCount} valores: falta {{${n}}}`
    );
  }

  const rows = await db
    .select({ conversation: schema.conversation, contact: schema.contact })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new TemplateError("not_found", "Conversación no encontrada");
  if (row.conversation.isTest) {
    // Aserción dura del sandbox (FR-031)
    throw new SendError(
      "sandbox_violation",
      "Conversación de prueba del Laboratorio: el envío real está prohibido"
    );
  }

  const creds = await getCredentialsByOrg(input.organizationId);
  if (!creds) throw new TemplateError("not_connected", "Sin número conectado");
  if (creds.status === "reconnect_required") {
    throw new TemplateError("reconnect_required", "Reconecta el número");
  }

  // 003: destinatario = teléfono normalizado o BSUID.
  // 003: teléfono en `to`, BSUID en `recipient` — Meta los pide en campos
  // distintos y mandar el BSUID en `to` devuelve 131026.
  const destinatario = destinatarioMeta(
    row.contact.phone ? normalizeRecipient(row.contact.phone) : null,
    row.contact.waUserId
  );
  if (!destinatario) {
    throw new TemplateError(
      "meta_error",
      "El contacto no tiene teléfono ni identidad de WhatsApp utilizable"
    );
  }

  const waMessageId = await callGraphSend(creds, {
    messaging_product: "whatsapp",
    ...destinatario,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      ...(variableCount > 0
        ? {
            components: [
              {
                type: "body",
                parameters: values.map((text) => ({ type: "text", text })),
              },
            ],
          }
        : {}),
    },
  });

  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId,
      direction: "out",
      type: "template",
      text: renderBody(template.body, values),
      status: "pending",
      origin: "template",
    })
    .returning();
  const message = inserted[0]!;

  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, input.conversationId));

  publish(input.organizationId, {
    type: "message.new",
    data: {
      conversationId: input.conversationId,
      message: serializeMessage(message),
    },
  });

  return { messageId: message.id };
}
