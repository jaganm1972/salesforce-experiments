# Functional Specification: Salesforce → eMoney API Integration Framework

**Document Version:** 1.1  
**Date:** June 9, 2026  
**Status:** Draft  
**Branch:** emoney-framework

---

## 1. EXECUTIVE SUMMARY

This document specifies a metadata-driven integration framework that synchronises customer and household data from Salesforce Financial Services Cloud (FSC) to the eMoney Advisor platform via its REST API. The framework is designed to accommodate a large number of distinct eMoney endpoints through declarative configuration, while providing first-class Apex extension points for endpoints that require orchestration, transformation, or conditional logic that cannot be expressed through metadata alone.

---

## 2. BUSINESS CONTEXT

### 2.1 Problem Statement

Financial advisors maintain client records in both Salesforce FSC and eMoney Advisor. When onboarding a new client or updating an existing one, data entered in Salesforce (via standard objects, custom fields, and the FSC Discovery Framework) must be transmitted to eMoney across a set of distinct API endpoints. The volume of endpoints and the variability of mapping logic makes a hard-coded approach brittle and expensive to maintain.

### 2.2 Key Requirements

| Requirement | Description |
|-------------|-------------|
| **Multi-member scope** | A single sync operation covers a primary account and one or more related household members, identified by a set of Account IDs selected by the user |
| **Data sources** | Salesforce Account, related standard FSC objects, and answers captured via the FSC Discovery Framework (questionnaire/needs analysis) |
| **Declarative mapping** | The majority of endpoint payloads can be defined entirely through metadata — no code for the common case |
| **Orchestration** | Certain endpoints must fire in a specific order (e.g., client must be created before dependants can be linked); response data from one call (e.g., eMoney client ID) must flow into subsequent calls |
| **Write-back** | Some endpoint responses return identifiers that must be persisted back to Salesforce fields (e.g., eMoney client ID on the Account record) |
| **Apex extensions** | An Apex interface mechanism allows complex or conditional logic to augment or replace the metadata-driven path for any endpoint |

### 2.3 Out of Scope (v1)

- Real-time synchronisation / event-driven triggers
- Inbound sync (eMoney → Salesforce)
- Bulk/batch sync of all accounts (the trigger is always user-initiated per household)
- eMoney endpoint detail and authentication implementation (addressed in a separate technical specification)

---

## 3. GLOSSARY

| Term | Definition |
|------|-----------|
| **Household** | A set of Account records representing a client and their related members (spouse, dependants) selected by the user |
| **Account ID set** | The list of `Account.Id` values that define the scope of a single sync operation |
| **Sync Run** | A single invocation of the integration framework for a given set of Account IDs |
| **Endpoint Definition** | A Custom Metadata record that fully describes one eMoney API endpoint and how to invoke it |
| **Field Mapping** | A Custom Metadata record that maps one source value (Salesforce field or Discovery answer) to one field in an eMoney request payload |
| **Response Mapping** | A Custom Metadata record that maps one field from an eMoney API response back to a Salesforce field |
| **Transform Provider** | An Apex class implementing the `IEMoneyTransformProvider` interface, used to supply custom request-building or response-handling logic for a specific endpoint |
| **Discovery Framework** | The Salesforce FSC feature that captures structured questionnaire responses (needs analysis, financial goals, risk tolerance, etc.) delivered via OmniScript and stored in `AssessmentTask` / `AssessmentQuestionResponse` objects |
| **Execution Context** | A runtime map of all data collected for the current Sync Run (SF field values, Discovery answers, prior API responses) — the shared state that flows through the pipeline |
| **Scalar Discovery Answer** | An `AssessmentQuestionResponse` record where the answer is a single typed value (text, number, date, boolean) stored in the appropriate typed column |
| **Structured Discovery Response** | An `AssessmentQuestionResponse` record where `ResponseValue` contains a JSON-encoded object or array (e.g., a table of financial accounts each with name, institution, balance) |
| **OmniProcess** | The OmniScript process that delivers a Discovery Framework questionnaire to the user |

---

## 4. DATA SOURCES

### 4.1 Salesforce Standard and FSC Objects

The framework queries the following objects for each Account ID in the household scope. The set of objects queried for a given Sync Run is driven by the Endpoint Definitions that are active for that run.

| Object | Notes |
|--------|-------|
| `Account` | Primary client record — personal details, demographic fields, eMoney ID write-back target |
| `Contact` (via `Account.PersonContact`) | Person account contact fields (email, phone) |
| `FinancialAccount` | Financial accounts owned by the client (via `FinancialAccountParty`) |
| `FinancialAccountBalance` | Most recent balance per financial account |
| `FinancialGoal` | Goals identified during financial planning |
| `InsurancePolicy` | Insurance holdings |
| `LifeEvent` | Life events on the account |
| `IndividualApplication` | Application records, if applicable |
| Related `Account` (household members) | Spouse, dependants etc. — queried using the same pattern per Account ID |

