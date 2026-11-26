# Element pipeline behavior specification

Source: required server files and `server/agent.js` call sites. JSON unless stated. Preserve array and JS key order.

## Exported surface

| Module | Export | Signature and result |
|---|---|---|
| elements | `newId()` | 21-character string. |
| elements | `indexFactory(existing = [])` | Zero-argument function returning index strings. |
| elements | `measureText(text, fontSize, fontFamily = 5)` | `{width, height}`. |
| elements | `labelMaxWidth(type, width)` | Number. |
| elements | `containerHeightFor(type, textHeight)` | Number. |
| elements | `wrapText(text, maxWidth, fontSize, fontFamily = 5)` | String. |
| elements | `buildElements(rawSpecs, {existing = [], ink = "#1e1e1e"} = {})` | `{elements, warnings, updated}`. |
| elements | `patchElement(element, patch)` | Shallow-copied element. |
| elements | `growContainerFor(text, container)` | Same container, or grown patched copy. |
| geometry | `pointBounds(points)` | `{minX, minY, maxX, maxY}`. |
| geometry | `expandSpecs(specs)` | `{specs, warnings}`. |
| geometry | `PRIMITIVE_TYPES` | `["polygon", "star", "arc", "capsule", "path"]`. |
| sketch | `resample(input, step = 18)` | Non-array input unchanged, else array. |
| sketch | `snapStrokeWidth(w)` | `1` if `w<1.5`, `2` if `w<3`, else `4`, including NaN. |
| sketch | `sketchLine(spec, {curved = true, step = 18, fill} = {})` | Shallow-copied spec. |
| sketch | `fillFor(fill, area)` | `fill ?? "solid"`, but non-solid with `area < 400` becomes solid. |
| paper | `luminance(color)` | Number, defaulting to `1`. |
| paper | `isDarkPaper(color)` | `luminance(color) < 0.4`. |
| paper | `inkFor(paper)` | `"#e9ecef"` if dark, else `"#1e1e1e"`. |
| paper | `paperOf(payload)` | `payload?.appState?.viewBackgroundColor ?? "#ffffff"`. |
| paper | `freshAppState(paper = "#121212")` | `{viewBackgroundColor: paper, currentItemStrokeColor: inkFor(paper)}`. |

Constants: `LINE_HEIGHT=1.25`, `BOUND_TEXT_PADDING=5`, `SKETCH_STEP=18`, `HACHURE_MIN_AREA=400`, `SKETCH_FILL="solid"`, `DARK_PAPER="#121212"`, `LIGHT_PAPER="#ffffff"`, `DEFAULT_PAPER=DARK_PAPER`, `INK_ON_DARK="#e9ecef"`, `INK_ON_LIGHT="#1e1e1e"`. `SUGARED_TYPES`: rectangle, ellipse, diamond, arrow, line, text, freedraw, frame.

## Shared JS semantics

| Case | Required behavior |
|---|---|
| `num(value, fallback)` | Accept only number values that are finite. No coercion. |
| `Math.round` | Ties toward positive infinity. `-1.5 -> -1`, `-0.5 -> -0`, `0.5 -> 1`, `2.5 -> 3`. Nim `round` differs. |
| `Math.max/min` | Propagate NaN. `max(-0,0)=+0`; `min(-0,0)=-0`. |
| `capped(value,max,what,warn)` | Return `value` when `value <= max`; otherwise warn and return `max`. NaN warns and caps. |
| Arithmetic | IEEE-754 binary64. Division by zero yields Infinity or NaN. Preserve `-0`; JSON emits `0`. |
| Randomness and time | `nonce=floor(random()*2**31)`. `updated` is epoch milliseconds. |
| `String(x)` | Strings unchanged; numbers use JS formatting, including `-0 -> "0"`, `NaN -> "NaN"`, and Infinity -> `"Infinity"`; booleans become `"true"` or `"false"`; null is `"null"`; undefined is `"undefined"`; plain objects are `"[object Object]"`. |
| `??` versus `||` | `??` falls back only for null or undefined. It preserves `0`, false, empty string, and NaN. `||` uses truthiness. |
| Strings | Split literally on `"\n"` or `" "`, preserving empty tokens. Iterate Unicode code points, not UTF-16 units or graphemes. `text ?? ""` replaces only null and undefined. |
| Objects | Spread shallowly copies own enumerable keys. Overwrites retain position; new keys append; integer-like keys sort first. `delete` removes a key. Undefined vanishes in JSON; non-finite numbers become null. |

