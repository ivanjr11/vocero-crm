import { and, eq, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  deleteMediaFile,
  MediaValidationError,
  saveMediaFile,
  validateOutgoing,
} from "@/server/whatsapp/media";

export const dynamic = "force-dynamic";

const MAX_CAPTION = 1024; // tope de WhatsApp para el texto de un video o imagen

type Asset = typeof schema.mediaAsset.$inferSelect;

function serialize(asset: Asset | null) {
  if (!asset) return { welcomeMedia: null };
  return {
    welcomeMedia: {
      id: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      fileName: asset.fileName,
      fileSize: asset.fileSize,
      caption: asset.caption,
      url: `/api/media/${asset.id}`,
    },
  };
}

async function actual(organizationId: string): Promise<Asset | null> {
  const db = getDb();
  const rows = await db
    .select({ asset: schema.mediaAsset })
    .from(schema.agentProfile)
    .innerJoin(
      schema.mediaAsset,
      eq(schema.agentProfile.welcomeMediaAssetId, schema.mediaAsset.id)
    )
    .where(scoped(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  return rows[0]?.asset ?? null;
}

/**
 * Suelta el asset anterior: la fila se borra solo si ningún mensaje la usa
 * (los hilos que ya recibieron el video lo siguen viendo), y el archivo solo
 * con ella. Igual que al eliminar una conversación.
 */
async function soltar(organizationId: string, assetId: string): Promise<void> {
  const db = getDb();
  const borrados = await db
    .delete(schema.mediaAsset)
    .where(
      and(
        eq(schema.mediaAsset.organizationId, organizationId),
        eq(schema.mediaAsset.id, assetId),
        notExists(
          db
            .select({ uno: sql`1` })
            .from(schema.message)
            .where(eq(schema.message.mediaAssetId, schema.mediaAsset.id))
        )
      )
    )
    .returning({ id: schema.mediaAsset.id });
  if (borrados.length > 0) {
    await deleteMediaFile(organizationId, assetId).catch(() => null);
  }
}

export const GET = withAuth(async (session) => {
  return Response.json(serialize(await actual(session.organizationId)));
});

/**
 * Subir (o reemplazar) el video de bienvenida. El cuerpo va crudo con su
 * `content-type`, como el icono de la marca; el nombre, en `x-file-name`.
 * Solo video o imagen: es lo que se ve sin abrir nada en WhatsApp.
 */
export const PUT = withAuth(async (session, req: Request) => {
  const mime = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.byteLength === 0) {
    return apiError(422, "empty", "No llegó ningún archivo");
  }
  let kind: string;
  try {
    kind = validateOutgoing(mime, buf.byteLength);
  } catch (err) {
    if (err instanceof MediaValidationError) {
      return apiError(err.code === "too_large" ? 413 : 422, err.code, err.message);
    }
    throw err;
  }
  if (kind !== "video" && kind !== "image") {
    return apiError(
      422,
      "unsupported_type",
      "Sube un video MP4 (máx. 16 MB) o una imagen JPG/PNG (máx. 5 MB)"
    );
  }
  const nombre = req.headers.get("x-file-name");
  const fileName = nombre ? decodeURIComponent(nombre).slice(0, 200) : null;

  const anterior = await actual(session.organizationId);
  const db = getDb();
  const assetId = newId("mediaAsset");
  const storagePath = await saveMediaFile(session.organizationId, assetId, buf, mime);
  const inserted = await db
    .insert(schema.mediaAsset)
    .values({
      id: assetId,
      organizationId: session.organizationId,
      kind: kind as "video" | "image",
      mimeType: mime,
      fileName,
      fileSize: buf.byteLength,
      // El texto se conserva al cambiar de video.
      caption: anterior?.caption ?? null,
      storagePath,
      fetchStatus: "available",
    })
    .returning();
  const actualizados = await db
    .update(schema.agentProfile)
    .set({ welcomeMediaAssetId: assetId, updatedAt: new Date() })
    .where(scoped(schema.agentProfile.organizationId, session.organizationId))
    .returning({ id: schema.agentProfile.id });
  if (actualizados.length === 0) {
    await soltar(session.organizationId, assetId);
    return apiError(404, "not_found", "Perfil del agente no encontrado");
  }
  if (anterior) await soltar(session.organizationId, anterior.id);

  return Response.json(serialize(inserted[0]!));
});

const patchSchema = z.object({
  caption: z.string().trim().max(MAX_CAPTION).nullable(),
});

/** Cambiar el texto que acompaña al video. */
export const PATCH = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;
  const asset = await actual(session.organizationId);
  if (!asset) {
    return apiError(404, "sin_bienvenida", "Primero sube el video de bienvenida");
  }
  const db = getDb();
  const rows = await db
    .update(schema.mediaAsset)
    .set({ caption: body.data.caption || null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.mediaAsset.organizationId, session.organizationId),
        eq(schema.mediaAsset.id, asset.id)
      )
    )
    .returning();
  return Response.json(serialize(rows[0] ?? null));
});

/** Quitar el video: el agente deja de mandarlo desde el siguiente contacto. */
export const DELETE = withAuth(async (session) => {
  const asset = await actual(session.organizationId);
  if (!asset) return Response.json(serialize(null));
  const db = getDb();
  await db
    .update(schema.agentProfile)
    .set({ welcomeMediaAssetId: null, updatedAt: new Date() })
    .where(scoped(schema.agentProfile.organizationId, session.organizationId));
  await soltar(session.organizationId, asset.id);
  return Response.json(serialize(null));
});