Additional objects may be declared on Endpoint Definitions; the framework resolves and caches them dynamically.

### 4.2 FSC Discovery Framework

The Discovery Framework captures structured question-and-answer data linked to Accounts. Questionnaires are delivered through OmniScripts; answers are persisted in `AssessmentQuestionResponse` records. The full object chain is:

```
OmniProcess (OmniScript)
  └─ OmniProcessAsmtQuestionVer (junction — which questions are embedded in this script)
       └─ AssessmentQuestionVersion
            └─ AssessmentQuestion

AssessmentTask (one per questionnaire session, linked to Account + OmniProcess)
  └─ AssessmentQuestionResponse (one per answered question per session)
       └─ AssessmentQuestionVersion (identifies which question was answered)
```

| Object | API Name | Purpose |
|--------|----------|---------|
| OmniScript Process | `OmniProcess` | The OmniScript that delivers the questionnaire UI |
| OmniProcess–Question Junction | `OmniProcessAsmtQuestionVer` | Junction between `OmniProcess` and `AssessmentQuestionVersion`; defines which question versions are embedded in a given OmniScript and their display order |
| Assessment Task | `AssessmentTask` | One record per questionnaire session; carries `AccountId`, `OmniProcessId`, `Status`, and `AssessmentTaskDefinitionId` |
| Assessment Task Definition | `AssessmentTaskDefinition` | Template that links a task type to its OmniScript and question set |
| Assessment Question Set | `AssessmentQuestionSet` | A named collection of questions (e.g., "Risk Profile", "Financial Goals") |
| Assessment Question Set Item | `AssessmentQuestionSetItem` | Junction: links a question version to a set with an `Order` |
| Assessment Question | `AssessmentQuestion` | The question entity; holds the active version reference |
| Assessment Question Version | `AssessmentQuestionVersion` | Versioned question text and metadata; `DeveloperName` is the stable identifier used in field mappings |
| **Assessment Question Response** | **`AssessmentQuestionResponse`** | **One record per answered question per task session. Stores the answer in a typed column (`ResponseText`, `ResponseValue`, `DateValue`, `DecimalResponseValue`, `CurrencyValue`, `IsTrueOrFalseValue`, etc.). For structured/multi-value questions, `ResponseValue` holds a JSON-encoded array.** |
| Assessment Indicator | `AssessmentIndicator` | Stores a computed/scored indicator value (e.g., risk score) linked to an Account; populated by post-task processing |
| Assessment Indicator Definition | `AssessmentIndDefinition` | Defines an indicator category and its scoring model |

**Querying answers at runtime:** For a given Account, the `DataFetcher` queries:
1. The most recently completed `AssessmentTask` per `AssessmentTaskDefinitionId` for the account
2. All `AssessmentQuestionResponse` records for those tasks, joined to `AssessmentQuestionVersion.DeveloperName`

Within Field Mappings, a Discovery source is addressed by the question's `DeveloperName`. The response value is read from the appropriate typed column depending on the question's data type. For structured responses, `ResponseValue` contains JSON and is handled as described in §5.5.

**Role of OmniProcessAsmtQuestionVer at runtime:** This object is primarily a configuration/setup object — it defines which questions an OmniScript presents. At runtime, the `DataFetcher` does not need to traverse it to retrieve answers (answers are already linked directly to `AssessmentQuestionVersion` via `AssessmentQuestionResponse`). However, it becomes relevant when:
- Filtering responses by the specific OmniScript that collected them (e.g., only use risk-profile answers from the risk OmniScript, not from an older general onboarding script)
- Validating that a required question is part of the expected OmniScript before relying on its response
- Diagnosing missing answers (question not in the OmniScript → no response record will exist)

---

## 5. METADATA-DRIVEN DESIGN

### 5.1 Rationale

The eMoney API consists of a large number of distinct endpoints. For the majority of these, the payload is a straightforward projection of Salesforce field values and Discovery answers with minor type transformations. Rather than writing and maintaining Apex for each endpoint, the framework externalises this knowledge into three families of Custom Metadata Types (CMTs). New endpoints and new mappings can be added and deployed without Apex changes.

### 5.2 Custom Metadata Type: `eMoney_Endpoint__mdt` (Endpoint Definition)

One record per eMoney API endpoint that participates in a Sync Run.

