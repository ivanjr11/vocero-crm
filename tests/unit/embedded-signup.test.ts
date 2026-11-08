import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 066 — «Conectar con Meta» (Embedded Signup v4).
 *
 *   - el evento de sesión y las opciones de `FB.login` / `FB.init`;
 *   - el alta en el servidor: canje del `code` (por `node:http` contra un
 *     servidor local, como el wa-mock), número de la WABA, registro con PIN,
 *     credenciales y webhook; nada se guarda si algo falla antes;
 *   - la ruta: 404 sin configuración, rol, origen.
 */

const env = vi.hoisted(() => ({
  APP_BASE_URL: "https://crm.ejemplo.test",
  META_WEBHOOK_VERIFY_TOKEN: "verify-token-xyz",
  META_GRAPH_BASE_URL: "http://127.0.0.1:1",
  META_GRAPH_API_VERSION: "v25.0",
  META_APP_ID: "1715957376325225" as string | undefined,
  META_EMBEDDED_CONFIG_ID: "998877" as string | undefined,
  META_APP_SECRET: "secreto-de-la-app" as string | undefined,
}));
vi.mock("@/lib/env", () => ({ getEnv: () => env }));

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  save: vi.fn(),
  webhook: vi.fn(),
  descubrir: vi.fn(),
}));
vi.mock("@/lib/auth/session", async (original) => ({
  ...(await original<typeof import("@/lib/auth/session")>()),
  requireSession: mocks.session,
}));
vi.mock("@/server/whatsapp/credentials", () => ({ saveCredentials: mocks.save }));
vi.mock("@/server/whatsapp/connect", () => ({
  registerWebhookForNumber: mocks.webhook,
  descubrirCuentaDeMensajes: mocks.descubrir,
}));

import {
  completarAltaEmbebida,
  EmbeddedSignupError,
  embeddedConfig,
  generarPin,
} from "@/server/whatsapp/embedded";
import { leerEventoDeAlta, opcionesDeInit, opcionesDeLogin } from "@/lib/meta/signup-event";
import { GET, POST } from "@/app/api/settings/whatsapp/embedded/route";
import { resetRateLimit } from "@/lib/rate-limit";

/** El canje de Meta: un servidor local, porque va por node:http y no por fetch. */
let server: Server;
const canjes: URLSearchParams[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    canjes.push(url.searchParams);
    const ok =
      url.pathname === "/v25.0/oauth/access_token" &&
      url.searchParams.get("client_secret") === "secreto-de-la-app" &&
      url.searchParams.get("code") !== "code-malo";
    res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { access_token: "EAAG-del-cliente" } : { error: { message: "bad code", code: 100 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  env.META_GRAPH_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fetchMock = vi.fn();
const respond = (data: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(data), { status }));
const graphCall = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i]! as [string, RequestInit];
  return { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
};
const numero = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  display_phone_number: "+51 999 888 777",
  verified_name: "AvisaPe",
  status: "PENDING",
  ...extra,
});
const WEBHOOK_OK = { ok: true, appWithoutWebhook: false, messagingAccount: { ok: true } };

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  canjes.length = 0;
  vi.clearAllMocks();
  env.META_APP_ID = "1715957376325225";
  env.META_EMBEDDED_CONFIG_ID = "998877";
  env.META_APP_SECRET = "secreto-de-la-app";
  mocks.session.mockResolvedValue({ organizationId: "org_1", userId: "usr_1", role: "owner" });
  mocks.save.mockResolvedValue(undefined);
  mocks.webhook.mockResolvedValue(WEBHOOK_OK);
  mocks.descubrir.mockResolvedValue("163890796811554");
  resetRateLimit();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("el evento de sesión de Meta", () => {
  const FB = "https://www.facebook.com";
  const ev = (event: string, data: Record<string, unknown> = {}) => ({ type: "WA_EMBEDDED_SIGNUP", event, data });

  it("FINISH trae la WABA y el número; también si llega como texto JSON", () => {
    const esperado = { kind: "finish", wabaId: "160228957180064", phoneNumberId: "555" };
    expect(leerEventoDeAlta(FB, ev("FINISH", { waba_id: "160228957180064", phone_number_id: "555" }))).toEqual(esperado);
    expect(
      leerEventoDeAlta(
        "https://business.facebook.com",
        JSON.stringify(ev("FINISH", { waba_id: "160228957180064", phone_number_id: "555" }))
      )
    ).toEqual(esperado);
  });

  it("FINISH_ONLY_WABA sin número deja phoneNumberId en null", () => {
    expect(leerEventoDeAlta(FB, ev("FINISH_ONLY_WABA", { waba_id: "1" }))).toEqual({
      kind: "finish",
      wabaId: "1",
      phoneNumberId: null,
    });
  });

  it("cancelación, error y coexistencia se distinguen", () => {
    expect(leerEventoDeAlta(FB, ev("CANCEL", { current_step: "PHONE_NUMBER_SETUP" }))).toEqual({ kind: "cancel" });
    expect(leerEventoDeAlta(FB, ev("ERROR", { error_message: "falló" }))).toEqual({ kind: "error", message: "falló" });
    expect(leerEventoDeAlta(FB, ev("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: "1" }))).toEqual({
      kind: "coexistence",
    });
  });

  it("ignora otros orígenes, otros mensajes y IDs que no son números", () => {
    expect(leerEventoDeAlta("https://evil.test", ev("FINISH", { waba_id: "1", phone_number_id: "2" }))).toBeNull();
    expect(leerEventoDeAlta(FB, "no-es-json")).toBeNull();
    expect(leerEventoDeAlta(FB, { type: "OTRA_COSA" })).toBeNull();
    expect(leerEventoDeAlta(FB, ev("FINISH", { waba_id: "1;drop" }))).toBeNull();
    expect(leerEventoDeAlta(FB, ev("FINISH", {}))).toBeNull();
  });

  it("FB.login pide el code con config_id y extras v4; FB.init apaga FedCM", () => {
    expect(opcionesDeLogin("998877")).toEqual({
      config_id: "998877",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: "3", version: "v4" },
    });
    expect(opcionesDeInit("1715957376325225", "v25.0")).toMatchObject({
      appId: "1715957376325225",
      version: "v25.0",
      fedCM: false,
    });
  });
});