## Construction

`base(spec,index,ink)` removes `ref`, `label`, `start`, `end`, and `wrap`, then shallow-copies. Defaults apply only to undefined, in order.

```text
id=newId(); x=0; y=0; width=100; height=100; angle=0;
strokeColor=ink; backgroundColor="transparent"; fillStyle="solid";
strokeWidth=2; strokeStyle="solid"; roughness=1; opacity=100;
groupIds=[]; frameId=null; roundness=defaultRoundness(spec.type);
seed=nonce(); version=1; versionNonce=nonce(); isDeleted=false;
boundElements=[]; updated=Date.now(); link=null; locked=false;
index=isIndex(spec.index) ? spec.index : index
```

All supplied fields survive, including null and unknown fields. Later stages override only what follows. Roundness defaults to `{type:3}` for rectangle and ellipse, `{type:2}` for diamond, arrow, and line, else null. `newId` maps each of 21 random bytes with `byte & 63` into `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_`.

```text
expandSpecs(rawSpecs) -> specs, geometryWarnings
nextIndex=indexFactory(existing); warnings=copy(geometryWarnings)
for each spec and parallel slot:
  reject null, non-object, or non-string type; warn; slot=null
  warn outside SUGARED_TYPES
  el=base(spec,nextIndex(),ink); complete type-specific fields
  handle frame name or ignored-label warning
  slot=el; append; register truthy ref
  shape with label: grow, build label, append immediately
resolveBindings(specs,slots,built,byRef,warnings,existing)
return {elements:built,warnings,updated}
```

A label is non-null and its object `text ?? ""` or primitive `String` is nonempty. False and zero count. A frame label sets `name` only when absent. A supplied name plus label warns. Non-shape labels warn and are ignored.

A shape label uses the label object, or `{text:String(label)}`. Parent font fields are defaults overridden by label fields. Stroke is `label.strokeColor ?? spec.strokeColor ?? ink`; opacity is `spec.opacity`. Force roundness null, centered coordinates, measured size, then text fields. Grow before placement. Append `{id:text.id,type:"text"}` to the shape's `boundElements`. Output the label immediately after its shape.

### Fractional indices

`DIGITS=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`. Heads `a..z` encode integer lengths `2..27`; `A..Z` encode `27..2`. Validity requires `^[A-Za-z][0-9A-Za-z]*$` and a complete integer prefix. Filter and sort existing valid indices lexicographically, then increment the largest integer prefix. Drop fractional tails. Carry widens lowercase heads and narrows uppercase heads. `Z` overflow returns `a0`; `z` overflow falls back to `a0`. First key is `a0`. Valid caller indices survive, even duplicates or lower keys.

## Text layout

Load metrics once; parse failure means `{}`. Keys are family ids `1,2,3,5,6,7,8,9`; each has `{name,mean,advance}` with 573 finite code-point advances.

Fallback weights: space `0.5`; ``iljtfrI|!.,;:'`()[]{}`` `0.45`; `mwMW@%` `1.45`; `ABCDEFGHJKLNOPQRSTUVXYZ` `1.1`; digits `1.0`; code points above `0x2e80` `2.0`; else `0.95`. Reference `the quick brown fox jumps over the lazy dog, 0123456789 THE QUICK` sums left to right to `54.35000000000001`; mean over 65 code points is `0.8361538461538462`.

`FONT_FACTOR={1:0.53,2:0.5,3:0.6,5:0.51,6:0.5,7:0.55,8:0.53}`; unknown uses `0.51`. With a family table, use measured advance; unmeasured code points above `0x2e80` use `1`, others family `mean`. Without a table, use `charWeight*(factor/referenceMean)`.

`lineWidth` sums advances left to right, then multiplies by font size. `measureText` splits `String(text ?? "")` on newline, takes the widest line, clamps width to `fontSize*0.5`, and returns height `lineCount*fontSize*1.25`.

