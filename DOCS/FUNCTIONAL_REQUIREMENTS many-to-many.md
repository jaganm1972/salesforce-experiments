# Functional Requirements: Multi-Account Transfer System
**Salesforce Case-Based Transfer Management for HNW Customers**

**Document Version:** 3.0
**Date:** June 10, 2026
**Status:** Updated to reflect row-based 1:1 model with external account support

---

## 1. EXECUTIVE SUMMARY

This document outlines the functional requirements for a **Multi-Account Transfer System** integrated into Salesforce. The system enables bank tellers to capture and manage transfer instructions for high-net-worth (HNW) customers. Each transfer configuration consists of one or more independent **1:1 transfer rows**, each pairing a single source account with a single destination account and an amount. The destination can be either a customer-owned account or any external account searched by name or account number.

---

## 2. BUSINESS CONTEXT & MOTIVATION

### 2.1 User Base
- **Primary Users:** Bank tellers/employees
- **On behalf of:** HNW customers with varied business interests and multiple accounts
- **Target Customers:** Those requiring multiple simultaneous transfer instructions in a single case

### 2.2 Key Use Cases
| Scenario | Description | Example |
|----------|-------------|---------|
| **Single transfer** | One source → one destination | Transfer $50K from checking to savings |
| **Multiple transfers** | Several independent 1:1 rows | Pay three different payees from three different accounts in one case |
| **External transfer** | Source is customer-owned; destination is a third-party account | Transfer to an account not owned by the customer (e.g. a beneficiary) |

### 2.3 Relationship to Salesforce Case
- The component can be embedded on either an **Account** page (account ID read directly from the record) or a **Case** page (account ID resolved from `Case.AccountId`)
- The transfer configuration is captured and displayed within the case
- Saving transfers is only permitted from a Case page context (the `CaseId` foreign key requires it)
- **Out of Scope:** Actual transfer execution (handled separately by backend systems)

---

## 3. FUNCTIONAL REQUIREMENTS

### 3.1 Transfer Model (F1)
**Requirement:** The system shall support one or more independent 1:1 transfer rows within a single case. Each row pairs exactly one source account with one destination account and one amount.

**Details:**
- A teller starts with zero rows and uses **Add Transfer Row** to add as many as needed
- Each row is fully independent — there are no cross-row amount constraints
- All rows share the same transfer date and status
- Every saved record stores `TransferType = '1:1'`

**Priority:** P0 (Core)

---

### 3.2 Account Selection — Source (F2)
**Requirement:** The source dropdown on each row shall show only accounts owned by the customer on the case.

**Details:**
- Account list sourced via **`FinancialAccountParty`** (junction object linking `Account` to `FinancialAccount`); only records where `Role = 'Owner'` and `FinancialAccount.Status = 'Active'` are returned (LIMIT 200)
- Dropdown label format: `Account Name — $X,XXX` (balance rounded to nearest dollar; shows "No balance" if no `FinancialAccountBalance` record exists)
- Sorted by balance descending
- The destination account selected in the same row is excluded from the source dropdown (prevents self-transfer within a row)
- Each row independently shows the full customer account list — there is no cross-row exclusion from the source dropdown

**Priority:** P0 (Core)

---

### 3.3 Account Selection — Destination (F3)
**Requirement:** The destination dropdown on each row shall show customer-owned accounts plus an "Other" option that allows the teller to search for any active account in the system.

**Details:**

