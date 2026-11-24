import { pathToFileURL } from "node:url";

const fractionalScene = [
  { id: "negative-low", type: "rectangle", index: "Z0" },
  { id: "negative-tail", type: "ellipse", index: "Z1z" },
  { id: "positive-tail", type: "diamond", index: "a0z" },
  { id: "positive-top", type: "rectangle", index: "a1V" },
  { id: "invalid-index", type: "line", index: "not an index" },
];

const bindingScene = [
  {
    id: "existing-box",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    index: "a0",
    boundElements: [],
  },
  {
    id: "existing-ellipse",
    type: "ellipse",
    x: 200,
    y: 0,
    width: 120,
    height: 80,
    index: "a1",
    boundElements: [{ id: "old-arrow", type: "arrow" }],
  },
  {
    id: "deleted-box",
    type: "rectangle",
    x: 400,
    y: 0,
    width: 100,
    height: 80,
    index: "a2",
    isDeleted: true,
    boundElements: [],
  },
  {
    id: "old-arrow",
    type: "arrow",
    x: 100,
    y: 40,
    width: 100,
    height: 0,
    index: "a3",
    points: [[0, 0], [100, 0]],
    startBinding: { elementId: "existing-box", focus: 0, gap: 4 },
    endBinding: { elementId: "existing-ellipse", focus: 0, gap: 4 },
    boundElements: [],
  },
];

const containerScene = [
  {
    id: "box",
    type: "rectangle",
    x: 10,
    y: 20,
    width: 120,
    height: 60,
    index: "a0",
    version: 3,
    groupIds: ["panel"],
    boundElements: [{ id: "label", type: "text" }],
  },
  {
    id: "label",
    type: "text",
    x: 20,
    y: 37.5,
    width: 100,
    height: 25,
    index: "a1",
    version: 2,
    fontSize: 20,
    fontFamily: 5,
    text: "Label",
    originalText: "Label",
    autoResize: false,
    containerId: "box",
    groupIds: ["panel"],
    boundElements: [],
  },
  {
    id: "other",
    type: "ellipse",
    x: 200,
    y: 20,
    width: 100,
    height: 60,
    index: "a2",
    version: 4,
    groupIds: ["other"],
    boundElements: [{ id: "arrow", type: "arrow" }],
  },
  {
    id: "arrow",
    type: "arrow",
    x: 130,
    y: 50,
    width: 70,
    height: 0,
    index: "a3",
    version: 5,
    points: [[0, 0], [70, 0]],
    startBinding: { elementId: "box", focus: 0, gap: 4 },
    endBinding: { elementId: "other", focus: 0, gap: 4 },
    boundElements: [],
  },
  {
    id: "deleted-box",
    type: "rectangle",
    x: -100,
    y: 0,
    width: 20,
    height: 20,
    index: "Z0",
    version: 1,
    isDeleted: true,
    boundElements: [],
  },
  {
    id: "dead-arrow",
    type: "arrow",
    x: -80,
    y: 10,
    width: 20,
    height: 0,
    index: "Z1",
    version: 1,
    points: [[0, 0], [20, 0]],
    startBinding: { elementId: "deleted-box", focus: 0, gap: 4 },
    endBinding: null,
    boundElements: [],
  },
];

const textScene = [
  {
    id: "auto-text",
    type: "text",
    x: 0,
    y: 0,
    width: 30,
    height: 25,
    index: "a0",
    version: 4,
    fontSize: 20,
    fontFamily: 5,
    text: "one",
    originalText: "one",
    autoResize: true,
    lineHeight: 1.25,
    boundElements: [],
  },
  {
    id: "fixed-text",
    type: "text",
    x: 0,
    y: 40,
    width: 100,
    height: 25,
    index: "a1",
    version: 2,
    fontSize: 20,
    fontFamily: 5,
    text: "fixed words",
    originalText: "fixed words",
    autoResize: false,
    lineHeight: 1.25,
    boundElements: [],
  },
];

