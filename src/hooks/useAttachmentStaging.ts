import { useMutation } from "convex/react";
import { useMemo } from "react";

import { api } from "../../convex/_generated/api";
import {
  postBytesToConvex,
  type AttachmentStagingDeps,
} from "../office/attachmentUpload";

// Assemble the AttachmentStagingDeps the SPA hands to stageAttachmentSources
// (ADR-0027): the Convex storage upload-URL mint and the raw byte POST. The Drive
// token-minting action is gone from the submit path — upload_all now runs in the
// deferred Attachment Fill worker (the SPA passes staged storageIds to syncRequest
// as `attachmentSources`). Convex coupling lives only here so the orchestration +
// helpers stay framework-free and unit-testable. Memoized so the deps identity is
// stable across renders.
export function useAttachmentStaging(): AttachmentStagingDeps {
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  return useMemo(
    () => ({
      generateUploadUrl: () => generateUploadUrl(),
      uploadBytes: postBytesToConvex,
    }),
    [generateUploadUrl],
  );
}
