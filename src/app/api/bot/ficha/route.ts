import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { upsertFicha } from "@/server/bot/ficha";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
  // Objeto libre a propósito: las claves las define el negocio, y el servidor
  // tolera el drift del LLM en vez de castigarlo con un 422 (ver server/bot/ficha).
  ficha: z.record(z.string(), z.unknown()),
});

/**
 * Ficha de calificación del lead, escrita por un cerebro externo.
 * Merge campo a campo contra lo que ya había; `null` explícito borra la clave.
 * Devuelve la ficha COMPLETA resultante, no solo el parche, para que el bot no
 * tenga que llevar su propia copia sincronizada.
 */
export async function PUT(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const rows = await db
    .select({ contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, body.data.conversationId)
      )
    )
    .limit(1);
  if (!rows[0]) return apiError(404, "not_found", "Conversación no encontrada");

  const result = await upsertFicha({
    organizationId,
    contactId: rows[0].contactId,
    ficha: body.data.ficha,
  });
  if (!result) return apiError(404, "not_found", "Contacto no encontrado");
  return Response.json(result);
}
