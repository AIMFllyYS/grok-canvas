"use client";

import { createContext, useContext } from "react";
import type { CanvasLibraryAsset } from "@/lib/canvas-library";
import type { PromptReference } from "@/lib/prompt-references";
import type { VideoInputRole } from "@/lib/video-references";

export type ReferencePickerOptions = { role?: VideoInputRole; onSelect?: (reference: PromptReference) => boolean; onClose?: () => void };
export type CanvasAssetsActions = {
  assets: CanvasLibraryAsset[];
  addReferences: (nodeId: string, references: PromptReference[], role?: VideoInputRole, prompt?: string) => boolean;
  referenceError: (nodeId: string, references: PromptReference[], role?: VideoInputRole) => string | null;
  requestPicker: (nodeId: string, options?: ReferencePickerOptions) => void;
};
export const CanvasAssetsContext = createContext<CanvasAssetsActions | null>(null);
export function useCanvasAssets(): CanvasAssetsActions {
  const value = useContext(CanvasAssetsContext);
  if (!value) throw new Error("画布素材库尚未初始化");
  return value;
}
