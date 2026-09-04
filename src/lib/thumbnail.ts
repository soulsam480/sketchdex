import { exportToSvg } from "@excalidraw/excalidraw";
import type { ScenePayload } from "./types";

/**
 * Renders a scene to an SVG string used as the card preview in the library.
 * The preview is shown through an <img>, which cannot reach the page's fonts,
 * so the fonts a scene uses are inlined into the SVG. That costs a few tens
 * of KB per preview in the vault's thumbs/ folder; without it every label
 * fell back to a serif and no card looked like its scene.
 */
export const renderThumbnail = async (
  payload: ScenePayload,
): Promise<string | null> => {
  const elements = payload.elements.filter((el: any) => !el.isDeleted);
  if (!elements.length) {
    return null;
  }
  try {
    const svg = await exportToSvg({
      elements: elements as any,
      appState: {
        ...payload.appState,
        exportBackground: true,
        exportWithDarkMode: false,
        viewBackgroundColor: payload.appState?.viewBackgroundColor ?? "#ffffff",
      },
      files: (payload.files ?? {}) as any,
      exportPadding: 24,
      skipInliningFonts: false,
    });
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return null;
  }
};

export const svgToDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