export const cases = [
  { name: "build-empty", op: "build", args: { specs: [], existing: [], ink: "#1e1e1e" } },
  {
    name: "native-defaults",
    op: "build",
    args: {
      specs: [
        { type: "rectangle" },
        { type: "ellipse" },
        { type: "diamond" },
        { type: "arrow" },
        { type: "line" },
        { type: "text", text: "hello" },
        { type: "freedraw" },
        { type: "frame" },
      ],
    },
  },
  {
    name: "native-negative-and-zero-dimensions",
    op: "build",
    args: {
      specs: [
        { type: "rectangle", width: -10, height: 0 },
        { type: "ellipse", width: 0, height: -20 },
        { type: "diamond", width: -0.5, height: 2.5 },
        { type: "arrow", width: -100, height: -50 },
        { type: "line", width: 0, height: 0 },
        { type: "text", text: "sized", width: -1, height: 0 },
      ],
    },
  },
  {
    name: "supplied-fields-survive",
    op: "build",
    args: {
      specs: [
        {
          type: "rectangle",
          id: "chosen-id",
          index: "a9z",
          x: -2.5,
          y: 1e-9,
          width: 1e9,
          height: 0.5,
          angle: 359.9,
          strokeColor: "#123456",
          backgroundColor: "#abcdef",
          fillStyle: "hachure",
          strokeWidth: 5,
          strokeStyle: "dotted",
          roughness: 0,
          opacity: 42,
          groupIds: ["g1", "g2"],
          frameId: "frame-1",
          roundness: null,
          seed: 7,
          version: 9,
          versionNonce: 11,
          isDeleted: false,
          boundElements: [{ id: "kept", type: "text" }],
          updated: 13,
          link: "https://example.com",
          locked: true,
          customField: { nested: [1, null, false] },
        },
      ],
    },
  },
  {
    name: "build-dark-paper-ink",
    op: "build",
    args: { specs: [{ type: "rectangle" }, { type: "text", text: "ink" }], ink: "#e9ecef" },
  },
  {
    name: "build-light-paper-ink",
    op: "build",
    args: { specs: [{ type: "ellipse" }], ink: "#1e1e1e" },
  },
  {
    name: "build-null-specs",
    op: "build",
    args: { specs: null, existing: [] },
  },
  {
    name: "unknown-type",
    op: "build",
    args: { specs: [{ type: "image", x: 3, fileId: "asset" }, { type: "future-widget", width: 12 }] },
  },
  {
    name: "empty-type",
    op: "build",
    args: { specs: [{ type: "", x: 1 }] },
  },
  {
    name: "missing-type",
    op: "build",
    args: { specs: [{ x: 1 }, { rectangle: null }, { widget: { width: 4 } }, {}, []] },
  },
  {
    name: "null-and-primitive-entries",
    op: "build",
    args: { specs: [null, false, 0, "rectangle", [], { type: "rectangle" }] },
  },
  {
    name: "keyed-rectangle",
    op: "build",
    args: { specs: [{ rectangle: { x: 4, y: 5, width: 60, height: 30, label: "keyed" } }] },
  },
  {
    name: "keyed-path",
    op: "build",
    args: { specs: [{ path: { points: [[0, 0], [20, 10], [40, 0]], smooth: false } }] },
  },
  {
    name: "keyed-image",
    op: "build",
    args: { specs: [{ image: { x: 2, width: 30, height: 40 } }] },
  },
  {
    name: "keyed-inner-type-wins",
    op: "build",
    args: { specs: [{ rectangle: { type: "ellipse", width: 50 } }] },
  },
  {
    name: "label-string",
    op: "build",
    args: { specs: [{ type: "rectangle", ref: "box", width: 160, height: 80, label: "Hello" }] },
  },
  {
    name: "label-object",
    op: "build",
    args: {
      specs: [
        {
          type: "ellipse",
          width: 180,
          height: 90,
          label: {
            text: "Object label",
            fontSize: 24,
            fontFamily: 3,
            textAlign: "right",
            verticalAlign: "bottom",
            strokeColor: "#ff0000",
          },
        },
      ],
    },
  },
  {
    name: "label-grows-rectangle",
    op: "build",
    args: {
      specs: [{ type: "rectangle", width: 140, height: 10, label: "one\ntwo\nthree" }],
    },
  },
  {
    name: "label-grows-diamond",
    op: "build",
    args: {
      specs: [{ type: "diamond", width: 100, height: 10, label: "one\ntwo" }],
    },
  },
  {
    name: "label-grows-ellipse",
    op: "build",
    args: {
      specs: [{ type: "ellipse", width: 100, height: 10, label: "one\ntwo" }],
    },
  },
  {
    name: "label-tiny-container",
    op: "build",
    args: {
      specs: [{ type: "rectangle", width: 1, height: 1, label: "A very long label" }],
    },
  },
  {
    name: "label-empty-values",
    op: "build",
    args: {
      specs: [
        { type: "rectangle", label: "" },
        { type: "ellipse", label: null },
        { type: "diamond", label: {} },
        { type: "rectangle", label: { text: null } },
      ],
    },
  },
  {
    name: "label-on-non-container-warns",
    op: "build",
    args: {
      specs: [
        { type: "arrow", label: "ignored" },
        { type: "text", text: "standalone", label: "ignored" },
        { type: "freedraw", label: "ignored" },
      ],
    },
  },
  {
    name: "frame-label-string",
    op: "build",
    args: { specs: [{ type: "frame", x: 10, y: 20, width: 300, height: 200, label: "Frame title" }] },
  },
  {
    name: "frame-label-object",
    op: "build",
    args: { specs: [{ type: "frame", label: { text: "Object frame", fontSize: 30 } }] },
  },
  {
    name: "frame-existing-name",
    op: "build",
    args: { specs: [{ type: "frame", name: "Kept", label: "Ignored" }] },
  },
  {
    name: "frame-without-label",
    op: "build",
    args: { specs: [{ type: "frame" }, { type: "frame", name: "Named" }] },
  },
  {
    name: "text-multiline",
    op: "build",
    args: { specs: [{ type: "text", text: "first\n\nthird\nfourth" }] },
  },
  {
    name: "text-long-word",
    op: "build",
    args: { specs: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz0123456789", width: 50 }] },
  },
  {
    name: "text-cjk",
    op: "build",
    args: { specs: [{ type: "text", text: "你好世界\n漢字かな交じり文", width: 80 }] },
  },
  {
    name: "text-emoji",
    op: "build",
    args: { specs: [{ type: "text", text: "A😀B🧑🏽‍💻C🇺🇸D", width: 42 }] },
  },
  {
    name: "text-explicit-width",
    op: "build",
    args: { specs: [{ type: "text", text: "one two three four", width: 70 }] },
  },
  {
    name: "text-wrap-number-overrides-width",
    op: "build",
    args: { specs: [{ type: "text", text: "one two three four", width: 200, wrap: 45 }] },
  },
  {
    name: "text-wrap-false",
    op: "build",
    args: { specs: [{ type: "text", text: "one two three four", width: 20, wrap: false }] },
  },
  {
    name: "text-zero-width",
    op: "build",
    args: { specs: [{ type: "text", text: "zero width", width: 0 }] },
  },
  {
    name: "text-negative-width",
    op: "build",
    args: { specs: [{ type: "text", text: "negative width", width: -10 }] },
  },
  {
    name: "text-zero-wrap",
    op: "build",
    args: { specs: [{ type: "text", text: "zero wrap", wrap: 0 }] },
  },
  {
    name: "text-negative-wrap",
    op: "build",
    args: { specs: [{ type: "text", text: "negative wrap", wrap: -1 }] },
  },
  {
    name: "text-auto-resize-true",
    op: "build",
    args: { specs: [{ type: "text", text: "free", autoResize: true }] },
  },
  {
    name: "text-auto-resize-false",
    op: "build",
    args: { specs: [{ type: "text", text: "fixed", width: 100, autoResize: false }] },
  },
  {
    name: "text-explicit-auto-resize-survives",
    op: "build",
    args: { specs: [{ type: "text", text: "claimed fixed", width: 100, autoResize: true }] },
  },
  {
    name: "text-alignment-overrides",
    op: "build",
    args: {
      specs: [{ type: "text", text: "aligned", textAlign: "right", verticalAlign: "bottom" }],
    },
  },
  {
    name: "text-coercion",
    op: "build",
    args: { specs: [{ type: "text", text: null }, { type: "text", text: 123 }, { type: "text" }] },
  },
  {
    name: "text-font-families",
    op: "build",
    args: {
      specs: [1, 2, 3, 5, 6, 7, 8].map((fontFamily) => ({
        type: "text",
        text: "Agil 0123",
        fontFamily,
        width: 90,
      })),
    },
  },
  {
    name: "text-invalid-font-values",
    op: "build",
    args: {
      specs: [
        { type: "text", text: "bad family", fontFamily: "3" },
        { type: "text", text: "unknown family", fontFamily: 99 },
        { type: "text", text: "bad size", fontSize: "20" },
      ],
    },
  },
  {
    name: "measure-empty",
    op: "measure",
    args: { text: "", fontSize: 20 },
  },
  {
    name: "measure-null",
    op: "measure",
    args: { text: null, fontSize: 20, fontFamily: 5 },
  },
  {
    name: "measure-multiline",
    op: "measure",
    args: { text: "short\nmuch longer line\n", fontSize: 17.5, fontFamily: 5 },
  },
  {
    name: "measure-cjk-emoji",
    op: "measure",
    args: { text: "你好😀🧑🏽‍💻", fontSize: 24, fontFamily: 8 },
  },
  { name: "measure-font-1", op: "measure", args: { text: "Virgil width", fontSize: 20, fontFamily: 1 } },
  { name: "measure-font-2", op: "measure", args: { text: "Helvetica width", fontSize: 20, fontFamily: 2 } },
  { name: "measure-font-3", op: "measure", args: { text: "Cascadia width", fontSize: 20, fontFamily: 3 } },
  { name: "measure-font-5", op: "measure", args: { text: "Excalifont width", fontSize: 20, fontFamily: 5 } },
  { name: "measure-font-6", op: "measure", args: { text: "Nunito width", fontSize: 20, fontFamily: 6 } },
  { name: "measure-font-7", op: "measure", args: { text: "Lilita width", fontSize: 20, fontFamily: 7 } },
  { name: "measure-font-8", op: "measure", args: { text: "Comic width", fontSize: 20, fontFamily: 8 } },
  {
    name: "wrap-zero",
    op: "wrap",
    args: { text: "one two three", maxWidth: 0, fontSize: 20, fontFamily: 5 },
  },
  {
    name: "wrap-negative",
    op: "wrap",
    args: { text: "one two three", maxWidth: -1, fontSize: 20, fontFamily: 5 },
  },
  {
    name: "wrap-long-word",
    op: "wrap",
    args: { text: "abcdefghijklmnopqrstuvwxyz", maxWidth: 35.5, fontSize: 20, fontFamily: 3 },
  },
  {
    name: "wrap-cjk",
    op: "wrap",
    args: { text: "天地玄黄宇宙洪荒日月盈昃辰宿列张", maxWidth: 55, fontSize: 20, fontFamily: 5 },
  },
  {
    name: "wrap-emoji",
    op: "wrap",
    args: { text: "😀😃😄😁😆😅😂🤣", maxWidth: 45, fontSize: 20, fontFamily: 8 },
  },
  {
    name: "wrap-multiline",
    op: "wrap",
    args: { text: "one two three\n\nfour five six", maxWidth: 60, fontSize: 18, fontFamily: 2 },
  },
  {
    name: "wrap-tiny-width",
    op: "wrap",
    args: { text: "wide glyph", maxWidth: 1e-9, fontSize: 20, fontFamily: 5 },
  },
  { name: "ink-dark", op: "ink", args: { paper: "#121212" } },
  { name: "ink-light", op: "ink", args: { paper: "#ffffff" } },
  { name: "ink-short-black", op: "ink", args: { paper: "#000" } },
  { name: "ink-short-white", op: "ink", args: { paper: "#FFF" } },
  { name: "ink-invalid", op: "ink", args: { paper: "red" } },
  { name: "ink-null", op: "ink", args: { paper: null } },
  { name: "ink-dark-threshold", op: "ink", args: { paper: "#a0a0a0" } },
  { name: "ink-light-threshold", op: "ink", args: { paper: "#b0b0b0" } },
  {
    name: "polygon-defaults",
    op: "build",
    args: { specs: [{ type: "polygon" }] },
  },
  {
    name: "polygon-minimum-sides",
    op: "build",
    args: { specs: [{ type: "polygon", sides: -1 }] },
  },
  {
    name: "polygon-half-rounding",
    op: "build",
    args: { specs: [{ type: "polygon", sides: 6.5 }, { type: "polygon", sides: 2.5 }] },
  },
  {
    name: "polygon-radii-precedence",
    op: "build",
    args: {
      specs: [
        { type: "polygon", x: 10, y: 20, width: 100, height: 60, r: 30 },
        { type: "polygon", width: 100, height: 60, rx: 10, ry: 20 },
        { type: "polygon", r: 30, rx: 5, ry: 8 },
      ],
    },
  },
  {
    name: "polygon-zero-and-negative-radii",
    op: "build",
    args: {
      specs: [
        { type: "polygon", r: 0 },
        { type: "polygon", rx: -10, ry: -20 },
        { type: "polygon", cx: -1e-9, cy: 1e9, r: -0.5 },
      ],
    },
  },
  {
    name: "polygon-rotation-extremes",
    op: "build",
    args: { specs: [{ type: "polygon", rotation: 359.9 }, { type: "polygon", rotation: -0.5 }] },
  },
  {
    name: "polygon-cap-warning",
    op: "build",
    args: { specs: [{ type: "polygon", sides: 10001 }] },
  },
  {
    name: "polygon-at-cap",
    op: "build",
    args: { specs: [{ type: "polygon", sides: 10000 }] },
  },
  {
    name: "star-defaults",
    op: "build",
    args: { specs: [{ type: "star" }] },
  },
  {
    name: "star-half-rounding",
    op: "build",
    args: { specs: [{ type: "star", points: 4.5 }, { type: "star", points: 2.5 }] },
  },
  {
    name: "star-inner-radius",
    op: "build",
    args: {
      specs: [
        { type: "star", r: 50, innerR: 0 },
        { type: "star", r: 50, innerRatio: -0.5 },
        { type: "star", r: -20, innerR: 10, rotation: 359.9 },
      ],
    },
  },
  {
    name: "star-cap-warning",
    op: "build",
    args: { specs: [{ type: "star", points: 5001 }] },
  },
  {
    name: "star-at-cap",
    op: "build",
    args: { specs: [{ type: "star", points: 5000 }] },
  },
  {
    name: "arc-defaults",
    op: "build",
    args: { specs: [{ type: "arc" }] },
  },
  {
    name: "arc-closed",
    op: "build",
    args: { specs: [{ type: "arc", from: 30, to: 300, closed: true }] },
  },
  {
    name: "arc-reversed-and-negative-radii",
    op: "build",
    args: {
      specs: [
        { type: "arc", from: 180, to: -180, segments: 8 },
        { type: "arc", rx: -50, ry: 0, segments: 4 },
      ],
    },
  },
  {
    name: "arc-half-rounding",
    op: "build",
    args: { specs: [{ type: "arc", segments: 4.5 }, { type: "arc", segments: 0 }] },
  },
  {
    name: "arc-large-angle",
    op: "build",
    args: { specs: [{ type: "arc", from: -359.9, to: 359.9, segments: 12 }] },
  },
  {
    name: "arc-cap-warning",
    op: "build",
    args: { specs: [{ type: "arc", segments: 10001 }] },
  },
  {
    name: "capsule-defaults",
    op: "build",
    args: { specs: [{ type: "capsule" }] },
  },
  {
    name: "capsule-zero-and-negative-dimensions",
    op: "build",
    args: {
      specs: [
        { type: "capsule", width: 0, height: 0 },
        { type: "capsule", width: -10, height: 20 },
        { type: "capsule", width: 20, height: -10 },
      ],
    },
  },
  {
    name: "capsule-radius-clamp",
    op: "build",
    args: {
      specs: [
        { type: "capsule", width: 100, height: 40, radius: 1000 },
        { type: "capsule", width: 100, height: 40, radius: -5 },
        { type: "capsule", width: 100, height: 40, radius: 0 },
      ],
    },
  },
  {
    name: "capsule-half-rounding",
    op: "build",
    args: { specs: [{ type: "capsule", segments: 3.5 }, { type: "capsule", segments: 0 }] },
  },
  {
    name: "capsule-cap-warning",
    op: "build",
    args: { specs: [{ type: "capsule", segments: 2501 }] },
  },
  {
    name: "path-defaults",
    op: "build",
    args: { specs: [{ type: "path", points: [[0, 0], [20, 10], [40, 0], [60, 20]] }] },
  },
  {
    name: "path-smooth-false",
    op: "build",
    args: {
      specs: [{ type: "path", points: [[0, 0], [20, 10], [40, 0]], smooth: false }],
    },
  },
  {
    name: "path-open-and-closed",
    op: "build",
    args: {
      specs: [
        { type: "path", points: [[0, 0], [30, 0], [30, 30]], closed: false, resolution: 3 },
        { type: "path", points: [[0, 0], [30, 0], [30, 30]], closed: true, resolution: 3 },
        { type: "path", points: [[0, 0], [30, 0], [30, 30], [0, 0]], closed: true, resolution: 3 },
      ],
    },
  },
  {
    name: "path-short-inputs",
    op: "build",
    args: {
      specs: [
        { type: "path", points: [] },
        { type: "path", points: [[5, 6]] },
        { type: "path", points: [[5, 6], [10, 12]], smooth: false },
      ],
    },
  },
  {
    name: "path-object-points",
    op: "build",
    args: {
      specs: [{ type: "path", points: [{ x: 5, y: 6 }, { x: 20, y: 10 }, { x: 40, y: 0 }] }],
    },
  },
  {
    name: "path-half-rounding",
    op: "build",
    args: {
      specs: [
        { type: "path", points: [[0, 0], [20, 20]], resolution: 2.5 },
        { type: "path", points: [[0, 0], [20, 20]], resolution: 0 },
      ],
    },
  },
  {
    name: "path-cap-warning",
    op: "build",
    args: { specs: [{ type: "path", points: [[0, 0], [100, 100]], resolution: 10001 }] },
  },
  {
    name: "path-long-input-cap-warning",
    op: "build",
    args: {
      specs: [
        {
          type: "path",
          points: Array.from({ length: 6 }, (_, i) => [i * 10, i % 2 === 0 ? 0 : 20]),
          resolution: 5000,
        },
      ],
    },
  },
  {
    name: "line-absolute-points",
    op: "build",
    args: { specs: [{ type: "line", x: 7, y: 8, points: [[10, 20], [30, 40], [10, 50]] }] },
  },
  {
    name: "line-relative-object-points",
    op: "build",
    args: { specs: [{ type: "line", points: [{ x: 0, y: 0 }, { x: -20, y: 30 }] }] },
  },
  {
    name: "arrow-points-and-explicit-size",
    op: "build",
    args: {
      specs: [{ type: "arrow", points: [[5, 6], [25, 26]], width: 999, height: -1 }],
    },
  },
  {
    name: "freedraw-absolute-points",
    op: "build",
    args: {
      specs: [
        {
          type: "freedraw",
          x: 3,
          y: 4,
          points: [[10, 20], [15, 25], [20, 20]],
          pressures: [0.1, 0.5, 0.9],
          simulatePressure: false,
        },
      ],
    },
  },
  {
    name: "linear-short-points-fall-back",
    op: "build",
    args: {
      specs: [
        { type: "line", points: [[5, 6]], width: 20, height: 10 },
        { type: "arrow", points: [], width: -5, height: 0 },
        { type: "freedraw", points: null },
      ],
    },
  },
  {
    name: "resample-open",
    op: "resample",
    args: { points: [[0, 0], [100, 0], [100, 100]], step: 18 },
  },
  {
    name: "resample-closed",
    op: "resample",
    args: { points: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], step: 25 },
  },
  {
    name: "resample-short-and-degenerate",
    op: "resample",
    args: { points: [[0, 0], [1, 1]], step: 18 },
  },
  {
    name: "resample-zero-length",
    op: "resample",
    args: { points: [[1, 1], [1, 1], [1, 1]], step: 18 },
  },
  {
    name: "resample-invalid-points",
    op: "resample",
    args: { points: [[0, 0], null, [20, 0], ["bad", 2], [40, 0]], step: 10 },
  },
  {
    name: "resample-non-array",
    op: "resample",
    args: { points: null, step: 18 },
  },
  {
    name: "resample-zero-step",
    op: "resample",
    args: { points: [[0, 0], [10, 0], [20, 0]], step: 0 },
  },
  {
    name: "mirror-keep-vertical",
    op: "build",
    args: {
      specs: [{ type: "rectangle", x: 10, y: 20, width: 30, height: 40, mirror: { axis: "vertical", at: 100 } }],
    },
  },
  {
    name: "mirror-drop-horizontal",
    op: "build",
    args: {
      specs: [{ type: "rectangle", x: 10, y: 20, width: 30, height: 40, mirror: { axis: "horizontal", at: 100, keep: false } }],
    },
  },
  {
    name: "mirror-x-and-y-fallbacks",
    op: "build",
    args: {
      specs: [
        { type: "ellipse", x: 10, width: 20, mirror: { x: 50 } },
        { type: "diamond", y: 10, height: 20, mirror: { axis: "horizontal", y: 50 } },
      ],
    },
  },
  {
    name: "mirror-line-anchor",
    op: "build",
    args: {
      specs: [{ type: "line", x: 10, y: 20, points: [[0, 0], [30, 40]], mirror: { axis: "vertical", at: 100 } }],
    },
  },
  {
    name: "mirror-path",
    op: "build",
    args: {
      specs: [{ type: "path", points: [[10, 20], [30, 40]], smooth: false, mirror: { axis: "horizontal", at: 50 } }],
    },
  },
  {
    name: "mirror-arc-and-polygon",
    op: "build",
    args: {
      specs: [
        { type: "arc", from: 20, to: 120, mirror: { axis: "vertical", at: 0 } },
        { type: "polygon", rotation: 30, mirror: { axis: "horizontal", at: 0 } },
      ],
    },
  },
  {
    name: "mirror-angle-id-and-ref",
    op: "build",
    args: {
      specs: [{ type: "rectangle", id: "original", ref: "original", angle: 30, mirror: { at: 10 } }],
    },
  },
  {
    name: "repeat-grid",
    op: "build",
    args: {
      specs: [{ type: "rectangle", x: 5, y: 6, width: 10, height: 20, repeat: { count: 5, cols: 3, rows: 2, dx: 20, dy: 30 } }],
    },
  },
  {
    name: "repeat-grid-skew",
    op: "build",
    args: {
      specs: [{ type: "ellipse", repeat: { count: 6, cols: 2, dx: 10, dy: 20, rowDx: 5, colDy: -3 } }],
    },
  },
  {
    name: "repeat-grid-rounding-and-empty",
    op: "build",
    args: {
      specs: [
        { type: "diamond", repeat: { count: 2.5, cols: 1.5, rows: 1.5, dx: 10 } },
        { type: "rectangle", repeat: { count: 0 } },
        { type: "rectangle", repeat: { count: -1 } },
      ],
    },
  },
  {
    name: "repeat-around",
    op: "build",
    args: {
      specs: [{ type: "rectangle", x: 100, y: 0, width: 10, height: 20, repeat: { around: { cx: 0, cy: 0 }, count: 4, radius: 100 } }],
    },
  },
  {
    name: "repeat-around-rotate",
    op: "build",
    args: {
      specs: [{ type: "rectangle", cx: 50, cy: 0, width: 10, height: 20, angle: 10, repeat: { around: { x: 0, y: 0 }, count: 3, from: 10, to: 120, rotate: true } }],
    },
  },
  {
    name: "repeat-around-without-rotate",
    op: "build",
    args: {
      specs: [{ type: "star", cx: 50, cy: 0, r: 5, repeat: { around: { cx: 0, cy: 0 }, count: 3, rotate: false } }],
    },
  },
  {
    name: "repeat-around-single-and-negative-radius",
    op: "build",
    args: {
      specs: [
        { type: "ellipse", cx: 10, cy: 20, repeat: { around: { cx: 0, cy: 0 }, count: 1 } },
        { type: "ellipse", cx: 10, cy: 20, repeat: { around: { cx: 0, cy: 0 }, count: 2, radius: -30 } },
      ],
    },
  },
  {
    name: "repeat-ref-and-id",
    op: "build",
    args: {
      specs: [{ type: "rectangle", id: "first", ref: "row", repeat: { count: 3, dx: 50 } }],
    },
  },
  {
    name: "repeat-cap-warning",
    op: "build",
    args: { specs: [{ type: "rectangle", repeat: { count: 2001, dx: 1 } }] },
  },
  {
    name: "mirror-then-repeat",
    op: "build",
    args: {
      specs: [{ type: "rectangle", x: 10, width: 20, mirror: { at: 0 }, repeat: { count: 2, dx: 50 } }],
    },
  },
  {
    name: "arrow-bind-built-refs",
    op: "build",
    args: {
      specs: [
        { type: "arrow", start: "left", end: "right" },
        { type: "rectangle", ref: "left" },
        { type: "ellipse", ref: "right" },
      ],
    },
  },
  {
    name: "arrow-bind-built-object-refs",
    op: "build",
    args: {
      specs: [
        { type: "rectangle", ref: "left" },
        { type: "arrow", start: { ref: "left" }, end: { ref: "right" } },
        { type: "diamond", ref: "right" },
      ],
    },
  },
  {
    name: "arrow-bind-built-ids",
    op: "build",
    args: {
      specs: [
        { type: "rectangle", id: "left-id" },
        { type: "arrow", start: "left-id", end: { id: "right-id" } },
        { type: "ellipse", id: "right-id" },
      ],
    },
  },
  {
    name: "arrow-bind-existing-id",
    op: "build",
    args: {
      specs: [{ type: "arrow", start: "existing-box", end: "existing-ellipse" }],
      existing: bindingScene,
    },
  },
  {
    name: "arrow-bind-existing-object-id",
    op: "build",
    args: {
      specs: [{ type: "arrow", start: { id: "existing-box" }, end: { id: "existing-ellipse" } }],
      existing: bindingScene,
    },
  },
  {
    name: "arrow-bind-missing-targets",
    op: "build",
    args: {
      specs: [{ type: "arrow", start: "missing", end: { id: "also-missing" } }],
      existing: bindingScene,
    },
  },
  {
    name: "arrow-bind-deleted-existing",
    op: "build",
    args: { specs: [{ type: "arrow", start: "deleted-box" }], existing: bindingScene },
  },
  {
    name: "arrow-bind-duplicate-refs",
    op: "build",
    args: {
      specs: [
        { type: "rectangle", ref: "same" },
        { type: "ellipse", ref: "same" },
        { type: "arrow", start: "same", end: "same" },
      ],
    },
  },
  {
    name: "arrow-bind-self",
    op: "build",
    args: { specs: [{ type: "arrow", ref: "self", start: "self" }] },
  },
  {
    name: "arrow-bind-ref-before-id",
    op: "build",
    args: {
      specs: [
        { type: "rectangle", ref: "named", id: "first-id" },
        { type: "ellipse", id: "named" },
        { type: "arrow", start: { ref: "named", id: "named" } },
      ],
    },
  },
  {
    name: "index-after-positive-tail",
    op: "build",
    args: { specs: [{ type: "rectangle" }], existing: [{ id: "old", type: "line", index: "a0z" }] },
  },
  {
    name: "index-after-negative-tail",
    op: "build",
    args: { specs: [{ type: "rectangle" }], existing: [{ id: "old", type: "line", index: "Z1z" }] },
  },
  {
    name: "index-negative-overflow",
    op: "build",
    args: {
      specs: [{ type: "rectangle" }],
      existing: [{ id: "old", type: "line", index: "Z0" }],
    },
  },
  {
    name: "index-positive-head-carry",
    op: "build",
    args: { specs: [{ type: "rectangle" }], existing: [{ id: "old", type: "line", index: "az" }] },
  },
  {
    name: "index-mixed-scene",
    op: "build",
    args: { specs: [{ type: "rectangle" }, { type: "ellipse" }], existing: fractionalScene },
  },
  {
    name: "index-invalid-existing",
    op: "build",
    args: {
      specs: [{ type: "rectangle" }],
      existing: [{ id: "bad", type: "line", index: "0" }, { id: "none", type: "line" }],
    },
  },
  {
    name: "patch-text-auto-resize",
    op: "patch",
    args: { element: textScene[0], patch: { text: "a longer piece of text" } },
  },
  {
    name: "patch-width-wrap",
    op: "patch",
    args: { element: textScene[1], patch: { text: "one two three four five", width: 55 } },
  },
  {
    name: "patch-font",
    op: "patch",
    args: { element: textScene[1], patch: { text: "font change", fontSize: 28.5, fontFamily: 3 } },
  },
  {
    name: "patch-wrap-number",
    op: "patch",
    args: { element: textScene[0], patch: { text: "wrap me now", wrap: 40 } },
  },
  {
    name: "patch-wrap-false-on-fixed-text",
    op: "patch",
    args: { element: textScene[1], patch: { text: "still fixed width", wrap: false } },
  },
  {
    name: "patch-index-valid",
    op: "patch",
    args: { element: textScene[0], patch: { index: "b2z", x: 12.5 } },
  },
  {
    name: "patch-index-invalid-refused",
    op: "patch",
    args: { element: textScene[0], patch: { index: "not valid", x: 12.5 } },
  },
  {
    name: "patch-id-refused",
    op: "patch",
    args: { element: textScene[0], patch: { id: "replacement", x: 5 } },
  },
  {
    name: "patch-wrap-instruction-not-stored",
    op: "patch",
    args: { element: textScene[0], patch: { wrap: 25, custom: true } },
  },
  {
    name: "patch-non-text",
    op: "patch",
    args: { element: containerScene[0], patch: { text: "kept", width: 200, backgroundColor: "#00ff00" } },
  },
  {
    name: "grow-no-op-fits",
    op: "grow",
    args: { text: containerScene[1], container: containerScene[0] },
  },
  {
    name: "grow-no-op-mismatched-container",
    op: "grow",
    args: { text: containerScene[1], container: containerScene[2] },
  },
  {
    name: "grow-no-op-missing",
    op: "grow",
    args: { text: null, container: containerScene[0] },
  },
  {
    name: "grow-rectangle",
    op: "grow",
    args: {
      text: { ...containerScene[1], text: "one\ntwo\nthree", height: 75 },
      container: containerScene[0],
    },
  },
  {
    name: "grow-diamond",
    op: "grow",
    args: {
      text: { ...containerScene[1], containerId: "diamond", height: 75 },
      container: { ...containerScene[0], id: "diamond", type: "diamond" },
    },
  },
  {
    name: "grow-ellipse",
    op: "grow",
    args: {
      text: { ...containerScene[1], containerId: "ellipse", height: 75 },
      container: { ...containerScene[0], id: "ellipse", type: "ellipse" },
    },
  },
  {
    name: "update-text",
    op: "update",
    args: { elements: textScene, patches: [{ id: "auto-text", text: "updated text" }] },
  },
  {
    name: "update-container-growth",
    op: "update",
    args: {
      elements: containerScene,
      patches: [{ id: "label", text: "one\ntwo\nthree", width: 100 }],
    },
  },
  {
    name: "update-missing-ids",
    op: "update",
    args: {
      elements: textScene,
      patches: [{ id: "missing", x: 10 }, { id: "auto-text", x: 20 }, null, { x: 30 }],
    },
  },
  {
    name: "update-duplicate-ids-last-wins",
    op: "update",
    args: {
      elements: textScene,
      patches: [{ id: "auto-text", x: 10 }, { id: "auto-text", x: 20 }],
    },
  },
  {
    name: "update-empty",
    op: "update",
    args: { elements: textScene, patches: [] },
  },
  {
    name: "move-container-and-label",
    op: "move",
    args: { elements: containerScene, ids: ["box"], dx: 10, dy: -5 },
  },
  {
    name: "move-follow-end",
    op: "move",
    args: { elements: containerScene, ids: ["other"], dx: 30, dy: 10 },
  },
  {
    name: "move-follow-both-ends",
    op: "move",
    args: { elements: containerScene, ids: ["box", "other"], dx: 30, dy: 10 },
  },
  {
    name: "move-arrow-itself",
    op: "move",
    args: { elements: containerScene, ids: ["arrow"], dx: -20, dy: 2.5 },
  },
  {
    name: "move-group",
    op: "move",
    args: { elements: containerScene, groupIds: ["panel"], dx: 5, dy: 6 },
  },
  {
    name: "move-region-boundary",
    op: "move",
    args: {
      elements: containerScene,
      region: { x: 200, y: 20, width: 100, height: 60 },
      dx: 1,
      dy: 1,
    },
  },
  {
    name: "move-region-overlap",
    op: "move",
    args: {
      elements: containerScene,
      region: { x: 0, y: 0, width: 50, height: 50 },
      dx: -3.5,
      dy: 0.5,
    },
  },
  {
    name: "move-union-selectors",
    op: "move",
    args: {
      elements: containerScene,
      ids: ["arrow"],
      groupIds: ["panel"],
      region: { x: 200, y: 20, width: 100, height: 60 },
      dx: 2,
      dy: 3,
    },
  },
  {
    name: "move-missing-and-deleted",
    op: "move",
    args: { elements: containerScene, ids: ["missing", "deleted-box"], dx: 10, dy: 10 },
  },
  {
    name: "move-default-delta",
    op: "move",
    args: { elements: containerScene, ids: ["box"] },
  },
  {
    name: "delete-container-and-label",
    op: "delete",
    args: { elements: containerScene, ids: ["box"] },
  },
  {
    name: "delete-bound-target",
    op: "delete",
    args: { elements: containerScene, ids: ["other"] },
  },
  {
    name: "delete-label-only",
    op: "delete",
    args: { elements: containerScene, ids: ["label"] },
  },
  {
    name: "delete-arrow-only",
    op: "delete",
    args: { elements: containerScene, ids: ["arrow"] },
  },
  {
    name: "delete-container-targets-and-arrow",
    op: "delete",
    args: { elements: containerScene, ids: ["box", "other", "arrow"] },
  },
  {
    name: "delete-already-deleted-target",
    op: "delete",
    args: { elements: containerScene, ids: ["deleted-box"] },
  },
  {
    name: "delete-missing-and-empty",
    op: "delete",
    args: { elements: containerScene, ids: ["missing"] },
  },
  {
    name: "build-bind-to-existing-with-fractional-indices",
    op: "build",
    args: {
      specs: [
        { type: "arrow", start: "negative-tail", end: "positive-top" },
        { type: "rectangle", label: "new" },
      ],
      existing: fractionalScene,
    },
  },
];

