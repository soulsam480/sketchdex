/**
 * Retune Excalidraw's colour picker for dark paper.
 *
 * Excalidraw's palette constants are module-private: the five quick picks for
 * stroke and background, the shade each starts on, and the canvas-background
 * picks. All of them assume white paper (a black pen, pastel fills, five
 * near-white canvases). Sketchdex scenes are dark paper and are never run
 * through the dark-mode invert filter, so those defaults come out as a black
 * pen on black and pale pastels floating on ink.
 *
 * There is no prop for this, so the built package is patched in place after
 * install. Every replacement is anchored on the palette code itself, works on
 * both the readable dev bundle and the minified prod bundle, and is idempotent:
 * running twice changes nothing the second time. If Excalidraw's build changes
 * shape and a pattern stops matching, this says so loudly rather than leaving
 * the picker half-patched.
 *
 * Runs from `npm install` in a checkout (the `prepare` script) and by hand:
 *   node scripts/patch-excalidraw.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "node_modules", "@excalidraw", "excalidraw", "dist");

// what the picker opens on, and the five quick picks, for dark paper
// neutral, deeper, warmer, navy, ink-blue: all dark. White is a hex away.
const CANVAS_PICKS = `["#121212","#0a0a0a","#1c1c1c","#171310","#0e1626"]`;
const OLD_CANVAS_PICKS = /\["#121212","#1e1e1e","#0e1626","#171310","#ffffff"\]/;

const RULES = [
  {
    name: "shade indexes: stroke starts light (shade 3), background deep (shade 5)",
    // prod: `Ps=4,fo=4,po=1,ft=[0,2,4,6,8]`  (chart, stroke, background, shades)
    from: /(\b[\w$]+=)4,(\b[\w$]+=)4,(\b[\w$]+=)1,(\b[\w$]+=\[0,2,4,6,8\])/,
    to: "$14,$22,$34,$4",
    dev: [
      [/DEFAULT_ELEMENT_STROKE_COLOR_INDEX = 4;/, "DEFAULT_ELEMENT_STROKE_COLOR_INDEX = 2;"],
      [/DEFAULT_ELEMENT_BACKGROUND_COLOR_INDEX = 1;/, "DEFAULT_ELEMENT_BACKGROUND_COLOR_INDEX = 4;"],
    ],
    done: /(?:[\w$]+=4,[\w$]+=2,[\w$]+=4,[\w$]+=\[0,2,4,6,8\])|DEFAULT_ELEMENT_STROKE_COLOR_INDEX = 2;/,
  },
  {
    name: "stroke quick picks: light grey ink instead of black",
    // `[Z.black,Z.red[fo],...`  /  `[\n COLOR_PALETTE.black,\n COLOR_PALETTE.red[...`
    from: /\[\s*([\w$]+)\.black,(\s*)\1\.red\[/,
    to: "[$1.gray[1],$2$1.red[",
    done: /\[\s*([\w$]+)\.gray\[1\],\s*\1\.red\[/,
  },
  {
    name: "canvas background picks: dark papers first",
    from: /\[\s*[\w$]+\.white,\s*(?:\/\/[^\n]*\s*)?"#f8f9fa",\s*(?:\/\/[^\n]*\s*)?"#f5faff",\s*(?:\/\/[^\n]*\s*)?"#fffce8",\s*(?:\/\/[^\n]*\s*)?"#fdf8f6"\s*\]/,
    to: CANVAS_PICKS,
    also: [[OLD_CANVAS_PICKS, CANVAS_PICKS]],
    done: new RegExp(CANVAS_PICKS.replace(/[[\]]/g, "\\$&")),
  },
];

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith(".js") ? [full] : [];
  });

if (!fs.existsSync(dist)) {
  console.error("patch-excalidraw: @excalidraw/excalidraw is not installed");
  process.exit(0);
}

const targets = walk(dist).filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return /\[0,\s*2,\s*4,\s*6,\s*8\]/.test(source) && /bronze/.test(source);
});

if (!targets.length) {
  console.error("patch-excalidraw: could not find the palette module; picker left as shipped");
  process.exit(1);
}

let failures = 0;
for (const file of targets) {
  let source = fs.readFileSync(file, "utf8");
  const before = source;
  for (const rule of RULES) {
    if (rule.done.test(source)) continue;
    let next = source.replace(rule.from, rule.to);
    if (next === source && rule.dev) {
      for (const [from, to] of rule.dev) next = next.replace(from, to);
    }
    if (next === source && rule.also) {
      for (const [from, to] of rule.also) next = next.replace(from, to);
    }
    if (next === source) {
      console.error(`patch-excalidraw: "${rule.name}" did not match in ${path.relative(root, file)}`);
      failures += 1;
    }
    source = next;
  }
  if (source !== before) {
    fs.writeFileSync(file, source);
    console.log(`patch-excalidraw: patched ${path.relative(root, file)}`);
  } else {
    console.log(`patch-excalidraw: already patched ${path.relative(root, file)}`);
  }
}
process.exit(failures ? 1 : 0);