`labelMaxWidth`: diamond `round(width/2)-10`; ellipse `round((width/2)*sqrt(2))-10`; else `width-10`. `containerHeightFor`: `h=ceil(textHeight)`; diamond `2*(h+10)`; ellipse `round(((h+10)/sqrt(2))*2)`; else `h+10`.

`wrapText` returns the original unless `maxWidth > 0`. Per newline paragraph and literal space token, fit `line ? line+" "+word : word` when width is `<= maxWidth`. Otherwise flush and split the word by code point. Before adding a glyph, flush a nonempty piece only when `(run+advance)*fontSize > maxWidth`. One oversized glyph remains alone. Flush every paragraph, including empty ones, and join with newline.

`textFields` returns `{text,originalText,fontSize,fontFamily,textAlign,verticalAlign,containerId,autoResize,lineHeight,measured}`. Fonts use `num`, defaulting to `20,5`. Wrap width is `max(labelMaxWidth(type,num(width,0)),fontSize)` for a container; otherwise numeric `wrap`, then numeric `width` unless `wrap===false`. Wrap only if truthy. Alignment defaults to center and middle for a truthy container id, else left and top. `autoResize=!containerId && !wrapWidth`; `lineHeight=1.25`. Truthy wrap width makes measured width `max(wrapWidth,measured.width)`. Omit `measured`.

Standalone text rewrites `text,originalText`; other fields only when absent. Size only when absent. Linear and freedraw elements normalize points, add the removed origin to `x,y`, and derive absent size from bounds. `lastCommittedPoint` defaults to the last point for freedraw, else null. Linear defaults are null bindings and arrowheads, except arrow end `"arrow"`, plus `elbowed:false`. Freedraw defaults are `pressures:[]` and `simulatePressure:true`.

`normalisePoints` accepts at least two pair arrays or `{x,y}` objects, mapping non-finite coordinates to `0`. Without a usable run, return `[[0,0],[num(width,100),num(height,0)]]`. Otherwise subtract the first point unless exactly `[0,0]`; return its offset as `dx,dy`.

## Geometry and macros

`pointBounds` loops with strict comparisons. NaN never updates a bound. If `minX` remains Infinity, return four zeroes. `TAU=Math.PI*2`; `rad(deg)=deg*Math.PI/180`.

`fromAbsolute` when closed appends the first point if endpoints differ exactly. Curved input is resampled first. Bounds give size; origin is the first point and stored points are relative. Drop `sides,cx,cy,r,rx,ry,innerR,innerRatio,rotation,from,to,segments,radius,smooth,closed,resolution`. Force `type:"line"`. Preserve supplied roundness, including null; otherwise use `{type:2}` when curved or `smooth` is truthy, else null.

| Primitive | Construction |
|---|---|
| polygon | `sides=cap(max(3,round(num(sides,6))),10000)`. `cx=num(cx,num(x,0)+num(width,100)/2)`; `cy` analogous. `rx=num(rx,num(r,num(width,100)/2))`; `ry=num(ry,num(r,num(height,num(width,100))/2))`. `turn=rad(num(rotation,-90))`; vertex `i` is at `turn+(i/sides)*TAU`. Close. |
| star | Count defaults `5`, minimum `3`, cap `5000`. Center as polygon. Outer defaults to half width; inner to `num(innerR,outer*num(innerRatio,0.45))`. `turn=rad(num(rotation,-90))`; vertex `i=0..2*count-1` uses outer when even, inner when odd, at `turn+(i/(2*count))*TAU`. Close. |
| arc | Center defaults `0,0`; radii to `r`, then `50`; angles to `from=0,to=180`. Steps default `abs(to-from)/4`, minimum `4`, cap `10000`. Emit `i=0..steps` at `rad(from+(to-from)*i/steps)`. Truthy `closed` appends center and closes. Always curve. |
| capsule | Defaults `x=0,y=0,width=100,height=60`. `r=min(num(radius,min(w,h)/2),min(w,h)/2)`. Steps default `8`, minimum `3`, cap `2500`. Emit `i=0..steps` at `rad(start+90*i/steps)` for center-start pairs `(x+w-r,y+r,-90)`, `(x+w-r,y+h-r,0)`, `(x+r,y+h-r,90)`, `(x+r,y+r,180)`. Close and curve. |
| path | Map points through `num`. Fewer than two uses the one point or `[[0,0],[1,1]]`, without Catmull-Rom or resampling. `smooth===false` keeps corners. Otherwise Catmull-Rom with clamped endpoints, modulo when closed. Resolution defaults `10`, minimum `2`, cap `max(2,floor(10000/spans))`. |