| Field | Type | Description |
|-------|------|-------------|
| `DeveloperName` | Text | Unique identifier (also used as the key in Execution Context) |
| `Label` | Text | Human-readable name |
| `HTTP_Method__c` | Picklist | `POST`, `PUT`, `PATCH`, `GET` |
| `Path_Template__c` | Text | URL path, supporting `{eMoneyClientId}` and similar context variable tokens |
| `Execution_Order__c` | Number | Determines call sequence within a Sync Run (lower = earlier) |
| `Scope__c` | Picklist | `PrimaryAccount`, `HouseholdMember`, `Household` — whether to invoke once per account, once per member, or once per run |
| `Depends_On__c` | Text | Comma-separated `DeveloperName`s of endpoints that must succeed before this one runs |
| `Transform_Provider_Class__c` | Text | Apex class name implementing `IEMoneyTransformProvider`; blank = metadata-only path |
| `Is_Active__c` | Checkbox | Enables/disables the endpoint without deletion |
| `On_Success_Apex__c` | Text | Optional post-success Apex class name (`IEMoneyResponseHandler`) |

### 5.3 Custom Metadata Type: `eMoney_Field_Mapping__mdt` (Field Mapping)

One record per field that contributes to an endpoint's request payload. Multiple records target the same endpoint.

| Field | Type | Description |
|-------|------|-------------|
| `DeveloperName` | Text | Unique identifier |
| `Endpoint__c` | Metadata Relationship | Parent `eMoney_Endpoint__mdt` record |
| `Source_Type__c` | Picklist | `SObjectField`, `DiscoveryAnswer`, `DiscoveryIndicator`, `DiscoveryStructuredResponse`, `ContextVariable`, `Constant`, `Formula` |
| `Source_Reference__c` | Text | For `SObjectField`: `Object.Field` API path (e.g., `Account.FirstName`). For `DiscoveryAnswer` / `DiscoveryStructuredResponse`: question `DeveloperName`. For `ContextVariable`: key in Execution Context. For `Constant`: the literal value |
| `Source_Response_Column__c` | Picklist | For `DiscoveryAnswer`: which typed column to read from (`ResponseText`, `ResponseValue`, `DateValue`, `DecimalResponseValue`, `CurrencyValue`, `IsTrueOrFalseValue`, `ChoiceValue`). Default: framework auto-selects based on question data type |
| `Source_JSON_Path__c` | Text | **For `DiscoveryStructuredResponse` only.** Dot-notation path into the JSON stored in `ResponseValue` to extract a single scalar value (e.g., `accounts[0].institutionName`). Used when you need one specific field from a structured response. For full array-to-array mapping, use a Transform Provider (see §5.5). |
| `Target_Path__c` | Text | Dot-notation path in the eMoney request JSON (e.g., `client.personalInfo.firstName`) |
| `Data_Type__c` | Picklist | `String`, `Integer`, `Decimal`, `Boolean`, `Date`, `DateTime` — applied during serialisation |
| `Transform__c` | Picklist | Optional value transform: `UpperCase`, `LowerCase`, `DateToISOString`, `BooleanToYN`, `GenderCode`, `StateAbbreviation`, etc. |
| `Default_Value__c` | Text | Value used when the source is null |
| `Is_Required__c` | Checkbox | Framework logs a warning (and optionally aborts) if the resolved value is null and no default is set |
| `Account_Scope__c` | Picklist | `Primary`, `Member`, `Any` — which account's data to pull when the endpoint covers a household member |

### 5.4 Custom Metadata Type: `eMoney_Response_Mapping__mdt` (Response Mapping)

One record per field extracted from an endpoint response and written back to Salesforce.

| Field | Type | Description |
|-------|------|-------------|
| `DeveloperName` | Text | Unique identifier |
| `Endpoint__c` | Metadata Relationship | Parent `eMoney_Endpoint__mdt` record |
| `Response_JSON_Path__c` | Text | Dot-notation path in the eMoney response JSON (e.g., `client.clientId`) |
| `Target_Object__c` | Text | Salesforce object API name to write back to (e.g., `Account`) |
| `Target_Field__c` | Text | Salesforce field API name to write back to (e.g., `eMoney_Client_Id__c`) |
| `Target_Record_Scope__c` | Picklist | `CurrentAccount`, `PrimaryAccount` — which record to update |
| `Store_In_Context__c` | Text | If non-blank, also stores the value in the Execution Context under this key (making it available to downstream endpoint path templates and mappings) |

### 5.5 Structured Multi-Value Discovery Responses

#### 5.5.1 The Problem