#### 3.3.1 Owned Account Selection
- Same account pool as the source (customer's active owned accounts, sorted by balance descending)
- The source account selected in the same row is excluded from the destination dropdown (prevents self-transfer within a row)
- Each row independently shows the full customer account list — there is no cross-row exclusion from the destination dropdown

#### 3.3.2 External Account Selection ("Other")
- A fixed **"Other — search by account name or number"** option appears at the bottom of every destination dropdown
- Selecting "Other" reveals a search input directly below the dropdown
- Minimum 4 characters required to trigger a search; results capped at 20
- Matches on `FinancialAccount.Name` or `FinancialAccount.FinancialAccountNumber` (LIKE search); active accounts only
- **Balance is intentionally not returned or displayed** for search results — these may be third-party accounts
- Selecting a result from the search list locks it in as the destination; the dropdown is replaced by the account name and masked account number (****XXXX) with a close (×) button
- Clicking × returns the row to the standard dropdown in its unselected state
- An external account already locked in as destination in another row is excluded from search results in all other rows, preventing the same third-party account from being targeted twice in the same transfer configuration

**Priority:** P0 (Core)

---

### 3.4 Amount Input (F4)
**Requirement:** Each transfer row shall have a single currency amount field.

**Details:**
- Each row has one amount input field (currency, step 0.01)
- There are no per-column totals or cross-row total-match constraints — each row is independent
- Amount must be greater than zero before the configuration can be saved

**Priority:** P0 (Core)

---

### 3.5 Balance Validation (F5)
**Requirement:** Balance enforcement shall be configurable via a single constant and is disabled by default.

**Details:**
- Controlled by `ENFORCE_BALANCE_CHECK` in `TransferConfigurationController.cls`:

```apex
private static final Boolean ENFORCE_BALANCE_CHECK = false;
```

| Value | Behaviour |
|-------|-----------|
| `false` (default) | No balance check — amounts are accepted as entered |
| `true` | Server-side check on save: queries the latest `FinancialAccountBalance` per source account and throws an `AuraHandledException` if any row's amount exceeds the available balance |

- When enabled, the check runs for both Draft and Submit saves (server-side)
- The check uses the most recent `FinancialAccountBalance` record per source account, ordered by `BalanceAsOfDate DESC, CreatedDate DESC`
- Accounts with no balance record are skipped
- **Rationale for default-off:** Balance enforcement is handled downstream by the actual transfer execution process; capturing the instruction at time of teller entry does not require a real-time balance gate

**Priority:** P1 (High)

---

### 3.6 Transfer Configuration Persistence (F6)
**Requirement:** System shall save transfer configurations using a configurable storage object, switchable between a custom development object and the standard FSC object.

**Details:**

#### 3.6.1 Dual-Object Architecture
A single boolean constant in `TransferConfigurationController.cls` controls which object is used:

```apex
private static final Boolean USE_STANDARD_OBJECT = false;
```

| Value | Object Used | Context |
|-------|-------------|---------|
| `false` | `Fund_Transfer_Request__c` (custom) | Development / current org |
| `true` | `FundTransferRequest` (standard FSC) | Target / production org |

Flipping the constant and redeploying the Apex class is the only change required to switch.

#### 3.6.2 Custom Object: `Fund_Transfer_Request__c`
| Field | API Name | Type | Notes |
|-------|----------|------|-------|
| Request Number | `Name` | Auto Number | Format: `FTR-{0000}` |
| Case | `Case__c` | Lookup (Case) | Parent case |
| From Account | `From_Account__c` | Lookup (FinancialAccount) | Source account |
| To Account | `To_Account__c` | Lookup (FinancialAccount) | Destination account |
| Amount | `Amount__c` | Currency (18,2) | Amount for this FROM→TO pair |
| Start Date | `Start_Date__c` | Date | Requested transfer date |
| Status | `Status__c` | Picklist | Values: `Draft`, `Submitted` (not restricted) |
| Transfer Type | `Transfer_Type__c` | Picklist | Always stored as `1:1` |

#### 3.6.3 Standard FSC Object: `FundTransferRequest`
| Field | API Name | Type | Notes |
|-------|----------|------|-------|
| Name | `Name` | Auto Number | Auto-generated |
| Case | `CaseId` | Lookup (Case) | Parent case |
| From Account | `FromId` | Lookup (FinancialAccount) | Source account — **always required** |
| To Account | `ToId` | Lookup (FinancialAccount) | Destination account — **always required** |
| Amount | `Amount` | Currency | Amount for this FROM→TO pair — **always required** |
| Start Date | `StartDate` | Date | Requested transfer date |
| Status | `Status` | Picklist | Values depend on org configuration |
| Transfer Type | `TransferType` | Picklist | Always stored as `1:1`; value must exist in the picklist |

> **Platform constraint:** `FundTransferRequest` requires **both `FromId` and `ToId` to be set** on every record. Every saved record therefore represents a specific FROM→TO pair — which aligns directly with the 1:1 row model.

#### 3.6.4 Record Strategy
Each row in the UI maps to exactly **one** saved record. There is no waterfall or pairing algorithm.

| UI Rows | Records Created | FromId | ToId | Amount |
|---------|----------------|--------|------|--------|
| N | N | row's source account | row's destination account | row's amount |

#### 3.6.5 Edit Behaviour
- Saving an edited transfer (Draft or Submit) **replaces** all existing records for the case atomically: existing records are deleted and the new set is inserted in the same transaction
- The UI pre-populates the form on Edit by reconstructing each row from the saved records; if a destination account is not in the customer's owned account list it is treated as an external account and rendered as a locked chip

**Priority:** P0 (Core)

---

### 3.7 Data Display in Case (F7)
**Requirement:** Transfer configurations shall be visible and easily readable within the case context.

**Details:**

**List mode (default view):**
- Shows transfer date and status badge
- Per-row table with columns: Source | Destination | Amount
- Each account shown with name and masked account number (****XXXX)
- **Edit** button → switches to form mode with data pre-populated
- **Reset** button → confirmation dialog → deletes all transfer records for the case

**Empty state:**
- When no records exist: icon, help text, and "New Transfer Request" button

**Form mode:**
- Transfer date input at the top
- Column headers: Source Account | Destination Account | Amount
- Each row: source combobox | destination combobox (or search / chip for external) | amount input | delete button
- **+ Add Transfer Row** button (lower left)
- Actions: Save as Draft / Submit / Cancel (lower right)

**Priority:** P1 (High)

---

### 3.8 Error Handling & User Feedback (F8)
**Requirement:** System shall provide clear error messaging and validation feedback.

**Details:**
- **Validation errors** shown inline above the form actions
- **Missing source/destination:** `"All rows must have a source account selected."` / `"All rows must have a destination account selected."`
- **Self-transfer:** `"Source and destination cannot be the same account."`
- **Zero amount:** `"All rows must have an amount greater than zero."`
- **Missing date:** `"Transfer date is required."`
- **No rows:** `"At least one transfer row is required."`
- **Balance exceeded (when enabled):** Apex throws a message identifying the account ID, available balance, and requested amount
- **Success:** toast notification on successful Draft save or Submit
- **Apex errors:** DML errors, field errors, and `AuraHandledException` messages all surface correctly via `_extractError()` in the LWC

**Priority:** P0 (Core)

---

### 3.9 Access Control (F9)
**Requirement:** Users must be granted explicit access to the custom object and Apex controller via a permission set.

**Details:**
- Permission set: **Transfer Configuration User** (`Transfer_Configuration_User`)
- Grants:
  - Create / Read / Edit / Delete on `Fund_Transfer_Request__c`
  - Read + Edit on all custom fields
  - Apex class access for `TransferConfigurationController`
- Assign to teller profiles via Setup → Permission Sets → Manage Assignments
- When switching to the standard `FundTransferRequest` object, a separate permission set or profile update is required for that object

**Priority:** P0 (Core)

---

## 4. SYSTEM CONSTRAINTS & BUSINESS RULES

### 4.1 Account Limits
- No upper limit on the number of transfer rows
- Customer accounts are loaded via `FinancialAccountParty` with a SOQL `LIMIT 200` safeguard
- External account search returns at most 20 results per query

### 4.2 Amount Rules
- All amounts must be **positive numbers greater than zero**
- Currency formatting automatically applied in the UI
- No cross-row total-match constraint — each row is independent
- Draft saves do not enforce balance constraints (even when `ENFORCE_BALANCE_CHECK = true`, only server-side saves check balance — see §3.5)

### 4.3 Account Selection Rules
- Within a single row: source and destination **cannot be the same account**
- Each row draws from the **full** customer account list independently — an account used as source in row 1 can still appear as source in row 2
- The same external account **cannot be selected as destination in more than one row** — enforced by filtering it out of all other rows' "Other" search results once locked in
- Only accounts with `FinancialAccountParty.Role = 'Owner'` and `FinancialAccount.Status = 'Active'` appear in owned-account dropdowns
- External accounts (via "Other") are restricted to `FinancialAccount.Status = 'Active'`; no ownership constraint

### 4.4 Balance Validation
- Controlled by `ENFORCE_BALANCE_CHECK` constant (default `false`) — see §3.5
- When enabled, validation runs server-side at save time against `FinancialAccountBalance`
- Balance is still **displayed** in the source dropdown label for reference, regardless of whether enforcement is enabled

### 4.5 `@AuraEnabled` Parameter Constraint
- Salesforce's `@AuraEnabled` framework silently nullifies `List<CustomInnerClass>` method parameters
- **Workaround:** The LWC serialises the entire save payload as a single JSON string (`payloadJson`) which Apex deserialises explicitly using `JSON.deserialize`. This is the implemented pattern and must be maintained if the method signature is modified

---

## 5. USER INTERFACE SPECIFICATIONS

### 5.1 Component Modes

The component operates in two modes, toggled by user action:

**List Mode (default)**
```
┌──────────────────────────────────────────────────────────┐
│  Transfer Requests                                       │
├──────────────────────────────────────────────────────────┤
│  Transfer Date: June 17, 2026        Status: [Draft]     │
│                                                          │
│  Source              Destination           Amount        │
│  ─────────────────── ───────────────────── ──────────    │
│  Savings ****1234    Checking ****5678     $300.00       │
│  Business ****9012   Beneficiary ****3456  $5,000.00     │
│                                                          │
│  [ Edit ]  [ Reset ]                                     │
└──────────────────────────────────────────────────────────┘
```

**Form Mode (New / Edit)**
```
┌──────────────────────────────────────────────────────────┐
│  Transfer Requests                                       │
├──────────────────────────────────────────────────────────┤
│  Transfer Date: [__________]                             │
│                                                          │
│  Source Account     Destination Account     Amount       │
│  ──────────────     ────────────────────     ──────      │
│  ┌─────────────────────────────────────────────────┐    │
│  │ [Select source ▼] [Select destination ▼] [$   ] [🗑]│ │
│  └─────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────┐    │
│  │ [Select source ▼] [Other — search...    ] [$   ] [🗑]│ │
│  │                    Search: [____________]        │    │
│  │                    > Beneficiary ****3456        │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  [+ Add Transfer Row]         [Save as Draft][Submit]    │
│                               [Cancel]                   │
└──────────────────────────────────────────────────────────┘
```

### 5.2 Responsive Design
- Component optimised for desktop (primary use case: teller workstations)
- Deployed as a `lightning__RecordPage` component for both `Account` and `Case` objects, Large form factor only

### 5.3 Destination "Other" Flow
1. Teller opens destination dropdown → sees owned accounts + "Other — search by account name or number" at the bottom
2. Selects "Other" → a search input appears below the dropdown (which remains showing "Other" selected)
3. Teller types ≥ 4 characters → debounced search fires, results appear as a clickable list
4. Teller clicks a result → search UI disappears; destination cell shows the account name and ****XXXX with a × button
5. To change: teller clicks × → destination resets to the standard dropdown (unselected)
6. To switch back to an owned account without using ×: teller can select any owned account from the dropdown while the search is visible — this cancels "Other" mode

### 5.4 User Interaction Flow

**New transfer:**
1. Teller opens Case record → sees empty state with "New Transfer Request" button
2. Clicks New → form mode opens (no rows yet)
3. Selects transfer date
4. Clicks **+ Add Transfer Row** for each transfer needed
5. For each row: selects source from dropdown; selects destination from dropdown or uses "Other" to search; enters amount
6. Clicks **Save as Draft** (skips balance check) or **Submit** (triggers balance check if enabled)
7. On success: toast notification, form resets, list mode shows the saved summary

**Edit transfer:**
1. Teller clicks **Edit** on the list view
2. Form opens pre-populated: owned-account destinations show in the dropdown; external destinations show as locked chips
3. Teller modifies rows as needed (add, remove, change accounts or amounts)
4. Saves — existing records deleted and new set inserted atomically

**Reset transfer:**
1. Teller clicks **Reset** → confirmation dialog
2. On confirm: all transfer records for the case are deleted
3. Component returns to empty state

---

## 6. TECHNICAL ARCHITECTURE

### 6.1 Data Model

```
Case
  └─ Fund_Transfer_Request__c / FundTransferRequest
       │   (one record per UI row; always a 1:1 pair)
       ├─ From_Account__c / FromId → FinancialAccount (source — customer-owned)
       └─ To_Account__c  / ToId   → FinancialAccount (destination — owned or external)

Account (Customer)
  └─ FinancialAccountParty (junction — Role = 'Owner')
       └─ FinancialAccount
            └─ FinancialAccountBalance (most recent by BalanceAsOfDate DESC, CreatedDate DESC)
```

### 6.2 Component Stack

| Layer | Technology | Detail |
|-------|-----------|--------|
| Frontend | Lightning Web Component | `transferConfiguration` — dual-mode (list/form) |
| Backend | Apex | `TransferConfigurationController` — with sharing |
| Storage | Custom or Standard object | Switched by `USE_STANDARD_OBJECT` constant |
| Access | Permission Set | `Transfer_Configuration_User` |

### 6.3 Apex Controller Methods

| Method | Type | Purpose |
|--------|------|---------|
| `getFinancialAccounts(accountId)` | `@AuraEnabled(cacheable=true)` | Returns active financial accounts owned by the customer, with most recent balance |
| `searchFinancialAccounts(searchTerm)` | `@AuraEnabled(cacheable=true)` | Ad-hoc search across all active `FinancialAccount` records by name or account number; requires ≥ 4 chars; returns max 20 results; no balance returned |
| `getTransferSummary(caseId)` | `@AuraEnabled(cacheable=true)` | Returns one `TransferSummaryRow` per saved record (source name/number, dest name/number, amount) |
| `saveTransferRequests(payloadJson)` | `@AuraEnabled` | Deletes existing records for the case and inserts one record per UI row; optionally validates balances if `ENFORCE_BALANCE_CHECK = true` |
| `deleteTransferRequests(caseId)` | `@AuraEnabled` | Deletes all transfer records for the case (Reset action) |

### 6.4 Configurable Constants

```apex
// Switches storage between custom dev object and standard FSC object.
private static final Boolean USE_STANDARD_OBJECT = false;

// Set true to enforce server-side balance check at save time.
// Leave false when balance enforcement is handled downstream.
private static final Boolean ENFORCE_BALANCE_CHECK = false;

// Minimum characters required to trigger the external account search.
private static final Integer SEARCH_MIN_LENGTH = 4;

// Maximum results returned by searchFinancialAccounts.
private static final Integer SEARCH_RESULT_LIMIT = 20;
```

### 6.5 LWC State Model

Each transfer row is stored as an object in the `transferRows` tracked array:

| Property | Type | Purpose |
|----------|------|---------|
| `_key` | Number | Unique render key |
| `sourceAccountId` | String \| null | Selected source account ID |
| `destAccountId` | String \| null | Selected destination account ID (owned or external) |
| `destIsExternal` | Boolean | True when destination was found via "Other" search |
| `destExternalName` | String \| null | Display name for locked external account |
| `destExternalLastFour` | String \| null | Last 4 digits of external account number |
| `amount` | value \| null | Raw input from the amount field |
| `destSearchTerm` | String | Current search input for "Other" lookup |
| `_destSearchRawResults` | Array | Raw results from last `searchFinancialAccounts` call |

The `displayRows` getter produces a computed array from `transferRows` with per-row option lists and search results, consumed directly by the template.

### 6.6 Deployed Metadata

| Artifact | Type | Purpose |
|----------|------|---------|
| `transferConfiguration` | LWC | UI component |
| `TransferConfigurationController` | Apex Class | Backend logic |
| `Fund_Transfer_Request__c` | Custom Object | Transfer records (dev org) |
| `Transfer_Configuration_User` | Permission Set | Field/object/class access for tellers |

### 6.7 Integration Points
- **Inbound:** Case object context (customer, case ID); Account page also supported (read-only view; saves require Case context)
- **Outbound:** Transfer data stored in Salesforce; external transfer system reads via API
- **No external API calls** in this scope

---

## 7. OUT OF SCOPE

1. **Actual Fund Transfer Execution** — backend/external system responsibility
2. **Audit Trail & Compliance** — regulatory compliance features (AML, KYC, etc.)
3. **Approval Workflows** — no manual approval steps required
4. **Transfer Scheduling** — future-dated transfers beyond the transfer date field
5. **Fee Calculation** — no fee computation or display
6. **Multi-Currency** — assumed single currency environment
7. **Reporting & Analytics** — dashboards and reports on transfers
8. **Mobile App** — desktop-first implementation; mobile form factor not configured
9. **Configurable Account Query (CMT)** — account query is currently hardcoded to `FinancialAccountParty` with `Role = 'Owner'` and `Status = 'Active'`; CMT-based configuration is a future enhancement
10. **Cross-row duplicate source/destination enforcement** — each row is independent; the same owned account can appear as source or destination in multiple rows

---

## 8. FUTURE ENHANCEMENTS (Post-MVP)

1. **Migrate to Standard Object** — set `USE_STANDARD_OBJECT = true` once `FundTransferRequest.TransferType` picklist values are configured in the target org
2. **Enable Balance Enforcement** — set `ENFORCE_BALANCE_CHECK = true` when downstream systems are ready to rely on the saved amount being pre-validated
3. **Approval Workflows** — add approval routing for high-value transfers
4. **Audit & Compliance** — regulatory compliance features
5. **Transfer Scheduling** — schedule transfers for future execution dates
6. **Templates** — save and reuse transfer configurations
7. **Bulk Upload** — CSV/Excel import for multiple transfer rows
8. **Analytics Dashboard** — track transfer volumes and patterns
9. **Configurable Account Query** — CMT-driven SOQL filter and sort for account dropdowns
10. **Notification System** — email/SMS notifications on transfer completion

---

## 9. ACCEPTANCE CRITERIA

### 9.1 Functional Acceptance Criteria
- [x] Each transfer row independently pairs one source account, one destination account, and one amount
- [x] Source dropdown shows customer's active owned accounts sorted by balance descending
- [x] Source dropdown excludes the destination account selected in the same row
- [x] Destination dropdown shows customer's active owned accounts plus an "Other" option
- [x] Destination dropdown excludes the source account selected in the same row
- [x] Selecting "Other" in the destination reveals a search field; ≥ 4 characters triggers a search
- [x] Search results show account name and masked number; balance is not displayed for external accounts
- [x] An external account locked in as destination in one row does not appear in search results for other rows
- [x] Locking in an external account replaces the search UI with a chip showing name and ****XXXX
- [x] Clicking × on an external chip returns the row to the standard destination dropdown
- [x] Rows can be added (up to any number) and removed individually
- [x] Validation prevents saving with: missing source, missing destination, self-transfer, zero amount, missing date, or zero rows
- [x] Balance validation is off by default; enabled by flipping `ENFORCE_BALANCE_CHECK = true`
- [x] Each UI row maps to exactly one saved record (`TransferType = '1:1'`)
- [x] List view shows a per-row table: Source | Destination | Amount
- [x] Edit pre-populates the form; external destinations reload as locked chips
- [x] Save on edit replaces existing records atomically (delete + insert in one transaction)
- [x] Reset deletes all transfer records after confirmation
- [x] Component embeddable on both Account and Case record pages
- [x] Error messages are clear and actionable; Apex errors surface correctly

### 9.2 Performance Criteria
- Component loads within **2 seconds**
- External account search returns results within **2 seconds** of the 4th character being typed
- Form submission completes within **3 seconds**
- Dropdown accounts populate within **1 second** of component load

### 9.3 Data Integrity Criteria
- Every saved record has both `From_Account__c` and `To_Account__c` populated
- All records for a transfer configuration share the same `Case__c`, `Start_Date__c`, and `Status__c`
- Saving an edit never results in orphaned or duplicate records
- `Transfer_Type__c` is always stored as `1:1`

---

## 10. GLOSSARY

| Term | Definition |
|------|-----------|
| **HNW Customer** | High-Net-Worth customer with multiple accounts and complex banking needs |
| **Transfer Configuration** | The complete set of 1:1 transfer rows for a case (date, status, and all rows) |
| **Transfer Row** | A single UI row pairing one source account, one destination account, and one amount — maps 1:1 to a saved record |
| **External Account** | Any `FinancialAccount` not owned by the case's customer, selected via the "Other" search path |
| **USE_STANDARD_OBJECT** | Boolean constant in `TransferConfigurationController` that switches between the custom and standard storage objects |
| **ENFORCE_BALANCE_CHECK** | Boolean constant in `TransferConfigurationController` that enables/disables server-side balance validation at save time |
| **Financial Account** | Salesforce FSC standard object representing a customer's bank account (`FinancialAccount`) |
| **displayRows** | LWC computed getter that enriches each raw `transferRows` entry with per-row option lists, search results, and display flags consumed by the template |

---

## 11. DOCUMENT REVISION HISTORY

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 6, 2026 | | Initial functional requirements draft |
| 2.0 | June 7, 2026 | | Updated to reflect implemented solution: dual-object architecture, shared pool UI, waterfall N:N algorithm, inferred transfer type, permission set, paired record strategy, edit pre-population |
| 3.0 | June 10, 2026 | | Full redesign: replaced M:N model with multiple independent 1:1 rows; added "Other" external account search on destination; removed per-side totals and total-match validation; replaced client-side balance check with configurable server-side `ENFORCE_BALANCE_CHECK` constant (default off); updated UI to row-based grid; updated Apex summary to per-row `TransferSummaryRow`; updated all acceptance criteria and glossary |

---

**Sign-Off:**

- **Product Owner:** _________________ Date: _______
- **Requirements Lead:** _________________ Date: _______
- **Technical Lead:** _________________ Date: _______
