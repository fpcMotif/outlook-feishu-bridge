/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as emailRecord from "../emailRecord.js";
import type * as emailRecordFill from "../emailRecordFill.js";
import type * as emailRecordLookup from "../emailRecordLookup.js";
import type * as emails from "../emails.js";
import type * as feishu_attachmentFill from "../feishu/attachmentFill.js";
import type * as feishu_attachmentFillSim_fakeConvex from "../feishu/attachmentFillSim/fakeConvex.js";
import type * as feishu_attachmentFillSim_feishuBaseSim from "../feishu/attachmentFillSim/feishuBaseSim.js";
import type * as feishu_attachmentFillSim_harness from "../feishu/attachmentFillSim/harness.js";
import type * as feishu_attachmentFillSim_index from "../feishu/attachmentFillSim/index.js";
import type * as feishu_attachmentFillSim_outlookIntake from "../feishu/attachmentFillSim/outlookIntake.js";
import type * as feishu_attachmentLimits from "../feishu/attachmentLimits.js";
import type * as feishu_auth from "../feishu/auth.js";
import type * as feishu_bitable from "../feishu/bitable.js";
import type * as feishu_bitableSyncRetry from "../feishu/bitableSyncRetry.js";
import type * as feishu_bitableUrl from "../feishu/bitableUrl.js";
import type * as feishu_call from "../feishu/call.js";
import type * as feishu_cjkSearch from "../feishu/cjkSearch.js";
import type * as feishu_client from "../feishu/client.js";
import type * as feishu_contactsMirror from "../feishu/contactsMirror.js";
import type * as feishu_contactsMirrorRows from "../feishu/contactsMirrorRows.js";
import type * as feishu_contactsMirrorSync from "../feishu/contactsMirrorSync.js";
import type * as feishu_coworkers from "../feishu/coworkers.js";
import type * as feishu_customerDomainMatchEngine from "../feishu/customerDomainMatchEngine.js";
import type * as feishu_customerMirrorCompletion from "../feishu/customerMirrorCompletion.js";
import type * as feishu_customerMirrorConfig from "../feishu/customerMirrorConfig.js";
import type * as feishu_customerMirrorFullSync from "../feishu/customerMirrorFullSync.js";
import type * as feishu_customerMirrorRows from "../feishu/customerMirrorRows.js";
import type * as feishu_customerMirrorSearchActions from "../feishu/customerMirrorSearchActions.js";
import type * as feishu_customerMirrorSync from "../feishu/customerMirrorSync.js";
import type * as feishu_customerMirrorValidators from "../feishu/customerMirrorValidators.js";
import type * as feishu_customerMirrorWrites from "../feishu/customerMirrorWrites.js";
import type * as feishu_customerSearchEngine from "../feishu/customerSearchEngine.js";
import type * as feishu_customers from "../feishu/customers.js";
import type * as feishu_customersMirror from "../feishu/customersMirror.js";
import type * as feishu_devCustomerFixtures from "../feishu/devCustomerFixtures.js";
import type * as feishu_devCustomerSeed from "../feishu/devCustomerSeed.js";
import type * as feishu_devEmailFixtures from "../feishu/devEmailFixtures.js";
import type * as feishu_devEmailRecordSeed from "../feishu/devEmailRecordSeed.js";
import type * as feishu_drive from "../feishu/drive.js";
import type * as feishu_pinyinTokens from "../feishu/pinyinTokens.js";
import type * as feishu_previewFixtures from "../feishu/previewFixtures.js";
import type * as feishu_requestSync from "../feishu/requestSync.js";
import type * as feishu_requestSyncCore from "../feishu/requestSyncCore.js";
import type * as feishu_requestSyncFill from "../feishu/requestSyncFill.js";
import type * as feishu_searchResultMerge from "../feishu/searchResultMerge.js";
import type * as feishu_serviceRow from "../feishu/serviceRow.js";
import type * as feishu_userAuth from "../feishu/userAuth.js";
import type * as http from "../http.js";
import type * as storage from "../storage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  emailRecord: typeof emailRecord;
  emailRecordFill: typeof emailRecordFill;
  emailRecordLookup: typeof emailRecordLookup;
  emails: typeof emails;
  "feishu/attachmentFill": typeof feishu_attachmentFill;
  "feishu/attachmentFillSim/fakeConvex": typeof feishu_attachmentFillSim_fakeConvex;
  "feishu/attachmentFillSim/feishuBaseSim": typeof feishu_attachmentFillSim_feishuBaseSim;
  "feishu/attachmentFillSim/harness": typeof feishu_attachmentFillSim_harness;
  "feishu/attachmentFillSim/index": typeof feishu_attachmentFillSim_index;
  "feishu/attachmentFillSim/outlookIntake": typeof feishu_attachmentFillSim_outlookIntake;
  "feishu/attachmentLimits": typeof feishu_attachmentLimits;
  "feishu/auth": typeof feishu_auth;
  "feishu/bitable": typeof feishu_bitable;
  "feishu/bitableSyncRetry": typeof feishu_bitableSyncRetry;
  "feishu/bitableUrl": typeof feishu_bitableUrl;
  "feishu/call": typeof feishu_call;
  "feishu/cjkSearch": typeof feishu_cjkSearch;
  "feishu/client": typeof feishu_client;
  "feishu/contactsMirror": typeof feishu_contactsMirror;
  "feishu/contactsMirrorRows": typeof feishu_contactsMirrorRows;
  "feishu/contactsMirrorSync": typeof feishu_contactsMirrorSync;
  "feishu/coworkers": typeof feishu_coworkers;
  "feishu/customerDomainMatchEngine": typeof feishu_customerDomainMatchEngine;
  "feishu/customerMirrorCompletion": typeof feishu_customerMirrorCompletion;
  "feishu/customerMirrorConfig": typeof feishu_customerMirrorConfig;
  "feishu/customerMirrorFullSync": typeof feishu_customerMirrorFullSync;
  "feishu/customerMirrorRows": typeof feishu_customerMirrorRows;
  "feishu/customerMirrorSearchActions": typeof feishu_customerMirrorSearchActions;
  "feishu/customerMirrorSync": typeof feishu_customerMirrorSync;
  "feishu/customerMirrorValidators": typeof feishu_customerMirrorValidators;
  "feishu/customerMirrorWrites": typeof feishu_customerMirrorWrites;
  "feishu/customerSearchEngine": typeof feishu_customerSearchEngine;
  "feishu/customers": typeof feishu_customers;
  "feishu/customersMirror": typeof feishu_customersMirror;
  "feishu/devCustomerFixtures": typeof feishu_devCustomerFixtures;
  "feishu/devCustomerSeed": typeof feishu_devCustomerSeed;
  "feishu/devEmailFixtures": typeof feishu_devEmailFixtures;
  "feishu/devEmailRecordSeed": typeof feishu_devEmailRecordSeed;
  "feishu/drive": typeof feishu_drive;
  "feishu/pinyinTokens": typeof feishu_pinyinTokens;
  "feishu/previewFixtures": typeof feishu_previewFixtures;
  "feishu/requestSync": typeof feishu_requestSync;
  "feishu/requestSyncCore": typeof feishu_requestSyncCore;
  "feishu/requestSyncFill": typeof feishu_requestSyncFill;
  "feishu/searchResultMerge": typeof feishu_searchResultMerge;
  "feishu/serviceRow": typeof feishu_serviceRow;
  "feishu/userAuth": typeof feishu_userAuth;
  http: typeof http;
  storage: typeof storage;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