Some Discovery Framework questions are designed to capture a collection of items rather than a single value. For example, an "Existing Financial Accounts" question may present the advisor with a repeating table where each row captures account name, institution, account number, and balance. When the OmniScript saves these answers, the entire table is serialised as a JSON array into a single `AssessmentQuestionResponse.ResponseValue` field. There may also be cases where each row produces a separate `AssessmentQuestionResponse` record for the same `AssessmentQuestionVersionId`.

This creates two distinct challenges for the integration framework:

| Challenge | Metadata-Only? | Recommended Approach |
|-----------|---------------|----------------------|
| Extract one scalar from a JSON array (e.g., the institution name of the *first* account) | **Yes** — use `DiscoveryStructuredResponse` + `Source_JSON_Path__c` | Field Mapping CMT with `Source_JSON_Path__c = 'accounts[0].institutionName'` |
| Map an entire array of items to a corresponding eMoney request array (e.g., all N accounts become N elements in `client.assets[]`) | **No** — the metadata structure cannot express iteration and multi-field extraction over an array of unknown length | Mandatory Transform Provider |

#### 5.5.2 Execution Context Pre-Processing

When the `DataFetcher` loads Discovery answers, it identifies `AssessmentQuestionResponse` records where `ResponseValue` contains valid JSON (detectable by a leading `[` or `{`). These are loaded into the Execution Context under a dedicated key pattern:

```
sf.discovery.structured.{QuestionDeveloperName}   →   parsed List<Object> or Map<String, Object>
```

Scalar answers continue to use:
```
sf.discovery.{QuestionDeveloperName}   →   the typed value from the appropriate column
```

This pre-processing means Transform Providers receive the structured data already parsed — they never need to deserialise `ResponseValue` themselves.

#### 5.5.3 Transform Provider Contract for Array Expansion

For endpoints that require full array expansion from a structured response, the `Transform_Provider_Class__c` on the Endpoint Definition must be set. The provider receives the parsed array from the Execution Context and is responsible for building the corresponding eMoney request array:

```apex
public class EMoneyFinancialAccountsProvider implements IEMoneyTransformProvider {
    public Map<String, Object> buildRequest(
        Map<String, Object> context,
        Map<String, Object> basePayload
    ) {
        // Pre-processed by DataFetcher — already a parsed list
        List<Object> sfAccounts =
            (List<Object>) context.get('sf.discovery.structured.Existing_Financial_Accounts');

        List<Map<String, Object>> eMoneyAssets = new List<Map<String, Object>>();
        if (sfAccounts != null) {
            for (Object row : sfAccounts) {
                Map<String, Object> acct = (Map<String, Object>) row;
                eMoneyAssets.add(new Map<String, Object>{
                    'institutionName' => acct.get('institutionName'),
                    'accountNumber'   => acct.get('accountNumber'),
                    'balance'         => acct.get('balance')
                });
            }
        }
        basePayload.put('assets', eMoneyAssets);
        return basePayload;
    }
}
```

The `basePayload` already contains all scalar mappings resolved by the metadata — the provider only needs to handle the array fields it is responsible for.

#### 5.5.4 Multiple Response Records (Row-per-Record Pattern)

In some org configurations, multi-row questionnaire data is stored as multiple `AssessmentQuestionResponse` records (one per row) for the same `AssessmentQuestionVersionId`, rather than a single JSON-encoded record. The `DataFetcher` handles this by collecting all response records for a given question version into a list. This list is placed in the Execution Context under the same `sf.discovery.structured.{DeveloperName}` key. The Transform Provider consumes it identically to the JSON array pattern — the distinction is transparent to the provider.

**Open Question (see §13, Q10):** Confirm which pattern this org uses for structured inputs — single JSON-encoded record or one record per row. This affects the `DataFetcher` query and pre-processing logic.

---

## 6. PROCESSING FLOW

### 6.1 Trigger

The integration is initiated by a user action in the Salesforce UI (e.g., a button on the Account page or a Flow screen). The trigger passes:
- `primaryAccountId` — the Account ID of the primary client
- `memberAccountIds` — a list of Account IDs of household members selected by the user

### 6.2 Pipeline Overview

