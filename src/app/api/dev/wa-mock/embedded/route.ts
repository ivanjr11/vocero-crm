import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { parseBody } from "@/lib/api";
import { getWaMockState } from "@/server/dev/wa-mock-state";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** La WABA que el cliente «compartió» en la ventana de Meta. */
  wabaId: z.string().regex(/^\d+$/),
  numeros: z
    .array(
      z.object({
        id: z.string().regex(/^\d+$/),
        display_phone_number: z.string().min(1),
        verified_name: z.string().default("Negocio de prueba"),
        status: z.string().default("PENDING"),
        platform_type: z.string().optional(),
      })
    )
    .max(20),
});

/**
 * 066 — Siembra los números de una WABA, como si el cliente acabara de
 * pasar por la ventana de Embedded Signup, para que el self-test canjee un
 * `code`, resuelva el número y lo registre sin una cuenta real.
 */
export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  getWaMockState().wabaNumbers[body.data.wabaId] = body.data.numeros.map((n) => ({
    ...n,
    verified_name: n.verified_name ?? "Negocio de prueba",
    status: n.status ?? "PENDING",
  }));
  return Response.json({ ok: true });
}

/** Lo que el arnés comprueba: con qué PIN se registró cada número. */
export async function GET() {
  const guard = mockGuard();
  if (guard) return guard;
  const state = getWaMockState();
  return Response.json({ registrations: state.registrations, wabaNumbers: state.wabaNumbers });
}