const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

export function generatedCases(seed, count) {
  const random = mulberry32(seed);
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const pick = (values) => values[Math.floor(random() * values.length)];
  const maybe = (target, key, value, probability = 0.82) => {
    if (random() < probability) target[key] = value;
  };
  const numbers = [0, 1, -1, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.25, -0.25, 1e-9, -1e-9, 1e9, -1e9, 359.9, -359.9, 10.5];
  const counts = [0, 1, -1, 2.5, 3, 4, 5, 6, 7, 8, 12];
  const rotations = [0, 1, -1, 0.5, -0.5, 2.5, 359.9, -359.9, 180];
  const fonts = [1, 2, 3, 5, 6, 7, 8];
  const sizes = [0, 1, -1, 0.5, 2.5, 12, 20, 1e-9];
  const labels = ["", "label", "one two three four", "first\nsecond", "你好世界", "😀🧑🏽‍💻", "abcdefghijklmnopqrstuvwxyz", String(pick(numbers))];
  const output = [];

  for (let i = 0; i < total; i += 1) {
    const kind = i % 8;
    let spec;

    if (kind === 0) {
      spec = { type: "polygon" };
      maybe(spec, "sides", pick(counts));
      maybe(spec, "r", pick(numbers));
      maybe(spec, "rx", pick(numbers));
      maybe(spec, "ry", pick(numbers));
      maybe(spec, "cx", pick(numbers));
      maybe(spec, "cy", pick(numbers));
      maybe(spec, "rotation", pick(rotations));
    } else if (kind === 1) {
      spec = { type: "star" };
      maybe(spec, "points", pick(counts));
      maybe(spec, "r", pick(numbers));
      maybe(spec, "innerR", pick(numbers));
      maybe(spec, "innerRatio", pick(numbers));
      maybe(spec, "rotation", pick(rotations));
    } else if (kind === 2) {
      spec = { type: "arc" };
      maybe(spec, "from", pick(rotations));
      maybe(spec, "to", pick(rotations));
      maybe(spec, "segments", pick(counts));
      maybe(spec, "rx", pick(numbers));
      maybe(spec, "ry", pick(numbers));
      maybe(spec, "closed", random() < 0.5);
    } else if (kind === 3) {
      spec = { type: "capsule" };
      maybe(spec, "width", pick(numbers));
      maybe(spec, "height", pick(numbers));
      maybe(spec, "radius", pick(numbers));
      maybe(spec, "segments", pick(counts));
    } else if (kind === 4) {
      const pointCount = 2 + Math.floor(random() * 4);
      spec = {
        type: "path",
        points: Array.from({ length: pointCount }, () => {
          if (random() < 0.25) return { x: pick(numbers) };
          if (random() < 0.25) return [pick(numbers)];
          return { x: pick(numbers), y: pick(numbers) };
        }),
      };
      maybe(spec, "smooth", random() < 0.5, 0.9);
      maybe(spec, "closed", random() < 0.5);
      maybe(spec, "resolution", pick(counts));
    } else if (kind === 5) {
      spec = {
        type: pick(["rectangle", "ellipse", "diamond", "star", "path"]),
        repeat: { count: pick(counts) },
      };
      maybe(spec.repeat, "cols", pick(counts));
      maybe(spec.repeat, "rows", pick(counts));
      maybe(spec.repeat, "dx", pick(numbers));
      maybe(spec.repeat, "dy", pick(numbers));
      maybe(spec.repeat, "rowDx", pick(numbers));
      maybe(spec.repeat, "colDy", pick(numbers));
      if (spec.type === "path") spec.points = [[0, 0], [pick(numbers), pick(numbers)]];
    } else if (kind === 6) {
      spec = {
        type: pick(["rectangle", "ellipse", "star", "capsule"]),
        repeat: {
          count: pick(counts),
          around: random() < 0.5 ? { cx: pick(numbers), cy: pick(numbers) } : { x: pick(numbers), y: pick(numbers) },
        },
      };
      maybe(spec, "cx", pick(numbers));
      maybe(spec, "cy", pick(numbers));
      maybe(spec, "angle", pick(rotations));
      maybe(spec.repeat, "radius", pick(numbers));
      maybe(spec.repeat, "from", pick(rotations));
      maybe(spec.repeat, "to", pick(rotations));
      maybe(spec.repeat, "rotate", random() < 0.5);
    } else {
      const text = pick(labels);
      spec = random() < 0.5
        ? { type: pick(["rectangle", "ellipse", "diamond"]), label: random() < 0.5 ? text : { text } }
        : { type: "text", text };
      maybe(spec, "fontSize", pick(sizes));
      maybe(spec, "fontFamily", pick(fonts));
      maybe(spec, "width", pick(numbers));
      if (spec.type === "text") {
        maybe(spec, "wrap", random() < 0.5 ? pick(numbers) : false);
        maybe(spec, "autoResize", random() < 0.5);
      } else {
        maybe(spec, "height", pick(numbers));
        if (typeof spec.label === "object") {
          maybe(spec.label, "fontSize", pick(sizes));
          maybe(spec.label, "fontFamily", pick(fonts));
          maybe(spec.label, "wrap", pick(numbers));
        }
      }
    }

    maybe(spec, "x", pick(numbers));
    maybe(spec, "y", pick(numbers));
    maybe(spec, "strokeColor", pick(["#121212", "#ffffff", "#ff0000", "transparent"]));
    output.push({ name: `generated-${i}-${spec.type}`, op: "build", args: { specs: [spec] } });
  }

  return output;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  console.log(`hand-written cases: ${cases.length}`);
  console.log(`generated cases: ${generatedCases(1, 500).length}`);
}