```
User Selects Accounts
        │
        ▼
┌───────────────────┐
│  1. Data Fetch    │  Query all required SF objects and Discovery answers
│     (Apex)        │  for all Account IDs in scope. Populate Execution Context.
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  2. Load Metadata │  Query active eMoney_Endpoint__mdt records.
│                   │  Sort by Execution_Order__c. Resolve dependencies.
└────────┬──────────┘
         │
         ▼
┌───────────────────┐   ┌──────────────────────────────┐
│  3. For each      │──▶│  a. Build Request             │
│     Endpoint      │   │     (metadata mapping OR       │
│     (in order)    │   │      Transform Provider)       │
│                   │   ├──────────────────────────────┤
│                   │   │  b. Resolve Path Template     │
│                   │   │     (inject context variables)│
│                   │   ├──────────────────────────────┤
│                   │   │  c. Call eMoney API           │
│                   │   ├──────────────────────────────┤
│                   │   │  d. Apply Response Mappings   │
│                   │   │     (write-back to SF;        │
│                   │   │      store in context)        │
│                   │   ├──────────────────────────────┤
│                   │   │  e. Execute On_Success_Apex   │
└───────────────────┘   └──────────────────────────────┘
         │
         ▼
┌───────────────────┐
│  4. Persist       │  Bulk DML write-back of all SF field updates
│     Write-back    │  collected during step 3d.
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  5. Log & Report  │  Persist Sync Run log record; surface result to user
└───────────────────┘
```

### 6.3 Execution Context

The Execution Context is a `Map<String, Object>` that persists across the entire Sync Run. It is pre-populated during Data Fetch and updated as endpoints execute. Keys follow a convention:

| Key Pattern | Populated By | Example |
|-------------|-------------|---------|
| `sf.{ObjectApiName}.{FieldApiName}` | Data Fetch | `sf.Account.FirstName` |
| `sf.discovery.{QuestionDeveloperName}` | Data Fetch — scalar answers | `sf.discovery.Risk_Tolerance_Score` |
| `sf.discovery.structured.{QuestionDeveloperName}` | Data Fetch — structured/multi-value answers | `sf.discovery.structured.Existing_Financial_Accounts` (value is `List<Object>` or `Map<String,Object>`) |
| `response.{EndpointDeveloperName}.{ContextKey}` | Response Mapping | `response.Create_Client.eMoneyClientId` |

Path templates in Endpoint Definitions use `{key}` syntax resolved against the Execution Context at invocation time.

### 6.4 Dependency Resolution

Before execution begins, the framework performs a topological sort of active endpoints based on `Depends_On__c`. If a circular dependency is detected, the Sync Run fails immediately with a clear error. If a dependency endpoint fails, all endpoints that depend on it are skipped and marked `Skipped` in the log.

### 6.5 Scope Expansion

Endpoints with `Scope__c = HouseholdMember` are invoked once per Account ID in `memberAccountIds`. For each invocation, the Execution Context is forked with the member's data overlaid on the primary context, so both primary and member data are accessible simultaneously.

---

## 7. APEX EXTENSION POINTS

### 7.1 `IEMoneyTransformProvider` Interface

Implement this interface when the metadata-driven mapping cannot fully express the request construction logic (e.g., conditional fields, derived values, data from external callouts, complex aggregations).

```apex
public interface IEMoneyTransformProvider {
    /**
     * Called instead of (or to augment) the metadata field mappings.
     * @param context  The Execution Context at the time this endpoint fires
     * @param basePayload  The payload already built from metadata mappings (may be empty map)
     * @return  The final payload map to serialise as the request body
     */
    Map<String, Object> buildRequest(
        Map<String, Object> context,
        Map<String, Object> basePayload
    );
}
```

When `Transform_Provider_Class__c` is set on an Endpoint Definition, the framework:
1. Builds the metadata-driven `basePayload` first
2. Instantiates the named Apex class via `Type.forName()`
3. Calls `buildRequest(context, basePayload)` — the provider may return the base payload unmodified, enrich it, or replace it entirely

This pattern means a provider can selectively override only the fields it needs without reimplementing the common mappings.

### 7.2 `IEMoneyResponseHandler` Interface

Implement this interface for post-response logic beyond simple field write-back: triggering downstream processes, sending notifications, creating Salesforce records, etc.

```apex
public interface IEMoneyResponseHandler {
    /**
     * Called after response mappings have been applied.
     * @param response  The parsed eMoney API response
     * @param context   The Execution Context (updated with response values)
     */
    void handleResponse(
        Map<String, Object> response,
        Map<String, Object> context
    );
}
```

---

## 8. ORCHESTRATION EXAMPLES

### 8.1 Client Creation with ID Write-back

**Scenario:** `Create_Client` endpoint creates a new eMoney client; the returned `clientId` must be stored on `Account.eMoney_Client_Id__c` and made available to all subsequent endpoints via the URL path.

**Metadata configuration:**

`eMoney_Endpoint__mdt` — `Create_Client`:
- `Path_Template__c`: `/clients`
- `Execution_Order__c`: `10`
- `HTTP_Method__c`: `POST`

