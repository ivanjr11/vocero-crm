import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { SendError, sendStoredMedia } from "@/server/inbox/send";
import { guardarRespuestaDePrueba } from "@/server/lab/sandbox";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
});

/**
 * Video de bienvenida — El cerebro pide mandar el video (o imagen) que el
 * dueño subió en la pantalla Agente. El archivo nunca sale del CRM ni viaja
 * por el cerebro: aquí se sube a WhatsApp y queda en el hilo marcado como IA.
 * Cuándo mandarlo (la primera respuesta a cada contacto) lo decide el cerebro.
 *
 * Mismos gates que `POST /api/bot/messages`: 409 ai_paused · window_closed ·
 * message_limit. 404 `sin_bienvenida` si no hay nada configurado. En el
 * Laboratorio (`is_test`) se guarda una marca en el hilo y no se envía.
 */
export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const profiles = await db
    .select({ assetId: schema.agentProfile.welcomeMediaAssetId })
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const assetId = profiles[0]?.assetId;
  if (!assetId) {
    return apiError(404, "sin_bienvenida", "No hay video de bienvenida configurado");
  }

  const convs = await db
    .select({
      aiEnabled: schema.conversation.aiEnabled,
      handoffAt: schema.conversation.handoffAt,
      isTest: schema.conversation.isTest,
    })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, body.data.conversationId)
      )
    )
    .limit(1);
  const conv = convs[0];
  if (!conv) return apiError(404, "not_found", "Conversación no encontrada");
  if (!conv.aiEnabled || conv.handoffAt) {
    return apiError(409, "ai_paused", "La IA está en pausa en esta conversación");
  }
  if (conv.isTest) {
    const guardada = await guardarRespuestaDePrueba({
      organizationId,
      conversationId: body.data.conversationId,
      text: "[Video de bienvenida]",
    });
    return Response.json({ messageId: guardada.messageId, status: "sent" });
  }

  try {
    const result = await sendStoredMedia({
      conversationId: body.data.conversationId,
      organizationId,
      assetId,
      aiGenerated: true,
    });
    return Response.json({ messageId: result.messageId });
  } catch (err) {
    if (err instanceof SendError) {
      if (
        err.code === "window_closed" ||
        err.code === "sandbox_violation" ||
        err.code === "message_limit"
      ) {
        return apiError(409, err.code, err.message);
      }
      return apiError(502, err.code, err.message);
    }
    throw err;
  }
}
