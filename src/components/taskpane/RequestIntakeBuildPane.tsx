import { CoworkerPicker } from "./CoworkerPicker";
import { SalesPicker } from "./SalesPicker";
import { CustomerPicker } from "./CustomerPicker";
import { IntakeHeader } from "./RequestIntakeScaffold";
import { NewRequestSection } from "./NewRequestSection";
import { AttachmentSection } from "./AttachmentSection";
import { SubmitDock } from "./SubmitDock";
import { clearIntakeUploadCache } from "./uploadIntakeFile";
import type { RequestIntakeScreenViewModel } from "./useRequestIntakeScreen";

// eslint-disable-next-line max-lines-per-function -- flat JSX wiring of the three intake pickers; no branching.
function IntakeBuildSections({ vm }: { vm: RequestIntakeScreenViewModel }) {
  const {
    state,
    dispatch,
    sessionId,
    user,
    userAccessToken,
    usePreviewCoworkers,
    customerDirectory,
    searchCustomers,
    triggerCustomerRefresh,
    mailAttachments,
    addFiles,
    retryUpload,
    selectCoworker,
    selectSales,
    openCreateCustomerMock,
  } = vm;

  return (
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
      <AttachmentSection
        mailAttachments={mailAttachments}
        selectedIds={state.selectedAttachmentIds}
        uploadedFiles={state.uploadedFiles}
        onToggleMail={(id) => dispatch({ type: "attachmentToggled", id })}
        onRemoveMail={(id) => dispatch({ type: "mailAttachmentRemoved", id })}
        onToggleUpload={(id) => dispatch({ type: "uploadedFileToggled", id })}
        onSetUploadedSelection={(ids) => dispatch({ type: "uploadedFilesSelectionChanged", ids })}
        onAddFiles={addFiles}
        onRetryUpload={retryUpload}
        onRemoveUpload={(id) => {
          clearIntakeUploadCache(id);
          dispatch({ type: "uploadedFileRemoved", id });
        }}
      />
    </div>
  );
}

export function RequestIntakeBuildPane({ vm }: { vm: RequestIntakeScreenViewModel }) {
  const { props, state, filledCount, readyToSync, submitHint, handleSubmit } = vm;

  return (
    <>
      <div className="no-scrollbar relative flex-1 overflow-y-auto px-5 pt-1 pb-[calc(8rem+1.5rem)]">
        <IntakeHeader profileSlot={props.profileSlot} />
        <IntakeBuildSections vm={vm} />
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
        onSubmit={handleSubmit}
      />
    </>
  );
}
