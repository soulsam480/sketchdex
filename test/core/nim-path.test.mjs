import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const suffix = process.platform === "win32" ? ".exe" : "";
const corePath = join(root, "nim", "bin", `sketchdex-core${suffix}`);

try {
  accessSync(corePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
} catch {
  assert.fail(`Nim core binary not found or not executable at ${corePath}. Run npm run build:core first.`);
}

delete process.env.SKETCHDEX_CORE_BIN;
process.env.SKETCHDEX_CORE = "nim";

const [{ createAgentApi }, { buildElements, closeCore, CORE_BACKEND, CoreError }] = await Promise.all([
  import("../../server/agent.js"),
  import("../../server/core.js"),
]);

const vault = await mkdtemp(join(tmpdir(), "sketchdex-nim-path-"));

after(async () => {
  try {
    await closeCore();
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

async function readPersistedScene(api, sceneId) {
  const scene = await api.readScene(sceneId, { includeFiles: true });
  const stored = JSON.parse(await readFile(scene.path, "utf8"));
  assert.deepEqual(stored.elements, scene.elements, "stored elements match readScene");
  assert.deepEqual(stored.appState, scene.appState, "stored appState matches readScene");
  assert.deepEqual(stored.files, scene.files, "stored files match readScene");
  assert.equal(stored.name, scene.name, "stored name matches readScene");
  return scene;
}

const indexById = (elements) => new Map(elements.map((element) => [element.id, element]));

const requireElement = (elements, id) => {
  const element = elements.get(id);
  assert.ok(element, `missing element ${id}`);
  return element;
};

async function createSceneFixture(t, elements) {
  assert.equal(CORE_BACKEND, "nim");
  const vault = await mkdtemp(join(tmpdir(), "sketchdex-nim-path-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const api = createAgentApi(vault);
  const created = await api.createScene({ name: "Nim agent fixture", elements });
  await readPersistedScene(api, created.sceneId);
  await api.setBackground(created.sceneId, "#ffffff", { label: "set fixed paper" });
  const scene = await readPersistedScene(api, created.sceneId);
  return { api, sceneId: created.sceneId, scene };
}

async function assertCoreRejects(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CoreError, `expected CoreError, received ${error}`);
    assert.equal(error.code, "internal");
    assert.equal(error.message, message);
    return true;
  });
}

async function assertSceneUnchanged(api, sceneId, previous, revision) {
  const current = await readPersistedScene(api, sceneId);
  assert.deepEqual(current.elements, previous.elements, "failed mutation left elements unchanged");
  assert.deepEqual(current.appState, previous.appState, "failed mutation left appState unchanged");
  assert.deepEqual(current.files, previous.files, "failed mutation left files unchanged");
  assert.equal(await api.store.rev(sceneId), revision, "failed mutation did not save the scene");
}

test("Nim-backed agent path mutates, persists, and snapshots a scene", async () => {
  assert.equal(CORE_BACKEND, "nim");
  const api = createAgentApi(vault);
  const labels = {
    add: "add ellipse and arrow",
    update: "recolor rectangle and rewrap label",
    move: "move rectangle",
    delete: "delete rectangle",
  };

  const created = await api.createScene({
    name: "Nim agent path",
    elements: [
      {
        id: "rectangle",
        type: "rectangle",
        x: 20,
        y: 30,
        width: 140,
        height: 80,
        strokeColor: "#336699",
        label: "Box",
      },
    ],
  });
  const sceneId = created.sceneId;
  assert.equal(created.added, 2);
  assert.deepEqual(created.warnings, []);

  const afterCreate = await readPersistedScene(api, sceneId);
  assert.equal(afterCreate.elements.length, 2);
  assert.equal(afterCreate.elements[0].id, "rectangle");
  assert.equal(afterCreate.elements[1].type, "text");
  const createdById = indexById(afterCreate.elements);
  const rectangle = requireElement(createdById, "rectangle");
  const rectangleLabel = requireElement(createdById, afterCreate.elements[1].id);
  assert.equal(rectangleLabel.containerId, rectangle.id);
  assert.ok(
    rectangle.boundElements.some((bound) => bound.id === rectangleLabel.id && bound.type === "text"),
    "rectangle lists its label as bound text",
  );

  const added = await api.addElements(
    sceneId,
    [
      {
        id: "ellipse",
        type: "ellipse",
        x: 300,
        y: 30,
        width: 140,
        height: 80,
        strokeColor: "#993366",
        label: "Ellipse",
      },
      {
        id: "arrow",
        type: "arrow",
        x: 160,
        y: 70,
        width: 140,
        height: 0,
        strokeColor: "#664400",
        start: "rectangle",
        end: "ellipse",
      },
    ],
    { label: labels.add },
  );
  assert.equal(added.added, 3);
  assert.deepEqual(added.warnings, []);

  const afterAdd = await readPersistedScene(api, sceneId);
  assert.equal(afterAdd.elements.length, 5);
  const addedById = indexById(afterAdd.elements);
  const addedRectangle = requireElement(addedById, "rectangle");
  const ellipse = requireElement(addedById, "ellipse");
  const arrow = requireElement(addedById, "arrow");
  const ellipseLabel = afterAdd.elements.find((element) => element.containerId === ellipse.id);
  assert.ok(ellipseLabel, "ellipse has a bound label");
  assert.equal(arrow.startBinding?.elementId, addedRectangle.id);
  assert.equal(arrow.endBinding?.elementId, ellipse.id);
  for (const target of [addedRectangle, ellipse]) {
    assert.ok(
      target.boundElements.some((bound) => bound.id === arrow.id && bound.type === "arrow"),
      `${target.type} lists the arrow as a bound element`,
    );
  }

  const replacementText = "This label now wraps onto several lines";
  const updated = await api.updateElements(
    sceneId,
    [
      { id: "rectangle", strokeColor: "#cc3344" },
      { id: rectangleLabel.id, text: replacementText },
    ],
    { label: labels.update },
  );
  assert.equal(updated.updated, 2);
  assert.deepEqual(updated.missing, []);

  const afterUpdate = await readPersistedScene(api, sceneId);
  assert.equal(afterUpdate.elements.length, 5);
  const updatedById = indexById(afterUpdate.elements);
  const updatedRectangle = requireElement(updatedById, "rectangle");
  const updatedLabel = requireElement(updatedById, rectangleLabel.id);
  assert.equal(updatedRectangle.strokeColor, "#cc3344");
  assert.ok(updatedRectangle.version > addedRectangle.version, "rectangle version increased");
  assert.ok(updatedLabel.version > rectangleLabel.version, "label version increased");
  assert.equal(updatedLabel.originalText, replacementText);
  assert.notEqual(updatedLabel.text, replacementText);
  assert.match(updatedLabel.text, /\n/);
  assert.ok(updatedLabel.height > rectangleLabel.height, "wrapped label grew taller");
  assert.ok(updatedRectangle.height > addedRectangle.height, "rectangle grew to fit the label");

  const beforeMove = updatedById;
  const moved = await api.moveElements(
    sceneId,
    { ids: ["rectangle"], dx: 10, dy: 5, label: labels.move },
  );
  assert.equal(moved.moved, 2);
  assert.equal(moved.followed, 1);
  assert.deepEqual(moved.missing, []);

  const afterMove = await readPersistedScene(api, sceneId);
  assert.equal(afterMove.elements.length, 5);
  const movedById = indexById(afterMove.elements);
  const movedRectangle = requireElement(movedById, "rectangle");
  const movedLabel = requireElement(movedById, rectangleLabel.id);
  const movedArrow = requireElement(movedById, "arrow");
  const previousRectangle = requireElement(beforeMove, "rectangle");
  const previousLabel = requireElement(beforeMove, rectangleLabel.id);
  const previousArrow = requireElement(beforeMove, "arrow");
  assert.equal(movedRectangle.x, previousRectangle.x + 10);
  assert.equal(movedRectangle.y, previousRectangle.y + 5);
  assert.equal(movedLabel.x, previousLabel.x + 10);
  assert.equal(movedLabel.y, previousLabel.y + 5);
  assert.equal(movedArrow.x, previousArrow.x + 10);
  assert.equal(movedArrow.y, previousArrow.y + 5);
  assert.equal(movedArrow.startBinding?.elementId, "rectangle");
  assert.equal(movedArrow.endBinding?.elementId, "ellipse");

  const deleted = await api.deleteElements(sceneId, ["rectangle"], { label: labels.delete });
  assert.equal(deleted.deleted, 2);

  const finalScene = await readPersistedScene(api, sceneId);
  assert.equal(finalScene.elements.length, 5);
  const finalById = indexById(finalScene.elements);
  const deletedRectangle = requireElement(finalById, "rectangle");
  const deletedLabel = requireElement(finalById, rectangleLabel.id);
  const liveEllipse = requireElement(finalById, "ellipse");
  const liveEllipseLabel = requireElement(finalById, ellipseLabel.id);
  const liveArrow = requireElement(finalById, "arrow");
  assert.equal(deletedRectangle.isDeleted, true);
  assert.equal(deletedLabel.isDeleted, true);
  assert.equal(liveEllipse.isDeleted, false);
  assert.equal(liveEllipseLabel.isDeleted, false);
  assert.equal(liveArrow.isDeleted, false);
  assert.equal(liveArrow.startBinding, null);
  assert.equal(liveArrow.endBinding?.elementId, "ellipse");

  const history = await api.listHistory(sceneId);
  assert.deepEqual(
    history.entries.map((entry) => entry.label),
    [labels.delete, labels.move, labels.update, labels.add],
    "each agent mutation snapshots once with its supplied label",
  );
});

test("replaceElements stores the exact Nim build", async (t) => {
  const { api, sceneId, scene: before } = await createSceneFixture(t, [
    { id: "old-box", type: "rectangle", label: "Old" },
  ]);
  const now = 1700000000000;
  const specs = [
    {
      id: "replacement-box",
      type: "rectangle",
      x: 10,
      y: 20,
      width: 120,
      height: 60,
      strokeColor: "#336699",
      seed: 11,
      versionNonce: 12,
      updated: now,
      label: {
        id: "replacement-label",
        text: "Replacement",
        seed: 13,
        versionNonce: 14,
        updated: now,
      },
    },
    {
      id: "replacement-arrow",
      type: "arrow",
      x: 130,
      y: 50,
      width: 80,
      height: 0,
      points: [[0, 0], [80, 0]],
      strokeColor: "#664400",
      seed: 15,
      versionNonce: 16,
      updated: now,
    },
  ];
  const expected = await buildElements(specs, { existing: [], ink: "#1e1e1e" });

  const replaced = await api.replaceElements(sceneId, specs, { label: "replace scene" });

  assert.equal(replaced.total, 3);
  assert.deepEqual(replaced.warnings, []);
  const after = await readPersistedScene(api, sceneId);
  assert.deepEqual(after.elements, expected.elements, "replaceElements stores the Nim build exactly");
  assert.deepEqual(
    after.elements.map((element) => [element.id, element.type]),
    [["replacement-box", "rectangle"], ["replacement-label", "text"], ["replacement-arrow", "arrow"]],
  );
  assert.deepEqual(after.appState, before.appState);
  assert.deepEqual(after.files, before.files);
});

test("replaceElements rejects a non-array payload without saving", async (t) => {
  const { api, sceneId, scene: before } = await createSceneFixture(t, [
    { id: "old-box", type: "rectangle", label: "Old" },
  ]);
  const revision = await api.store.rev(sceneId);

  await assertCoreRejects(
    api.replaceElements(sceneId, {}, { label: "reject invalid replacement" }),
    "specs is not iterable",
  );
  await assertSceneUnchanged(api, sceneId, before, revision);
});

test("writeScene rejects non-array elements without saving", async (t) => {
  const { api, sceneId, scene: before } = await createSceneFixture(t, [
    { id: "old-box", type: "rectangle", label: "Old" },
  ]);
  const revision = await api.store.rev(sceneId);

  await assertCoreRejects(
    api.writeScene(sceneId, { elements: {}, label: "reject invalid write" }),
    "specs is not iterable",
  );
  await assertSceneUnchanged(api, sceneId, before, revision);
});

test("addElements does not save when the Nim build fails", async (t) => {
  const { api, sceneId, scene: before } = await createSceneFixture(t, [
    { id: "old-box", type: "rectangle", label: "Old" },
  ]);
  const revision = await api.store.rev(sceneId);

  await assertCoreRejects(
    api.addElements(
      sceneId,
      [{ type: "rectangle", label: "Broken", boundElements: {} }],
      { label: "reject malformed build" },
    ),
    "value is not iterable",
  );
  await assertSceneUnchanged(api, sceneId, before, revision);
});

test("importSvg adds grouped line elements from one path", async (t) => {
  const { api, sceneId, scene: before } = await createSceneFixture(t, [
    { id: "old-box", type: "rectangle", label: "Old" },
  ]);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><path d="M 0 0 L 40 20" fill="none" stroke="#336699"/></svg>';

  const imported = await api.importSvg(sceneId, svg, { label: "import one path" });

  assert.equal(imported.added, 1);
  assert.equal(imported.ids.length, 1);
  assert.match(imported.groupId, /^svg-/);
  assert.deepEqual(imported.warnings, []);
  const after = await readPersistedScene(api, sceneId);
  assert.equal(after.elements.length, before.elements.length + 1);
  const line = requireElement(indexById(after.elements), imported.ids[0]);
  assert.equal(line.type, "line");
  assert.deepEqual(line.groupIds, [imported.groupId]);
  assert.ok(line.points.length >= 2);

  const ungrouped = await api.importSvg(sceneId, svg, {
    label: "import one path without group",
    group: false,
  });

  assert.equal(ungrouped.added, 1);
  assert.equal(ungrouped.groupId, null);
  assert.deepEqual(ungrouped.warnings, []);
  const afterUngrouped = await readPersistedScene(api, sceneId);
  assert.equal(afterUngrouped.elements.length, after.elements.length + 1);
  const ungroupedLine = requireElement(indexById(afterUngrouped.elements), ungrouped.ids[0]);
  assert.equal(ungroupedLine.type, "line");
  assert.deepEqual(ungroupedLine.groupIds, []);
});
