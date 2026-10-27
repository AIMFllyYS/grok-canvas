import { assetToDataUri, saveRemoteAsset } from "./assets";
import { getJson, postJson } from "./xai/client";
import type { VideoGenerateDeps, VideoUpstreamStatus } from "./video-generate";
import { verifyGenerationClaim, finishGeneration, attachGenerationTask } from "./generation-claims";

export const videoUpstream: VideoGenerateDeps = {
  createGeneration: (body) => postJson<{ request_id: string }>("/videos/generations", body),
  getGeneration: (requestId) => getJson<VideoUpstreamStatus>(`/videos/${encodeURIComponent(requestId)}`),
  toDataUri: assetToDataUri,
  saveRemote: (url, snapshot) => saveRemoteAsset(url, "mp4", fetch, snapshot),
  verifyClaim: verifyGenerationClaim,
  finishClaim: finishGeneration,
  attachClaim: attachGenerationTask,
};