For each span emit `s=0..resolution-1`, `t=s/resolution`, `t2=t*t`, `t3=t2*t`:

```text
p=0.5*(2*p1+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t²
              +(-p0+3*p1-3*p2+p3)*t³)
```

Append the first output point when closed, else the last raw point. Curve and close as requested.

`expandSpecs` passes non-objects through. A typeless one-key entry unwraps to `{type:key,...inner}` when the key is a primitive, sugared type, or image and the value is a non-array object. Order is unwrap, mirror, repeat, primitive. Falsey `mirror` or `repeat` fields remain. Primitive exceptions warn.

Mirror defaults to vertical; `at=num(m.at ?? m.x ?? m.y,0)`. `keep===false` emits only the reflection. Anchored means line, arrow, or freedraw. For numeric `x`, vertical sets `x'=2*at-x-(anchored?0:num(width,0))`; horizontal sets `y'=2*at-y-(anchored?0:num(height,0))`. Numeric `cx,cy` reflect. Path points reflect absolutely; other points negate the relevant coordinate. Vertical maps numeric `from,to,rotation` to `180-value`; horizontal negates them. Negate numeric `angle`; delete `id` and `ref`.

Repeat count defaults `1`, minimum `1`, cap `2000`. Set `dx=num(r.dx,0)`, `dy=num(r.dy,0)`. Around mode uses center `num(r.around.cx ?? r.around.x,0),num(r.around.cy ?? r.around.y,0)`, anchor `num(base.cx,num(base.x,0)+num(base.width,0)/2)` and its `y` analogue, radius `num(r.radius,hypot(anchor-center))`, and start `atan2(anchorY-cy,anchorX-cx)`. `from=0`; `to=num(r.to,360-360/count+from)`. Copy `i` uses `a=count===1?start:start+rad(from+(to-from)*i/max(1,count-1))` and shifts by `(cx+cos(a)*radius-anchorX,cy+sin(a)*radius-anchorY)`. Truthy `rotate` sets `angle=num(base.angle,0)+a-start`. Grid uses `cols=max(1,round(num(r.cols,count)))`, `rows=max(1,round(num(r.rows,ceil(count/cols))))`, and row-major offset `(dx*col+num(r.rowDx,0)*row,dy*row+num(r.colDy,0)*col)`. Every copy loses `id`; only the first keeps `ref`.

`shift` adds offsets to numeric `x,y`, creating them for truthy offsets, and shifts numeric `cx,cy`. Only path points move. Line, arrow, and freedraw points are relative.

### Resampling and sketch style

`resample` filters points that are not arrays with two finite coordinates. Fewer than three returns them. Closed means more than two points with exactly equal endpoints. Sum `hypot` segments. Zero total returns points. `n=max(closed?6:2,round(total/step))`; if `n>=count-1`, return points. `target=total/n`.

Start with the first point. While `i<count` and output length is below `n`, measure from `prev`. If `acc+seg>=target`, interpolate at `t=seg===0?0:(target-acc)/seg`, append, set `prev` to it, reset `acc`, and retain `i`. Else add `seg` to `acc`, advance `prev`, and increment `i`. Append the exact last point unless the tail equals it.

`sketchLine` resamples when curved and sets `{type:2}` only for missing or null roundness. Non-curved sets null only for missing roundness. Default roughness is `1`. A truthy non-transparent background gets `fillFor(fill,(width??0)*(height??0))` when fill style is missing or `fill` is truthy.

Paper luminance trims and lowercases input, accepts `#rgb` or `#rrggbb`, and treats other input as light. Channels are hexadecimal divided by `255`; linearize with `c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)**2.4`; combine with weights `0.2126,0.7152,0.0722`.

## Bindings, patches, and agent loops

Resolve after building. Maps retain the last duplicate id or ref. Only truthy `start,end` are resolved. Strings try ref, built id, then live existing id. Objects try truthy `ref` only, else built or live existing id. Live existing means non-deleted and not shadowed by a built id. Set `{elementId:target.id,focus:0,gap:4}`. Built targets gain reverse entries directly. Existing targets become patched copies in `updated`; repeated arrows patch the latest copy. Missing targets warn.

