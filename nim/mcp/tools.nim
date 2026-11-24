import std/[json, strutils, tables]

type
  ToolOperation* = enum
    opListScenes
    opDescribeScene
    opReadElements
    opSearchElements
    opReadScene
    opCreateScene
    opAddElements
    opUpdateElements
    opDeleteElements
    opMoveElements
    opReplaceScene
    opSetBackground
    opRenderScene
    opImportSvg
    opCheckScene
    opSketchdexInfo
    opSketchdexDocs
    opSnapshotScene
    opListHistory
    opRestoreSnapshot
    opAddComment
    opListComments
    opUpdateComment
    opBrowseLibraries
    opInstallLibrary
    opListLibrary

const
  INSTRUCTIONS* = "Sketchdex draws on the user's Excalidraw canvases; scenes are real .excalidraw files, every write is snapshotted, and `label` is required on every write. Everything must look HAND-DRAWN - it is Excalidraw: roughness 1, sparse confident strokes, flat solid colour (no shading, no cross-hatch texture), hand-drawn font, colours exactly as written (never inverted), dark paper by default. To draw anything that has to look like something - a character, object, illustration - write it as ONE SVG and call import_svg; never assemble a figure from shapes. Use add_elements for diagrams, text, boxes, arrows and detail strokes. describe_scene before you draw, search_elements when you need one shape by name or note, browse_libraries when the person asks for an icon set or a symbol you would otherwise draw by hand, render_scene after, and fix what looks wrong. For anything about setup - installing on a client, where scenes are stored, the app, what rendering needs, or an error - call sketchdex_docs before guessing."
  LabelRequiredNote = ". `label` is what the user reads in the history sidebar when deciding whether to keep this change, so describe what you are doing, e.g. 'add the dog illustration'."

