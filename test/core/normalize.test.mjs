import test from "node:test";
import assert from "node:assert/strict";
import { assertVolatile, collectIds, compare, normalize } from "./normalize.mjs";
import { assertSuppliedVolatile } from "./differential.mjs";

const generatedId = "a".repeat(21);

test("input ids stay exact while output-only ids become GEN ids", () => {
  const inputIds = new Set(["box", "label"]);
  const value = {
    elements: [
      { id: "box", containerId: null, boundElements: [{ id: "label", type: "text" }] },
      { id: "label", containerId: "box" },
      { id: "generated-only" },
    ],
  };

  assert.deepEqual(normalize(value, { inputIds }), {
    elements: [
      { id: "box", containerId: null, boundElements: [{ id: "label", type: "text" }] },
      { id: "label", containerId: "box" },
      { id: "GEN_0" },
    ],
  });
});

test("generated ids are remapped by first-seen traversal order", () => {
  const value = {
    elements: [
      { id: "g2", containerId: "g1", boundElements: ["g3"] },
      { id: "g1" },
      { id: "g3" },
    ],
  };
  const reordered = {
    elements: [
      { boundElements: ["g3"], containerId: "g1", id: "g2" },
      { id: "g1" },
      { id: "g3" },
    ],
  };
  const expected = {
    elements: [
      { id: "GEN_0", containerId: "GEN_1", boundElements: ["GEN_2"] },
      { id: "GEN_1" },
      { id: "GEN_2" },
    ],
  };

  assert.deepEqual(normalize(value), expected);
  assert.deepEqual(normalize(reordered), expected);
});

test("an output-only dangling reference is a reference error", () => {
  const value = { elements: [{ id: "known", containerId: "ghost" }] };

  assert.throws(() => normalize(value), ReferenceError);
  assert.deepEqual(compare(value, value), {
    equal: false,
    path: "$.elements[0].containerId",
    reason: 'reference error: unknown id "ghost"',
  });
});

test("updated is compared exactly", () => {
  assert.equal(compare({ updated: 10 }, { updated: 11 }).equal, false);
  assert.equal(compare({ updated: 10 }, { updated: 10 }).equal, true);
});

test("volatile ranges and generated ids are checked without enforcing updated", () => {
  const now = 1234;
  const valid = { id: generatedId, updated: now, seed: 0, versionNonce: 2 ** 31 - 1 };

  assert.doesNotThrow(() => assertVolatile(valid, { now }));
  assert.doesNotThrow(() => assertVolatile({ ...valid, updated: 13 }, { now }));
  assert.doesNotThrow(() => assertVolatile({ ...valid, updated: now + 1 }, { now }));
  assert.doesNotThrow(() => assertVolatile({ elements: [], warnings: [], updated: [] }, { now }));
  assert.throws(() => assertVolatile({ ...valid, seed: -1 }, { now }));
  assert.throws(() => assertVolatile({ ...valid, seed: 2 ** 31 }, { now }));
  assert.throws(() => assertVolatile({ ...valid, seed: 1.5 }, { now }));
  assert.throws(() => assertVolatile({ ...valid, versionNonce: -1 }, { now }));
  assert.throws(() => assertVolatile({ ...valid, versionNonce: 2 ** 31 }, { now }));
  assert.throws(() => assertVolatile({ ...valid, versionNonce: 1.5 }, { now }));
  assert.throws(() => assertVolatile({ ...valid, id: "short" }, { now }));
  assert.throws(() => assertVolatile({ ...valid, id: `${generatedId}!` }, { now }));
  assert.throws(() => assertVolatile({ elements: [{ id: generatedId }, { id: generatedId }] }, { now }));
  assert.doesNotThrow(() => assertVolatile({ id: "input-id" }, { now, inputIds: new Set(["input-id"]) }));
});

test("warning prefixes ignore only their payloads", () => {
  const skippedA = 'skipped an entry with no "type" field: null';
  const skippedB = 'skipped an entry with no "type" field: {"x":1}';
  const buildA = "could not build polygon: first";
  const buildB = "could not build polygon: second";

  assert.equal(compare({ warnings: [skippedA] }, { warnings: [skippedB] }).equal, true);
  assert.equal(compare({ warnings: [buildA] }, { warnings: [buildB] }).equal, true);
  assert.equal(compare({ warnings: [skippedA] }, { warnings: [buildA] }).equal, false);
  assert.equal(compare({ warnings: ["first"] }, { warnings: ["second"] }).equal, false);
});

test("object key order is ignored", () => {
  assert.equal(compare({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }).equal, true);
});

test("collectIds returns input ids from definitions and references", () => {
  const args = {
    specs: [{ id: "new", containerId: "box", frameId: "frame", start: { id: "arrow-target" } }],
    existing: [{ id: "box", boundElements: [{ id: "label" }, "loose-id"] }],
  };

  assert.deepEqual(collectIds(args), new Set(["new", "box", "frame", "arrow-target", "label", "loose-id"]));
});

test("supplied volatile fields without a string id fail the case", () => {
  const testCase = {
    name: "id-less-volatile",
    op: "build",
    args: { specs: [{ type: "rectangle", seed: 7 }] },
  };
  const output = { elements: [{ id: "generated-id", seed: 7 }] };

  assert.throws(() => assertSuppliedVolatile(testCase, output, output), {
    message: "id-less-volatile: specs[0] has supplied seed but no string id",
  });
});

test("supplied volatile fields on identified objects stay exact", () => {
  const testCase = {
    name: "identified-volatile",
    op: "build",
    args: { specs: [{ type: "rectangle", id: "box", seed: 7, versionNonce: 11, updated: 13 }] },
  };
  const output = { elements: [{ id: "box", seed: 7, versionNonce: 11, updated: 13 }] };

  assert.doesNotThrow(() => assertSuppliedVolatile(testCase, output, output));
  assert.throws(
    () => assertSuppliedVolatile(testCase, output, { elements: [{ ...output.elements[0], seed: 8 }] }),
    /identified-volatile: Nim changed supplied seed for id "box"/,
  );
});

test("integral numbers stay exact and non-integers use combined tolerance", () => {
  assert.equal(compare({ value: 2 }, { value: 1 }).equal, false);
  assert.equal(compare({ value: 1 }, { value: 1 + 5e-9 }).equal, true);
  assert.equal(compare({ value: 1 }, { value: 1 + 3e-7 }).equal, false);
  assert.equal(compare({ value: 0.5 }, { value: 0.50000005 }).equal, true);
  assert.equal(compare({ value: 0.5 }, { value: 0.50000025 }).equal, false);
  assert.equal(
    compare({ value: -92.8542001247406 }, { value: -92.85420000553131 }).equal,
    true,
  );
  assert.equal(
    compare({ value: 10.50000011920929 }, { value: 10.49999999535743 }).equal,
    true,
  );
  assert.equal(
    compare({ value: -0.49999988079071045 }, { value: -0.5000000046425708 }).equal,
    true,
  );
});
