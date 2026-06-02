import { useAction, useMutation } from "convex/react";
import { useMemo } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  postBytesToConvex,
  type AttachmentStagingDeps,
} from "../office/attachmentUpload";

// Assemble the AttachmentStagingDeps the SPA hands to stageAndUploadAttachments
// (ADR-0022): the Convex storage upload-URL mint, the raw byte POST, and the
// Drive token-minting action. Convex coupling lives only here so the
// orchestration + helpers stay framework-free and unit-testable. Memoized so the
// deps identity is stable across renders.
export function useAttachmentStaging(): AttachmentStagingDeps {
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const uploadToDrive = useAction(api.feishu.drive.uploadAttachmentsToDrive);
  return useMemo(
    () => ({
      generateUploadUrl: () => generateUploadUrl(),
      uploadBytes: postBytesToConvex,
      uploadToDrive: (sources) =>
        uploadToDrive({
          // storageId is a real Id<"_storage"> minted by the upload response; the
          // decoupled deps type it as string, so re-brand it at this boundary.
          sources: sources.map((s) => ({
            storageId: s.storageId as Id<"_storage">,
            fileName: s.fileName,
          })),
        }),
    }),
    [generateUploadUrl, uploadToDrive],
  );
}