let
  TOOLS* = parseJson("""[
  {
    "name": "list_scenes",
    "description": "Every scene in the vault with its id, name, element count and last-edited time. Start here.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "browse_libraries",
    "description": "Search the official Excalidraw library catalog by name, description or author. Returns ids to pass to install_library. Use this instead of drawing an icon set by hand.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Words from the library name, description or author. Empty lists the newest."
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 20)."
        }
      }
    }
  },
  {
    "name": "install_library",
    "description": "Install a library into the vault so its items appear in the app's library panel. Pass an id from browse_libraries, or a direct .excalidrawlib URL. Installing the same library twice adds nothing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "library": {
          "type": "string",
          "description": "A catalog id from browse_libraries, or an https URL ending in .excalidrawlib."
        }
      },
      "required": [
        "library"
      ]
    }
  },
  {
    "name": "list_library",
    "description": "What is installed in the vault's library: item ids, names and element counts.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "describe_scene",
    "description": "What is on a scene, as structure rather than pixels: counts by type, overall bounds, and a rounded summary of each element with its id, position, size, text and bindings. Cheaper than read_scene and usually enough to plan an edit.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "type": {
          "type": "string",
          "description": "Only elements of this type."
        },
        "limit": {
          "type": "number",
          "description": "Max elements to list (default 400)."
        }
      },
      "required": [
        "scene"
      ]
    }
  },
  {
    "name": "read_elements",
    "description": "Full, unabridged elements, filtered down to the ones you need. Use this when you already have the ids or a region; search_elements is the way to find them by text, id or comment.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "ids": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "type": {
          "type": "string"
        },
        "contains": {
          "type": "string",
          "description": "Only elements whose text contains this."
        },
        "region": {
          "type": "object",
          "description": "Only elements overlapping this box.",
          "properties": {
            "x": {
              "type": "number"
            },
            "y": {
              "type": "number"
            },
            "width": {
              "type": "number"
            },
            "height": {
              "type": "number"
            }
          }
        },
        "limit": {
          "type": "number",
          "description": "Default 100."
        }
      },
      "required": [
        "scene"
      ]
    }
  },
  {
    "name": "search_elements",
    "description": "Find elements without reading the scene: matches element text, ids and comment bodies, case-insensitively, and every word in the query must appear. A hit on a bound label reports the shape the label belongs to. Answers compact summaries ranked by match quality, each with the snippet that matched; full: true returns the raw elements. Use this instead of describe_scene or read_elements when you know what you are looking for.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "query": {
          "type": "string",
          "description": "Words to look for in element text, ids or comments."
        },
        "type": {
          "type": "string",
          "description": "Only elements of this type."
        },
        "limit": {
          "type": "number",
          "description": "Max results (default 20)."
        },
        "full": {
          "type": "boolean",
          "description": "Return the raw elements instead of summaries."
        }
      },
      "required": [
        "scene",
        "query"
      ]
    }
  },
  {
    "name": "read_scene",
    "description": "The whole scene exactly as stored, plus the path to the .excalidraw file on disk. Large scenes run to thousands of elements, so prefer describe_scene or read_elements unless you genuinely need everything. The path is there for edits no tool here covers - take a snapshot first if you use it.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "includeFiles": {
          "type": "boolean",
          "description": "Include the embedded image map. Off by default: it is base64 and usually megabytes."
        }
      },
      "required": [
        "scene"
      ]
    }
  },
  {
    "name": "create_scene",
    "description": "Make a new scene, optionally with its starting elements.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "elements": {
          "type": "array",
          "description": "Excalidraw elements. Any field of a real element is honoured verbatim; what\nyou omit gets a valid default (id, index, seed, version are generated).\n\nUSE THIS FOR diagrams, layout, text, boxes, arrows, and detail strokes on top\nof something already drawn. For anything that has to LOOK LIKE something - a\ncharacter, creature, object, vehicle, logo, illustration - do NOT assemble it\nfrom shapes here. Write it as one SVG and call import_svg. Shapes stacked by\nhand come out as a pile of parts (fat, seamed, toy-like) every time; one SVG\ncomes out as one drawing.\n\nTypes: rectangle ellipse diamond arrow line text freedraw frame.\nFields: x y width height angle, strokeColor, backgroundColor (the fill),\nfillStyle solid|hachure|cross-hatch, strokeWidth 1|2|4, strokeStyle,\nroughness 0|1|2, opacity, roundness, fontSize, fontFamily (5 hand-drawn),\ntextAlign, groupIds, points [[0,0],[dx,dy],...] relative. y points down.\nTEXT WRAPS: give a text element a `width` and prose is wrapped to it with\nthe real font metrics (height follows); no width = one line per \\n, sized\nexactly. Never break long paragraphs by hand.\n\nTHE LOOK IS HAND-DRAWN. This is Excalidraw. roughness 1 (default) on\neverything; native rectangle/ellipse/arrow rather than 4-point lines; sparse\npoints with roundness {type:2} for a curve (dense points look furry, not\nsketchy); hand-drawn font. Detail is a few extra strokes, never more parts.\n\nCOLOUR IS FLAT. Solid fills, one colour per part, and the wobbly outline\ndoes the rest - that is the Excalidraw look. Do not shade: no hachure or\ncross-hatch as texture, no gradients faked with stacked shapes, no drop\nshadows. If a part must read as darker, give it a darker solid hex. Reserve\nhachure/cross-hatch for something that IS hatched (a cutaway, a glass pane).\n\nPAPER AND INK. Nothing is inverted for display: every hex shows exactly as\nwritten. New scenes are dark paper (#121212). Anything drawn without a\nstrokeColor gets ink that contrasts with the paper (#e9ecef on dark, #1e1e1e\non light); describe_scene reports `background` and `ink`. Any hex is fine -\ncharacter colours are character colours on any paper.\n\nSHORTHAND. label on a shape adds centred bound text; ref names an element\nand start/end on an arrow bind to it. Generated geometry is an element whose\ntype is polygon|star|arc|capsule|path, e.g.\n  {\"type\":\"path\",\"points\":[[0,0],[40,30],[90,10]],\"closed\":true}  smooth curve through the points\n  polygon {sides,cx,cy,r}  star {points,cx,cy,r,innerRatio}  arc {cx,cy,r,from,to}  capsule {x,y,width,height,radius}\nrepeat {count,dx,dy | cols,rows | around:{cx,cy}} and mirror {axis:'vertical',at}\nmultiply one spec evenly. These are for furniture - rings, plates, arrays -\nnot for bodies.",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      }
    }
  },
  {
    "name": "add_elements",
    "description": "Append elements to a scene, leaving everything already there untouched. The usual way to draw something new.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "elements": {
          "type": "array",
          "description": "Excalidraw elements. Any field of a real element is honoured verbatim; what\nyou omit gets a valid default (id, index, seed, version are generated).\n\nUSE THIS FOR diagrams, layout, text, boxes, arrows, and detail strokes on top\nof something already drawn. For anything that has to LOOK LIKE something - a\ncharacter, creature, object, vehicle, logo, illustration - do NOT assemble it\nfrom shapes here. Write it as one SVG and call import_svg. Shapes stacked by\nhand come out as a pile of parts (fat, seamed, toy-like) every time; one SVG\ncomes out as one drawing.\n\nTypes: rectangle ellipse diamond arrow line text freedraw frame.\nFields: x y width height angle, strokeColor, backgroundColor (the fill),\nfillStyle solid|hachure|cross-hatch, strokeWidth 1|2|4, strokeStyle,\nroughness 0|1|2, opacity, roundness, fontSize, fontFamily (5 hand-drawn),\ntextAlign, groupIds, points [[0,0],[dx,dy],...] relative. y points down.\nTEXT WRAPS: give a text element a `width` and prose is wrapped to it with\nthe real font metrics (height follows); no width = one line per \\n, sized\nexactly. Never break long paragraphs by hand.\n\nTHE LOOK IS HAND-DRAWN. This is Excalidraw. roughness 1 (default) on\neverything; native rectangle/ellipse/arrow rather than 4-point lines; sparse\npoints with roundness {type:2} for a curve (dense points look furry, not\nsketchy); hand-drawn font. Detail is a few extra strokes, never more parts.\n\nCOLOUR IS FLAT. Solid fills, one colour per part, and the wobbly outline\ndoes the rest - that is the Excalidraw look. Do not shade: no hachure or\ncross-hatch as texture, no gradients faked with stacked shapes, no drop\nshadows. If a part must read as darker, give it a darker solid hex. Reserve\nhachure/cross-hatch for something that IS hatched (a cutaway, a glass pane).\n\nPAPER AND INK. Nothing is inverted for display: every hex shows exactly as\nwritten. New scenes are dark paper (#121212). Anything drawn without a\nstrokeColor gets ink that contrasts with the paper (#e9ecef on dark, #1e1e1e\non light); describe_scene reports `background` and `ink`. Any hex is fine -\ncharacter colours are character colours on any paper.\n\nSHORTHAND. label on a shape adds centred bound text; ref names an element\nand start/end on an arrow bind to it. Generated geometry is an element whose\ntype is polygon|star|arc|capsule|path, e.g.\n  {\"type\":\"path\",\"points\":[[0,0],[40,30],[90,10]],\"closed\":true}  smooth curve through the points\n  polygon {sides,cx,cy,r}  star {points,cx,cy,r,innerRatio}  arc {cx,cy,r,from,to}  capsule {x,y,width,height,radius}\nrepeat {count,dx,dy | cols,rows | around:{cx,cy}} and mirror {axis:'vertical',at}\nmultiply one spec evenly. These are for furniture - rings, plates, arrays -\nnot for bodies.",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "label": {
          "type": "string",
          "description": "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it."
        }
      },
      "required": [
        "scene",
        "elements",
        "label"
      ]
    }
  },
  {
    "name": "update_elements",
    "description": "Change named fields on existing elements. Send only what changes - {id, x: 40} moves one box and leaves its other 25 fields alone. Pass a list in `elements`, each carrying its `id`, or use `ids` + `patch` to apply one change across many.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "elements": {
          "type": "array",
          "description": "Partial elements, each with an `id` and the fields to change.",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "ids": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "patch": {
          "type": "object",
          "additionalProperties": true
        },
        "label": {
          "type": "string",
          "description": "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it."
        }
      },
      "required": [
        "scene",
        "label"
      ]
    }
  },
  {
    "name": "delete_elements",
    "description": "Remove elements by id.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "ids": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "label": {
          "type": "string",
          "description": "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it."
        }
      },
      "required": [
        "scene",
        "ids",
        "label"
      ]
    }
  },
  {
    "name": "move_elements",
    "description": "Shift a set of elements by dx, dy in one write, keeping everything else about them. Select by ids, groupIds (an import_svg piece), a region box, or any mix. A container's label always moves with it, and an arrow bound to something that moves keeps that end attached (include the arrow itself to move it whole). Returns the new bounds of what moved.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "ids": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "groupIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "region": {
          "type": "object",
          "description": "Everything overlapping this box moves.",
          "properties": {
            "x": {
              "type": "number"
            },
            "y": {
              "type": "number"
            },
            "width": {
              "type": "number"
            },
            "height": {
              "type": "number"
            }
          }
        },
        "dx": {
          "type": "number",
          "description": "Scene px to the right (negative = left)."
        },
        "dy": {
          "type": "number",
          "description": "Scene px down (negative = up)."
        },
        "label": {
          "type": "string",
          "description": "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it."
        }
      },
      "required": [
        "scene",
        "label"
      ]
    }
  },
  {
    "name": "replace_scene",
    "description": "Replace a scene's entire contents. Destructive by design - the previous state is snapshotted, but prefer add_elements or update_elements when you only mean to change part of it.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "elements": {
          "type": "array",
          "description": "Excalidraw elements. Any field of a real element is honoured verbatim; what\nyou omit gets a valid default (id, index, seed, version are generated).\n\nUSE THIS FOR diagrams, layout, text, boxes, arrows, and detail strokes on top\nof something already drawn. For anything that has to LOOK LIKE something - a\ncharacter, creature, object, vehicle, logo, illustration - do NOT assemble it\nfrom shapes here. Write it as one SVG and call import_svg. Shapes stacked by\nhand come out as a pile of parts (fat, seamed, toy-like) every time; one SVG\ncomes out as one drawing.\n\nTypes: rectangle ellipse diamond arrow line text freedraw frame.\nFields: x y width height angle, strokeColor, backgroundColor (the fill),\nfillStyle solid|hachure|cross-hatch, strokeWidth 1|2|4, strokeStyle,\nroughness 0|1|2, opacity, roundness, fontSize, fontFamily (5 hand-drawn),\ntextAlign, groupIds, points [[0,0],[dx,dy],...] relative. y points down.\nTEXT WRAPS: give a text element a `width` and prose is wrapped to it with\nthe real font metrics (height follows); no width = one line per \\n, sized\nexactly. Never break long paragraphs by hand.\n\nTHE LOOK IS HAND-DRAWN. This is Excalidraw. roughness 1 (default) on\neverything; native rectangle/ellipse/arrow rather than 4-point lines; sparse\npoints with roundness {type:2} for a curve (dense points look furry, not\nsketchy); hand-drawn font. Detail is a few extra strokes, never more parts.\n\nCOLOUR IS FLAT. Solid fills, one colour per part, and the wobbly outline\ndoes the rest - that is the Excalidraw look. Do not shade: no hachure or\ncross-hatch as texture, no gradients faked with stacked shapes, no drop\nshadows. If a part must read as darker, give it a darker solid hex. Reserve\nhachure/cross-hatch for something that IS hatched (a cutaway, a glass pane).\n\nPAPER AND INK. Nothing is inverted for display: every hex shows exactly as\nwritten. New scenes are dark paper (#121212). Anything drawn without a\nstrokeColor gets ink that contrasts with the paper (#e9ecef on dark, #1e1e1e\non light); describe_scene reports `background` and `ink`. Any hex is fine -\ncharacter colours are character colours on any paper.\n\nSHORTHAND. label on a shape adds centred bound text; ref names an element\nand start/end on an arrow bind to it. Generated geometry is an element whose\ntype is polygon|star|arc|capsule|path, e.g.\n  {\"type\":\"path\",\"points\":[[0,0],[40,30],[90,10]],\"closed\":true}  smooth curve through the points\n  polygon {sides,cx,cy,r}  star {points,cx,cy,r,innerRatio}  arc {cx,cy,r,from,to}  capsule {x,y,width,height,radius}\nrepeat {count,dx,dy | cols,rows | around:{cx,cy}} and mirror {axis:'vertical',at}\nmultiply one spec evenly. These are for furniture - rings, plates, arrays -\nnot for bodies.",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "label": {
          "type": "string",
          "description": "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it."
        }
      },
      "required": [
        "scene",
        "elements",
        "label"
      ]
    }
  },
  {
    "name": "set_background",
    "description": "Set the paper: the scene's real background colour, shown exactly as given (never inverted). The default pen for hand drawing follows it, so the next stroke in the app is visible. Elements already drawn keep their colours - recolour their ink yourself if you flip a scene from light to dark or back. New scenes start on dark paper (#121212).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "color": {
          "type": "string"
        },
        "label": {
          "type": "string",
          "description": "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it."
        }
      },
      "required": [
        "scene",
        "color",
        "label"
      ]
    }
  },
  {
    "name": "render_scene",
    "description": "A PNG of the scene as it actually renders, so you can look at what you drew. Use it to check your own work - proportions, overlaps, whether the thing reads as the thing. Always written to a file as well as returned. A tall or wide page (long edge more than about twice the short one, and too big to fit at the asked size) comes back as a few tiles cut along its length, each with the scene box it shows, so a whole board is readable in one call; a `region` renders just that box, which is the way to look closely at one part. When an image is too big to travel inline you get a downscaled preview plus the file path.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "scale": {
          "type": "number",
          "description": "Pixel density, 1-3. Default 1."
        },
        "maxWidth": {
          "type": "number",
          "description": "Cap the long edge in pixels. Default 1400. Above ~1200 the result is a file path instead of an inline image."
        },
        "region": {
          "type": "object",
          "description": "Render only what overlaps this box, in scene coordinates. Take the numbers from describe_scene's `bounds`.",
          "properties": {
            "x": {
              "type": "number"
            },
            "y": {
              "type": "number"
            },
            "width": {
              "type": "number"
            },
            "height": {
              "type": "number"
            }
          },
          "required": [
            "x",
            "y",
            "width",
            "height"
          ]
        },
        "ids": {
          "type": "array",
          "description": "Render only these elements.",
          "items": {
            "type": "string"
          }
        },
        "transparent": {
          "type": "boolean",
          "description": "Leave the paper out of the PNG (alpha background). For dropping a sketch onto a slide or a page."
        },
        "tiles": {
          "type": "number",
          "description": "Split the picture into this many tiles along its long axis (max 8). Default: chosen from the shape of the scene, 1 for anything roughly square. Pass 1 to force a single image."
        }
      },
      "required": [
        "scene"
      ]
    }
  },
  {
    "name": "import_svg",
    "description": "Draw by writing SVG. THE way to draw anything that has to look like\nsomething: a character, creature, object, vehicle, logo, illustration.\nThis is what produces good figures; stacking shapes with add_elements does\nnot.\n\nThe result is hand-drawn, not pasted: every path becomes a real editable\nExcalidraw element (grouped as one piece), curves are re-spaced to\nhand-sized strokes and drawn with the sketchy pen, <circle>/<ellipse>/<rect>\nbecome native shapes. Write the SVG for SHAPE, PROPORTION and COLOUR and let\nthe canvas supply the pen - do not fake wobble or hatching in the SVG.\n\nA recipe that works for a figure:\n  * viewBox about 300 x 600 for a standing figure; import at width 350-450.\n  * ONE closed path per body region - torso, each leg, each arm - tapered\n    like a real limb (forearm ~60% of the upper arm, calf into a narrow\n    ankle), plus head, hands, feet. Let them overlap; later paths draw on\n    top. Then detail as separate strokes OVER the silhouette: plates, seams,\n    webbing, a knee line. A few, not many.\n  * Every shape: fill=<vibrant, character-accurate hex> stroke=<the scene\n    ink from describe_scene, or a deep shade of the fill> stroke-width 2 to\n    2.5. Filled shapes with no stroke read as flat.\n  * Flat colour, no shading. One solid fill per part; a darker part is a\n    darker hex, not a hatched overlay or a shadow shape. The sketchy\n    outline carries the drawing - texture on top of it looks overworked.\n  * Proportion from a rule: 7-8 heads tall for heroic, 5-6 for stylised.\n    Head first, derive the rest.\n  * Then render_scene and LOOK; fix what is off. The first pass is usually\n    mis-proportioned, the second is right.\n\nSupported: path (all commands), rect, circle, ellipse, line, polyline,\npolygon, g, transform, <style>/class, <use>/<defs>, presentation attributes,\ntext. viewBox honoured exactly. Gradients flatten to their first stop; pass\nholeColor to punch compound-path holes.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "svg": {
          "type": "string",
          "description": "Complete SVG markup, including the <svg> element and its viewBox."
        },
        "x": {
          "type": "number",
          "description": "Where to place it on the canvas. Default 0."
        },
        "y": {
          "type": "number",
          "description": "Default 0."
        },
        "width": {
          "type": "number",
          "description": "Scale the artwork to this width, keeping its aspect ratio. Height follows."
        },
        "height": {
          "type": "number",
          "description": "Optional bound on height."
        },
        "tolerance": {
          "type": "number",
          "description": "Curve flattening, in source units. Default 3. Lower is smoother and heavier."
        },
        "style": {
          "type": "string",
          "enum": [
            "sketch",
            "precise"
          ],
          "description": "sketch (default): hand-drawn treatment - anchors re-spaced, curves as curves, roughness 1, native circles/rects. precise: every flattened vertex kept, roughness 0 - for a logo or a drawing that must be exact."
        },
        "fillStyle": {
          "type": "string",
          "enum": [
            "hachure",
            "cross-hatch",
            "solid"
          ],
          "description": "Fill for every filled shape. Default solid. hachure for a lighter, sketchier piece (small shapes stay solid); cross-hatch for weight."
        },
        "roughness": {
          "type": "number",
          "description": "0 precise, 1 sketchy (default in sketch mode), 2 very sketchy."
        },
        "step": {
          "type": "number",
          "description": "Anchor spacing for curves in sketch mode, in canvas px. Default 18. Lower keeps more of the source curve; higher is looser."
        },
        "holeColor": {
          "type": "string",
          "description": "Backdrop colour used to punch compound-path holes."
        },
        "group": {
          "type": "boolean",
          "description": "Group the result as one unit. Default true."
        },
        "label": {
          "type": "string",
          "description": "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it."
        }
      },
      "required": [
        "scene",
        "svg",
        "label"
      ]
    }
  },
  {
    "name": "check_scene",
    "description": "Find layout problems by geometry instead of by looking: text hidden behind a filled shape drawn after it, captions running past the panel they sit in, labels too tall for their container, zero-size elements, broken arrow bindings, strays parked far off, exact duplicates. Each finding carries the element ids, so the fix is one update_elements call. Run it after a batch of drawing - it is far cheaper than a render and catches what a render would only show you if you looked closely.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "limit": {
          "type": "number",
          "description": "Max findings (default 60)."
        }
      },
      "required": [
        "scene"
      ]
    }
  },
  {
    "name": "sketchdex_info",
    "description": "Version of this server, where it is running from, which vault it is using, and how long this process has been alive. Use it to confirm you are talking to the build you think you are.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "sketchdex_docs",
    "description": "The manual, for answering the user's questions and fixing problems without guessing: install on any client, where scenes are stored and how to move the vault, the library app, what rendering needs, every tool, the drawing contract, and troubleshooting for the errors that come up. No topic returns the index.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "topic": {
          "type": "string",
          "enum": [
            "install",
            "vault",
            "app",
            "rendering",
            "tools",
            "drawing",
            "troubleshooting",
            "all"
          ],
          "description": "One of: install, vault, app, rendering, tools, drawing, troubleshooting. Omit for the index; `all` for the whole manual."
        }
      }
    }
  },
  {
    "name": "snapshot_scene",
    "description": "Stash the current state without changing anything, so it can be restored from the history sidebar. Do this before editing a .excalidraw file directly with your own file tools - every other tool here snapshots on its own.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "label": {
          "type": "string",
          "description": "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it."
        }
      },
      "required": [
        "scene",
        "label"
      ]
    }
  },
  {
    "name": "list_history",
    "description": "Snapshots held for a scene, newest first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        }
      },
      "required": [
        "scene"
      ]
    }
  },
  {
    "name": "restore_snapshot",
    "description": "Put a snapshot back on the canvas. This is itself snapshotted, so reverting a revert is possible.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "snapshot": {
          "type": "string"
        }
      },
      "required": [
        "scene",
        "snapshot"
      ]
    }
  },
  {
    "name": "add_comment",
    "description": "Attach a comment to one element. The comment lives on the element itself, so it travels with save, copy, duplicate, undo and history, and the write bumps only that element so a stale canvas save cannot erase it. Use it to leave a note about a shape for the person reading the scene.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "elementId": {
          "type": "string",
          "description": "The element the comment is about. From describe_scene or read_elements."
        },
        "body": {
          "type": "string",
          "description": "Plain text, up to 4000 characters."
        },
        "author": {
          "type": "string",
          "description": "Name shown on the comment. Defaults to Sketchdex agent."
        },
        "label": {
          "type": "string",
          "description": "Short description of this change for the history sidebar."
        }
      },
      "required": [
        "scene",
        "elementId",
        "body",
        "label"
      ]
    }
  },
  {
    "name": "list_comments",
    "description": "Comments on a scene or on one element, with open and resolved counts. Comment bodies are only here and in read_elements; describe_scene reports counts without the text.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "elementId": {
          "type": "string",
          "description": "Only this element. Omit for the whole scene."
        },
        "status": {
          "type": "string",
          "enum": [
            "open",
            "resolved"
          ],
          "description": "Only comments in this state. Omit for both."
        },
        "limit": {
          "type": "number",
          "description": "Max comments to return (default 500)."
        }
      },
      "required": [
        "scene"
      ]
    }
  },
  {
    "name": "update_comment",
    "description": "Resolve, reopen or delete one comment. Resolving and reopening are idempotent and answer changed: false when the comment is already in that state, so a retry is safe.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "scene": {
          "type": "string",
          "description": "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure."
        },
        "elementId": {
          "type": "string",
          "description": "The element the comment is attached to."
        },
        "commentId": {
          "type": "string",
          "description": "The cmt_ id from list_comments."
        },
        "action": {
          "type": "string",
          "enum": [
            "resolve",
            "reopen",
            "delete"
          ]
        },
        "label": {
          "type": "string",
          "description": "Short description of this change for the history sidebar."
        }
      },
      "required": [
        "scene",
        "elementId",
        "commentId",
        "action",
        "label"
      ]
    }
  }
]""")

