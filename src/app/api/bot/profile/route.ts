import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import {
  serializeBotProfile,
  type BotAppointmentReminder,
  type BotLlm,
  type BotWelcomeMedia,
} from "@/server/bot/profile";
import { resolveAiProvider } from "@/lib/ai/provider";
import { agendaEnabled } from "@/server/agenda/flag";

export const dynamic = "force-dynamic";

/**
 * Perfil del agente + knowledge base para un cerebro externo.
 * GET /api/bot/profile → {profile, kb, resources}. Sin caché: cada consulta
 * refleja lo que el dueño dejó en la UI al momento (el TTL vive del lado del
 * bot, que es quien sabe cada cuánto le conviene releer).
 */
export async function GET(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const db = getDb();
  const profiles = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profiles[0];
  if (!profile) {
    // Condición esperada (instancia sin perfil): el bot cae a su brief local.
    return apiError(404, "no_profile", "La instancia no tiene perfil de agente");
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));

  // 036 — Con qué piensa el cerebro que no trae llave: el proxy del CRM.
  const ia = await resolveAiProvider(organizationId);
  const llm: BotLlm = ia.ok && ia.provider.model ? { path: "/api/bot/llm", model: ia.provider.model } : null;

  let welcomeMedia: BotWelcomeMedia = null;
  if (profile.welcomeMediaAssetId) {
    const assets = await db
      .select({ kind: schema.mediaAsset.kind, caption: schema.mediaAsset.caption })
      .from(schema.mediaAsset)
      .where(
        and(
          eq(schema.mediaAsset.organizationId, organizationId),
          eq(schema.mediaAsset.id, profile.welcomeMediaAssetId)
        )
      )
      .limit(1);
    const asset = assets[0];
    if (asset) welcomeMedia = { kind: asset.kind, caption: asset.caption ?? null };
  }

  // Sin agenda no hay citas que recordar: el bloque va en null.
  let appointmentReminder: BotAppointmentReminder = null;
  if (agendaEnabled()) {
    const cal = await db
      .select({ minutes: schema.calendarSettings.reminderMinutes })
      .from(schema.calendarSettings)
      .where(eq(schema.calendarSettings.organizationId, organizationId))
      .limit(1);
    const minutes = cal[0]?.minutes ?? 0;
    if (minutes > 0) appointmentReminder = { minutesBefore: minutes };
  }

  return Response.json(
    serializeBotProfile(profile, kb, llm, welcomeMedia, appointmentReminder)
  );
}
