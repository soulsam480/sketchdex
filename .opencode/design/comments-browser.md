# Comments browser

The comments aside has two levels. The scene-wide list is the default. A row opens the existing per-element thread. Back returns to the list with the filter intact. Nothing draws on the canvas, and no server operation was added.

## Panel states

```mermaid
stateDiagram-v2
    [*] --> closed
    closed --> list: Comments button or popover All comments
    closed --> commentMode: pencil button
    list --> detail: row click
    detail --> list: Back or Esc
    list --> closed: Close or Esc
    list --> commentMode: pencil button
    detail --> commentMode: pencil button
    commentMode --> commentMode: Esc closes the popover first
    commentMode --> closed: Esc with no popover
```

The panel and comment mode are mutually exclusive. Esc in detail goes back first. Esc in the list closes the panel. The comment-mode Esc listener belongs to Editor and unmounts with the panel.

## Row click

```mermaid
sequenceDiagram
    actor User
    participant List as CommentThreadList
    participant Editor
    participant Canvas as Excalidraw API
    participant Aside as Comments detail
    User->>List: click row
    List->>Editor: onSelectThread elementId
    Editor->>Canvas: getSceneElements find live element
    Editor->>Aside: view detail, element describeElement
    Editor->>Canvas: scrollToContent fitToViewport zoom 0.5 animate
    Canvas-->>User: target framed, selection unchanged
    Aside-->>User: rows for the element plus composer
```

Selection is deliberately untouched. Excalidraw reports a selection change through `onChange`, which clears the panel target and would tear down the detail that just opened.

## Data

`buildThreads` groups flat `comment-list` records by element id. The newest record by createdAt, with id as tiebreak, carries the row. Threads sort open before resolved, then newest first, then element id. `filterThreads` applies status then a case-insensitive query over body and name. `threadCounts` feeds the toolbar.

Rows come only from `comment-list`. The server already skips comments on deleted elements. There are no replies, so a thread is just a group of comments on one element.

## Entry points

| Action | Result |
| --- | --- |
| Header Comments button | Opens the list and marks the button active |
| Popover All comments | Opens the list, leaving comment mode |
| Header pencil button | Toggles comment mode and closes panel and popover |
| Aside pencil button | Leaves the panel for comment mode |
| Row click | Frames the element and opens its thread |
