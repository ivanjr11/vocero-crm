/**
 * Self-test E2E — 064: una sola lista de conversaciones por pestaña.
 * Guion: tests/e2e/us-lista-compartida.md.
 *
 * Cuenta cuántas veces la pestaña pide la lista de conversaciones mientras
 * llega una ráfaga de mensajes:
 *  1. Con la Bandeja abierta: la ráfaga de diez son pocas peticiones, no
 *     cuarenta, y la lista y la insignia del menú quedan al día.
 *  2. Ctrl+K dentro de la Bandeja no pide otra lista.
 *  3. Fuera de la Bandeja (Pipeline): el menú pide su lista, también junta.
 *  4. Al volver a la Bandeja, todo cuadra.
 *
 * Requiere la app viva con WA_MOCK_ENABLED=true. `E2E_EMAIL` / `E2E_PASSWORD`
 * para entrar con una cuenta que ya exista (el registro público se cierra tras
 * la primera). La insignia se mide contra lo que ya marcaba al empezar.
 *
 * Uso: node --env-file=<env> scripts/e2e-lista-compartida.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const S = Date.now().toString(36).toUpperCase();
const EMAIL = process.env.E2E_EMAIL ?? "e2e-lista@vocero.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "password-e2e-lista";
const PN = `PN-LC-${S}`;

let failures = 0;
let checks = 0;
function ok(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`  OK  ${name}`);
  else {
    failures++;
    console.log(`  FALLA  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(fn, ms = 20000) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > fin) return v;
    await espera(200);
  }
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const req = ctx.request;
const errores = [];

try {
  console.log("== Preparación ==");
  let r = await req.post(`${BASE}/api/auth/sign-up/email`, {
    headers: { origin: BASE },
    data: { email: EMAIL, password: PASSWORD, name: "Dueña Lista" },
  });
  if (!r.ok())
    r = await req.post(`${BASE}/api/auth/sign-in/email`, {
      headers: { origin: BASE },
      data: { email: EMAIL, password: PASSWORD },
    });
  ok("login", r.ok(), String(r.status()));
  const wa = await req.put(`${BASE}/api/settings/whatsapp`, {
    data: { wabaId: "WABA-LC", phoneNumberId: PN, token: "tok-lc" },
  });
  ok("número de pruebas guardado", wa.ok(), String(wa.status()));

  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errores.push(e.message));
  let pedidas = 0;
  page.on("request", (q) => {
    if (new URL(q.url()).pathname === "/api/conversations") pedidas++;
  });

  let n = 0;
  const entrante = async (texto) => {
    n++;
    const res = await req.post(`${BASE}/api/dev/wa-mock/inbound`, {
      data: { phoneNumberId: PN, from: `5215550${String(100000 + n)}`, name: `Cliente ${n} ${S}`, text: `${texto} ${S}` },
    });
    return res.ok();
  };
  // El riel de íconos (escritorio): la insignia es el único <span> del botón.
  const insignia = () =>
    page.locator('nav.tarjeta[aria-label="Secciones"] a[aria-label="Bandeja"] > span').textContent({ timeout: 2000 }).catch(() => null);
  const filas = () => page.locator("li", { hasText: S }).count();

  console.log("\n== 1 · Ráfaga de diez mensajes con la Bandeja abierta ==");
  await page.goto(`${BASE}/inbox`, { waitUntil: "load" });
  await page.getByLabel("Buscar conversación").waitFor();
  await espera(3000); // carga inicial y conexión de eventos en vivo
  const base = Number((await insignia()) ?? 0);
  const marca = (k) => String(base + k);
  pedidas = 0;
  let enviados = 0;
  for (let i = 0; i < 10; i++) if (await entrante(`Hola ráfaga ${i}`)) enviados++;
  ok("los diez entrantes entraron", enviados === 10, String(enviados));
  ok("la lista enseña las diez conversaciones", await hasta(async () => (await filas()) === 10), String(await filas()));
  ok(`y la insignia del menú sube 10 (a ${marca(10)})`, await hasta(async () => (await insignia()) === marca(10)), String(await insignia()));
  await espera(2500);
  const rafaga = pedidas;
  console.log(`    (peticiones de la lista durante la ráfaga: ${rafaga})`);
  ok("la ráfaga pidió la lista a lo más 6 veces (antes: ~40)", rafaga >= 1 && rafaga <= 6, String(rafaga));

  console.log("\n== 2 · Ctrl+K dentro de la Bandeja ==");
  pedidas = 0;
  await page.keyboard.press("Control+K");
  const barra = page.getByRole("dialog", { name: "Barra de comandos" });
  await barra.waitFor();
  await page.keyboard.type(`cliente 3 ${S.toLowerCase()}`);
  ok(
    "encuentra la conversación con la lista de la Bandeja",
    await hasta(async () => (await barra.getByRole("option").filter({ hasText: `Cliente 3 ${S}` }).count()) === 1, 8000)
  );
  const atajo = pedidas;
  console.log(`    (peticiones de la lista al abrir Ctrl+K: ${atajo})`);
  ok("Ctrl+K no pidió otra lista (antes: 1–2)", atajo === 0, String(atajo));
  await page.keyboard.press("Escape");

  console.log("\n== 3 · Fuera de la Bandeja, el menú pide la suya ==");
  await page.goto(`${BASE}/pipeline`, { waitUntil: "load" });
  await espera(3000);
  pedidas = 0;
  for (let i = 0; i < 5; i++) await entrante(`Hola desde pipeline ${i}`);
  ok(`la insignia sube a ${marca(15)} sin la Bandeja abierta`, await hasta(async () => (await insignia()) === marca(15)), String(await insignia()));
  await espera(2500);
  const fuera = pedidas;
  console.log(`    (peticiones de la lista: ${fuera})`);
  ok("cinco mensajes pidieron la lista a lo más 4 veces (antes: ~10)", fuera >= 1 && fuera <= 4, String(fuera));

  console.log("\n== 4 · De vuelta en la Bandeja ==");
  await page.goto(`${BASE}/inbox`, { waitUntil: "load" });
  ok("la lista trae las quince", await hasta(async () => (await filas()) === 15), String(await filas()));
  ok(`y la insignia sigue en ${marca(15)}`, await hasta(async () => (await insignia()) === marca(15), 10000), String(await insignia()));
  ok("sin errores de página", errores.length === 0, errores.slice(0, 3).join(" | "));
  console.log(`\nRESUMEN peticiones: ráfaga=${rafaga} ctrlK=${atajo} fuera=${fuera}`);
} catch (e) {
  checks++;
  failures++;
  console.log(`  FALLA  excepción: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
console.log(`\n${checks - failures}/${checks} comprobaciones en verde`);
process.exit(failures ? 1 : 0);