const
  OPERATIONS* = {
    "list_scenes": opListScenes,
    "describe_scene": opDescribeScene,
    "read_elements": opReadElements,
    "search_elements": opSearchElements,
    "read_scene": opReadScene,
    "create_scene": opCreateScene,
    "add_elements": opAddElements,
    "update_elements": opUpdateElements,
    "delete_elements": opDeleteElements,
    "move_elements": opMoveElements,
    "replace_scene": opReplaceScene,
    "set_background": opSetBackground,
    "render_scene": opRenderScene,
    "import_svg": opImportSvg,
    "check_scene": opCheckScene,
    "sketchdex_info": opSketchdexInfo,
    "sketchdex_docs": opSketchdexDocs,
    "snapshot_scene": opSnapshotScene,
    "list_history": opListHistory,
    "restore_snapshot": opRestoreSnapshot,
    "add_comment": opAddComment,
    "list_comments": opListComments,
    "update_comment": opUpdateComment,
    "browse_libraries": opBrowseLibraries,
    "install_library": opInstallLibrary,
    "list_library": opListLibrary,
  }.toTable()

let requiredKeys* = block:
  var result = initTable[string, seq[string]]()
  for tool in TOOLS:
    var keys: seq[string]
    let schema = tool["inputSchema"]
    if schema.hasKey("required"):
      for key in schema["required"]:
        keys.add(key.getStr)
    result[tool["name"].getStr] = keys
  result

proc validateArgs*(toolName: string; args: JsonNode): string =
  let required = requiredKeys.getOrDefault(toolName)
  if required.len == 0: return ""

  let values = if args.isNil or args.kind == JNull: newJObject() else: args
  var missing: seq[string]
  for key in required:
    let value = if values.kind == JObject and values.hasKey(key): values[key] else: nil
    if value.isNil or (value.kind == JString and value.getStr.len == 0):
      missing.add(key)

  if missing.len == 0: return ""
  result = toolName & " is missing: " & missing.join(", ")
  if missing.contains("label"):
    result.add(LabelRequiredNote)
