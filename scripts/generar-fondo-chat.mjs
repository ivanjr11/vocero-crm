/**
 * El fondo del chat, a la WhatsApp: un mosaico de dibujos en línea (propios,
 * no los de WhatsApp) que se repite sin costuras. Sale en dos versiones, la
 * clara (negro muy tenue) y la oscura (blanco muy tenue): el tono va dentro
 * del SVG porque una imagen de fondo no acepta opacidad desde CSS.
 *
 * Determinista: la misma semilla da el mismo mosaico. Para cambiar un dibujo
 * se edita aquí y se vuelve a generar; los SVG de `public/` no se tocan a mano.
 *
 * Uso: node scripts/generar-fondo-chat.mjs [carpeta]   (por defecto public/fondo-chat)
 */
import { writeFileSync, mkdirSync } from "node:fs";

const salida = process.argv[2] ?? "public/fondo-chat";
mkdirSync(salida, { recursive: true });

// Cada dibujo vive en una caja de 40×40 centrada en (20,20).
const DIBUJOS = {
  burbuja: `<path d="M10 8H30A4 4 0 0 1 34 12V24A4 4 0 0 1 30 28H18L11 34V28H10A4 4 0 0 1 6 24V12A4 4 0 0 1 10 8Z"/><circle cx="14" cy="18" r="1"/><circle cx="20" cy="18" r="1"/><circle cx="26" cy="18" r="1"/>`,
  corazon: `<path d="M20 33C8 25 5 18 8 13C11 8 17 9 20 14C23 9 29 8 32 13C35 18 32 25 20 33Z"/>`,
  estrella: `<path d="M20 7L23.2 15.6L32.4 16L25.2 21.7L27.6 30.5L20 25.5L12.4 30.5L14.8 21.7L7.6 16L16.8 15.6Z"/>`,
  avion: `<path d="M6 19L34 8L26 32L19 23Z"/><path d="M34 8L19 23V31L23 27"/>`,
  carita: `<circle cx="20" cy="20" r="13"/><circle cx="15.5" cy="17" r=".8"/><circle cx="24.5" cy="17" r=".8"/><path d="M14 23Q20 29 26 23"/>`,
  calendario: `<rect x="7" y="10" width="26" height="23" rx="3"/><path d="M7 16H33M13 6V12M27 6V12M12 21H15M18.5 21H21.5M25 21H28M12 27H15M18.5 27H21.5"/>`,
  reloj: `<circle cx="20" cy="20" r="13"/><path d="M20 12V20L25 24"/>`,
  telefono: `<path d="M12 7C10 7 8 9 8 11C8 22 18 32 29 32C31 32 33 30 33 28V25L27 22L24 25C20 23 17 20 15 16L18 13L15 7Z"/>`,
  cafe: `<path d="M9 15H27V25A7 7 0 0 1 20 32H16A7 7 0 0 1 9 25Z"/><path d="M27 18H30A3.5 3.5 0 0 1 30 25H27"/><path d="M14 11C13 9 15 8 14 5M20 11C19 9 21 8 20 5"/>`,
  nota: `<path d="M15 29V10L30 7V26"/><circle cx="12" cy="29" r="3.2"/><circle cx="27" cy="26" r="3.2"/>`,
  cactus: `<path d="M17 34V10A3 3 0 0 1 23 10V34"/><path d="M17 22H13A3 3 0 0 1 10 19V15"/><path d="M23 19H27A3 3 0 0 0 30 16V13"/><path d="M11 34H29"/>`,
  sol: `<circle cx="20" cy="20" r="6"/><path d="M20 7V10M20 30V33M7 20H10M30 20H33M10.8 10.8L12.9 12.9M27.1 27.1L29.2 29.2M10.8 29.2L12.9 27.1M27.1 12.9L29.2 10.8"/>`,
  nube: `<path d="M12 29H29A6 6 0 0 0 29 17A8 8 0 0 0 14 15A7 7 0 0 0 12 29Z"/>`,
  hoja: `<path d="M8 32C8 16 18 8 33 7C32 22 24 32 8 32Z"/><path d="M8 32L22 18"/>`,
  regalo: `<rect x="8" y="17" width="24" height="16" rx="2"/><rect x="6" y="11" width="28" height="6" rx="1.5"/><path d="M20 11V33"/><path d="M20 11C16 4 10 8 14 11M20 11C24 4 30 8 26 11"/>`,
  camara: `<rect x="6" y="12" width="28" height="19" rx="3"/><circle cx="20" cy="21.5" r="5.5"/><path d="M14 12L16 8H24L26 12"/><circle cx="29" cy="16" r=".8"/>`,
  sobre: `<rect x="6" y="10" width="28" height="20" rx="2.5"/><path d="M7 11L20 21L33 11"/>`,
  pin: `<path d="M20 34C20 34 9 23 9 15A11 11 0 0 1 31 15C31 23 20 34 20 34Z"/><circle cx="20" cy="15" r="4"/>`,
  foco: `<path d="M15 26C15 22 11 20 11 15A9 9 0 0 1 29 15C29 20 25 22 25 26Z"/><path d="M16 30H24M17 33.5H23"/>`,
  cohete: `<path d="M20 5C27 10 28 19 25 27H15C12 19 13 10 20 5Z"/><circle cx="20" cy="15" r="3"/><path d="M15 21L10 27H15M25 21L30 27H25M18 30L20 35L22 30"/>`,
  destello: `<path d="M20 6C21 15 25 19 34 20C25 21 21 25 20 34C19 25 15 21 6 20C15 19 19 15 20 6Z"/>`,
  palomitas: `<path d="M4 21L10.5 27.5L22 13M14 25L16.5 27.5L28 13"/>`,
  megafono: `<path d="M8 16H13L28 9V31L13 24H8Z"/><path d="M13 24L15 31H19L17 25"/><path d="M32 15C34 17 34 23 32 25"/>`,
  microfono: `<rect x="15" y="6" width="10" height="17" rx="5"/><path d="M10 19A10 10 0 0 0 30 19"/><path d="M20 29V34M15 34H25"/>`,
  etiqueta: `<path d="M7 21L19 9H31V21L19 33Z"/><circle cx="26" cy="14" r="2.2"/>`,
  carrito: `<path d="M5 9H10L14 26H30L33 14H12"/><circle cx="16" cy="31" r="2"/><circle cx="28" cy="31" r="2"/>`,
  luna: `<path d="M24 6A14 14 0 1 0 34 25A11 11 0 0 1 24 6Z"/>`,
  chile: `<path d="M10 12C14 12 15 16 18 20C21 25 27 30 33 31C26 34 16 32 11 24C8 19 8 14 10 12Z"/><path d="M10 12C9 9 10 7 13 6"/>`,
  bolsa: `<path d="M9 14H31L29 34H11Z"/><path d="M15 18V12A5 5 0 0 1 25 12V18"/>`,
  grafica: `<path d="M8 33H33M12 33V24M19 33V18M26 33V21"/><path d="M10 15L17 9L22 12L31 5M26 5H31V10"/>`,
  gato: `<path d="M9 33V16L12 7L17 13H23L28 7L31 16V33Z"/><circle cx="16" cy="21" r=".9"/><circle cx="24" cy="21" r=".9"/><path d="M18.5 25L20 26.5L21.5 25M6 24H12M6 28H12M28 24H34M28 28H34"/>`,
  planta: `<path d="M12 24H28L26 34H14Z"/><path d="M20 24V14"/><path d="M20 18C15 18 13 14 13 10C18 10 20 13 20 18Z"/><path d="M20 15C25 15 27 11 27 7C22 7 20 10 20 15Z"/>`,
  globo: `<path d="M20 26C13 26 10 20 10 15A10 10 0 0 1 30 15C30 20 27 26 20 26Z"/><path d="M18 26L20 29L22 26"/><path d="M20 29C18 32 22 33 20 36"/>`,
  dona: `<circle cx="20" cy="20" r="13"/><circle cx="20" cy="20" r="4.5"/><path d="M12 14L13.5 15M27 13L25.5 14.5M13 26L14.5 25M26 27L27 25.5M20 9.5V11"/>`,
  candado: `<rect x="9" y="18" width="22" height="16" rx="3"/><path d="M14 18V13A6 6 0 0 1 26 13V18"/><path d="M20 24V28"/>`,
  rayo: `<path d="M22 5L10 22H19L17 35L30 17H21Z"/>`,
  // Los de la casa (pedido de Kevin): el carnero (Belier), el pulpo, el
  // plato de DJ y la diosa del logo de AISHIA, en el mismo trazo que el resto.
  carnero: `<path d="M15 16C15 14 17 13 20 13C23 13 25 14 25 16L24 27C23.5 30 22 32 20 32C18 32 16.5 30 16 27Z"/><path d="M15.5 15C11 10 4 13 5 19C6 24 12 24 12 20C12 17.5 9 17.5 9 19.5"/><path d="M24.5 15C29 10 36 13 35 19C34 24 28 24 28 20C28 17.5 31 17.5 31 19.5"/><path d="M17 13Q18 10.5 20 12Q22 10.5 23 13"/><circle cx="18" cy="20" r=".8"/><circle cx="22" cy="20" r=".8"/><path d="M18.5 28L19.3 28.8M21.5 28L20.7 28.8"/>`,
  pulpo: `<path d="M11 19C9 10 14 4 20 4C26 4 31 10 29 19"/><path d="M11 19Q12.5 21.5 14 21Q16 22.5 18 22Q20 23 22 22Q24 22.5 26 21Q27.5 21.5 29 19"/><path d="M11 19C8 22 7 26 4 26C2 26 2 23 4 23M14 21C13 26 11 30 8 32C6 33 5 31 7 30M18 22C18 27 16 31 15 34C14 36 16 37 17 35M22 22C22 27 24 31 25 34C26 36 24 37 23 35M26 21C27 26 29 30 32 32C34 33 35 31 33 30M29 19C32 22 33 26 36 26C38 26 38 23 36 23"/><circle cx="16.5" cy="13.5" r="1.3"/><circle cx="23.5" cy="13.5" r="1.3"/><path d="M18.5 16.5Q20 17.7 21.5 16.5"/>`,
  dj: `<rect x="5" y="8" width="30" height="24" rx="3"/><circle cx="17" cy="20" r="9"/><circle cx="17" cy="20" r="2.5"/><circle cx="31" cy="12" r="1.5"/><path d="M31 13.5V23L25 26.5"/><path d="M29.5 29H32.5"/>`,
  aishia: `<path d="M8 13A14 14 0 0 1 16.5 6.4M23.5 6.4A14 14 0 0 1 32 13"/><circle cx="20" cy="3.6" r="1.4"/><circle cx="3.4" cy="20" r="1.4"/><circle cx="36.6" cy="20" r="1.4"/><circle cx="20" cy="36.4" r="1.4"/><path d="M20 5.5V9L14 13M20 9L26 13"/><path d="M14 13C13 15 13 18 13 21C13 26.5 16.5 30.5 20 30.5C23.5 30.5 27 26.5 27 21C27 18 27 15 26 13"/><circle cx="20" cy="15.5" r=".9"/><path d="M15.8 19.6Q17.2 18.6 18.6 19.6M21.4 19.6Q22.8 18.6 24.2 19.6M18.6 25.6Q20 26.6 21.4 25.6M19.4 22.8H20.6"/><path d="M5.2 20H9V17H13M34.8 20H31V17H27M9 23.5H12.5M31 23.5H27.5M9.5 26.5L12 29.5M30.5 26.5L28 29.5M20 30.5V34.6"/>`,
};

