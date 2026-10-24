import { and, eq, gt, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { vaciarFicha } from "@/server/bot/ficha";
import type { CanalDelEvento } from "@/server/brains/contract";
import { deleteMediaFile } from "@/server/whatsapp/media";

/**
 * 026 — Eliminar una conversación, por petición explícita de quien administra
 * el negocio.
 *
 * Dos alcances, porque son dos intenciones distintas:
 *
 * - `hilo`: se van los mensajes, sus adjuntos y la ficha. El contacto, su
 *   lugar en el pipeline y sus citas pasadas se quedan. Si la persona vuelve a
 *   escribir, es una conversación nueva.
 * - `contacto`: se va la persona entera. Todo lo que cuelga de ella cae en
 *   cascada, incluido su historial de etapas — los números de Resultados
 *   cambian, y por eso es una casilla aparte y no el comportamiento normal.
 *
 * Casi todo el trabajo lo hacen las foráneas con ON DELETE CASCADE. Lo que
 * este módulo añade es lo que una cascada no puede hacer: los adjuntos (fila y
 * archivo), la ficha y la cita por venir que detiene el borrado.
 */

export type AlcanceBorrado = "hilo" | "contacto";

export type ConversacionEliminada = {
  id: string;
  channel: CanalDelEvento;
};

export type ResultadoEliminar =
  | {
      ok: true;
      alcance: AlcanceBorrado;
      organization: { id: string; slug: string | null };
      contact: { id: string; identity: string };
      /** En `hilo`, una. En `contacto`, todas las reales de esa persona. */
      conversaciones: ConversacionEliminada[];
    }
  | { ok: false; motivo: "no_encontrada" }
  | { ok: false; motivo: "cita_pendiente"; cuando: Date };

export async function eliminarConversacion(
  organizationId: string,
  conversationId: string,
  alcance: AlcanceBorrado
): Promise<ResultadoEliminar> {
  const db = getDb();
  const archivos: string[] = [];

  const resultado = await db.transaction(async (tx): Promise<ResultadoEliminar> => {
    const [org] = await tx
      .select({ id: schema.organization.id, slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .limit(1);
    if (!org) return { ok: false, motivo: "no_encontrada" };

    const [fila] = await tx
      .select({
        conversation: schema.conversation,
        contact: schema.contact,
      })
      .from(schema.conversation)
      .innerJoin(
        schema.contact,
        and(
          eq(schema.contact.organizationId, schema.conversation.organizationId),
          eq(schema.contact.id, schema.conversation.contactId)
        )
      )
      .where(
        scoped(
          schema.conversation.organizationId,
          organizationId,
          eq(schema.conversation.id, conversationId)
        )
      )
      // Dos personas eliminando a la vez: la segunda espera y luego no la
      // encuentra, en vez de borrar a medias.
      .for("update")
      .limit(1);
    // Una conversación del Laboratorio no vive en la bandeja: por aquí no
    // existe. Sus corridas se limpian desde el Laboratorio.
    if (!fila || fila.conversation.isTest) return { ok: false, motivo: "no_encontrada" };
    const { contact } = fila;
    const todoElContacto = alcance === "contacto";

    const conversaciones = todoElContacto
      ? await tx
          .select()
          .from(schema.conversation)
          .where(
            scoped(
              schema.conversation.organizationId,
              organizationId,
              eq(schema.conversation.contactId, contact.id)
            )
          )
      : [fila.conversation];
    const ids = conversaciones.map((c) => c.id);

    /**
     * Una cita por venir detiene el borrado, en los dos alcances.
     *
     * La cita sobrevive al hilo (`conversation_id` queda en NULL), pero su
     * recordatorio se manda POR la conversación: sin ella no saldría, y nadie
     * se enteraría. Y borrar el contacto se llevaría la cita de la base
     * dejando viva la reunión en Google o Zoom. Cancelar es el camino que
     * avisa a quien hay que avisar.
     */
    const [cita] = await tx
      .select({ cuando: schema.booking.scheduledAt })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          eq(schema.booking.status, "agendada"),
          eq(schema.booking.isTest, false),
          gt(schema.booking.scheduledAt, new Date()),
          todoElContacto
            ? eq(schema.booking.contactId, contact.id)
            : eq(schema.booking.conversationId, conversationId)
        )
      )
      .orderBy(schema.booking.scheduledAt)
      .limit(1);
    if (cita) return { ok: false, motivo: "cita_pendiente", cuando: cita.cuando };

    // Los adjuntos se anotan ANTES de borrar: después ya no hay mensaje que
    // diga cuáles eran.
    const deMensajes = await tx
      .selectDistinct({ id: schema.message.mediaAssetId })
      .from(schema.message)
      .where(
        scoped(
          schema.message.organizationId,
          organizationId,
          inArray(schema.message.conversationId, ids),
          isNotNull(schema.message.mediaAssetId)
        )
      );
    const deAnuncios = await tx
      .select({ id: schema.adAttribution.imageAssetId })
      .from(schema.adAttribution)
      .where(
        scoped(
          schema.adAttribution.organizationId,
          organizationId,
          inArray(schema.adAttribution.conversationId, ids),
          isNotNull(schema.adAttribution.imageAssetId)
        )
      );
    const candidatos = [
      ...new Set(
        [...deMensajes, ...deAnuncios]
          .map((r) => r.id)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    if (todoElContacto) {
      await tx
        .delete(schema.contact)
        .where(
          scoped(
            schema.contact.organizationId,
            organizationId,
            eq(schema.contact.id, contact.id)
          )
        );
    } else {
      await tx
        .delete(schema.conversation)
        .where(
          scoped(
            schema.conversation.organizationId,
            organizationId,
            eq(schema.conversation.id, conversationId)
          )
        );
      // La ficha es lo que el agente fue aprendiendo de esta persona, y viaja
      // al cerebro en cada turno: dejarla sería borrar el hilo y conservar
      // justo lo que el agente recordaba de él.
      await vaciarFicha(tx, organizationId, contact.id);
    }

    if (candidatos.length > 0) {
      // Solo los adjuntos que ya nadie usa: la imagen de un anuncio puede
      // estar en otra conversación.
      const borrados = await tx
        .delete(schema.mediaAsset)
        .where(
          and(
            eq(schema.mediaAsset.organizationId, organizationId),
            inArray(schema.mediaAsset.id, candidatos),
            notExists(
              tx
                .select({ uno: sql`1` })
                .from(schema.message)
                .where(eq(schema.message.mediaAssetId, schema.mediaAsset.id))
            ),
            notExists(
              tx
                .select({ uno: sql`1` })
                .from(schema.adAttribution)
                .where(eq(schema.adAttribution.imageAssetId, schema.mediaAsset.id))
            ),
            // El video de bienvenida lo comparten todos los hilos que lo
            // recibieron: sigue en el Agente aunque se borre este.
            notExists(
              tx
                .select({ uno: sql`1` })
                .from(schema.agentProfile)
                .where(eq(schema.agentProfile.welcomeMediaAssetId, schema.mediaAsset.id))
            )
          )
        )
        .returning({ id: schema.mediaAsset.id });
      archivos.push(...borrados.map((a) => a.id));
    }

    return {
      ok: true,
      alcance,
      organization: org,
      contact: { id: contact.id, identity: contact.waIdentity },
      // Al cerebro solo se le avisa de las reales: de una de prueba nunca supo.
      conversaciones: conversaciones
        .filter((c) => !c.isTest)
        .map((c) => ({ id: c.id, channel: c.channel })),
    };
  });

  // Los archivos, DESPUÉS del commit: si la transacción se revierte, las
  // filas vuelven y sus archivos tienen que seguir ahí. Al revés solo queda
  // un archivo huérfano que nadie puede abrir, y no un mensaje sin adjunto.
  if (resultado.ok && archivos.length > 0) {
    const intentos = await Promise.allSettled(
      archivos.map((id) => deleteMediaFile(organizationId, id))
    );
    const fallidos = intentos.filter((r) => r.status === "rejected").length;
    if (fallidos > 0) {
      console.warn(
        `[bandeja] ${fallidos} de ${archivos.length} adjuntos no se pudieron borrar del volumen (${organizationId})`
      );
    }
  }

  return resultado;
}