`eMoney_Response_Mapping__mdt` — `Client_Id_Writeback`:
- `Response_JSON_Path__c`: `clientId`
- `Target_Object__c`: `Account`
- `Target_Field__c`: `eMoney_Client_Id__c`
- `Target_Record_Scope__c`: `CurrentAccount`
- `Store_In_Context__c`: `eMoneyClientId`

`eMoney_Endpoint__mdt` — `Create_Goal`:
- `Path_Template__c`: `/clients/{eMoneyClientId}/goals`
- `Execution_Order__c`: `30`
- `Depends_On__c`: `Create_Client`

At runtime, `{eMoneyClientId}` in the path is resolved from `response.Create_Client.eMoneyClientId` stored in the Execution Context.

### 8.2 Household Member Sync

**Scenario:** After the primary client is created, sync each household member using a `Create_Dependent` endpoint.

**Metadata configuration:**

`eMoney_Endpoint__mdt` — `Create_Dependent`:
- `Scope__c`: `HouseholdMember`
- `Path_Template__c`: `/clients/{eMoneyClientId}/family`
- `Execution_Order__c`: `20`
- `Depends_On__c`: `Create_Client`

The framework invokes this endpoint once per `memberAccountId`. For each invocation, field mappings sourced from `Account.FirstName` etc. resolve against the current member's Account record.

### 8.3 Discovery-Driven Risk Profile Endpoint

**Scenario:** An endpoint consumes the risk tolerance score and investment time horizon captured via the Discovery Framework questionnaire — all scalar values, no array expansion needed.

`eMoney_Field_Mapping__mdt` records for `Update_Risk_Profile`:

| Source_Type__c | Source_Reference__c | Source_Response_Column__c | Target_Path__c |
|----------------|---------------------|---------------------------|----------------|
| `DiscoveryIndicator` | `Risk_Tolerance_Score` | *(indicator — column not applicable)* | `riskProfile.score` |
| `DiscoveryAnswer` | `Investment_Time_Horizon` | `IntegerResponseValue` | `riskProfile.timeHorizon` |
| `DiscoveryAnswer` | `Primary_Investment_Goal` | `ChoiceValue` | `riskProfile.primaryGoal` |

No Apex required.

### 8.4 Structured Response — Existing Financial Accounts Endpoint

**Scenario:** The advisor captured a list of held-away financial accounts via a repeating table in the Discovery questionnaire. Each row has institution name, account number, account type, and balance. These must be sent to eMoney as an array under `client.assets[]`.

Because this requires iterating over an unknown-length array and mapping multiple fields per element, **a Transform Provider is mandatory**. The metadata handles the scalar fields on the same endpoint; the provider handles only the array:

`eMoney_Endpoint__mdt` — `Sync_Financial_Assets`:
- `Transform_Provider_Class__c`: `EMoneyFinancialAssetsProvider`

`eMoney_Field_Mapping__mdt` scalar records for `Sync_Financial_Assets` (handled by metadata):

| Source_Type__c | Source_Reference__c | Target_Path__c |
|----------------|---------------------|----------------|
| `SObjectField` | `Account.eMoney_Client_Id__c` | *(used in path template)* |

Array expansion handled by `EMoneyFinancialAssetsProvider` which reads `sf.discovery.structured.Existing_Financial_Accounts` from the Execution Context (see §5.5.3 for the provider pattern).

### 8.4 Complex Payload via Transform Provider

**Scenario:** The `Update_Net_Worth` endpoint requires aggregating balances across all financial accounts and applying business logic that cannot be expressed as a flat field mapping.

`eMoney_Endpoint__mdt` — `Update_Net_Worth`:
- `Transform_Provider_Class__c`: `EMoneyNetWorthProvider`

```apex
public class EMoneyNetWorthProvider implements IEMoneyTransformProvider {
    public Map<String, Object> buildRequest(
        Map<String, Object> context,
        Map<String, Object> basePayload
    ) {
        List<Object> accounts = (List<Object>) context.get('sf.FinancialAccount.all');
        Decimal totalAssets = 0;
        // ... aggregation logic ...
        basePayload.put('totalAssets', totalAssets);
        return basePayload;
    }
}
```

---

## 9. SYNC RUN LOG

Every Sync Run creates a `eMoney_Sync_Run__c` record with child `eMoney_Sync_Run_Step__c` records (one per endpoint invocation).

### 9.1 `eMoney_Sync_Run__c`