// Rellenos chicos entre los dibujos.
const RELLENOS = [
  `<circle cx="0" cy="0" r="1.6"/>`,
  `<circle cx="0" cy="0" r="3.5"/>`,
  `<path d="M-4 0H4M0 -4V4"/>`,
  `<path d="M-6 0C-4 -3 -2 3 0 0C2 -3 4 3 6 0"/>`,
  `<path d="M-3 -3L3 3M3 -3L-3 3"/>`,
];

// PRNG determinista: el mosaico sale igual en cada corrida.
let semilla = 20261025;
const azar = () => {
  semilla = (semilla * 1664525 + 1013904223) % 4294967296;
  return semilla / 4294967296;
};

// El lado del mosaico es el `background-size` de `.thread-bg` (globals.css).
const LADO = 440;
const MIN_ESCALA = 1.2;
const MAX_ESCALA = 1.6;
// Lo más que un dibujo girado y escalado se sale de su centro.
const ALCANCE = 50;
const nombres = Object.keys(DIBUJOS);

// Distancia en el toro: el mosaico se repite, los bordes se tocan.
const dist = (a, b) => {
  const dx = Math.min(Math.abs(a.x - b.x), LADO - Math.abs(a.x - b.x));
  const dy = Math.min(Math.abs(a.y - b.y), LADO - Math.abs(a.y - b.y));
  return Math.hypot(dx, dy);
};

