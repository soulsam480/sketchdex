import { exportToSvg } from "@excalidraw/excalidraw";
import type { ScenePayload } from "./types";

/**
 * Renders a scene to an inline SVG string used as the card preview in the
 * library. Fonts are skipped so the files in the vault's thumbs/ folder stay
 * small.
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
      skipInliningFonts: true,
    });
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return null;
  }
};

export const svgToDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