describe("configuración de la instancia (CA-1)", () => {
  it("lista solo con App ID, Config ID numéricos y el secreto", () => {
    expect(embeddedConfig().ready).toBe(true);
    env.META_EMBEDDED_CONFIG_ID = undefined;
    expect(embeddedConfig().ready).toBe(false);
    env.META_EMBEDDED_CONFIG_ID = "998877";
    env.META_APP_SECRET = undefined;
    expect(embeddedConfig().ready).toBe(false);
    env.META_APP_SECRET = "s";
    env.META_APP_ID = "abc";
    expect(embeddedConfig().ready).toBe(false);
  });

  it("el PIN generado son seis dígitos", () => {
    for (let i = 0; i < 50; i++) expect(generarPin()).toMatch(/^\d{6}$/);
  });
});

describe("el alta en el servidor", () => {
  const input = { organizationId: "org_1", code: "code-bueno", wabaId: "160228957180064", phoneNumberId: "555", pin: null };

  it("canjea, verifica el número, lo registra con un PIN generado, guarda y registra el webhook", async () => {
    respond({ data: [numero("444"), numero("555")] }); // phone_numbers
    respond({ success: true }); // register

    const r = await completarAltaEmbebida(input);

    expect(canjes[0]!.get("client_id")).toBe("1715957376325225");
    expect(canjes[0]!.get("code")).toBe("code-bueno");
    expect(canjes[0]!.has("redirect_uri")).toBe(false);
    expect(graphCall(0).url).toContain("/160228957180064/phone_numbers?");
    expect(graphCall(1)).toMatchObject({
      url: expect.stringContaining("/555/register"),
      method: "POST",
      body: { messaging_product: "whatsapp", pin: r.generatedPin },
    });
    expect(r.generatedPin).toMatch(/^\d{6}$/);
    expect(mocks.save).toHaveBeenCalledWith({
      organizationId: "org_1",
      wabaId: "160228957180064",
      messagingAccountId: "163890796811554",
      phoneNumberId: "555",
      token: "EAAG-del-cliente",
      displayPhoneNumber: "+51 999 888 777",
      verifiedName: "AvisaPe",
    });
    expect(mocks.webhook).toHaveBeenCalledWith(
      expect.objectContaining({
        wabaId: "160228957180064",
        phoneNumberId: "555",
        token: "EAAG-del-cliente",
        messagingAccountId: "163890796811554",
        webhookUrl: "https://crm.ejemplo.test/api/webhooks/wa/verify-token-xyz",
      })
    );
    expect(r).toMatchObject({ registered: true, displayPhoneNumber: "+51 999 888 777", webhook: WEBHOOK_OK });
    expect(JSON.stringify(r)).not.toContain("EAAG-del-cliente");
  });

  it("con el PIN del dueño lo usa y no lo devuelve; un número CONNECTED no se re-registra", async () => {
    respond({ data: [numero("555")] });
    respond({ success: true });
    const r = await completarAltaEmbebida({ ...input, pin: "123456" });
    expect(graphCall(1).body).toEqual({ messaging_product: "whatsapp", pin: "123456" });
    expect(r.generatedPin).toBeUndefined();

    fetchMock.mockReset();
    respond({ data: [numero("555", { status: "CONNECTED" })] });
    const r2 = await completarAltaEmbebida({ ...input, code: "code-2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ registered: false });
    expect(r2.generatedPin).toBeUndefined();
  });

  it("sin phone_number_id usa el único número; con varios falla sin guardar (CA-3)", async () => {
    respond({ data: [numero("555")] });
    respond({ success: true });
    expect((await completarAltaEmbebida({ ...input, phoneNumberId: null })).phoneNumberId).toBe("555");

    respond({ data: [numero("444"), numero("555")] });
    mocks.save.mockClear();
    await expect(completarAltaEmbebida({ ...input, code: "c3", phoneNumberId: null })).rejects.toMatchObject({
      code: "varios_numeros",
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("un número que no es de la WABA, o ON_PREMISE, falla sin guardar", async () => {
    respond({ data: [numero("444")] });
    await expect(completarAltaEmbebida(input)).rejects.toMatchObject({ code: "asset_mismatch" });
    respond({ data: [numero("555", { platform_type: "ON_PREMISE" })] });
    await expect(completarAltaEmbebida(input)).rejects.toMatchObject({ code: "migration_required" });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
  });

  it("si Meta no registra el número, no se guarda nada", async () => {
    respond({ data: [numero("555")] });
    respond({ error: { message: "PIN Mismatch", code: 133005 } }, 400);
    await expect(completarAltaEmbebida(input)).rejects.toMatchObject({ code: "registration_failed" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("un code que Meta no acepta falla sin hablar con la Graph API ni filtrar el secreto (CA-7)", async () => {
    const err = await completarAltaEmbebida({ ...input, code: "code-malo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddedSignupError);
    expect((err as EmbeddedSignupError).code).toBe("exchange_failed");
    expect((err as Error).message).not.toContain("secreto-de-la-app");
    expect((err as Error).message).not.toContain("code-malo");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("la ruta /api/settings/whatsapp/embedded", () => {
  const post = (body: unknown, origin = "https://crm.ejemplo.test") =>
    POST(
      new Request("https://crm.ejemplo.test/api/settings/whatsapp/embedded", {
        method: "POST",
        headers: { "content-type": "application/json", origin, host: "crm.ejemplo.test" },
        body: JSON.stringify(body),
      })
    );
  const valido = { code: "code-bueno", wabaId: "160228957180064", phoneNumberId: "555", pin: null };

  it("sin configuración, GET y POST responden 404 (CA-1)", async () => {
    env.META_APP_ID = undefined;
    expect((await GET()).status).toBe(404);
    expect((await post(valido)).status).toBe(404);
  });

  it("GET da lo del SDK a quien configura, nunca el secreto; a un miembro, solo que no puede", async () => {
    const res = await GET();
    const data = await res.json();
    expect(data).toEqual({
      ready: true,
      canManage: true,
      appId: "1715957376325225",
      configId: "998877",
      graphVersion: "v25.0",
    });
    expect(JSON.stringify(data)).not.toContain("secreto");
    mocks.session.mockResolvedValue({ organizationId: "org_1", userId: "usr_2", role: "member" });
    expect(await (await GET()).json()).toEqual({ ready: true, canManage: false });
  });

  it("un miembro, otro origen o un cuerpo inválido no llegan a Meta (CA-2)", async () => {
    mocks.session.mockResolvedValue({ organizationId: "org_1", userId: "usr_2", role: "member" });
    expect((await post(valido)).status).toBe(403);
    mocks.session.mockResolvedValue({ organizationId: "org_1", userId: "usr_1", role: "owner" });
    expect((await post(valido, "https://evil.test")).status).toBe(403);
    expect((await post({ ...valido, pin: "12" })).status).toBe(422);
    expect(canjes).toHaveLength(0);
  });

  it("completa el alta y responde el número, el webhook y el PIN generado", async () => {
    respond({ data: [numero("555")] });
    respond({ success: true });
    const res = await post(valido);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ connected: true, phoneNumberId: "555", registered: true, webhook: WEBHOOK_OK });
    expect(data.generatedPin).toMatch(/^\d{6}$/);
    expect(JSON.stringify(data)).not.toContain("EAAG-del-cliente");
  });

  it("un fallo de Meta vuelve como error legible, sin guardar", async () => {
    respond({ data: [] });
    const res = await post(valido);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("asset_mismatch");
  });
});