// Dardos: cada dibujo cae donde no pisa a otro. Sale orgánico, sin filas.
const piezas = [];
const ocupados = [];
for (const nombre of nombres.sort(() => azar() - 0.5)) {
  for (let intento = 0, hueco = 6; intento < 6000; intento++) {
    if (intento % 1500 === 1499) hueco -= 2;
    const escala = MIN_ESCALA + azar() * (MAX_ESCALA - MIN_ESCALA);
    const p = { x: azar() * LADO, y: azar() * LADO, r: 17 * escala };
    if (ocupados.every((o) => dist(o, p) > o.r + p.r + hueco)) {
      const giro = Math.round((azar() - 0.5) * 60);
      piezas.push({ cx: p.x, cy: p.y, svg: `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${giro}) scale(${escala.toFixed(2)}) translate(-20 -20)"><use href="#${nombre}"/></g>` });
      ocupados.push(p);
      break;
    }
  }
}
if (ocupados.length < nombres.length) throw new Error(`Solo cupieron ${ocupados.length} de ${nombres.length} dibujos`);
const rellenos = [];
for (let intento = 0; intento < 4000 && rellenos.length < 56; intento++) {
  const p = { x: 8 + azar() * (LADO - 16), y: 8 + azar() * (LADO - 16), r: 7 };
  if ([...ocupados, ...rellenos].every((o) => dist(o, p) > o.r + p.r + 4)) {
    rellenos.push(p);
    const forma = RELLENOS[Math.floor(azar() * RELLENOS.length)];
    piezas.push({ cx: p.x, cy: p.y, svg: `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${Math.round(azar() * 90)})">${forma}</g>` });
  }
}

