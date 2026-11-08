import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { getWaMockState, nextN } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** La cuenta de WhatsApp que queda partida por el split de 2026. */
  wabaId: z.string().min(1),
  messagingAccountId: z.string().regex(/^\d+$/),
  /** Si `?fields=paid_messaging_account_id` la revela. */
  descubrible: z.boolean().default(false),
  /** 066 — Si `POST {wabaId}/subscribed_apps` también responde 2388339. */
  rechazaSuscripcion: z.boolean().default(false),
  /**
   * Plantillas creadas FUERA de Vocero (Administrador de WhatsApp, Graph
   * directo, `hello_world`): el «panel de Meta» ya las tiene, el CRM no.
   */
  plantillasExternas: z
    .array(
      z.object({
        name: z.string().min(1),
        language: z.string().default("es_MX"),
        category: z.string().default("UTILITY"),
        status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("APPROVED"),
        components: z.array(z.record(z.string(), z.unknown())).min(1),
      })
    )
    .max(500)
    .default([]),
});

/**
 * 065 — Parte una cuenta de WhatsApp como hace Meta desde 2026 y siembra las
 * plantillas externas, para que un self-test reproduzca el 2388339, la
 * importación y la paginación sin una cuenta real.
 */
export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const state = getWaMockState();
  state.splitAccounts[body.data.wabaId] = {
    messagingAccountId: body.data.messagingAccountId,
    descubrible: body.data.descubrible ?? false,
    rechazaSuscripcion: body.data.rechazaSuscripcion ?? false,
  };
  for (const t of body.data.plantillasExternas ?? []) {
    const bodyText = t.components.find(
      (c) => String(c.type ?? "").toUpperCase() === "BODY"
    )?.text;
    state.templates.push({
      id: `tplext_${nextN()}`,
      name: t.name,
      language: t.language ?? "es_MX",
      category: t.category ?? "UTILITY",
      status: t.status ?? "APPROVED",
      body: typeof bodyText === "string" ? bodyText : "",
      components: t.components,
    });
  }
  return Response.json({ ok: true, templates: state.templates.length });
}

/** Deshace el split de una cuenta (`?wabaId=`) o de todas. */
export async function DELETE(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const wabaId = new URL(req.url).searchParams.get("wabaId");
  const state = getWaMockState();
  if (wabaId) delete state.splitAccounts[wabaId];
  else state.splitAccounts = {};
  return Response.json({ ok: true });
}
