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
import type * as emails from "../emails.js";
import type * as feishu_attachmentFill from "../feishu/attachmentFill.js";
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
import type * as feishu_customerMirrorRows from "../feishu/customerMirrorRows.js";
import type * as feishu_customerMirrorSync from "../feishu/customerMirrorSync.js";
import type * as feishu_customers from "../feishu/customers.js";
import type * as feishu_customersMirror from "../feishu/customersMirror.js";
import type * as feishu_devCustomerFixtures from "../feishu/devCustomerFixtures.js";
import type * as feishu_devCustomerSeed from "../feishu/devCustomerSeed.js";
import type * as feishu_devEmailFixtures from "../feishu/devEmailFixtures.js";
import type * as feishu_devEmailRecordSeed from "../feishu/devEmailRecordSeed.js";
import type * as feishu_drive from "../feishu/drive.js";
import type * as feishu_emailDomain from "../feishu/emailDomain.js";
import type * as feishu_pinyinTokens from "../feishu/pinyinTokens.js";
import type * as feishu_previewFixtures from "../feishu/previewFixtures.js";
import type * as feishu_requestSync from "../feishu/requestSync.js";
import type * as feishu_searchResultMerge from "../feishu/searchResultMerge.js";
import type * as feishu_serviceRow from "../feishu/serviceRow.js";
import type * as feishu_userAuth from "../feishu/userAuth.js";
import type * as http from "../http.js";
import type * as m365_aadErrors from "../m365/aadErrors.js";
import type * as m365_selfForward from "../m365/selfForward.js";
import type * as m365_selfForwardChain from "../m365/selfForwardChain.js";
import type * as m365_selfForwardMessage from "../m365/selfForwardMessage.js";
import type * as storage from "../storage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  emailRecord: typeof emailRecord;
  emails: typeof emails;
  "feishu/attachmentFill": typeof feishu_attachmentFill;
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
  "feishu/customerMirrorRows": typeof feishu_customerMirrorRows;
  "feishu/customerMirrorSync": typeof feishu_customerMirrorSync;
  "feishu/customers": typeof feishu_customers;
  "feishu/customersMirror": typeof feishu_customersMirror;
  "feishu/devCustomerFixtures": typeof feishu_devCustomerFixtures;
  "feishu/devCustomerSeed": typeof feishu_devCustomerSeed;
  "feishu/devEmailFixtures": typeof feishu_devEmailFixtures;
  "feishu/devEmailRecordSeed": typeof feishu_devEmailRecordSeed;
  "feishu/drive": typeof feishu_drive;
  "feishu/emailDomain": typeof feishu_emailDomain;
  "feishu/pinyinTokens": typeof feishu_pinyinTokens;
  "feishu/previewFixtures": typeof feishu_previewFixtures;
  "feishu/requestSync": typeof feishu_requestSync;
  "feishu/searchResultMerge": typeof feishu_searchResultMerge;
  "feishu/serviceRow": typeof feishu_serviceRow;
  "feishu/userAuth": typeof feishu_userAuth;
  http: typeof http;
  "m365/aadErrors": typeof m365_aadErrors;
  "m365/selfForward": typeof m365_selfForward;
  "m365/selfForwardChain": typeof m365_selfForwardChain;
  "m365/selfForwardMessage": typeof m365_selfForwardMessage;
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
