import { mockGuard } from "@/lib/dev-guard";
import { barridoRecordatorios } from "@/server/agenda/recordatorios";

export const dynamic = "force-dynamic";

/**
 * Solo pruebas: corre una pasada del barrido de recordatorios con un reloj
 * dado (`{ now }`), para que el self-test no espere a que pase la media hora.
 */
export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const body = (await req.json().catch(() => ({}))) as { now?: string };
  const now = body.now ? new Date(body.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    return Response.json({ error: "now inválido" }, { status: 422 });
  }
  return Response.json({ atendidas: await barridoRecordatorios(now) });
}