`patchElement` shallow-copies and applies own enumerable keys in order. Ignore `id`, invalid `index`, and `wrap`. Assign other values, including undefined. Existing text re-layouts when `text`, `fontSize`, `fontFamily`, `width`, or `wrap` is not undefined. Fonts default with `??` to `20,5`. Original is `String(patch.text ?? element.originalText ?? element.text ?? "")`. Numeric patch wrap wins; otherwise non-auto-resize or bound text uses `patch.width ?? element.width`. Rewrite text and original, measure, replace width only when patch width is absent and unwrapped, and height when absent. Set `version=(element.version??1)+1`, fresh nonce, and timestamp. Null or undefined patch throws at the re-layout test.

`growContainerFor` returns the same object unless both inputs exist, ids match, and `containerHeightFor(type,text.height??0) > container.height??0`. Growth patches height.

| Operation | Behavior and result |
|---|---|
| update | Map patches or `ids` plus patch. Duplicate ids keep the last patch. Patch in scene order. Grow the first container of each touched bound text. Later growth for one container wins. Do not recenter `y`. Return `{updated:touchedCount,missing:insertionOrderedUntouchedIds}`. |
| move | `dx,dy` default to `0`. Select live ids, groups, or intersecting boxes. Add labels of selected containers. Selected elements patch `x+dx,y+dy`. A stationary arrow with at least two points follows each bound end that moved. Start-follow moves origin and subtracts the delta from later points. End-follow adds it to the last point. Patch point min and max size. Return `{moved,followed,missing,bounds}`; bounds is the rounded moved box or null. |
| delete | Soft-delete selected live elements with `isDeleted=true` and `version+1` only. Forward pass adds labels of doomed containers. Survivors null doomed bindings and filter doomed reverse entries, incrementing only version. Deleted elements stay unchanged. Return `{deleted:liveRemovedCount}`. |

Built reverse bindings keep versions. Existing reverse copies and edits use full bookkeeping. Delete only bumps version. Append paths replace existing elements with `updated` copies, then append built elements. Write and replace build without existing elements. Write uses default ink; replace uses scene ink. Create uses dark paper. Add and SVG import use existing elements and scene ink.

## Exact warnings

- `skipped an entry with no "type" field - every element is {"type": "path" | "rectangle" | ..., ...fields}: ${JSON.stringify(spec)?.slice(0, 80)}`
- `"${spec.type}" passed through without shape-specific defaults`
- `frame already has a name; its label was ignored`
- `label on a ${spec.type} was ignored: only rectangle, ellipse and diamond take a label (a frame's label becomes its name). Add a separate text element instead.`
- `arrow ${key} target not found: ${JSON.stringify(spec[key])}`
- `${what} ${value} capped at ${max}`
- `could not build ${copy.type}: ${err?.message ?? err}`

Cap labels: `polygon sides`, `star points`, `arc segments`, `capsule segments`, `path resolution`, `repeat count`. Warning order: geometry, construction, binding.

## Known JS traps

| Trap | Nim behavior |
|---|---|
| Missing, null, undefined | Keep distinct. Defaults react only to undefined. |
| Wrap truthiness | Zero and NaN disable wrapping and make standalone `autoResize` true. Negative and Infinity are truthy. |
| Text fonts | Layout may use fallback fonts while supplied nonnumeric font fields survive. |
| Coercion | Follow JS operators. Version addition can concatenate strings; area multiplication can concatenate first. |
| Signed zero | Preserve in arithmetic. JS equality treats `-0` and `0` alike. |
| Undefined output | Assigned undefined properties vanish from JSON. |
| Shallow copy | Nested values are shared in JS. Grow must still distinguish identity change. |
| Invalid patch | Null or undefined patch throws. |

## Float parity limits

Exact parity is not guaranteed for `sin`, `cos`, `atan2`, `hypot`, `sqrt(2)`, `pow(...,2.4)`, Catmull-Rom arithmetic, resampling interpolation, or text-width sums. V8 and platform libm can differ by one ulp, changing threshold wraps or resampling. Copied coordinates and integrals stay exact. Use relative tolerance `1e-9` for generated floats.
