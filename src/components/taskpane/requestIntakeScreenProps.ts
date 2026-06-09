import type { ReactNode } from "react";

import type { MailItemData } from "../../office/useMailItem";
import type { AttachmentStagingDeps } from "../../office/attachmentUpload";
import type { UploadedFile } from "./intakeReducer";

export type RequestIntakeScreenProps = {
  isLoggedIn: boolean;
  // True while the Convex session query is in flight without a logged-in signal;
  // suppresses the LoginScreen flash for returning users with cached creds.
  isAuthLoading?: boolean;
  mailItem: MailItemData;
  sessionId: string;
  // The signed-in Feishu user (the Initiator, ADR-0014); optional on dev-preview.
  user?: { openId: string; userName?: string; avatarUrl?: string };
  userAccessToken?: string;
  usePreviewCoworkers?: boolean;
  /** Browser dev host without Outlook mailbox — gates live Base sync for fixtures. */
  devPreview?: boolean;
  /** DEV-only ("constra mode", ?mock=): seed fixture uploads to debug the failed/retry UI. */
  mockUploads?: UploadedFile[];
  /** DEV-only: deterministic staging deps so Retry behaves predictably under ?mock=. */
  mockStagingDeps?: AttachmentStagingDeps;
  profileSlot?: ReactNode;
  onLogin: () => void;
  onLoginFallback: () => void;
};