| Field | Type | Description |
|-------|------|-------------|
| `Name` | Auto Number | e.g., `SYNC-000042` |
| `Primary_Account__c` | Lookup (Account) | |
| `Run_Date_Time__c` | DateTime | |
| `Status__c` | Picklist | `In Progress`, `Complete`, `Partial`, `Failed` |
| `Initiated_By__c` | Lookup (User) | |
| `Member_Account_IDs__c` | Long Text | JSON array of member Account IDs |

### 9.2 `eMoney_Sync_Run_Step__c`

| Field | Type | Description |
|-------|------|-------------|
| `Sync_Run__c` | Lookup | Parent run |
| `Endpoint__c` | Text | `DeveloperName` of the endpoint |
| `Account__c` | Lookup (Account) | Account in scope for this invocation |
| `Status__c` | Picklist | `Success`, `Failed`, `Skipped` |
| `HTTP_Status_Code__c` | Number | e.g., `200`, `422` |
| `Request_Payload__c` | Long Text | Serialised request (for debugging) |
| `Response_Payload__c` | Long Text | Serialised response (for debugging) |
| `Error_Message__c` | Long Text | Error details if status is `Failed` |
| `Duration_Ms__c` | Number | Callout duration |

---

## 10. ERROR HANDLING

| Scenario | Behaviour |
|----------|-----------|
| Dependency endpoint failed | Downstream endpoints are skipped; marked `Skipped` in log |
| HTTP 4xx from eMoney | Step marked `Failed`; error payload captured; run continues for non-dependent endpoints |
| HTTP 5xx from eMoney | Step marked `Failed`; configurable retry count (default: 0 in v1) |
| Required field null | Configurable: `Warn` (proceed with null) or `Abort` per endpoint |
| Apex `IEMoneyTransformProvider` throws | Step marked `Failed`; exception message captured |
| Apex callout governor limits | Framework monitors remaining callout count; aborts run gracefully if limit is close |
| DML write-back failure | Logged as a warning on the run record; does not fail the step that produced the response |

---

## 11. SECURITY AND ACCESS CONTROL

- All callouts to eMoney are made server-side from Apex, never from client-side JavaScript
- eMoney API credentials are stored in a Named Credential (not Custom Settings or hardcoded)
- A Permission Set controls which Salesforce users can initiate a Sync Run
- Sync Run log records are visible only to users with the integration permission set or admin profiles
- Request/response payloads in the log may contain PII — field-level security on `Request_Payload__c` and `Response_Payload__c` should restrict log record visibility to integration admins only

---

## 12. TECHNICAL ARCHITECTURE SUMMARY

```
┌──────────────────────────────────────────────────────────────┐
│                     Salesforce Org                           │
│                                                              │
│  ┌─────────────┐      ┌──────────────────────────────────┐  │
│  │  LWC / Flow │─────▶│    EMoneyIntegrationService      │  │
│  │  (UI Trigger)│     │    (Apex — orchestration core)   │  │
│  └─────────────┘      │                                  │  │
│                       │  ┌─────────────────────────────┐ │  │
│                       │  │  MetadataLoader              │ │  │
│                       │  │  (reads eMoney_*__mdt CMTs)  │ │  │
│                       │  └─────────────────────────────┘ │  │
│                       │                                  │  │
│                       │  ┌─────────────────────────────┐ │  │
│                       │  │  DataFetcher                 │ │  │
│                       │  │  (SOQL for Account/FSC/      │ │  │
│                       │  │   Discovery objects)         │ │  │
│                       │  └─────────────────────────────┘ │  │
│                       │                                  │  │
│                       │  ┌─────────────────────────────┐ │  │
│                       │  │  RequestBuilder              │ │  │
│                       │  │  (metadata mapping +         │ │  │
│                       │  │   IEMoneyTransformProvider)  │ │  │
│                       │  └─────────────────────────────┘ │  │
│                       │                                  │  │
│                       │  ┌─────────────────────────────┐ │  │
│                       │  │  EMoneyApiClient             │ │  │
│                       │  │  (HTTP callouts via          │ │  │
│                       │  │   Named Credential)          │ │  │
│                       │  └─────────────────────────────┘ │  │
│                       │                                  │  │
│                       │  ┌─────────────────────────────┐ │  │
│                       │  │  ResponseProcessor           │ │  │
│                       │  │  (response mappings +        │ │  │
│                       │  │   IEMoneyResponseHandler)    │ │  │
│                       │  └─────────────────────────────┘ │  │
│                       └──────────────────────────────────┘  │
│                                                              │
│  Custom Metadata Types:  eMoney_Endpoint__mdt                │
│                          eMoney_Field_Mapping__mdt           │
│                          eMoney_Response_Mapping__mdt        │
│                                                              │
│  Custom Objects:         eMoney_Sync_Run__c                  │
│                          eMoney_Sync_Run_Step__c             │
└──────────────────────────────────────────────────────────────┘
                               │
                               │  Named Credential (HTTPS)
                               ▼
                    ┌──────────────────────┐
                    │   eMoney Advisor API  │
                    └──────────────────────┘
```

