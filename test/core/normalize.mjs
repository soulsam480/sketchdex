const ZERO_FIELDS = new Set(["seed", "versionNonce"]);
const ID_FIELDS = new Set(["id", "containerId", "frameId", "elementId"]);
const KEY_ORDER = ["id", "containerId", "startBinding", "endBinding", "boundElements", "frameId", "elementId"];
const WARNING_PREFIXES = [
  'skipped an entry with no "type" field',
  "could not build ",
];
const GENERATED_ID = /^[0-9A-Za-z_-]{21}$/;

const keyRank = (key) => {
  const rank = KEY_ORDER.indexOf(key);
  return rank === -1 ? KEY_ORDER.length : rank;
};

const compareKeys = (a, b) => keyRank(a) - keyRank(b) || (a < b ? -1 : a > b ? 1 : 0);

const childPath = (path, key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
  ? `${path}.${key}`
  : `${path}[${JSON.stringify(key)}]`;

const isCollectedId = (value, key) =>
  typeof value === "string" && (ID_FIELDS.has(key) || key === "boundElements");

const isReferenceId = (value, key) =>
  typeof value === "string" && (
    ID_FIELDS.has(key) ||
    key === "boundElements" ||
    key === "startBinding" ||
    key === "endBinding"
  );

const walk = (value, visit, key = null, path = "$", context = {}) => {
  visit(value, key, path, context);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, key, `${path}[${index}]`, context));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const childKey of Object.keys(value).sort(compareKeys)) {
    walk(value[childKey], visit, childKey, childPath(path, childKey), {
      boundEntry: context.boundEntry || childKey === "boundElements",
      bindingEntry: context.bindingEntry || childKey === "startBinding" || childKey === "endBinding",
    });
  }
};

const referenceError = (path, id) => {
  const error = new ReferenceError(`unknown id ${JSON.stringify(id)}`);
  error.path = path;
  return error;
};

const assertReferences = (value, inputIds) => {
  const definitions = new Set();
  const references = [];
  walk(value, (current, key, path, context) => {
    if (!isReferenceId(current, key)) return;
    if (key === "id" && !context.boundEntry && !context.bindingEntry) definitions.add(current);
    else references.push({ id: current, path });
  });
  for (const reference of references) {
    if (!inputIds.has(reference.id) && !definitions.has(reference.id)) {
      throw referenceError(reference.path, reference.id);
    }
  }
};

export function collectIds(value) {
  const ids = new Set();
  walk(value, (current, key) => {
    if (isCollectedId(current, key)) ids.add(current);
  });
  return ids;
}

export function normalize(value, { inputIds } = {}) {
  const knownIds = new Set(inputIds ?? []);
  assertReferences(value, knownIds);
  const ids = new Map();
  const remapId = (id) => {
    if (typeof id !== "string" || knownIds.has(id)) return id;
    if (!ids.has(id)) ids.set(id, `GEN_${ids.size}`);
    return ids.get(id);
  };

  const visit = (current, key) => {
    if (Array.isArray(current)) return current.map((item) => visit(item, key));
    if (current === null || typeof current !== "object") {
      return isReferenceId(current, key) ? remapId(current) : current;
    }
    const output = {};
    for (const childKey of Object.keys(current).sort(compareKeys)) {
      const child = current[childKey];
      output[childKey] = ZERO_FIELDS.has(childKey) ? 0 : visit(child, childKey);
    }
    return output;
  };

  return visit(value, null);
}

export function assertVolatile(value, { inputIds } = {}) {
  const knownIds = new Set(inputIds ?? []);
  const generatedIds = new Set();
  walk(value, (current, key, path, context) => {
    if (ZERO_FIELDS.has(key) && !(Number.isInteger(current) && current >= 0 && current < 2 ** 31)) {
      throw new Error(`${path}: ${key} must be an integer in [0, 2^31)`);
    }
    if (!isReferenceId(current, key) || knownIds.has(current)) return;
    if (!GENERATED_ID.test(current)) {
      throw new Error(`${path}: generated id must match ${GENERATED_ID}`);
    }
    if (key === "id" && !context.boundEntry && !context.bindingEntry) {
      if (generatedIds.has(current)) throw new Error(`${path}: duplicate generated id ${JSON.stringify(current)}`);
      generatedIds.add(current);
    }
  });
  return value;
}

const divergence = (path, reason) => ({ equal: false, path, reason });

const warningPrefix = (value) => WARNING_PREFIXES.find((prefix) => value.startsWith(prefix));

export function compare(a, b, { inputIds } = {}) {
  let left;
  let right;
  try {
    left = normalize(a, { inputIds });
  } catch (error) {
    if (error instanceof ReferenceError) {
      return divergence(error.path ?? "$", `reference error: ${error.message}`);
    }
    throw error;
  }
  try {
    right = normalize(b, { inputIds });
  } catch (error) {
    if (error instanceof ReferenceError) {
      return divergence(error.path ?? "$", `reference error: ${error.message}`);
    }
    throw error;
  }

  const visit = (actual, expected, path, inWarnings) => {
    const warnings = inWarnings || path.split(".").at(-1) === "warnings";

    if (typeof actual !== typeof expected) {
      return divergence(path, `type mismatch: ${typeof actual} vs ${typeof expected}`);
    }
    if (actual === null || expected === null) {
      return actual === expected ? null : divergence(path, `null mismatch: ${String(actual)} vs ${String(expected)}`);
    }
    if (typeof actual === "number") {
      if (Number.isInteger(actual) && Number.isInteger(expected)) {
        return actual === expected ? null : divergence(path, `number mismatch: ${actual} vs ${expected}`);
      }
      const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
      // The absolute floor covers cancellation from large around or offset coordinates. Two ten-millionths of a pixel is below scene precision.
      return Math.abs(actual - expected) <= 1e-8 * scale + 2e-7
        ? null
        : divergence(path, `number mismatch: ${actual} vs ${expected}`);
    }
    if (typeof actual === "string" || typeof actual === "boolean") {
      if (warnings) {
        const actualPrefix = warningPrefix(actual);
        const expectedPrefix = warningPrefix(expected);
        if (actualPrefix && expectedPrefix) {
          return actualPrefix === expectedPrefix ? null : divergence(path, "warning prefix mismatch");
        }
      }
      return actual === expected ? null : divergence(path, `value mismatch: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
    }
    if (Array.isArray(actual) || Array.isArray(expected)) {
      if (!Array.isArray(actual) || !Array.isArray(expected)) {
        return divergence(path, "array mismatch");
      }
      if (actual.length !== expected.length) {
        return divergence(`${path}[${Math.min(actual.length, expected.length)}]`, `array length mismatch: ${actual.length} vs ${expected.length}`);
      }
      for (let i = 0; i < actual.length; i += 1) {
        const result = visit(actual[i], expected[i], `${path}[${i}]`, warnings);
        if (result) return result;
      }
      return null;
    }
    if (typeof actual === "object" && typeof expected === "object") {
      const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort(compareKeys);
      for (const key of keys) {
        const nextPath = childPath(path, key);
        if (!Object.hasOwn(actual, key)) return divergence(nextPath, "missing key in actual");
        if (!Object.hasOwn(expected, key)) return divergence(nextPath, "missing key in expected");
        const result = visit(actual[key], expected[key], nextPath, warnings || key === "warnings");
        if (result) return result;
      }
      return null;
    }
    return actual === expected ? null : divergence(path, `value mismatch: ${String(actual)} vs ${String(expected)}`);
  };

  return visit(left, right, "$", false) ?? { equal: true, path: null, reason: null };
}
