// Barrel re-export for the deferred Attachment Fill simulation harness
// (ADR-0027). Import everything from here:
//
//   import { createHarness, makeBytes } from "./attachmentFillSim";
//
// See ./README.md for the vi.mock seam pattern and a copy-paste example.

export {
  createHarness,
  type Harness,
  type HarnessMocks,
  type FillLookup,
  type DriveResult,
  type JobError,
} from "./harness";

export {
  makeIntake,
  stageAttachments,
  makeBytes,
  resetIntakeSeq,
  DEFAULT_COWORKER,
  DEFAULT_SALES,
  type OutlookIntake,
  type IntakeAttachment,
  type IntakeCoworker,
  type MakeIntakeOptions,
} from "./outlookIntake";

export {
  FeishuBaseSim,
  RATE_LIMIT_CODE,
  CLIENT_TABLE_ID,
  type PutLogEntry,
  type CreateLogEntry,
  type UploadLogEntry,
} from "./feishuBaseSim";

export {
  FakeDb,
  FakeStorage,
  FakeScheduler,
  Registry,
  UnregisteredFunctionError,
  buildHarnessCtx,
  wallClock,
  EMAIL_RECORD_INDEXES,
  type FakeDoc,
  type ScheduledJob,
  type HarnessClock,
} from "./fakeConvex";
