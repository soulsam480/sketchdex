# Using an installed library item

An installed item is data in `library.excalidrawlib`. Placing it is a scene write.
The two operations share no state: the store is read, the clone is pure, and the
scene is saved through the same `mutate` path as every other write.

## Placement

```mermaid
sequenceDiagram
    participant A as Agent
    participant T as Tool surface
    participant S as LibraryStore
    participant C as cloneElementsForInsert
    participant M as mutate
    participant V as Vault

    A->>T: insert_library_item(scene, item, x, y, label)
    T->>S: findItem(item)
    S-->>T: stored item
    T->>M: apply with the current payload
    M->>V: read scene and snapshot with label
    M->>C: clone stored elements against payload elements
    C-->>M: elements, idMap, warnings
    M->>M: append clones after existing elements
    M->>V: conditional save with ifRev retry
    V-->>A: sceneId, name, itemId, added, ids, idMap, bounds, warnings
```

## Remap

```mermaid
flowchart TD
    A[Stored item elements] --> B[Validate: array of objects, string type, finite x/y]
    B --> C[Assign fresh ids, seeds, versions, indices]
    C --> D[Build one group map and one id map for the whole item]
    D --> E[Remap groupIds, containerId, frameId, boundElements and bindings]
    E --> F{Reference points inside the item?}
    F -- yes --> G[Use the mapped id]
    F -- no --> H[Null the binding or drop the boundElements entry, warn]
    G --> I[Translate x and y from the item top-left to targetX and targetY]
    H --> I
    I --> J[Copy every other field verbatim, including customData]
```

Validation raises `ValueError`. Ambiguous item lookup raises a 400 with candidate
ids and names. An unknown item raises a 404. A second insert clones again, so it
never reuses the ids of the first. The library file is never written by a read or
an insert.