---

## 13. OPEN QUESTIONS

| # | Question | Owner | Notes |
|---|----------|-------|-------|
| 1 | What is the eMoney API authentication mechanism? (OAuth 2.0, API key, JWT?) | Integration Team | Determines Named Credential configuration |
| 2 | Does eMoney use a sandbox environment for testing? | Integration Team | Needed for dev/QA Named Credential setup |
| 3 | Are eMoney endpoints idempotent? Can the same create request be safely retried? | Integration Team | Affects error recovery strategy |
| 4 | Which specific endpoints are in scope for v1? | Product / Integration Team | Determines initial CMT records to author |
| 5 | What is the expected volume — number of households synced per day? | Product | May affect governor limit strategy (queueable vs. synchronous) |
| 6 | Should failed Sync Runs be retryable by the user, or is a new run always initiated from scratch? | Product | Affects UI and run log design |
| 7 | Are there eMoney rate limits? | Integration Team | Affects pacing and error handling |
| 8 | Does the Discovery Framework use standard `AssessmentTask` / `AssessmentQuestionResponse` objects or custom objects in this org? | Salesforce Admin | Affects SOQL in DataFetcher |
| 9 | Which Discovery question `DeveloperName`s map to eMoney fields? | Business Analyst | Drives initial `eMoney_Field_Mapping__mdt` records |
| 10 | For multi-value questionnaire inputs (e.g., existing financial accounts list), does the OmniScript store responses as (a) a single `AssessmentQuestionResponse` with JSON in `ResponseValue`, or (b) one `AssessmentQuestionResponse` record per row? | Salesforce Admin / Developer | Determines `DataFetcher` SOQL and pre-processing logic for structured responses (§5.5.4) |
| 11 | Which `OmniProcess` records correspond to the Discovery questionnaire flows that feed eMoney? Are there multiple OmniScripts (e.g., separate ones for risk profile, onboarding, needs analysis)? | Salesforce Admin | Determines whether `DataFetcher` must scope response queries to a specific `OmniProcessId` to avoid pulling answers from unrelated questionnaire sessions |

---

## 14. PHASED DELIVERY

### Phase 1 — Framework Foundation
- Core Apex classes: `EMoneyIntegrationService`, `MetadataLoader`, `DataFetcher`, `RequestBuilder`, `EMoneyApiClient`, `ResponseProcessor`
- Three CMT families deployed with no records (shell only)
- Sync Run log objects deployed
- Named Credential configured for eMoney sandbox
- `IEMoneyTransformProvider` and `IEMoneyResponseHandler` interfaces defined

### Phase 2 — First Endpoints
- Author CMT records for the first batch of endpoints (e.g., `Create_Client`, `Update_Personal_Info`, `Create_Dependent`)
- Validate end-to-end with real eMoney sandbox calls
- Confirm response mapping and write-back (eMoney Client ID → Account)

### Phase 3 — Discovery Framework Mappings
- Confirm Discovery object structure in org (§13, Q8)
- Wire Discovery answers into `DataFetcher` and expose via Execution Context
- Author field mapping CMT records for Discovery-sourced fields
- Test full needs-analysis → eMoney payload flow

### Phase 4 — Remaining Endpoints and Hardening
- Author all remaining endpoint CMT records
- Implement `IEMoneyTransformProvider` for any endpoints requiring custom Apex
- Error handling hardening, retry configuration, governor limit monitoring

---

## 15. DOCUMENT REVISION HISTORY

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 9, 2026 | | Initial draft |
| 1.1 | June 9, 2026 | | Added `OmniProcessAsmtQuestionVer` and `AssessmentQuestionResponse` to Discovery Framework data model (§4.2); added full object chain diagram; added `DiscoveryStructuredResponse` source type and `Source_JSON_Path__c` / `Source_Response_Column__c` fields to Field Mapping CMT (§5.3); added §5.5 Structured Multi-Value Discovery Responses covering scalar JSON extraction, Transform Provider contract for array expansion, and row-per-record pattern; updated Execution Context key table (§6.3); added orchestration example §8.4; added Open Questions 10–11 |

---

**Sign-Off:**

- **Product Owner:** _________________ Date: _______
- **Requirements Lead:** _________________ Date: _______
- **Technical Lead:** _________________ Date: _______