// Lo que se sale por un borde se repite por el de enfrente: sin costuras.
const conCopias = [];
for (const p of piezas) {
  conCopias.push(p.svg);
  for (const [ox, oy] of [[LADO, 0], [-LADO, 0], [0, LADO], [0, -LADO], [LADO, LADO], [-LADO, -LADO], [LADO, -LADO], [-LADO, LADO]]) {
    const x = p.cx + ox;
    const y = p.cy + oy;
    if (x > -ALCANCE && x < LADO + ALCANCE && y > -ALCANCE && y < LADO + ALCANCE) {
      conCopias.push(`<g transform="translate(${ox} ${oy})">${p.svg}</g>`);
    }
  }
}

const defs = Object.entries(DIBUJOS)
  .map(([id, d]) => `<g id="${id}">${d}</g>`)
  .join("");

for (const [archivo, color, opacidad] of [["claro.svg", "#000000", 0.08], ["oscuro.svg", "#ffffff", 0.07]]) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LADO}" height="${LADO}" viewBox="0 0 ${LADO} ${LADO}">` +
    `<!-- Vocero: el fondo del chat. Dibujos propios en línea; el tono lo pone la opacidad. -->` +
    `<defs>${defs}</defs>` +
    `<g opacity="${opacidad}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${conCopias.join("")}</g>` +
    `</svg>\n`;
  writeFileSync(`${salida}/${archivo}`, svg);
  console.log(archivo, svg.length, "bytes");
}
