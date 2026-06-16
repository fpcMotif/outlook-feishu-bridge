/* eslint-disable max-lines-per-function */
import { useMemo, useRef } from "react";

import { SubmitDock } from "@/design-system/taskpane";

import { CoworkerPicker } from "./CoworkerPicker";
import { SalesPicker } from "./SalesPicker";
import { CustomerPicker } from "./CustomerPicker";
import { IntakeHeader } from "./RequestIntakeScaffold";
import { NewRequestSection } from "./NewRequestSection";
import { AttachmentSection } from "./AttachmentSection";
import { clearIntakeUploadCache } from "./uploadIntakeFile";
import type { RequestIntakeScreenViewModel } from "./useRequestIntakeScreen";

function submitConfirmationKey({
  readyToSync,
  customerId,
  coworkerId,
  notes,
  selectedAttachmentIds,
  uploadedFiles,
}: {
  readyToSync: boolean;
  customerId?: string | null;
  coworkerId?: string | null;
  notes: Record<string, string>;
  selectedAttachmentIds: string[];
  uploadedFiles: RequestIntakeScreenViewModel["state"]["uploadedFiles"];
}) {
  return JSON.stringify({
    readyToSync,
    customerId: customerId ?? null,
    coworkerId: coworkerId ?? null,
    notes,
    selectedAttachmentIds: selectedAttachmentIds.toSorted(),
    uploadedFiles: uploadedFiles.map((file) => ({
      id: file.id,
      name: file.file.name,
      selected: file.selected,
      rejection: file.rejection,
      status: file.status ?? null,
      storageId: file.storageId ?? null,
    })),
  });
}

export function RequestIntakeBuildPane({ vm }: { vm: RequestIntakeScreenViewModel }) {
  const attachmentSectionRef = useRef<HTMLDivElement>(null);
  const {
    props,
    state,
    dispatch,
    sessionId,
    user,
    userAccessToken,
    usePreviewCoworkers,
    customerDirectory,
    searchCustomers,
    triggerCustomerRefresh,
    emailDomainPart,
    mailAttachments,
    addFiles,
    retryUpload,
    replaceUpload,
    filledCount,
    readyToSync,
    submitHint,
    selectCoworker,
    selectSales,
    openCreateCustomerMock,
    handleSubmit,
  } = vm;
  const confirmResetKey = useMemo(
    () =>
      submitConfirmationKey({
        readyToSync,
        customerId: state.selectedCustomer?.recordId,
        coworkerId: state.selectedCoworker?.openId,
        notes: state.notes,
        selectedAttachmentIds: state.selectedAttachmentIds,
        uploadedFiles: state.uploadedFiles,
      }),
    [
      readyToSync,
      state.selectedCustomer?.recordId,
      state.selectedCoworker?.openId,
      state.notes,
      state.selectedAttachmentIds,
      state.uploadedFiles,
    ],
  );

  return (
    <>
      <div className="no-scrollbar relative flex-1 overflow-y-auto px-5 pt-1 pb-[calc(8rem+1.5rem)]">
        <IntakeHeader profileSlot={props.profileSlot} />
        <div className="space-y-7">
          <CoworkerPicker
            salesSlot={
              <SalesPicker
                sessionId={sessionId}
                userAccessToken={userAccessToken}
                selectedSales={state.selectedSales}
                salesFromDefault={state.selectedSales !== null && !state.salesTouched}
                onSelect={selectSales}
                usePreviewCoworkers={usePreviewCoworkers}
              />
            }
            customerSlot={
              <CustomerPicker
                directory={customerDirectory}
                searchCustomers={searchCustomers}
                triggerRefresh={triggerCustomerRefresh}
                emailDomain={emailDomainPart}
                selectedCustomer={state.selectedCustomer}
                currentUserOpenId={user?.openId}
                embedded={true}
                onChange={(customer) => dispatch({ type: "customerOverridden", customer })}
                onCreateCustomer={openCreateCustomerMock}
              />
            }
            sessionId={sessionId}
            userAccessToken={userAccessToken}
            selectedCoworker={state.selectedCoworker}
            onSelect={selectCoworker}
            usePreviewCoworkers={usePreviewCoworkers}
          />
          <NewRequestSection
            values={state.notes}
            onChange={(id, value) => dispatch({ type: "noteChanged", id, value })}
          />
          <div ref={attachmentSectionRef}>
            <AttachmentSection
              mailAttachments={mailAttachments}
              selectedIds={state.selectedAttachmentIds}
              uploadedFiles={state.uploadedFiles}
              onToggleMail={(id) => dispatch({ type: "attachmentToggled", id })}
              onRemoveMail={(id) => dispatch({ type: "mailAttachmentRemoved", id })}
              onToggleUpload={(id) => dispatch({ type: "uploadedFileToggled", id })}
              onSetUploadedSelection={(ids) =>
                dispatch({ type: "uploadedFilesSelectionChanged", ids })
              }
              onAddFiles={addFiles}
              onRetryUpload={retryUpload}
              onReplaceUpload={replaceUpload}
              onRemoveUpload={(id) => {
                clearIntakeUploadCache(id);
                dispatch({ type: "uploadedFileRemoved", id });
              }}
            />
          </div>
        </div>
      </div>

      <SubmitDock
        count={readyToSync ? filledCount : 0}
        canSubmit={readyToSync}
        sending={false}
        hint={submitHint}
        label={
          readyToSync && state.selectedCoworker
            ? `Sync with ${state.selectedCoworker.name}`
            : undefined
        }
        confirmResetKey={confirmResetKey}
        onReviewStart={() =>
          attachmentSectionRef.current?.scrollIntoView?.({
            behavior: "smooth",
            block: "center",
          })
        }
        onSubmit={handleSubmit}
      />
    </>
  );
}
